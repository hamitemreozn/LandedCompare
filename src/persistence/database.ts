/**
 * Database lifecycle: opening, upgrading, refusing, closing.
 *
 * This is the only file that calls `indexedDB.open`. Everything above it works
 * through the `Database` handle, which exposes exactly two things —
 * `read(stores, …)` and `write(stores, …)` — so an operation cannot
 * accidentally run outside a transaction, and no feature, domain or React
 * module ever sees an `IDBDatabase`.
 */

import { PersistenceError, classifyRequestFailure, toPersistenceError } from './errors'
import { runInTransaction, type TransactionMode, type TransactionScope } from './idb'
import {
  MIGRATIONS,
  assertMigrationChain,
  runMigrations,
  type Migration,
  type MigrationRunState,
} from './migrations'
import { META_KEY, parseMetaRecord, type MetaRecord } from './records/meta'
import {
  APP_VERSION,
  DATABASE_NAME,
  SCHEMA_VERSION,
  createMissingStores,
  type StoreName,
} from './schema'

export interface Database {
  readonly name: string
  readonly schemaVersion: number
  readonly meta: MetaRecord
  read<T>(stores: readonly StoreName[], work: (scope: TransactionScope) => Promise<T> | T): Promise<T>
  write<T>(stores: readonly StoreName[], work: (scope: TransactionScope) => Promise<T> | T): Promise<T>
  close(): void
}

export interface OpenDatabaseOptions {
  /** Defaults to the single production database name. Overridden only by tests. */
  readonly name?: string
  readonly schemaVersion?: number
  readonly migrations?: readonly Migration[]
  readonly appVersion?: string
  /** Injectable so tests can drive a fake factory without touching globals. */
  readonly indexedDBFactory?: IDBFactory
  readonly now?: () => string
  readonly generateId?: () => string
}

