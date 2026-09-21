/**
 * The application runtime: what a screen is allowed to know about storage.
 *
 * Exactly one thing crosses this boundary — the `Database` handle — and it
 * exposes only `read(stores, …)` and `write(stores, …)`. No component receives
 * an `IDBDatabase`, opens a transaction, or sees a `TransactionScope`; a
 * screen calls a feature service, and the service calls a typed store. The
 * dependency direction is one-way and this file is the only place it is
 * established:
 *
 * ```text
 *   screens → feature services → persistence stores → IndexedDB
 * ```
 *
 * Alongside it travels the state the boot sequence produced — backup
 * freshness, snapshot maintenance, the storage grant — because the shell has
 * to be able to say those things and re-deriving them per screen would mean
 * asking the browser the same question four times.
 *
 * ## Why a context and not a store library
 *
 * The runtime is written once, at boot, and never changes afterwards. That is
 * the shape a context is for. Redux, Zustand and friends solve the problem of
 * *frequently changing shared state*, which this is the opposite of — and the
 * durable state that does change lives in IndexedDB, which is the source of
 * truth by design. A second in-memory copy of the catalogue, kept in step by
 * hand, is precisely the duplicated state this architecture keeps refusing.
 */

import { createContext, useContext } from 'react'
import type { ExternalBackupStatus, SnapshotMaintenanceResult } from '../backup'
import type { Database, PersistenceGrant } from '../persistence'
import type { BootWarning } from './bootstrap'

export interface AppRuntime {
  readonly database: Database
  readonly backup: ExternalBackupStatus
  readonly maintenance?: SnapshotMaintenanceResult
  readonly storage: PersistenceGrant
  readonly warnings: readonly BootWarning[]
  /** True once another tab has announced itself on this database. */
  readonly multipleTabs: boolean
}

/**
 * Exported rather than wrapped in a provider component, so this module stays
 * free of JSX and can be imported by hooks and services without dragging a
 * component into their dependency graph. `App.tsx` renders the provider.
 */
export const AppRuntimeContext = createContext<AppRuntime | null>(null)

/**
 * The runtime, or a thrown error.
 *
 * Returning `null` for "not booted yet" would push the check into every
 * screen and make the compiler accept a component that renders business data
 * before the database exists. The whole point of the boot gate is that a
 * screen below it cannot be in that situation, so reaching this hook outside
 * the provider is a wiring bug, not a state to handle.
 */
export function useAppRuntime(): AppRuntime {
  const runtime = useContext(AppRuntimeContext)
  if (runtime === null) {
    throw new Error('useAppRuntime was called outside AppRuntimeProvider')
  }
  return runtime
}
