import { describe, expect, it } from 'vitest'
import { deleteDatabase, openDatabase } from './database'
import { isPersistenceError, PersistenceError } from './errors'
import {
  DATABASE_NAME,
  SCHEMA_VERSION,
  STORE_DEFINITIONS,
  STORE_NAMES,
  BUSINESS_STORE_NAMES,
} from './schema'
import { META_KEY } from './records/meta'
import { createTestDatabaseName, openTestDatabase } from './testSupport'

async function expectPersistenceError(
  operation: Promise<unknown>,
  code: string,
): Promise<PersistenceError> {
  try {
    await operation
  } catch (error) {
    if (!isPersistenceError(error)) {
      throw error
    }
    expect(error.code).toBe(code)
    return error
  }
  throw new Error(`Expected the operation to fail with ${code}, but it resolved`)
}

describe('database identity', () => {
  it('uses one stable, non-derived database name', () => {
    expect(DATABASE_NAME).toBe('landedcompare')
  })

  it('excludes meta and snapshots from the business stores a backup covers', () => {
    expect(BUSINESS_STORE_NAMES).not.toContain('meta')
    expect(BUSINESS_STORE_NAMES).not.toContain('snapshots')
    expect(BUSINESS_STORE_NAMES).toContain('projects')
    expect(BUSINESS_STORE_NAMES).toContain('inventoryMovements')
  })
})

describe('opening the database', () => {
  it('creates every store from the canonical layout, with its indexes', async () => {
    const name = createTestDatabaseName('layout')
    const database = await openDatabase({ name })

    const found = await database.read(STORE_NAMES, async (scope) => {
      const counts = new Map<string, number>()
      for (const store of STORE_NAMES) {
        counts.set(store, await scope.count(store))
      }
      return counts
    })

    expect([...found.keys()].sort()).toEqual([...STORE_NAMES].sort())
    database.close()
    await deleteDatabase(name)
  })

  it('creates the declared indexes, including the compound ledger index', async () => {
    const name = createTestDatabaseName('indexes')
    const database = await openDatabase({ name })

    // Reading through an index only succeeds if the index was actually created.
    const movements = await database.read(['inventoryMovements'], (scope) =>
      scope.getAllFromIndex<unknown>('inventoryMovements', 'productId_occurredAt'),
    )
    expect(movements).toEqual([])

    const products = await database.read(['products'], (scope) =>
      scope.getAllFromIndex<unknown>('products', 'sku'),
    )
    expect(products).toEqual([])

    database.close()
    await deleteDatabase(name)
  })

  it('declares an index for every index named in the store layout', async () => {
    const name = createTestDatabaseName('index-coverage')
    const database = await openDatabase({ name })

    for (const definition of STORE_DEFINITIONS) {
      for (const index of definition.indexes) {
        const rows = await database.read([definition.name], (scope) =>
          scope.getAllFromIndex<unknown>(definition.name, index.name),
        )
        expect(rows).toEqual([])
      }
    }

    database.close()
    await deleteDatabase(name)
  })

  it('stamps the meta record with the schema version, app version and an install id', async () => {
    const { database, destroy } = await openTestDatabase()

    expect(database.meta.key).toBe(META_KEY)
    expect(database.meta.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.meta.appVersion).not.toBe('')
    expect(database.meta.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )

    await destroy()
  })

  it('preserves installId and createdAt when the database is reopened', async () => {
    const name = createTestDatabaseName('reopen-meta')
    const first = await openDatabase({ name })
    const { installId, createdAt } = first.meta
    first.close()

    const second = await openDatabase({ name })
    expect(second.meta.installId).toBe(installId)
    expect(second.meta.createdAt).toBe(createdAt)

    second.close()
    await deleteDatabase(name)
  })

  it('reports an unusable environment instead of throwing a raw TypeError', async () => {
    const host = globalThis as { indexedDB?: IDBFactory }
    const original = host.indexedDB
    delete host.indexedDB
    try {
      await expectPersistenceError(
        openDatabase({ name: createTestDatabaseName('no-idb') }),
        'ENVIRONMENT_UNSUPPORTED',
      )
    } finally {
      host.indexedDB = original
    }
  })
})

describe('refusing data this build cannot safely handle', () => {
  it('refuses a database whose IndexedDB version is newer than this build', async () => {
    const name = createTestDatabaseName('too-new')

    // A future build's database: schemaVersion 2, created through the same code
    // path with a migration chain this build does not have.
    const future = await openDatabase({
      name,
      schemaVersion: 2,
      migrations: [{ to: 2, description: 'future schema', migrate: () => {} }],
    })
    future.close()

    const error = await expectPersistenceError(
      openDatabase({ name }),
      'SCHEMA_VERSION_TOO_NEW',
    )
    expect(error.details.supportedVersion).toBe(SCHEMA_VERSION)

    await deleteDatabase(name)
  })

  it('refuses a stored meta record claiming a newer schema version', async () => {
    const name = createTestDatabaseName('meta-too-new')
    const database = await openDatabase({ name })
    await database.write(['meta'], (scope) =>
      scope.put('meta', { ...database.meta, schemaVersion: SCHEMA_VERSION + 5 }),
    )
    database.close()

    const error = await expectPersistenceError(openDatabase({ name }), 'SCHEMA_VERSION_TOO_NEW')
    expect(error.details.storedVersion).toBe(SCHEMA_VERSION + 5)

    await deleteDatabase(name)
  })

  it('refuses a database whose meta record is missing', async () => {
    const name = createTestDatabaseName('meta-missing')
    const database = await openDatabase({ name })
    await database.write(['meta'], (scope) => scope.delete('meta', META_KEY))
    database.close()

    await expectPersistenceError(openDatabase({ name }), 'SCHEMA_METADATA_INVALID')
    await deleteDatabase(name)
  })

  it('refuses a database whose meta record is malformed', async () => {
    const name = createTestDatabaseName('meta-malformed')
    const database = await openDatabase({ name })
    await database.write(['meta'], (scope) =>
      scope.put('meta', { key: META_KEY, schemaVersion: SCHEMA_VERSION, appVersion: 1 }),
    )
    database.close()

    await expectPersistenceError(openDatabase({ name }), 'RECORD_INVALID')
    await deleteDatabase(name)
  })
})

describe('deleting a database', () => {
  it('refuses to delete the production database without an explicit token', async () => {
    await expectPersistenceError(deleteDatabase(DATABASE_NAME), 'DESTRUCTIVE_OPERATION_REFUSED')
  })

  it('deletes a test database freely', async () => {
    const name = createTestDatabaseName('disposable')
    const database = await openDatabase({ name })
    database.close()
    await expect(deleteDatabase(name)).resolves.toBeUndefined()
  })
})
