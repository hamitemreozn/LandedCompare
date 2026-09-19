import { describe, expect, it } from 'vitest'
import { deleteDatabase, openDatabase } from './database'
import { isPersistenceError, type PersistenceError } from './errors'
import { MIGRATIONS, assertMigrationChain, selectMigrations, type Migration } from './migrations'
import { parseSupplierRecord } from './records/supplier'
import { SCHEMA_VERSION } from './schema'
import { createTestDatabaseName, TEST_INSTANT, testUuid } from './testSupport'

/**
 * A genuine previous-schema fixture.
 *
 * The supplier master as it might have looked one version earlier: a `name`
 * field instead of `displayName`, and no `active` flag. It is written into a
 * real database at its real IndexedDB version, so the migration under test
 * transforms persisted records through the production runner rather than
 * transforming a hand-held object in memory.
 *
 * The shape is test-only on purpose. `schemaVersion` 1 is the first version
 * that has ever existed, so there is no real `v1 → v2` step to test; inventing
 * one in `MIGRATIONS` would ship a migration that runs on every pilot database
 * for no reason. What must be proved now is that the *mechanism* works, and
 * that is what this fixture does.
 */
interface LegacySupplierRecord {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

function legacySupplier(seed: number): LegacySupplierRecord {
  return {
    id: testUuid(seed),
    name: `Legacy supplier ${seed}`,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
  }
}

const renameSupplierName: Migration = {
  to: 2,
  description: 'suppliers: name -> displayName, add active',
  migrate: (context) => {
    context.rewriteStore('suppliers', (record) => {
      const legacy = record as LegacySupplierRecord
      return {
        id: legacy.id,
        displayName: legacy.name,
        active: true,
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
      }
    })
  },
}

const addSupplierNote: Migration = {
  to: 3,
  description: 'suppliers: record why each supplier was migrated',
  migrate: (context) => {
    context.rewriteStore('suppliers', (record) => ({
      ...(record as Record<string, unknown>),
      note: 'migrated',
    }))
  },
}

const failsOnSecondRecord: Migration = {
  to: 2,
  description: 'suppliers: fails partway through',
  migrate: (context) => {
    let seen = 0
    context.rewriteStore('suppliers', (record) => {
      seen += 1
      if (seen === 2) {
        throw new Error('migration cannot interpret this record')
      }
      const legacy = record as LegacySupplierRecord
      return { id: legacy.id, displayName: legacy.name, active: true, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt }
    })
  },
}

/** Creates a database at `schemaVersion` 1 holding two legacy supplier rows. */
async function seedLegacyDatabase(label: string): Promise<string> {
  const name = createTestDatabaseName(label)
  const database = await openDatabase({ name })
  await database.write(['suppliers'], async (scope) => {
    await scope.put('suppliers', legacySupplier(1))
    await scope.put('suppliers', legacySupplier(2))
  })
  database.close()
  return name
}

describe('the released migration chain', () => {
  it('is empty at schemaVersion 1 — there has never been an earlier version', () => {
    expect(MIGRATIONS).toEqual([])
    expect(SCHEMA_VERSION).toBe(1)
  })

  it('never reaches beyond the schema version it claims to produce', () => {
    expect(() => assertMigrationChain(MIGRATIONS, SCHEMA_VERSION)).not.toThrow()
  })

  it('rejects a chain with a gap', () => {
    expect(() =>
      assertMigrationChain([renameSupplierName, { ...addSupplierNote, to: 4 }], 4),
    ).toThrow(/not contiguous/)
  })

  it('rejects a chain that overshoots the schema version', () => {
    expect(() => assertMigrationChain([renameSupplierName], 1)).toThrow(/beyond schemaVersion/)
  })

  it('selects only the steps between the stored and the target version', () => {
    const chain = [renameSupplierName, addSupplierNote]
    expect(selectMigrations(chain, 1, 3).map((step) => step.to)).toEqual([2, 3])
    expect(selectMigrations(chain, 2, 3).map((step) => step.to)).toEqual([3])
    expect(selectMigrations(chain, 3, 3)).toEqual([])
  })
})

describe('migrating a real previous-version database', () => {
  it('transforms stored records and advances the recorded schema version', async () => {
    const name = await seedLegacyDatabase('migrate-ok')

    const migrated = await openDatabase({
      name,
      schemaVersion: 2,
      migrations: [renameSupplierName],
    })

    expect(migrated.meta.schemaVersion).toBe(2)

    const suppliers = await migrated.read(['suppliers'], (scope) =>
      scope.getAll<unknown>('suppliers'),
    )
    const parsed = suppliers
      .map((record) => parseSupplierRecord(record))
      .sort((a, b) => a.id.localeCompare(b.id))

    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.displayName).toBe('Legacy supplier 1')
    expect(parsed[1]?.displayName).toBe('Legacy supplier 2')
    expect(parsed.every((record) => record.active)).toBe(true)
    // The install identity survives the migration; only the schema moved.
    expect(parsed[0]?.createdAt).toBe(TEST_INSTANT)

    migrated.close()
    await deleteDatabase(name)
  })

  it('applies a multi-step chain in order', async () => {
    const name = await seedLegacyDatabase('migrate-chain')

    const migrated = await openDatabase({
      name,
      schemaVersion: 3,
      migrations: [renameSupplierName, addSupplierNote],
    })

    expect(migrated.meta.schemaVersion).toBe(3)
    const suppliers = await migrated.read(['suppliers'], (scope) =>
      scope.getAll<unknown>('suppliers'),
    )
    const parsed = suppliers.map((record) => parseSupplierRecord(record))
    // `note: 'migrated'` could only have been added after `displayName` existed:
    // step 3 reads the shape step 2 produced.
    expect(parsed.every((record) => record.note === 'migrated')).toBe(true)
    expect(parsed.every((record) => record.displayName.startsWith('Legacy supplier'))).toBe(true)

    migrated.close()
    await deleteDatabase(name)
  })

  it('preserves installId and createdAt across a migration', async () => {
    const name = await seedLegacyDatabase('migrate-meta')
    const before = await openDatabase({ name })
    const { installId, createdAt } = before.meta
    before.close()

    const migrated = await openDatabase({
      name,
      schemaVersion: 2,
      migrations: [renameSupplierName],
    })
    expect(migrated.meta.installId).toBe(installId)
    expect(migrated.meta.createdAt).toBe(createdAt)

    migrated.close()
    await deleteDatabase(name)
  })
})

