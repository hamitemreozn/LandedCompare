/**
 * Application startup: the sequence that connects Phase 7's database and
 * Phase 8's recovery layer to a running product.
 *
 * Both of those phases deliberately stopped short of this file. Their
 * documents say so in as many words — "wiring `ensurePreMigrationSnapshot()`
 * and `runSnapshotMaintenance()` into application startup is Phase 9's,
 * because the decision on failure is user-facing" — and an independent audit
 * confirmed the mechanisms worked and had no production caller. This is that
 * caller.
 *
 * ## The order, and why each step is where it is
 *
 * ```text
 *   1  ask for durable storage        ← best effort, never fatal
 *   2  PRE_MIGRATION protection       ← BEFORE the database is opened
 *   3  open the database              ← the migration runs here, or not at all
 *   4  snapshot maintenance           ← needs an open connection
 *   5  read external-backup state     ← from the meta the open produced
 * ```
 *
 * Step 2 is the one with a real constraint behind it, and it is the reason
 * this sequence cannot be folded into `openDatabase()`. A `PRE_MIGRATION`
 * snapshot written inside `upgradeneeded` is part of the version-change
 * transaction, so a migration that fails rolls the snapshot back with it — it
 * vanishes in exactly the case it exists for. `ensurePreMigrationSnapshot()`
 * therefore opens the database *at the version it is already at*, snapshots,
 * and closes, and only then does step 3 trigger the upgrade. Steps 2 and 3
 * cannot be reordered or run concurrently.
 *
 * Steps 1, 4 and 5 are not allowed to stop the application. A browser that
 * declines a persistence grant, a snapshot that will not fit, a backup
 * timestamp that has never been written — none of those mean the working data
 * is unusable, and refusing to start over them would be a worse outcome than
 * the problem. They are reported as warnings the shell surfaces.
 *
 * Step 2 and step 3 *are* allowed to stop it, and do.
 *
 * ## No string in this file is user-facing
 *
 * Every failure leaves here as a machine-readable code, exactly as the
 * persistence and backup layers produce them. `src/app/bootText.ts` maps codes
 * to translation keys and `src/i18n` holds the Turkish and English; a
 * `DOMException`'s browser-dependent message text never reaches a screen.
 */

import {
  ensurePreMigrationSnapshot,
  externalBackupStatus,
  isBackupError,
  runSnapshotMaintenance,
  type ExternalBackupStatus,
  type PreMigrationSnapshotResult,
  type SnapshotMaintenanceResult,
} from '../backup'
import {
  isPersistenceError,
  isStoragePersisted,
  openDatabase,
  requestPersistentStorage,
  type Database,
  type PersistenceGrant,
} from '../persistence'

export type BootPhase =
  /** The sequence is running. Nothing business-related may be rendered yet. */
  | 'INITIALIZING'
  /** The database is open and every service the shell needs exists. */
  | 'READY'
  /**
   * A migration was needed and could not be protected. The database was **not**
   * opened, so no upgrade has been attempted and the stored data is exactly as
   * it was. This is a distinct state from `FAILED` because the remedy is
   * different: nothing is broken, the application is refusing to risk it.
   */
  | 'MIGRATION_BLOCKED'
  /** The database could not be opened. There is no usable local data. */
  | 'FAILED'

/** A non-fatal problem worth telling the user about. */
export type BootWarningCode =
  /** The daily snapshot or retention pass did not complete. */
  | 'SNAPSHOT_MAINTENANCE_FAILED'
  /** Snapshots still exceed their storage ceiling after pruning. */
  | 'SNAPSHOT_STORAGE_OVER_CEILING'
  /** The browser did not grant durable storage, so the origin may be evicted. */
  | 'STORAGE_NOT_PERSISTED'

export interface BootWarning {
  readonly code: BootWarningCode
  /** A `PersistenceErrorCode` or `BackupErrorCode`, when one caused this. */
  readonly cause?: string
}

export type BootFailureReason =
  /** The stored version could not be read, so an upgrade cannot be protected. */
  | 'PRE_MIGRATION_VERSION_UNKNOWN'
  /** A migration was due and the protective snapshot could not be written. */
  | 'PRE_MIGRATION_SNAPSHOT_FAILED'
  /** `openDatabase()` refused or failed. `code` carries its reason. */
  | 'DATABASE_OPEN_FAILED'

export interface BootFailure {
  readonly reason: BootFailureReason
  /** The originating `PersistenceErrorCode` / `BackupErrorCode`, if any. */
  readonly code?: string
  /** Already-safe context — never raw `DOMException` text. */
  readonly details?: Readonly<Record<string, string | number | boolean>>
}

export interface BootSuccess {
  readonly phase: 'READY'
  readonly database: Database
  readonly preMigration: PreMigrationSnapshotResult
  readonly maintenance?: SnapshotMaintenanceResult
  readonly backup: ExternalBackupStatus
  readonly storage: PersistenceGrant
  readonly warnings: readonly BootWarning[]
}

