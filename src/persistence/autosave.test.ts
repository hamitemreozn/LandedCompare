import { describe, expect, it } from 'vitest'
import {
  createAutosaveController,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RETRY_DELAYS_MS,
  type AutosaveScheduler,
  type AutosaveStatus,
} from './autosave'
import { PersistenceError } from './errors'

/**
 * A controllable clock. Time only moves when a test says so, which is what
 * makes the debounce and the backoff assertable rather than a race.
 */
function createTestScheduler() {
  const pending = new Map<number, { callback: () => void; dueAt: number }>()
  let nextHandle = 1
  let now = 0

  const scheduler: AutosaveScheduler = {
    setTimeout(callback, delayMs) {
      const handle = nextHandle
      nextHandle += 1
      pending.set(handle, { callback, dueAt: now + delayMs })
      return handle
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
  }

  return {
    scheduler,
    get pendingCount() {
      return pending.size
    },
    async advance(ms: number) {
      now += ms
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)
      for (const [handle, timer] of due) {
        pending.delete(handle)
        timer.callback()
      }
      // Let the save promises that the callbacks started settle.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

interface Recorder {
  readonly saved: string[]
  save: (value: string) => Promise<void>
  failNext: (times: number) => void
  resolveAll: () => void
}

function createRecorder(): Recorder {
  const saved: string[] = []
  let failuresLeft = 0
  let hold: (() => void) | null = null

  return {
    saved,
    save(value: string) {
      if (failuresLeft > 0) {
        failuresLeft -= 1
        return Promise.reject(new PersistenceError('QUOTA_EXCEEDED', 'storage is full'))
      }
      if (hold !== null) {
        const release = hold
        return new Promise<void>((resolve) => {
          hold = () => {
            saved.push(value)
            resolve()
          }
          release()
        })
      }
      saved.push(value)
      return Promise.resolve()
    },
    failNext(times: number) {
      failuresLeft = times
    },
    resolveAll() {
      hold?.()
    },
  }
}

describe('debounce', () => {
  it('writes once after the last keystroke, not once per keystroke', async () => {
    const recorder = createRecorder()
    const clock = createTestScheduler()
    const controller = createAutosaveController({
      save: recorder.save,
      scheduler: clock.scheduler,
    })

    controller.change('T')
    controller.change('Tı')
    controller.change('Tıbbi')
    await clock.advance(DEFAULT_DEBOUNCE_MS - 1)
    expect(recorder.saved).toEqual([])

    await clock.advance(1)
    expect(recorder.saved).toEqual(['Tıbbi'])
    expect(controller.status.state).toBe('SAVED')
  })

  it('uses the 600 ms interval the persistence document specifies', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(600)
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([1000, 3000, 10000])
  })

  it('flushes immediately, without waiting for the debounce', async () => {
    const recorder = createRecorder()
    const clock = createTestScheduler()
    const controller = createAutosaveController({
      save: recorder.save,
      scheduler: clock.scheduler,
    })

    controller.change('leaving the field')
    await controller.flush()

    expect(recorder.saved).toEqual(['leaving the field'])
    expect(clock.pendingCount).toBe(0)
  })

  it('does nothing when there is nothing buffered', async () => {
    const recorder = createRecorder()
    const controller = createAutosaveController({
      save: recorder.save,
      scheduler: createTestScheduler().scheduler,
    })
    const status = await controller.flush()
    expect(recorder.saved).toEqual([])
    expect(status.state).toBe('IDLE')
  })

  it('starts no timer of its own — only a change does', () => {
    const clock = createTestScheduler()
    createAutosaveController({ save: createRecorder().save, scheduler: clock.scheduler })
    expect(clock.pendingCount).toBe(0)
  })
})

describe('save state', () => {
  it('never reports SAVED before the write has resolved', async () => {
    const states: AutosaveStatus['state'][] = []
    const releases: Array<() => void> = []
    const controller = createAutosaveController({
      save: () => new Promise<void>((resolve) => releases.push(resolve)),
      scheduler: createTestScheduler().scheduler,
      onStatusChange: (status) => states.push(status.state),
    })

    controller.change('value')
    const flushed = controller.flush()
    await Promise.resolve()

    expect(states).toEqual(['IDLE', 'SAVING'])
    expect(controller.status.state).toBe('SAVING')

    releases[0]?.()
    await flushed
    expect(controller.status.state).toBe('SAVED')
  })

  it('reports a failure instead of swallowing it, and keeps the dirty buffer', async () => {
    const recorder = createRecorder()
    const clock = createTestScheduler()
    const controller = createAutosaveController({
      save: recorder.save,
      scheduler: clock.scheduler,
    })

    recorder.failNext(1)
    controller.change('unsaved work')
    const status = await controller.flush()

    expect(status.state).toBe('ERROR')
    expect(status.error?.code).toBe('QUOTA_EXCEEDED')
    expect(controller.hasUnsavedChanges()).toBe(true)
    expect(recorder.saved).toEqual([])
  })

  it('retries with the documented backoff and clears the error on success', async () => {
    const recorder = createRecorder()
    const clock = createTestScheduler()
    const controller = createAutosaveController({
      save: recorder.save,
      scheduler: clock.scheduler,
    })

    recorder.failNext(2)
    controller.change('retry me')
    await controller.flush()
    expect(controller.status.failedAttempts).toBe(1)

    await clock.advance(1000)
    expect(controller.status.failedAttempts).toBe(2)
    expect(recorder.saved).toEqual([])

    await clock.advance(3000)
    expect(recorder.saved).toEqual(['retry me'])
    expect(controller.status.state).toBe('SAVED')
    expect(controller.status.error).toBeNull()
    expect(controller.hasUnsavedChanges()).toBe(false)
  })

  it('stops retrying after the backoff is exhausted and waits for a person', async () => {
    const recorder = createRecorder()
    const clock = createTestScheduler()
    const controller = createAutosaveController({
      save: recorder.save,
      scheduler: clock.scheduler,
    })

    recorder.failNext(10)
    controller.change('doomed')
    await controller.flush()
    await clock.advance(1000)
    await clock.advance(3000)
    await clock.advance(10000)

    expect(controller.status.state).toBe('ERROR')
    expect(controller.status.willRetry).toBe(false)
    expect(clock.pendingCount).toBe(0)
    // The error stays visible; it does not fade into a dismissed toast.
    expect(controller.status.error?.code).toBe('QUOTA_EXCEEDED')

    recorder.failNext(0)
    await controller.retry()
    expect(recorder.saved).toEqual(['doomed'])
    expect(controller.status.state).toBe('SAVED')
  })

  it('saves the newest value when a change arrives during a write', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const controller = createAutosaveController({
      save: (value: string) =>
        new Promise<void>((resolve) => {
          started.push(value)
          releases.push(resolve)
        }),
      scheduler: createTestScheduler().scheduler,
    })

    controller.change('first')
    const flushed = controller.flush()
    await Promise.resolve()
    expect(started).toEqual(['first'])

    // The user keeps typing while the first write is still in flight.
    controller.change('second')
    releases[0]?.()
    await Promise.resolve()
    await Promise.resolve()

    // The committed value is not the buffered one, so a second write follows
    // rather than the change being dropped as "already saved".
    expect(started).toEqual(['first', 'second'])
    releases[1]?.()
    await flushed

    expect(controller.hasUnsavedChanges()).toBe(false)
    expect(controller.status.state).toBe('SAVED')
  })

  it('keeps the buffer after dispose so nothing is silently discarded', async () => {
    const recorder = createRecorder()
    const clock = createTestScheduler()
    const controller = createAutosaveController({
      save: recorder.save,
      scheduler: clock.scheduler,
    })

    controller.change('half typed')
    controller.dispose()

    expect(clock.pendingCount).toBe(0)
    expect(controller.hasUnsavedChanges()).toBe(true)
    expect(recorder.saved).toEqual([])
  })
})
