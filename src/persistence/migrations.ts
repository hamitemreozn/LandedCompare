/**
 * The numbered migration runner.
 *
 * Rules (canonical: `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §4):
 *
 * 1. Migrations are ordered, numbered steps applied in sequence. There is no
 *    "inspect the data and adapt" path — inferring a schema from its contents
 *    is how corrupt data gets silently accepted.
 * 2. A migration reads the previous shape explicitly and writes the new one. It
 *    never assumes old data already matches the current model.
 * 3. Every step runs inside IndexedDB's `upgradeneeded` transaction, which
 *    aborts as a unit. A failed migration therefore leaves the database at its
 *    previous version with its previous data.
 * 4. A released migration is frozen. Later shape changes are the next number,
 *    not an edit to a shipped step.
 *
 * ### The snapshot that covers the other failure mode
 *
 * Rule 3 of the canonical document also requires a `PRE_MIGRATION` snapshot
 * written before the upgrade begins. The IndexedDB-level guarantee above is
 * real and tested: a migration that throws rolls back completely. What it does
 * not cover is a migration that commits successfully but is logically wrong,
 * and no transaction can — the transaction did what it was told. That cover is
 * `ensurePreMigrationSnapshot()` in `src/backup/preMigration.ts`, which opens
 * the database at the version it is already at, snapshots, and closes, so the
 * copy is committed *outside* the upgrade it protects.
 */

import { REMOVED_BOOLEAN_INDEXES } from './schema'

export interface MigrationContext {
  readonly oldVersion: number
  readonly database: IDBDatabase
  readonly transaction: IDBTransaction
  /**
   * Reads every record of a store and writes back whatever `transform`
   * returns. Anything `transform` throws aborts the entire upgrade.
   */
  rewriteStore(store: string, transform: (record: unknown) => unknown): void
  /** Writes one record. For seeding a store a migration introduces. */
  putRecord(store: string, record: unknown): void
  /** Removes a store that no longer exists in the current schema. */
  deleteStore(store: string): void
  /**
   * Removes an index that no longer exists in the current schema.
   *
   * Schema surgery, not data surgery: it touches no record, so it issues no
   * request and completes synchronously inside the `upgradeneeded`
   * transaction. An abort restores the index along with everything else,
   * because index deletion is part of the version-change transaction like any
   * other schema change.
   *
   * "Ensure this index is gone" means the same thing whether it runs once or
   * twice, so an index that is already absent is not an error — the same
   * reasoning `createMissingStores` applies in the other direction. A data
   * migration does not get that latitude, which is why it is numbered and
   * applied exactly once instead.
   */
  deleteIndex(store: string, index: string): void
}

export interface Migration {
  /** The `schemaVersion` this step produces. A step from `to - 1` to `to`. */
  readonly to: number
  /** Developer-facing description. Not a user-facing string. */
  readonly description: string
  /**
   * Synchronous on purpose. Awaiting a non-IndexedDB promise inside an upgrade
   * transaction lets it close mid-migration; chain further work through the
   * helpers on `MigrationContext` instead.
   */
  readonly migrate: (context: MigrationContext) => void
}

/**
 * `v1 → v2`: drop the three `active` indexes a boolean key can never populate.
 *
 * The defect they carried is described in full on `REMOVED_BOOLEAN_INDEXES` in
 * `schema.ts`. In one line: a boolean is not a valid IndexedDB key, so those
 * indexes silently contained **no entries at all**, and a query through one
 * would have reported an empty catalogue over a populated store.
 *
 * ## Why this step touches no record
 *
 * Nothing about the stored *shape* changes. `active: boolean` was and remains
 * the canonical field on every product, supplier and customer; what is removed
 * is an index that never indexed anything. So this migration rewrites no
 * record, and every existing row survives the upgrade byte for byte — which is
 * the property its tests assert rather than assume.
 *
 * It is still a real `schemaVersion` bump: the set of indexes is part of the
 * stored schema, an upgrade is the only place IndexedDB permits the change, and
 * a v1 database left alone would keep three indexes this build no longer
 * declares. Pretending v1 never existed by silently editing
 * `STORE_DEFINITIONS` would leave exactly that — stale indexes in every
 * already-created database, visible to nothing that would ever correct them.
 */
const dropUnusableActiveIndexes: Migration = {
  to: 2,
  description: 'products/suppliers/customers: drop the unusable boolean "active" indexes',
  migrate: (context) => {
    for (const { store, index } of REMOVED_BOOLEAN_INDEXES) {
      context.deleteIndex(store, index)
    }
  },
}

/**
 * The released migration chain.
 *
 * Frozen once released (rule 4): a later shape change is the next number, never
 * an edit to a shipped step — a shipped step is the only thing that can read
 * the databases already out there.
 */
export const MIGRATIONS: readonly Migration[] = [dropUnusableActiveIndexes]

/**
 * Checks that a chain is usable before anything runs it: sorted, no duplicate
 * or skipped numbers, nothing above the schema version it claims to reach, and
 * no step at or below 1 (version 1 is store creation, not a migration).
 */
