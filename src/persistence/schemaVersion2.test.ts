/**
 * `schemaVersion` 1 → 2: removing three indexes a boolean key never populated.
 *
 * The first test in this file is the one that justifies the rest. It takes a
 * genuine version-1 database, fills the three master stores with records, and
 * shows that their `active` indexes contain **nothing** — not fewer entries
 * than expected, not stale entries: zero, over stores holding real data. That
 * is the defect version 2 exists to remove, and it is reproduced here rather
 * than described, so the removal is anchored to an observable failure.
 *
 * Everything after it proves the removal is safe: that a fresh database never
 * creates those indexes, that upgrading an existing one deletes them and keeps
 * every record, that the indexes which *are* valid still work afterwards, and
 * that a failed upgrade leaves a version-1 database exactly as it was.
 */

import { describe, expect, it } from 'vitest'
import { deleteDatabase, openDatabase, readStoredSchemaVersion } from './database'
import { isPersistenceError } from './errors'
import { MIGRATIONS, assertMigrationChain, type Migration } from './migrations'
import { REMOVED_BOOLEAN_INDEXES, SCHEMA_VERSION, STORE_DEFINITIONS } from './schema'
import {
  V1_APP_VERSION,
  V1_CREATED_AT,
  V1_INSTALL_ID,
  createLegacyV1Database,
  readIndexNames,
  readStoredRecords,
} from './schemaV1.testSupport'
import { createTestDatabaseName, TEST_INSTANT, testUuid } from './testSupport'

/** A product as the catalogue stores it: `active` is a boolean, and stays one. */
function productRecord(seed: number, active: boolean) {
  return {
    id: testUuid(seed),
    sku: `SKU-${seed}`,
    name: `Product ${seed}`,
    active,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
  }
}

function supplierRow(seed: number, active: boolean) {
  return {
    id: testUuid(seed),
    displayName: `Supplier ${seed}`,
    active,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
  }
}

function customerRow(seed: number, active: boolean) {
  return {
    id: testUuid(seed),
    displayName: `Customer ${seed}`,
    active,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
  }
}

/** A version-1 database with both active and inactive rows in all three masters. */
function mixedActivitySeed() {
  return {
    products: [productRecord(101, true), productRecord(102, false), productRecord(103, true)],
    suppliers: [supplierRow(201, true), supplierRow(202, false)],
    customers: [customerRow(301, true), customerRow(302, false), customerRow(303, false)],
  }
}

async function seededV1(label: string): Promise<string> {
  const name = createTestDatabaseName(label)
  await createLegacyV1Database(name, mixedActivitySeed())
  return name
}

/** Reads through an index at the database's current version, without upgrading it. */
async function countInIndex(name: string, store: string, index: string): Promise<number> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    const request = connection
      .transaction([store], 'readonly')
      .objectStore(store)
      .index(index)
      .count()
    return await new Promise<number>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    connection.close()
  }
}

describe('the defect schemaVersion 2 removes', () => {
  it('shows a version-1 active index holding zero entries over populated stores', async () => {
    const name = await seededV1('v1-defect')

    // The records are there.
    expect(await readStoredRecords(name, 'products')).toHaveLength(3)
    expect(await readStoredRecords(name, 'suppliers')).toHaveLength(2)
    expect(await readStoredRecords(name, 'customers')).toHaveLength(3)

    // The indexes over them are empty. IndexedDB never complained: a boolean is
    // not a valid key, so each record was simply left out, and a catalogue
    // screen querying this index would have shown an empty list.
    expect(await countInIndex(name, 'products', 'active')).toBe(0)
    expect(await countInIndex(name, 'suppliers', 'active')).toBe(0)
    expect(await countInIndex(name, 'customers', 'active')).toBe(0)

    // A valid index over the same records is populated, which is what rules out
    // "the fixture never wrote anything" as an explanation.
    expect(await countInIndex(name, 'products', 'sku')).toBe(3)

    await deleteDatabase(name)
  })
})

describe('a fresh version-2 database', () => {
  it('never creates the unusable indexes in the first place', async () => {
    const name = createTestDatabaseName('v2-fresh')
    const database = await openDatabase({ name })
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    database.close()

    for (const { store, index } of REMOVED_BOOLEAN_INDEXES) {
      expect(await readIndexNames(name, store)).not.toContain(index)
    }

    await deleteDatabase(name)
  })

  it('declares no boolean-keyed index anywhere in the layout', () => {
    const declared = STORE_DEFINITIONS.flatMap((definition) =>
      definition.indexes.map((index) => `${definition.name}.${index.name}`),
    )
    for (const { store, index } of REMOVED_BOOLEAN_INDEXES) {
      expect(declared).not.toContain(`${store}.${index}`)
    }
  })

  it('runs no migration on a brand-new database, because there is no history', async () => {
    const name = createTestDatabaseName('v2-no-history')
    let ran = 0
    const counted: Migration = {
      to: 2,
      description: 'counts its own invocations',
      migrate: () => {
        ran += 1
      },
    }
    const database = await openDatabase({ name, migrations: [counted] })
    expect(ran).toBe(0)
    database.close()
    await deleteDatabase(name)
  })
})