function defaultFactory(factory: IDBFactory | undefined): IDBFactory {
  const resolved = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (resolved === undefined) {
    throw new PersistenceError(
      'ENVIRONMENT_UNSUPPORTED',
      'IndexedDB is not available in this environment',
    )
  }
  return resolved
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * Writes the `meta` record inside the upgrade transaction, so a database is
 * never observable without one.
 *
 * `installId` and `createdAt` are preserved across upgrades — they identify the
 * installation, not the schema — while `schemaVersion` and `appVersion` are
 * restamped. If the migration chain aborts, this write rolls back with it and
 * `meta` still describes the old version, which is the truth.
 */
function stampMeta(
  transaction: IDBTransaction,
  options: { schemaVersion: number; appVersion: string; now: () => string; generateId: () => string },
): void {
  const store = transaction.objectStore('meta')
  const request = store.get(META_KEY)
  request.onsuccess = () => {
    const existing: unknown = request.result
    const record: MetaRecord = {
      key: META_KEY,
      schemaVersion: options.schemaVersion,
      appVersion: options.appVersion,
      installId: readStringField(existing, 'installId') ?? options.generateId(),
      createdAt: readStringField(existing, 'createdAt') ?? options.now(),
    }
    const lastExternalBackupAt = readStringField(existing, 'lastExternalBackupAt')
    store.put(lastExternalBackupAt === undefined ? record : { ...record, lastExternalBackupAt })
  }
}

/**
 * Refuses a database this build cannot safely touch, **before** opening it.
 *
 * IndexedDB cannot downgrade, and an older build writing into a newer schema
 * corrupts it — silently, because the older build has no idea what the fields
 * it is dropping meant. `databases()` is not universally available, so the
 * `VersionError` produced by `open()` is handled as well; this path exists
 * because it can name the version it found, which a `VersionError` cannot.
 */
async function assertNotNewerThanSupported(
  factory: IDBFactory,
  name: string,
  schemaVersion: number,
): Promise<void> {
  const list = (factory as { databases?: () => Promise<IDBDatabaseInfo[]> }).databases
  if (typeof list !== 'function') {
    return
  }
  let entries: IDBDatabaseInfo[]
  try {
    entries = await list.call(factory)
  } catch {
    // Enumeration is a convenience, not a gate. `open()` still refuses.
    return
  }
  const existing = entries.find((entry) => entry.name === name)
  if (existing?.version !== undefined && existing.version > schemaVersion) {
    throw new PersistenceError(
      'SCHEMA_VERSION_TOO_NEW',
      'The stored database was written by a newer version of this application',
      { details: { storedVersion: existing.version, supportedVersion: schemaVersion } },
    )
  }
}

function openConnection(options: {
  factory: IDBFactory
  name: string
  schemaVersion: number
  migrations: readonly Migration[]
  appVersion: string
  now: () => string
  generateId: () => string
}): Promise<IDBDatabase> {
  const { factory, name, schemaVersion, migrations } = options

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = factory.open(name, schemaVersion)
    } catch (cause) {
      reject(toPersistenceError(cause, { database: name }))
      return
    }

    let migrationState: MigrationRunState | null = null
    let upgradeFailure: { targetVersion: number; description: string; cause: unknown } | null = null

    request.onupgradeneeded = (event) => {
      const database = request.result
      const transaction = request.transaction
      if (transaction === null) {
        return
      }
      const oldVersion = event.oldVersion

      try {
        createMissingStores(database, transaction)
        stampMeta(transaction, {
          schemaVersion,
          appVersion: options.appVersion,
          now: options.now,
          generateId: options.generateId,
        })
      } catch (cause) {
        upgradeFailure = { targetVersion: schemaVersion, description: 'create stores', cause }
        try {
          transaction.abort()
        } catch {
          // Already aborting.
        }
        return
      }

      // A brand-new database (`oldVersion === 0`) has no data to migrate: the
      // stores were just created at their current shape. Running the chain
      // over empty stores would be busy-work that pretends a history existed.
      if (oldVersion > 0) {
        migrationState = runMigrations({
          database,
          transaction,
          migrations,
          oldVersion,
          newVersion: schemaVersion,
        })
      }
    }

    request.onblocked = () => {
      reject(
        new PersistenceError(
          'DATABASE_UPGRADE_BLOCKED',
          'Another tab is holding this database open and is blocking the upgrade',
          { details: { database: name, requestedVersion: schemaVersion } },
        ),
      )
    }

    request.onerror = () => {
      const migrationFailure = migrationState?.failure
      const failure =
        upgradeFailure ??
        (migrationFailure
          ? {
              targetVersion: migrationFailure.migration.to,
              description: migrationFailure.migration.description,
              cause: migrationFailure.cause,
            }
          : null)
      if (failure !== null) {
        reject(
          new PersistenceError(
            'MIGRATION_FAILED',
            `Upgrade to schemaVersion ${failure.targetVersion} failed; the database is unchanged`,
            {
              details: { targetVersion: failure.targetVersion, description: failure.description },
              cause: failure.cause,
            },
          ),
        )
        return
      }
      const cause = request.error
      const code = classifyRequestFailure(cause)
      if (code === 'SCHEMA_VERSION_TOO_NEW') {
        reject(
          new PersistenceError(
            'SCHEMA_VERSION_TOO_NEW',
            'The stored database was written by a newer version of this application',
            { details: { supportedVersion: schemaVersion }, cause },
          ),
        )
        return
      }
      reject(
        new PersistenceError('DATABASE_OPEN_FAILED', 'Could not open the local database', {
          details: { database: name, requestedVersion: schemaVersion },
          cause,
        }),
      )
    }

    request.onsuccess = () => {
      resolve(request.result)
    }
  })
}

/**
 * The stored `meta` record must describe the database that was just opened.
 *
 * A mismatch means something other than this code path wrote the database — a
 * hand-edit, a partially applied change, an unrelated database occupying the
 * name. The connection is closed rather than used: continuing would mean
 * writing current-shape records into a store whose contents are unexplained.
 */
