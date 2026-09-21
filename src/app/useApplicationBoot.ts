/**
 * Drives the startup sequence from React, and owns the two things that only
 * make sense once it has succeeded: the open connection, and the multi-tab
 * advisory.
 *
 * ## The database is a resource, not a value
 *
 * An open IndexedDB connection has to be closed, and it has to be closed even
 * when the boot that produced it was abandoned half-way. React 19's
 * `StrictMode` mounts, unmounts and remounts every effect in development
 * precisely to find code that forgets this. So the effect below tracks
 * cancellation explicitly and closes a connection that arrives after its
 * effect has been torn down — otherwise the second mount would open a second
 * connection while the first still held the database, and the next schema
 * upgrade would find itself blocked by the application's own ghost.
 */

import { useCallback, useEffect, useState } from 'react'
import { createTabAdvisory } from '../persistence'
import { bootstrapApplication, type BootFailure, type BootstrapOptions } from './bootstrap'
import type { AppRuntime } from './runtime'

export type BootState =
  | { readonly phase: 'INITIALIZING' }
  | { readonly phase: 'READY'; readonly runtime: AppRuntime }
  | {
      readonly phase: 'MIGRATION_BLOCKED' | 'FAILED'
      readonly failure: BootFailure
    }

export function useApplicationBoot(options: BootstrapOptions = {}): {
  state: BootState
  retry: () => void
} {
  const [state, setState] = useState<BootState>({ phase: 'INITIALIZING' })
  const [attempt, setAttempt] = useState(0)

  const { databaseName, indexedDBFactory, now, requestStorage } = options

  useEffect(() => {
    let cancelled = false
    let close: (() => void) | undefined

    setState({ phase: 'INITIALIZING' })

    void (async () => {
      const result = await bootstrapApplication({
        databaseName,
        indexedDBFactory,
        now,
        requestStorage,
      })

      if (result.phase !== 'READY') {
        if (!cancelled) {
          setState({ phase: result.phase, failure: result.failure })
        }
        return
      }

      if (cancelled) {
        // The effect was torn down while the database was opening. Nothing
        // will ever close this connection if we do not.
        result.database.close()
        return
      }

      // The advisory is an announcement, not a lock: it tells a newly opened
      // tab that another one exists so it can warn, rather than waiting for
      // the stale-write check to catch the conflict after an edit is lost.
      // No leader election, no locking — `docs/LOCAL_PERSISTENCE_AND_BACKUP.md`
      // §5 is explicit that detecting the situation is the goal and resolving
      // it is the user's job.
      const advisory = createTabAdvisory({
        onOtherTab: () => {
          setState((current) =>
            current.phase === 'READY'
              ? { phase: 'READY', runtime: { ...current.runtime, multipleTabs: true } }
              : current,
          )
        },
      })

      close = () => {
        advisory.close()
        result.database.close()
      }

      setState({
        phase: 'READY',
        runtime: {
          database: result.database,
          backup: result.backup,
          maintenance: result.maintenance,
          storage: result.storage,
          warnings: result.warnings,
          multipleTabs: false,
        },
      })

      advisory.announce()
    })()

    return () => {
      cancelled = true
      close?.()
    }
  }, [databaseName, indexedDBFactory, now, requestStorage, attempt])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  return { state, retry }
}
