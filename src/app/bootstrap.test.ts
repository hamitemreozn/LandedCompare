/**
 * The startup sequence.
 *
 * These are the tests that exist because an independent audit of Phase 8
 * found the recovery mechanisms working and **not called by anything**. Each
 * one asserts a connection, not a mechanism: the mechanisms already have their
 * own suites in `src/persistence` and `src/backup`.
 */

import { describe, expect, it } from 'vitest'
import { listSnapshots } from '../backup/snapshots'
import { markExternalBackupCompleted } from '../backup/externalBackup'
import { deleteDatabase } from '../persistence/database'
import { DATABASE_NAME, SCHEMA_VERSION } from '../persistence/schema'
import { createLegacyV1Database, readIndexNames } from '../persistence/schemaV1.testSupport'
import { createTestDatabaseName } from '../persistence/testSupport'
import { seedRecordsByStore, standardSeed } from '../backup/testSupport'
import { bootstrapApplication, type BootResult } from './bootstrap'

const clock = (instant: string) => () => instant

async function boot(name: string, now?: () => string): Promise<BootResult> {
  return bootstrapApplication({ databaseName: name, requestStorage: false, now })
}

/** Closes whatever a successful boot opened, so the next test is not blocked. */
function release(result: BootResult): void {
  if (result.phase === 'READY') {
    result.database.close()
  }
}

describe('a first start, with no database yet', () => {
  it('reaches READY with an open database at the current schema version', async () => {
    const name = createTestDatabaseName('boot-fresh')
    const result = await boot(name)

    expect(result.phase).toBe('READY')
    if (result.phase !== 'READY') return
    expect(result.database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.database.meta.schemaVersion).toBe(SCHEMA_VERSION)

    release(result)
    await deleteDatabase(name)
  })

  it('takes no PRE_MIGRATION snapshot, because there is nothing to protect', async () => {
    const name = createTestDatabaseName('boot-fresh-nosnapshot')
    const result = await boot(name)
    if (result.phase !== 'READY') throw new Error('expected READY')

    expect(result.preMigration.outcome).toBe('NO_DATABASE')
    expect(await listSnapshots(result.database)).toHaveLength(1)
    expect((await listSnapshots(result.database))[0]!.kind).toBe('DAILY')

    release(result)
    await deleteDatabase(name)
  })

  it('runs snapshot maintenance once the database is open', async () => {
    const name = createTestDatabaseName('boot-maintenance')
    const result = await boot(name, clock('2026-09-21T10:00:00.000Z'))
    if (result.phase !== 'READY') throw new Error('expected READY')

    expect(result.maintenance?.daily.created).toBe(true)
    expect(result.maintenance?.daily.day).toBe('2026-09-21')
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      'SNAPSHOT_MAINTENANCE_FAILED',
    )

    release(result)
    await deleteDatabase(name)
  })

  it('takes one daily snapshot per UTC day, not one per start', async () => {
    const name = createTestDatabaseName('boot-daily-idempotent')

    const first = await boot(name, clock('2026-09-21T06:00:00.000Z'))
    release(first)
    const second = await boot(name, clock('2026-09-21T18:00:00.000Z'))
    if (second.phase !== 'READY') throw new Error('expected READY')

    expect(second.maintenance?.daily.reason).toBe('ALREADY_EXISTS_TODAY')
    expect(await listSnapshots(second.database)).toHaveLength(1)

    release(second)
    await deleteDatabase(name)
  })

  it('reports NEVER for external backup freshness, which is the loudest state', async () => {
    const name = createTestDatabaseName('boot-backup-never')
    const result = await boot(name)
    if (result.phase !== 'READY') throw new Error('expected READY')

    expect(result.backup.state).toBe('NEVER')
    expect(result.backup.lastExternalBackupAt).toBeUndefined()

    release(result)
    await deleteDatabase(name)
  })
})

