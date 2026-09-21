/**
 * The migration **runner**: sequencing, chain validation, and what a failure
 * costs.
 *
 * The released `v1 → v2` step has its own suite in `schemaVersion2.test.ts`,
 * against a genuine version-1 database. This file tests the machinery that will
 * carry every step after it, and does so with the only fixture that can prove a
 * runner works: steps that actually rewrite records, applied to records that
 * are actually stored.
 *
 * Those steps are numbered 3 and 4 because the database they run against is
 * already at version 2 — the current one. Inventing a second `to: 2` here would
 * mean testing the runner against a version the released chain also claims,
 * which is the one arrangement guaranteed to stop matching production.
 */

import { describe, expect, it } from 'vitest'
import { deleteDatabase, openDatabase } from './database'
import { isPersistenceError, type PersistenceError } from './errors'
import { MIGRATIONS, assertMigrationChain, selectMigrations, type Migration } from './migrations'
import { parseSupplierRecord } from './records/supplier'
import { SCHEMA_VERSION } from './schema'
import { createTestDatabaseName, TEST_INSTANT, testUuid } from './testSupport'

/**
 * A genuine previous-shape fixture.
 *
 * The supplier master as it might look one version before a rename: a `name`
 * field instead of `displayName`, and no `active` flag. It is written into a
 * real database and transformed by the production runner, rather than by a
 * hand-held object in memory.
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

/** The first step past the released chain. */
const NEXT_VERSION = SCHEMA_VERSION + 1

const renameSupplierName: Migration = {
  to: NEXT_VERSION,
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
  to: NEXT_VERSION + 1,
  description: 'suppliers: record why each supplier was migrated',
  migrate: (context) => {
    context.rewriteStore('suppliers', (record) => ({
      ...(record as Record<string, unknown>),
      note: 'migrated',
    }))
  },
}

const failsOnSecondRecord: Migration = {
  to: NEXT_VERSION,
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

/**
 * A database at the current schema version holding two previous-shape supplier
 * rows, ready for a step that has not shipped yet.
 */
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

/** The released chain plus the steps under test, as a build one version on would ship it. */
function chainWith(...steps: readonly Migration[]): readonly Migration[] {
  return [...MIGRATIONS, ...steps]
}

describe('the released migration chain', () => {
  it('reaches exactly the schema version this build declares', () => {
    expect(MIGRATIONS.map((step) => step.to)).toEqual([2])
    expect(SCHEMA_VERSION).toBe(2)
  })

  it('never reaches beyond the schema version it claims to produce', () => {
    expect(() => assertMigrationChain(MIGRATIONS, SCHEMA_VERSION)).not.toThrow()
  })

  it('gives every step a description that is not a user-facing string', () => {
    for (const step of MIGRATIONS) {
      expect(step.description.length).toBeGreaterThan(0)
    }
  })

  it('rejects a chain with a gap', () => {
    const toTwo: Migration = { to: 2, description: 'two', migrate: () => {} }
    const toFour: Migration = { to: 4, description: 'four', migrate: () => {} }
    expect(() => assertMigrationChain([toTwo, toFour], 4)).toThrow(/not contiguous/)
  })

  it('rejects a chain that does not start at 2', () => {
    const toThree: Migration = { to: 3, description: 'three', migrate: () => {} }
    expect(() => assertMigrationChain([toThree], 3)).toThrow(/not contiguous/)
  })

  it('rejects a chain that overshoots the schema version', () => {
    expect(() => assertMigrationChain(chainWith(renameSupplierName), SCHEMA_VERSION)).toThrow(
      /beyond schemaVersion/,
    )
  })

  it('selects only the steps between the stored and the target version', () => {
    const chain = chainWith(renameSupplierName, addSupplierNote)
    expect(selectMigrations(chain, 1, 4).map((step) => step.to)).toEqual([2, 3, 4])
    expect(selectMigrations(chain, 2, 4).map((step) => step.to)).toEqual([3, 4])
    expect(selectMigrations(chain, 3, 4).map((step) => step.to)).toEqual([4])
    expect(selectMigrations(chain, 4, 4)).toEqual([])
  })
})

describe('migrating a real previous-version database', () => {
  it('transforms stored records and advances the recorded schema version', async () => {
    const name = await seedLegacyDatabase('migrate-ok')

    const migrated = await openDatabase({
      name,
      schemaVersion: NEXT_VERSION,
      migrations: chainWith(renameSupplierName),
    })

    expect(migrated.meta.schemaVersion).toBe(NEXT_VERSION)

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
      schemaVersion: NEXT_VERSION + 1,
      migrations: chainWith(renameSupplierName, addSupplierNote),
    })

    expect(migrated.meta.schemaVersion).toBe(NEXT_VERSION + 1)
    const suppliers = await migrated.read(['suppliers'], (scope) =>
      scope.getAll<unknown>('suppliers'),
    )
    const parsed = suppliers.map((record) => parseSupplierRecord(record))
    // `note: 'migrated'` could only have been added after `displayName` existed:
    // the second step reads the shape the first one produced.
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
      schemaVersion: NEXT_VERSION,
      migrations: chainWith(renameSupplierName),
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
      await openDatabase({
        name,
        schemaVersion: NEXT_VERSION,
        migrations: chainWith(failsOnSecondRecord),
      })
    } catch (error) {
      if (!isPersistenceError(error)) {
        throw error
      }
      captured = error
    }

    expect(captured?.code).toBe('MIGRATION_FAILED')
    expect(captured?.details.targetVersion).toBe(NEXT_VERSION)

    await deleteDatabase(name)
  })

  it('leaves the database at its previous version with its previous data', async () => {
    const name = await seedLegacyDatabase('migrate-rollback')

    await expect(
      openDatabase({
        name,
        schemaVersion: NEXT_VERSION,
        migrations: chainWith(failsOnSecondRecord),
      }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })

    // The migration had already rewritten the first record before it threw on
    // the second. If the upgrade transaction had not rolled back as a unit,
    // this database would now hold one new-shape row and one old-shape row —
    // a half-migrated state no version number describes.
    const reopened = await openDatabase({ name })
    expect(reopened.meta.schemaVersion).toBe(SCHEMA_VERSION)

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