describe('a failed migration', () => {
  it('reports the failure instead of opening a half-migrated database', async () => {
    const name = await seedLegacyDatabase('migrate-fail')

    let captured: PersistenceError | null = null
    try {
      await openDatabase({ name, schemaVersion: 2, migrations: [failsOnSecondRecord] })
    } catch (error) {
      if (!isPersistenceError(error)) {
        throw error
      }
      captured = error
    }

    expect(captured?.code).toBe('MIGRATION_FAILED')
    expect(captured?.details.targetVersion).toBe(2)

    await deleteDatabase(name)
  })

  it('leaves the database at its previous version with its previous data', async () => {
    const name = await seedLegacyDatabase('migrate-rollback')

    await expect(
      openDatabase({ name, schemaVersion: 2, migrations: [failsOnSecondRecord] }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })

    // The migration had already rewritten the first record before it threw on
    // the second. If the upgrade transaction had not rolled back as a unit,
    // this database would now hold one new-shape row and one old-shape row —
    // a half-migrated state no version number describes.
    const reopened = await openDatabase({ name })
    expect(reopened.meta.schemaVersion).toBe(1)

    const suppliers = await reopened.read(['suppliers'], (scope) =>
      scope.getAll<LegacySupplierRecord>('suppliers'),
    )
    expect(suppliers).toHaveLength(2)
    expect(suppliers.every((record) => typeof record.name === 'string')).toBe(true)
    expect(suppliers.every((record) => !('displayName' in record))).toBe(true)

    reopened.close()
    await deleteDatabase(name)
  })
})