export function assertMigrationChain(migrations: readonly Migration[], schemaVersion: number): void {
  let expected = 2
  for (const migration of migrations) {
    if (migration.to !== expected) {
      throw new Error(
        `Migration chain is not contiguous: expected a step to version ${expected}, found ${migration.to}`,
      )
    }
    expected += 1
  }
  const highest = migrations.at(-1)?.to ?? 1
  if (highest > schemaVersion) {
    throw new Error(
      `Migration chain reaches version ${highest}, beyond schemaVersion ${schemaVersion}`,
    )
  }
}

/** The steps needed to move a database from `oldVersion` to `newVersion`. */
export function selectMigrations(
  migrations: readonly Migration[],
  oldVersion: number,
  newVersion: number,
): readonly Migration[] {
  return migrations.filter((migration) => migration.to > oldVersion && migration.to <= newVersion)
}

/**
 * Tracks the requests one migration step has outstanding, so the next step
 * does not start until the previous one has finished writing.
 *
 * This is not a nicety. A migration's work is issued as IndexedDB requests and
 * completes asynchronously, so two steps started back to back would run their
 * cursors over the same store *concurrently*: `v2 → v3` would read the records
 * `v1 → v2` had not rewritten yet, and the second step's writes would land on
 * top of the first step's, silently undoing them. A chain has to be a chain.
 */
interface StepTracker {
  begin(): void
  end(): void
  /** Called once `migrate()` has returned, i.e. all work has been issued. */
  declareIssued(): void
}

function createStepTracker(onIdle: () => void): StepTracker {
  let outstanding = 0
  let issued = false
  let finished = false

  const settleIfIdle = () => {
    if (issued && outstanding === 0 && !finished) {
      finished = true
      onIdle()
    }
  }

  return {
    begin: () => {
      outstanding += 1
    },
    end: () => {
      outstanding -= 1
      settleIfIdle()
    },
    declareIssued: () => {
      issued = true
      settleIfIdle()
    },
  }
}

function createContext(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
  tracker: StepTracker,
  fail: (cause: unknown) => void,
): MigrationContext {
  return {
    oldVersion,
    database,
    transaction,
    rewriteStore(store, transform) {
      tracker.begin()
      const request = transaction.objectStore(store).openCursor()
      request.onerror = () => {
        fail(request.error)
        tracker.end()
      }
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor === null) {
          tracker.end()
          return
        }
        try {
          cursor.update(transform(cursor.value))
          cursor.continue()
        } catch (cause) {
          // A throw from inside a request handler is reported to the global
          // scope rather than surfacing to the caller, so the failure is
          // captured and the transaction aborted explicitly instead of relying
          // on the implementation to do it.
          fail(cause)
          tracker.end()
        }
      }
    },
    putRecord(store, record) {
      tracker.begin()
      const request = transaction.objectStore(store).put(record)
      request.onsuccess = () => tracker.end()
      request.onerror = () => {
        fail(request.error)
        tracker.end()
      }
    },
    deleteStore(store) {
      if (database.objectStoreNames.contains(store)) {
        database.deleteObjectStore(store)
      }
    },
    deleteIndex(store, index) {
      if (!database.objectStoreNames.contains(store)) {
        return
      }
      const objectStore = transaction.objectStore(store)
      if (objectStore.indexNames.contains(index)) {
        objectStore.deleteIndex(index)
      }
    },
  }
}

export interface MigrationFailure {
  readonly migration: Migration
  readonly cause: unknown
}

/**
 * The live state of a migration run.
 *
 * Mutable, and read *after* the open request settles: a step's work finishes in
 * a request callback long after `runMigrations` has returned, so a snapshot
 * taken at return time would always report success.
 */
export interface MigrationRunState {
  failure: MigrationFailure | null
  readonly applied: number[]
}

/**
 * Applies the selected steps, in order, inside an already-open upgrade
 * transaction.
 *
 * Returns state rather than throwing, because this runs inside an
 * `upgradeneeded` handler where a thrown error is reported to the global scope
 * instead of to the caller. The opener reads the state once the open request
 * settles and turns a failure into a `MIGRATION_FAILED` `PersistenceError`.
 */
export function runMigrations(options: {
  database: IDBDatabase
  transaction: IDBTransaction
  migrations: readonly Migration[]
  oldVersion: number
  newVersion: number
}): MigrationRunState {
  const { database, transaction, migrations, oldVersion, newVersion } = options
  const steps = selectMigrations(migrations, oldVersion, newVersion)
  const state: MigrationRunState = { failure: null, applied: [] }

  const runStep = (index: number): void => {
    if (state.failure !== null || index >= steps.length) {
      return
    }
    const migration = steps[index]!

    const fail = (cause: unknown) => {
      if (state.failure !== null) {
        return
      }
      state.failure = { migration, cause }
      try {
        transaction.abort()
      } catch {
        // Already aborting.
      }
    }

    const tracker = createStepTracker(() => {
      if (state.failure === null) {
        state.applied.push(migration.to)
        runStep(index + 1)
      }
    })

    try {
      migration.migrate(createContext(database, transaction, oldVersion, tracker, fail))
      tracker.declareIssued()
    } catch (cause) {
      fail(cause)
    }
  }

  runStep(0)
  return state
}
