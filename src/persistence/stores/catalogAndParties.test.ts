import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../database'
import { isPersistenceError } from '../errors'
import type { CustomerRecord } from '../records/customer'
import type { ProductRecord } from '../records/product'
import { normaliseSku } from '../records/product'
import { STORE_DEFINITIONS } from '../schema'
import { openTestDatabase, TEST_INSTANT, testUuid, type TestDatabase } from '../testSupport'
import {
  listCustomerRecords,
  loadCustomerRecord,
  saveCustomer,
} from './customerStore'
import { listProductRecords, loadProductRecord, saveProduct } from './productStore'

let fixture: TestDatabase
let database: Database

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
})

afterEach(async () => {
  await fixture.destroy()
})

function product(seed: number, overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: testUuid(seed),
    sku: `SKU-${seed}`,
    name: `Product ${seed}`,
    stockUnit: 'adet',
    active: true,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
    ...overrides,
  }
}

function customer(seed: number, overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: testUuid(seed),
    displayName: `Customer ${seed}`,
    active: true,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
    ...overrides,
  }
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
    return 'did-not-throw'
  } catch (cause) {
    return isPersistenceError(cause) ? cause.code : `unexpected:${String(cause)}`
  }
}

describe('product catalog', () => {
  it('round-trips every canonical field, and stores no stock quantity', async () => {
    await saveProduct(
      database,
      product(1, {
        description: 'Paslanmaz çelik bağlantı elemanı',
        defaultPurchaseUnit: 'kutu',
        unitsPerPurchaseUnit: { value: '50' },
        manufacturer: 'Acme',
        manufacturerRef: 'ACM-9911',
        note: 'Pilot kaydı',
      }),
    )

    const stored = await loadProductRecord(database, testUuid(1))
    expect(stored.unitsPerPurchaseUnit).toEqual({ value: '50' })
    expect(stored.stockUnit).toBe('adet')
    // Physical stock is Σ(IN) − Σ(OUT) over the ledger (Data Model I1). A
    // quantity on the product would be a second, competing answer.
    expect(Object.keys(stored)).not.toContain('stockQuantity')
  })

  it('omits an absent optional field rather than storing an explicit undefined', async () => {
    await saveProduct(database, product(2))

    const raw = await database.read(['products'], (scope) =>
      scope.get<Record<string, unknown>>('products', testUuid(2)),
    )
    expect(Object.keys(raw!).sort()).toEqual(
      ['id', 'sku', 'name', 'stockUnit', 'active', 'createdAt', 'updatedAt'].sort(),
    )
  })

  it('refuses a SKU another product already uses, whatever its casing', async () => {
    await saveProduct(database, product(3, { sku: 'ABC-100' }))

    expect(await codeOf(() => saveProduct(database, product(4, { sku: 'abc-100' })))).toBe(
      'DUPLICATE_KEY',
    )
    expect(await codeOf(() => saveProduct(database, product(4, { sku: 'ABC-100' })))).toBe(
      'DUPLICATE_KEY',
    )
    // The refusal happened before the write: the store still holds one record.
    expect(await listProductRecords(database)).toHaveLength(1)
  })

  it('lets a product keep its own SKU across an edit', async () => {
    await saveProduct(database, product(5, { sku: 'KEEP-1' }))
    await saveProduct(
      database,
      product(5, { sku: 'KEEP-1', name: 'Renamed', updatedAt: '2026-09-20T00:00:00.000Z' }),
      { previousUpdatedAt: TEST_INSTANT },
    )

    expect((await loadProductRecord(database, testUuid(5))).name).toBe('Renamed')
  })

  it('folds SKU case independently of the UI locale', () => {
    // `toLocaleLowerCase('tr')` would fold "I" to the dotless "ı", so the same
    // catalogue would accept or refuse a SKU depending on the selected
    // language. Identity must not depend on presentation.
    expect(normaliseSku('  ISO-1 ')).toBe('iso-1')
    expect(normaliseSku('iso-1')).toBe('iso-1')
    expect(normaliseSku('ISO-1')).not.toBe(normaliseSku('ıso-1'))
  })

  it('deactivates rather than deleting, so future references stay resolvable', async () => {
    await saveProduct(database, product(6))
    await saveProduct(
      database,
      product(6, { active: false, updatedAt: '2026-09-20T00:00:00.000Z' }),
      { previousUpdatedAt: TEST_INSTANT },
    )

    const stored = await loadProductRecord(database, testUuid(6))
    expect(stored.active).toBe(false)
    expect(stored.id).toBe(testUuid(6))
  })

  it('refuses a write whose loaded version is stale', async () => {
    await saveProduct(database, product(7))
    expect(
      await codeOf(() =>
        saveProduct(database, product(7, { name: 'Loser' }), {
          previousUpdatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe('STALE_WRITE')
  })

  it('rejects a pack factor of zero instead of storing a division by zero', async () => {
    expect(
      await codeOf(() =>
        saveProduct(database, product(8, { unitsPerPurchaseUnit: { value: '0' } })),
      ),
    ).toBe('RECORD_INVALID')
  })

  it('rejects an untrimmed SKU rather than silently trimming it on the way in', async () => {
    expect(await codeOf(() => saveProduct(database, product(9, { sku: ' SKU-9 ' })))).toBe(
      'RECORD_INVALID',
    )
  })

  it('rejects a corrupted stored record on read instead of returning it', async () => {
    await saveProduct(database, product(10))
    await database.write(['products'], (scope) =>
      scope.put('products', { ...product(10), stockUnit: 42 }),
    )

    expect(await codeOf(() => loadProductRecord(database, testUuid(10)))).toBe('RECORD_INVALID')
  })

  it('reports a missing product by name', async () => {
    expect(await codeOf(() => loadProductRecord(database, testUuid(99)))).toBe('RECORD_NOT_FOUND')
  })
})

describe('customer master', () => {
  it('round-trips the minimal canonical shape and nothing more', async () => {
    await saveCustomer(database, customer(20, { externalRef: 'LOGO-4411', note: 'Pilot' }))

    const stored = await loadCustomerRecord(database, testUuid(20))
    expect(Object.keys(stored).sort()).toEqual(
      ['id', 'displayName', 'externalRef', 'active', 'note', 'createdAt', 'updatedAt'].sort(),
    )
  })

  it('allows two customers to share an externalRef, because it is not an identifier', async () => {
    await saveCustomer(database, customer(21, { externalRef: 'LOGO-1' }))
    await saveCustomer(database, customer(22, { externalRef: 'LOGO-1' }))

    expect(await listCustomerRecords(database)).toHaveLength(2)
  })

  it('deactivates rather than deleting', async () => {
    await saveCustomer(database, customer(23))
    await saveCustomer(
      database,
      customer(23, { active: false, updatedAt: '2026-09-20T00:00:00.000Z' }),
      { previousUpdatedAt: TEST_INSTANT },
    )

    expect((await loadCustomerRecord(database, testUuid(23))).active).toBe(false)
  })

  it('refuses a write whose loaded version is stale', async () => {
    await saveCustomer(database, customer(24))
    expect(
      await codeOf(() =>
        saveCustomer(database, customer(24, { displayName: 'Loser' }), {
          previousUpdatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe('STALE_WRITE')
  })

  it('refuses a create that would overwrite an existing record', async () => {
    await saveCustomer(database, customer(25))
    expect(await codeOf(() => saveCustomer(database, customer(25)))).toBe('STALE_WRITE')
  })

  it('rejects an unknown field rather than dropping it', async () => {
    expect(
      await codeOf(() =>
        saveCustomer(database, {
          ...customer(26),
          creditLimit: '100000',
        } as unknown as CustomerRecord),
      ),
    ).toBe('RECORD_INVALID')
  })
})

describe('active/inactive is a filtered read, never an index', () => {
  it('lists every record so the application layer can filter it', async () => {
    await saveProduct(database, product(30, { active: true }))
    await saveProduct(database, product(31, { active: false }))
    await saveCustomer(database, customer(32, { active: false }))

    // The three `active` indexes were removed at schemaVersion 2 because a
    // boolean is not a valid IndexedDB key: a query through one returned
    // nothing over a populated store. Reading the store is the correct answer
    // at pilot volume, and this is the shape the UI consumes.
    expect(await listProductRecords(database)).toHaveLength(2)
    expect((await listProductRecords(database)).filter((item) => item.active)).toHaveLength(1)
    expect((await listCustomerRecords(database)).filter((item) => !item.active)).toHaveLength(1)
  })

  it('declares no index on any of the three master stores beyond the SKU', () => {
    // The claim is about what this build *declares*: the regression to catch
    // is someone re-adding `active` — or an `activeFlag` mirror of it — to
    // `STORE_DEFINITIONS`.
    const declared = STORE_DEFINITIONS.filter((definition) =>
      ['products', 'suppliers', 'customers'].includes(definition.name),
    ).flatMap((definition) =>
      definition.indexes.map((index) => `${definition.name}.${index.name}`),
    )

    expect(declared).toEqual(['products.sku'])
  })
})