describe('upgrading a real version-1 database', () => {
  it('deletes exactly the three unusable indexes and nothing else', async () => {
    const name = await seededV1('v2-drop')

    const before = {
      products: await readIndexNames(name, 'products'),
      suppliers: await readIndexNames(name, 'suppliers'),
      customers: await readIndexNames(name, 'customers'),
      movements: await readIndexNames(name, 'inventoryMovements'),
    }
    expect(before.products).toContain('active')
    expect(before.suppliers).toContain('active')
    expect(before.customers).toContain('active')

    const upgraded = await openDatabase({ name })
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    upgraded.close()

    expect(await readIndexNames(name, 'products')).toEqual(['sku'])
    expect(await readIndexNames(name, 'suppliers')).toEqual([])
    expect(await readIndexNames(name, 'customers')).toEqual([])
    // An untouched store keeps every index it had.
    expect(await readIndexNames(name, 'inventoryMovements')).toEqual(before.movements)

    await deleteDatabase(name)
  })

  it('preserves every record, field for field', async () => {
    const name = await seededV1('v2-preserve')
    const seed = mixedActivitySeed()

    const before = {
      products: await readStoredRecords(name, 'products'),
      suppliers: await readStoredRecords(name, 'suppliers'),
      customers: await readStoredRecords(name, 'customers'),
    }

    const upgraded = await openDatabase({ name })
    upgraded.close()

    expect(await readStoredRecords(name, 'products')).toEqual(before.products)
    expect(await readStoredRecords(name, 'suppliers')).toEqual(before.suppliers)
    expect(await readStoredRecords(name, 'customers')).toEqual(before.customers)

    // And what survived is the seed itself, not merely "the same as before the
    // upgrade" — including the boolean that started all of this.
    expect(await readStoredRecords(name, 'products')).toEqual(seed.products)
    expect(await readStoredRecords(name, 'suppliers')).toEqual(seed.suppliers)
    expect(await readStoredRecords(name, 'customers')).toEqual(seed.customers)

    await deleteDatabase(name)
  })

  it('keeps active as a boolean on the record — the field was never the problem', async () => {
    const name = await seededV1('v2-field')
    const upgraded = await openDatabase({ name })

    const products = await upgraded.read(['products'], (scope) =>
      scope.getAll<{ id: string; active: unknown }>('products'),
    )
    expect(products.map((record) => record.active)).toEqual([true, false, true])
    expect(products.every((record) => typeof record.active === 'boolean')).toBe(true)
    // No mirrored copy was introduced to make an index possible.
    for (const record of products) {
      expect(Object.keys(record)).not.toContain('activeFlag')
      expect(Object.keys(record)).not.toContain('activeKey')
    }

    upgraded.close()
    await deleteDatabase(name)
  })

  it('answers "only the active ones" by filtering a read, which needs no index', async () => {
    const name = await seededV1('v2-filter')
    const upgraded = await openDatabase({ name })

    const active = (
      await upgraded.read(['suppliers'], (scope) => scope.getAll<{ active: boolean }>('suppliers'))
    ).filter((record) => record.active)

    expect(active).toHaveLength(1)
    upgraded.close()
    await deleteDatabase(name)
  })

  it('leaves the surviving indexes usable, including the compound ledger index', async () => {
    const name = await seededV1('v2-indexes-work')
    const upgraded = await openDatabase({ name })

    const bySku = await upgraded.read(['products'], (scope) =>
      scope.getAllFromIndex<{ sku: string }>('products', 'sku'),
    )
    expect(bySku.map((record) => record.sku)).toEqual(['SKU-101', 'SKU-102', 'SKU-103'])

    const movements = await upgraded.read(['inventoryMovements'], (scope) =>
      scope.getAllFromIndex<unknown>('inventoryMovements', 'productId_occurredAt'),
    )
    expect(movements).toEqual([])

    upgraded.close()
    await deleteDatabase(name)
  })

  it('still enforces the unique sku index after the upgrade', async () => {
    const name = await seededV1('v2-unique-sku')
    const upgraded = await openDatabase({ name })

    let code: string | undefined
    try {
      await upgraded.write(['products'], (scope) =>
        scope.add('products', productRecord(199, true)),
      )
      await upgraded.write(['products'], (scope) =>
        // A different primary key, the same sku as the record above.
        scope.add('products', { ...productRecord(198, true), sku: 'SKU-199' }),
      )
    } catch (cause) {
      code = isPersistenceError(cause) ? cause.code : `unexpected:${String(cause)}`
    }
    expect(code).toBe('DUPLICATE_KEY')

    upgraded.close()
    await deleteDatabase(name)
  })

  it('still enforces the unique code index on documents after the upgrade', async () => {
    const name = await seededV1('v2-unique-code')
    const upgraded = await openDatabase({ name })

    let code: string | undefined
    try {
      await upgraded.write(['purchaseOrders'], async (scope) => {
        await scope.add('purchaseOrders', { id: testUuid(401), code: 'PO-1', status: 'DRAFT' })
        await scope.add('purchaseOrders', { id: testUuid(402), code: 'PO-1', status: 'DRAFT' })
      })
    } catch (cause) {
      code = isPersistenceError(cause) ? cause.code : `unexpected:${String(cause)}`
    }
    expect(code).toBe('DUPLICATE_KEY')

    upgraded.close()
    await deleteDatabase(name)
  })

  it('reports the current schema version from meta and from the connection', async () => {
    const name = await seededV1('v2-reports')
    expect(await readStoredSchemaVersion(name)).toBe(1)

    const upgraded = await openDatabase({ name })
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    expect(upgraded.meta.schemaVersion).toBe(SCHEMA_VERSION)
    upgraded.close()

    expect(await readStoredSchemaVersion(name)).toBe(SCHEMA_VERSION)

    // Reopening is a no-op: no upgrade fires, and the version still reads back
    // as the current one from both the stored record and the connection.
    const reopened = await openDatabase({ name })
    expect(reopened.meta.schemaVersion).toBe(SCHEMA_VERSION)
    expect(await readIndexNames(name, 'suppliers')).toEqual([])
    reopened.close()

    await deleteDatabase(name)
  })

  it('preserves the installation identity the version-1 build stamped', async () => {
    const name = await seededV1('v2-identity')
    const upgraded = await openDatabase({ name })

    expect(upgraded.meta.installId).toBe(V1_INSTALL_ID)
    expect(upgraded.meta.createdAt).toBe(V1_CREATED_AT)
    // `appVersion` is restamped by the build that ran the upgrade; that is what
    // makes "which build wrote this?" answerable at all.
    expect(upgraded.meta.appVersion).not.toBe('')

    upgraded.close()
    await deleteDatabase(name)
  })

  it('is the released chain, not a chain a test invented', async () => {
    expect(MIGRATIONS.map((step) => step.to)).toEqual([2, 3])
    expect(SCHEMA_VERSION).toBe(3)
    expect(() => assertMigrationChain(MIGRATIONS, SCHEMA_VERSION)).not.toThrow()

    const name = await seededV1('v2-released-chain')
    // No `migrations` option: whatever ships is what runs.
    const upgraded = await openDatabase({ name })
    upgraded.close()
    expect(await readIndexNames(name, 'suppliers')).toEqual([])
    await deleteDatabase(name)
  })
})