describe('external backup staleness is read from stored state', () => {
  it('is FRESH within the window and STALE beyond it', async () => {
    const name = createTestDatabaseName('boot-backup-age')

    const first = await boot(name)
    if (first.phase !== 'READY') throw new Error('expected READY')
    await markExternalBackupCompleted(first.database, { at: '2026-09-20T09:00:00.000Z' })
    release(first)

    const fresh = await boot(name, clock('2026-09-22T09:00:00.000Z'))
    if (fresh.phase !== 'READY') throw new Error('expected READY')
    expect(fresh.backup.state).toBe('FRESH')
    expect(fresh.backup.ageDays).toBe(2)
    release(fresh)

    const stale = await boot(name, clock('2026-10-05T09:00:00.000Z'))
    if (stale.phase !== 'READY') throw new Error('expected READY')
    expect(stale.backup.state).toBe('STALE')
    release(stale)

    await deleteDatabase(name)
  })
})

describe('a start that finds an older database', () => {
  it('commits a PRE_MIGRATION snapshot before the upgrade runs', async () => {
    const name = createTestDatabaseName('boot-premigration')
    await createLegacyV1Database(name, seedRecordsByStore(standardSeed()))
    // The three unusable `active` indexes are still there: this is a genuine
    // version-1 database, not a current one with its version field edited.
    expect(await readIndexNames(name, 'suppliers')).toEqual(['active'])

    const result = await boot(name, clock('2026-09-21T10:00:00.000Z'))
    if (result.phase !== 'READY') throw new Error('expected READY')

    expect(result.preMigration.outcome).toBe('CREATED')
    expect(result.preMigration.storedVersion).toBe(1)
    expect(result.preMigration.targetVersion).toBe(SCHEMA_VERSION)

    // The snapshot exists, it was taken at the *old* version, and it survived
    // the upgrade — which is the whole reason it is not written inside
    // `upgradeneeded`.
    const snapshots = await listSnapshots(result.database)
    const preMigration = snapshots.find((summary) => summary.kind === 'PRE_MIGRATION')
    expect(preMigration).toBeDefined()
    expect(preMigration?.schemaVersion).toBe(1)
    expect(preMigration?.entityCounts.suppliers).toBeGreaterThan(0)

    // …and the upgrade it protected actually happened.
    expect(result.database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(await readIndexNames(name, 'suppliers')).toEqual([])

    release(result)
    await deleteDatabase(name)
  })

  it('does not snapshot again on the next start', async () => {
    const name = createTestDatabaseName('boot-premigration-once')
    await createLegacyV1Database(name, seedRecordsByStore(standardSeed()))

    const first = await boot(name, clock('2026-09-21T10:00:00.000Z'))
    release(first)
    const second = await boot(name, clock('2026-09-22T10:00:00.000Z'))
    if (second.phase !== 'READY') throw new Error('expected READY')

    expect(second.preMigration.outcome).toBe('NOT_NEEDED')
    const kinds = (await listSnapshots(second.database)).map((summary) => summary.kind)
    expect(kinds.filter((kind) => kind === 'PRE_MIGRATION')).toHaveLength(1)

    release(second)
    await deleteDatabase(name)
  })
})

describe('a start that cannot proceed safely', () => {
  it('refuses a database written by a newer build, and never opens it', async () => {
    const name = createTestDatabaseName('boot-too-new')
    // A future build's database: opened at a version this one does not know.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, SCHEMA_VERSION + 5)
      request.onupgradeneeded = () => request.result.createObjectStore('meta', { keyPath: 'key' })
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })

    const result = await boot(name)

    expect(result.phase).toBe('FAILED')
    if (result.phase === 'READY') return
    expect(result.failure.reason).toBe('DATABASE_OPEN_FAILED')
    expect(result.failure.code).toBe('SCHEMA_VERSION_TOO_NEW')

    await deleteDatabase(name)
  })

  it('blocks rather than migrating when the stored version cannot be established', async () => {
    // A browser without `indexedDB.databases()` — Firefox, at the time of
    // writing. "No database" and "a database one version behind" are then the
    // same answer, and guessing the harmless one is the guess that silently
    // migrates real data with no way back.
    const factory = {
      open: () => {
        throw new Error('the boot sequence must stop before reaching open()')
      },
      deleteDatabase: () => {
        throw new Error('not used')
      },
    } as unknown as IDBFactory

    const result = await bootstrapApplication({
      databaseName: createTestDatabaseName('boot-unknown-version'),
      indexedDBFactory: factory,
      requestStorage: false,
    })

    expect(result.phase).toBe('MIGRATION_BLOCKED')
    if (result.phase === 'READY') return
    expect(result.failure.reason).toBe('PRE_MIGRATION_VERSION_UNKNOWN')
  })

  it('offers no destructive escape hatch: the production database still refuses deletion', async () => {
    // The failure screen's only action is "try again". This asserts the guard
    // underneath it, so a convenience "reset the database" path could not be
    // added without tripping a test.
    await expect(deleteDatabase(DATABASE_NAME)).rejects.toMatchObject({
      code: 'DESTRUCTIVE_OPERATION_REFUSED',
    })
  })
})