export interface BootStopped {
  readonly phase: 'MIGRATION_BLOCKED' | 'FAILED'
  readonly failure: BootFailure
}

export type BootResult = BootSuccess | BootStopped

export interface BootstrapOptions {
  /** Overridden only by tests; production always uses the single database. */
  readonly databaseName?: string
  readonly indexedDBFactory?: IDBFactory
  readonly now?: () => string
  /** Skips the `navigator.storage` request. Tests, and nothing else. */
  readonly requestStorage?: boolean
}

function errorCode(cause: unknown): string | undefined {
  if (isPersistenceError(cause) || isBackupError(cause)) {
    return cause.code
  }
  return undefined
}

/**
 * Asks for durable storage once, and only when it is not already granted.
 *
 * Calling `persist()` unconditionally on every start is the nagging pattern
 * the canonical document warns against, and it is also pointless: once an
 * origin is persisted the answer never changes. A refusal is a normal outcome
 * — `requestPersistentStorage` already reports it rather than throwing — and
 * changes nothing about whether the application runs. It changes only how
 * exposed the data is, which is a thing to say, not a thing to fail on.
 */
async function ensureDurableStorage(): Promise<PersistenceGrant> {
  const current = await isStoragePersisted()
  if (current === 'PERSISTED' || current === 'UNSUPPORTED') {
    return current
  }
  return requestPersistentStorage()
}

/**
 * Runs the startup sequence and reports where it got to.
 *
 * Never throws for an expected failure: the caller is a React tree that has to
 * render *something*, and an exception would make "the database is one version
 * too new" indistinguishable from a bug in this function. Unexpected
 * throwables still propagate — they are bugs, and swallowing them into a
 * generic error screen is how a bug becomes a support ticket about IndexedDB.
 */
export async function bootstrapApplication(options: BootstrapOptions = {}): Promise<BootResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const warnings: BootWarning[] = []

  const storage =
    options.requestStorage === false ? 'UNSUPPORTED' : await ensureDurableStorage()
  if (storage === 'NOT_PERSISTED') {
    warnings.push({ code: 'STORAGE_NOT_PERSISTED' })
  }

  // ── 2. PRE_MIGRATION protection, before anything can trigger an upgrade ──
  let preMigration: PreMigrationSnapshotResult
  try {
    preMigration = await ensurePreMigrationSnapshot({
      name: options.databaseName,
      indexedDBFactory: options.indexedDBFactory,
      now,
    })
  } catch (cause) {
    // A migration was due and the snapshot could not be written. Opening now
    // would run that migration with no way back, so it is not attempted. There
    // is deliberately no override: a button labelled "upgrade anyway" is a
    // button that destroys data, and the honest remedy is free space or a
    // different browser profile, not a confirmation dialog.
    return {
      phase: 'MIGRATION_BLOCKED',
      failure: { reason: 'PRE_MIGRATION_SNAPSHOT_FAILED', code: errorCode(cause) },
    }
  }

  if (preMigration.outcome === 'VERSION_UNKNOWN') {
    // The browser does not implement `indexedDB.databases()`, so "no database"
    // and "a database one version behind" are the same answer here. Treating
    // that as "nothing to protect" is the guess the canonical document
    // explicitly refuses: it is the guess that silently migrates real data
    // with no snapshot behind it.
    return {
      phase: 'MIGRATION_BLOCKED',
      failure: {
        reason: 'PRE_MIGRATION_VERSION_UNKNOWN',
        details: { targetVersion: preMigration.targetVersion },
      },
    }
  }

  // ── 3. Open, which is where a migration actually runs ──
  let database: Database
  try {
    database = await openDatabase({
      name: options.databaseName,
      indexedDBFactory: options.indexedDBFactory,
    })
  } catch (cause) {
    if (!isPersistenceError(cause)) {
      throw cause
    }
    return {
      phase: 'FAILED',
      failure: {
        reason: 'DATABASE_OPEN_FAILED',
        code: cause.code,
        details: cause.details,
      },
    }
  }

  // ── 4. Snapshot maintenance: today's snapshot, then retention ──
  // Housekeeping over a database that is already open and already correct. A
  // failure here does not make the working data unusable, so it is a warning
  // rather than a reason to refuse to start — but it is not swallowed either,
  // because "snapshots stopped being taken" is exactly the kind of silence
  // that is discovered on the day one is needed.
  let maintenance: SnapshotMaintenanceResult | undefined
  try {
    maintenance = await runSnapshotMaintenance(database, { now })
    if (maintenance.retention.overCeiling) {
      warnings.push({ code: 'SNAPSHOT_STORAGE_OVER_CEILING' })
    }
  } catch (cause) {
    warnings.push({ code: 'SNAPSHOT_MAINTENANCE_FAILED', cause: errorCode(cause) })
  }

  // ── 5. External backup freshness, as state ──
  const backup = externalBackupStatus(database.meta, now())

  return { phase: 'READY', database, preMigration, maintenance, backup, storage, warnings }
}