function assertSchemaVersionConsistency(meta: MetaRecord, connection: IDBDatabase, expected: number): void {
  if (meta.schemaVersion > expected) {
    throw new PersistenceError(
      'SCHEMA_VERSION_TOO_NEW',
      'The stored data declares a newer schema version than this application supports',
      { details: { storedVersion: meta.schemaVersion, supportedVersion: expected } },
    )
  }
  if (meta.schemaVersion !== expected || connection.version !== expected) {
    throw new PersistenceError(
      'SCHEMA_METADATA_INVALID',
      'The stored schema version does not match the database version',
      {
        details: {
          storedVersion: meta.schemaVersion,
          databaseVersion: connection.version,
          supportedVersion: expected,
        },
      },
    )
  }
}

export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<Database> {
  const name = options.name ?? DATABASE_NAME
  const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION
  const migrations = options.migrations ?? MIGRATIONS
  const appVersion = options.appVersion ?? APP_VERSION
  const now = options.now ?? (() => new Date().toISOString())
  const generateId = options.generateId ?? (() => crypto.randomUUID())

  const factory = defaultFactory(options.indexedDBFactory)
  assertMigrationChain(migrations, schemaVersion)
  await assertNotNewerThanSupported(factory, name, schemaVersion)

  const connection = await openConnection({
    factory,
    name,
    schemaVersion,
    migrations,
    appVersion,
    now,
    generateId,
  })

  // Another tab upgrading the schema must not be blocked by this connection.
  // Closing here is what turns "blocked forever" into "the other tab wins and
  // this one reloads"; the UI reacts to the close, it is not hidden from it.
  connection.onversionchange = () => connection.close()

  let meta: MetaRecord
  try {
    const stored = await runInTransaction(connection, ['meta'], 'readonly', (scope) =>
      scope.get<unknown>('meta', META_KEY),
    )
    if (stored === undefined) {
      throw new PersistenceError('SCHEMA_METADATA_INVALID', 'The database has no meta record', {
        details: { database: name },
      })
    }
    meta = parseMetaRecord(stored)
    assertSchemaVersionConsistency(meta, connection, schemaVersion)
  } catch (cause) {
    connection.close()
    throw toPersistenceError(cause, { database: name })
  }

  const run = <T>(
    stores: readonly StoreName[],
    mode: TransactionMode,
    work: (scope: TransactionScope) => Promise<T> | T,
  ): Promise<T> => runInTransaction(connection, stores, mode, work)

  return {
    name,
    schemaVersion,
    meta,
    read: (stores, work) => run(stores, 'readonly', work),
    write: (stores, work) => run(stores, 'readwrite', work),
    close: () => connection.close(),
  }
}

/**
 * Deletes a database outright.
 *
 * Guarded because "delete everything" is one typo away from the pilot's only
 * copy of its data, and before Phase 8 there is no backup to restore from. The
 * production database requires an explicit confirmation token that no test and
 * no convenience path will produce by accident; test databases (which carry
 * their own generated names) delete freely.
 */
export async function deleteDatabase(
  name: string,
  options: { confirm?: 'DELETE_PRODUCTION_DATABASE'; indexedDBFactory?: IDBFactory } = {},
): Promise<void> {
  if (name === DATABASE_NAME && options.confirm !== 'DELETE_PRODUCTION_DATABASE') {
    throw new PersistenceError(
      'DESTRUCTIVE_OPERATION_REFUSED',
      'Refusing to delete the production database without an explicit confirmation token',
      { details: { database: name } },
    )
  }
  const factory = defaultFactory(options.indexedDBFactory)
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onblocked = () => resolve()
    request.onerror = () =>
      reject(
        new PersistenceError('DATABASE_OPEN_FAILED', 'Could not delete the local database', {
          details: { database: name },
          cause: request.error,
        }),
      )
  })
}