describe('what a stopped start does not produce', () => {
  it('carries no database, no counts and no backup state when it fails', async () => {
    const name = createTestDatabaseName('boot-failed-shape')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, SCHEMA_VERSION + 5)
      request.onupgradeneeded = () => request.result.createObjectStore('meta', { keyPath: 'key' })
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })

    const result = await boot(name)

    // There is deliberately no shape in which a stopped boot hands the UI a
    // database handle or an empty-looking summary: the union has no such
    // member, so a screen cannot render business data over a failure.
    expect(result).not.toHaveProperty('database')
    expect(result).not.toHaveProperty('backup')

    await deleteDatabase(name)
  })

  it('leaves an older database un-upgraded when the version cannot be established', async () => {
    const name = createTestDatabaseName('boot-blocked-untouched')
    await createLegacyV1Database(name, seedRecordsByStore(standardSeed()))

    const factory = {
      ...indexedDB,
      open: indexedDB.open.bind(indexedDB),
      deleteDatabase: indexedDB.deleteDatabase.bind(indexedDB),
      // No `databases()`: the version is unknowable.
    } as unknown as IDBFactory

    const result = await bootstrapApplication({
      databaseName: name,
      indexedDBFactory: factory,
      requestStorage: false,
    })

    expect(result.phase).toBe('MIGRATION_BLOCKED')
    // The database is exactly as it was: still version 1, still carrying the
    // indexes the upgrade would have removed.
    expect(await readIndexNames(name, 'suppliers')).toEqual(['active'])

    await deleteDatabase(name)
  })
})

describe('the sequence itself', () => {
  it('opens the database only after the pre-migration step has finished', async () => {
    const name = createTestDatabaseName('boot-order')
    await createLegacyV1Database(name, seedRecordsByStore(standardSeed()))

    const order: string[] = []
    const realOpen = indexedDB.open.bind(indexedDB)
    const factory = {
      databases: () => indexedDB.databases(),
      deleteDatabase: indexedDB.deleteDatabase.bind(indexedDB),
      open: (dbName: string, version?: number) => {
        order.push(`open@${version ?? 'current'}`)
        return realOpen(dbName, version)
      },
      cmp: indexedDB.cmp.bind(indexedDB),
    } as unknown as IDBFactory

    const result = await bootstrapApplication({
      databaseName: name,
      indexedDBFactory: factory,
      requestStorage: false,
    })
    if (result.phase !== 'READY') throw new Error('expected READY')

    // The snapshot connection opens at the stored version (1) and the upgrade
    // connection opens at the target — in that order. Reversing them would
    // mean the migration ran before the snapshot existed.
    expect(order[0]).toBe('open@1')
    expect(order).toContain(`open@${SCHEMA_VERSION}`)
    expect(order.indexOf('open@1')).toBeLessThan(order.indexOf(`open@${SCHEMA_VERSION}`))

    release(result)
    await deleteDatabase(name)
  })
})
