/**
 * The pre-migration snapshot, against the real `v1 → v2` upgrade.
 *
 * This is no longer a rehearsal. `schemaVersion` 2 exists, the released chain
 * has a step in it, and the databases these tests protect are genuine version-1
 * databases built by `createLegacyV1Database` — the Phase 7 layout, the Phase 7
 * `meta` stamp, and the three unusable `active` indexes included.
 *
 * The test that matters is still the same one: a snapshot taken this way must
 * **survive a migration that fails**. That is the entire reason the snapshot
 * cannot be written inside `upgradeneeded`, and asserting it here is what stops
 * someone later "simplifying" the sequence back into the opener.
 */

import { describe, expect, it } from 'vitest'
import { deleteDatabase, openDatabase, readStoredSchemaVersion } from '../persistence/database'
import type { Migration } from '../persistence/migrations'
import { SCHEMA_VERSION } from '../persistence/schema'
import { createLegacyV1Database, readIndexNames } from '../persistence/schemaV1.testSupport'
import { createTestDatabaseName } from '../persistence/testSupport'
import { ensurePreMigrationSnapshot } from './preMigration'
import { prepareRestoreFromSnapshot } from './restore'
import { listSnapshots, readSnapshot } from './snapshots'
import { seedDatabase, seedRecordsByStore, standardSeed } from './testSupport'

const clock = (instant: string) => () => instant

/** A genuine version-1 database holding the standard fixture. */
async function legacyDatabase(label: string): Promise<string> {
  const name = createTestDatabaseName(label)
  await createLegacyV1Database(name, seedRecordsByStore(standardSeed()))
  return name
}