describe('an upgrade that fails', () => {
  /** Deletes the indexes, then throws — so a rollback has something to undo. */
  const dropsThenFails: Migration = {
    to: 2,
    description: 'drops the indexes and then refuses to finish',
    migrate: (context) => {
      for (const { store, index } of REMOVED_BOOLEAN_INDEXES) {
        context.deleteIndex(store, index)
      }
      throw new Error('migration cannot complete')
    },
  }

  it('rolls the index deletions back with everything else', async () => {
    const name = await seededV1('v2-rollback')

    await expect(
      openDatabase({ name, schemaVersion: 2, migrations: [dropsThenFails] }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })

    // The version-change transaction aborted as a unit, so the indexes the step
    // had already deleted are back. A half-applied schema is not a state any
    // version number describes.
    expect(await readIndexNames(name, 'products')).toEqual(['active', 'sku'])
    expect(await readIndexNames(name, 'suppliers')).toEqual(['active'])
    expect(await readIndexNames(name, 'customers')).toEqual(['active'])

    await deleteDatabase(name)
  })

  it('leaves the database at version 1 with its records intact', async () => {
    const name = await seededV1('v2-rollback-data')
    const seed = mixedActivitySeed()

    await expect(
      openDatabase({ name, schemaVersion: 2, migrations: [dropsThenFails] }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })

    expect(await readStoredSchemaVersion(name)).toBe(1)
    expect(await readStoredRecords(name, 'products')).toEqual(seed.products)
    expect(await readStoredRecords(name, 'suppliers')).toEqual(seed.suppliers)
    expect(await readStoredRecords(name, 'customers')).toEqual(seed.customers)

    const meta = await readStoredRecords(name, 'meta')
    expect(meta).toEqual([
      {
        key: 'meta',
        schemaVersion: 1,
        appVersion: V1_APP_VERSION,
        installId: V1_INSTALL_ID,
        createdAt: V1_CREATED_AT,
      },
    ])

    await deleteDatabase(name)
  })

  it('can be retried successfully once the defect in the step is fixed', async () => {
    const name = await seededV1('v2-retry')

    await expect(
      openDatabase({ name, schemaVersion: 2, migrations: [dropsThenFails] }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })

    const upgraded = await openDatabase({ name })
    expect(upgraded.meta.schemaVersion).toBe(SCHEMA_VERSION)
    upgraded.close()
    expect(await readIndexNames(name, 'suppliers')).toEqual([])

    await deleteDatabase(name)
  })
})
