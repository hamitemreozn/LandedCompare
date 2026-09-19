/**
 * The autosave engine and its save-state model.
 *
 * Canonical behaviour: `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §5. The rules
 * that shaped this file:
 *
 * - **The unit of save is the aggregate, never the field.** This controller
 *   holds one buffered value and hands the whole thing to `save`; it has no
 *   concept of a changed field and cannot produce a partial write.
 * - **`SAVED` is never reported before the transaction commits.** `save` is
 *   expected to resolve only on commit (`Database#write` does), and the state
 *   moves on that resolution, not on the call.
 * - **A failed save keeps the dirty buffer.** Discarding it would throw away
 *   the user's work to make the indicator look tidy.
 * - **Ledger-affecting operations are never autosaved.** Nothing here posts
 *   anything; a timer must not be able to write a stock movement. Posting is
 *   an explicit action taken once, knowingly, by a person.
 *
 * Timing is injected rather than taken from the global scope, so the debounce
 * and the retry backoff are exercised by tests with a controlled clock instead
 * of by waiting. There is no interval, no polling and no background loop: the
 * only timers are the 600 ms debounce and the retry backoff, both of which are
 * started by a change and cancelled when there is nothing left to save.
 */

import { toPersistenceError, type PersistenceError } from './errors'

export type SaveState = 'IDLE' | 'SAVING' | 'SAVED' | 'ERROR'

export interface AutosaveStatus {
  readonly state: SaveState
  /** A change is buffered and not yet committed. */
  readonly pendingChanges: boolean
  /** The last failure, kept visible until a save succeeds. */
  readonly error: PersistenceError | null
  /** Failed attempts since the last success. */
  readonly failedAttempts: number
  /** False once the backoff is exhausted; only a manual `retry()` continues. */
  readonly willRetry: boolean
}

export interface AutosaveScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const globalScheduler: AutosaveScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** §5: 600 ms after the last keystroke. */
export const DEFAULT_DEBOUNCE_MS = 600
/** §5: roughly 1s, 3s, 10s, then stop and wait for a person. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 10000]

export interface AutosaveOptions<T> {
  /** Must resolve only once the write has committed. */
  readonly save: (value: T) => Promise<void>
  readonly debounceMs?: number
  readonly retryDelaysMs?: readonly number[]
  readonly scheduler?: AutosaveScheduler
  readonly onStatusChange?: (status: AutosaveStatus) => void
}

export interface AutosaveController<T> {
  readonly status: AutosaveStatus
  /** Buffers a change and (re)starts the debounce. */
  change(value: T): void
  /** Writes immediately — for field blur, editor close and navigation away. */
  flush(): Promise<AutosaveStatus>
  /** Manual retry after the backoff gave up. */
  retry(): Promise<AutosaveStatus>
  /** True while a change has not reached the database. Drives `beforeunload`. */
  hasUnsavedChanges(): boolean
  /** Stops pending timers. The dirty buffer is kept, not discarded. */
  dispose(): void
}

export function createAutosaveController<T>(options: AutosaveOptions<T>): AutosaveController<T> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const scheduler = options.scheduler ?? globalScheduler

  let status: AutosaveStatus = {
    state: 'IDLE',
    pendingChanges: false,
    error: null,
    failedAttempts: 0,
    willRetry: false,
  }
  let buffered: { value: T } | null = null
  let timer: unknown = null
  let inFlight: Promise<AutosaveStatus> | null = null
  let disposed = false

  const setStatus = (next: Partial<AutosaveStatus>) => {
    status = { ...status, ...next }
    options.onStatusChange?.(status)
  }

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.clearTimeout(timer)
      timer = null
    }
  }

  const write = async (): Promise<AutosaveStatus> => {
    const pending = buffered
    if (pending === null) {
      return status
    }
    setStatus({ state: 'SAVING' })
    try {
      await options.save(pending.value)
    } catch (cause) {
      const error = toPersistenceError(cause)
      const failedAttempts = status.failedAttempts + 1
      const delay = retryDelays[failedAttempts - 1]
      const willRetry = delay !== undefined && !disposed
      // The buffer is deliberately left in place: the change is still unsaved,
      // and dropping it here is how a "save failed" message ends up attached
      // to work that no longer exists anywhere.
      setStatus({ state: 'ERROR', error, failedAttempts, willRetry, pendingChanges: true })
      if (willRetry) {
        cancelTimer()
        timer = scheduler.setTimeout(() => {
          timer = null
          void run()
        }, delay)
      }
      return status
    }

    // Only a change that arrived *during* the write is still pending; the
    // value just committed is not.
    if (buffered === pending) {
      buffered = null
      setStatus({
        state: 'SAVED',
        pendingChanges: false,
        error: null,
        failedAttempts: 0,
        willRetry: false,
      })
      return status
    }

    setStatus({ error: null, failedAttempts: 0, willRetry: false })
    return write()
  }

  const run = (): Promise<AutosaveStatus> => {
    if (inFlight !== null) {
      return inFlight
    }
    const started = write().finally(() => {
      inFlight = null
    })
    inFlight = started
    return started
  }

  return {
    get status() {
      return status
    },
    change(value: T) {
      if (disposed) {
        return
      }
      buffered = { value }
      setStatus({ pendingChanges: true, state: status.state === 'ERROR' ? 'ERROR' : 'IDLE' })
      cancelTimer()
      timer = scheduler.setTimeout(() => {
        timer = null
        void run()
      }, debounceMs)
    },
    flush() {
      cancelTimer()
      return run()
    },
    retry() {
      cancelTimer()
      setStatus({ failedAttempts: 0 })
      return run()
    },
    hasUnsavedChanges() {
      return buffered !== null
    },
    dispose() {
      disposed = true
      cancelTimer()
    },
  }
}