describe('ensurePreMigrationSnapshot', () => {
  it('does nothing when no database exists yet', async () => {
    const name = createTestDatabaseName('premigration-none')
    const result = await ensurePreMigrationSnapshot({ name, targetSchemaVersion: SCHEMA_VERSION })
    expect(result.outcome).toBe('NO_DATABASE')
    expect(result.snapshot).toBeUndefined()
  })

  it('does nothing when the stored database is already current', async () => {
    const name = createTestDatabaseName('premigration-current')
    const database = await openDatabase({ name })
    await seedDatabase(database, standardSeed())
    database.close()

    const result = await ensurePreMigrationSnapshot({ name, targetSchemaVersion: SCHEMA_VERSION })
    expect(result.outcome).toBe('NOT_NEEDED')
    expect(result.storedVersion).toBe(SCHEMA_VERSION)

    const reopened = await openDatabase({ name })
    expect(await listSnapshots(reopened)).toHaveLength(0)
    reopened.close()
    await deleteDatabase(name)
  })

  it('snapshots the old data when the stored version is behind this build', async () => {
    const name = await legacyDatabase('premigration-behind')

    const result = await ensurePreMigrationSnapshot({
      name,
      targetSchemaVersion: SCHEMA_VERSION,
      now: clock('2026-09-19T08:00:00.000Z'),
    })

    expect(result.outcome).toBe('CREATED')
    expect(result.storedVersion).toBe(1)
    expect(result.targetVersion).toBe(2)
    expect(result.snapshot?.kind).toBe('PRE_MIGRATION')
    expect(result.snapshot?.entityCounts.suppliers).toBe(2)
    // Taken at the version the data was written at, which is the version a
    // restore of it would have to be migrated *from*.
    expect(result.snapshot?.schemaVersion).toBe(1)

    // The snapshot was committed without upgrading anything.
    expect(await readStoredSchemaVersion(name)).toBe(1)
    expect(await readIndexNames(name, 'suppliers')).toEqual(['active'])

    const reopened = await openDatabase({ name })
    const stored = await readSnapshot(reopened, result.snapshot!.id)
    expect(stored.payload.suppliers).toHaveLength(2)
    expect(stored.payload.projects).toHaveLength(1)
    reopened.close()
    await deleteDatabase(name)
  })

  it('leaves the database closed, so it does not block the upgrade it enables', async () => {
    const name = await legacyDatabase('premigration-unblocked')

    await ensurePreMigrationSnapshot({ name, targetSchemaVersion: SCHEMA_VERSION })

    // The real upgrade proceeds without `DATABASE_UPGRADE_BLOCKED`.
    const upgraded = await openDatabase({ name })
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    upgraded.close()
    expect(await readIndexNames(name, 'suppliers')).toEqual([])
    await deleteDatabase(name)
  })

  it('survives a migration that fails and rolls the upgrade back', async () => {
    const name = await legacyDatabase('premigration-survives')

    const snapshotResult = await ensurePreMigrationSnapshot({
      name,
      targetSchemaVersion: SCHEMA_VERSION,
    })
    expect(snapshotResult.outcome).toBe('CREATED')

    const failing: Migration = {
      to: 2,
      description: 'a step that cannot cope with the old shape',
      migrate: () => {
        throw new Error('unexpected shape')
      },
    }
    await expect(
      openDatabase({ name, schemaVersion: 2, migrations: [failing] }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })

    // The database is back at version 1 with its data — and, crucially, the
    // snapshot is still there. Written inside `upgradeneeded` it would have
    // rolled back with the migration.
    expect(await readStoredSchemaVersion(name)).toBe(1)
    expect(await readIndexNames(name, 'suppliers')).toEqual(['active'])

    // It also survives the upgrade that does succeed, because the `snapshots`
    // store is never what a migration rewrites.
    const reopened = await openDatabase({ name })
    expect(reopened.schemaVersion).toBe(SCHEMA_VERSION)
    const snapshots = await listSnapshots(reopened)
    expect(snapshots.map((entry) => entry.id)).toContain(snapshotResult.snapshot!.id)
    const stored = await readSnapshot(reopened, snapshotResult.snapshot!.id)
    expect(stored.payload.suppliers).toHaveLength(2)
    reopened.close()
    await deleteDatabase(name)
  })

  it('reports an unknown version rather than guessing, when the browser will not enumerate', async () => {
    const withoutEnumeration = {
      open: () => {
        throw new Error('should not be reached')
      },
    } as unknown as IDBFactory

    const result = await ensurePreMigrationSnapshot({
      name: 'landedcompare-probe',
      targetSchemaVersion: SCHEMA_VERSION,
      indexedDBFactory: withoutEnumeration,
    })
    expect(result.outcome).toBe('VERSION_UNKNOWN')
    expect(result.storedVersion).toBeUndefined()
    expect(result.snapshot).toBeUndefined()
  })

  it('does not take a second snapshot once the upgrade has happened', async () => {
    const name = await legacyDatabase('premigration-once')

    await ensurePreMigrationSnapshot({ name, targetSchemaVersion: SCHEMA_VERSION })
    const upgraded = await openDatabase({ name })
    upgraded.close()

    const again = await ensurePreMigrationSnapshot({ name, targetSchemaVersion: SCHEMA_VERSION })
    expect(again.outcome).toBe('NOT_NEEDED')

    const reopened = await openDatabase({ name })
    expect(await listSnapshots(reopened)).toHaveLength(1)
    expect(await reopened.read(['suppliers'], (scope) => scope.count('suppliers'))).toBe(2)
    reopened.close()
    await deleteDatabase(name)
  })

  it('restores the snapshot it took, which is the point of taking it', async () => {
    const name = await legacyDatabase('premigration-restorable')

    const result = await ensurePreMigrationSnapshot({ name, targetSchemaVersion: SCHEMA_VERSION })
    expect(result.outcome).toBe('CREATED')

    const upgraded = await openDatabase({ name })
    // A version-1 snapshot read by a version-2 build: the payload migration
    // chain is what makes it usable, and it must be found rather than assumed.
    const plan = await prepareRestoreFromSnapshot(upgraded, result.snapshot!.id)
    expect(plan.preview.backupSchemaVersion).toBe(1)
    expect(plan.preview.targetSchemaVersion).toBe(SCHEMA_VERSION)
    expect(plan.preview.migrationsApplied).toEqual([2])
    expect(plan.data.suppliers).toHaveLength(2)

    upgraded.close()
    await deleteDatabase(name)
  })
})
