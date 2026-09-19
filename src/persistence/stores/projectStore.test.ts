import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Money } from '../../domain/monetary/Money'
import { Quantity } from '../../domain/quantity/Quantity'
import { createProject, type Project } from '../../domain/project/Project'
import { createRequirementItem } from '../../domain/requirement/RequirementItem'
import { createSupplier } from '../../domain/supplier/Supplier'
import { createQuote } from '../../domain/quote/Quote'
import { createQuoteItem } from '../../domain/quote/QuoteItem'
import type { Database } from '../database'
import { toSupplierRecord } from '../records/supplier'
import { openTestDatabase, TEST_INSTANT, testUuid, type TestDatabase } from '../testSupport'
import {
  deleteProject,
  listProjectSummaries,
  loadProject,
  readProjectRecord,
  saveProject,
} from './projectStore'
import { saveSupplier } from './supplierStore'

let fixture: TestDatabase
let database: Database

const SUPPLIER_A = testUuid(1)
const SUPPLIER_B = testUuid(2)
const PROJECT_ID = testUuid(10)
const REQUIREMENT_ID = testUuid(20)
const QUOTE_ID = testUuid(30)
const QUOTE_ITEM_ID = testUuid(31)

/**
 * A decimal with more fractional digits than any currency's minor unit, and a
 * magnitude no float represents exactly. If the persisted form were ever a JS
 * `number`, this is the value that would come back different.
 */
const AWKWARD_PRICE = '1234.567891234567890123'
const AWKWARD_QUANTITY = '0.000000000000000001'

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
  await saveSupplier(
    database,
    toSupplierRecord(createSupplier({ id: SUPPLIER_A, displayName: 'Alpha Tedarik' }), {
      active: true,
      createdAt: TEST_INSTANT,
      updatedAt: TEST_INSTANT,
    }),
  )
  await saveSupplier(
    database,
    toSupplierRecord(createSupplier({ id: SUPPLIER_B, displayName: 'Beta Supply' }), {
      active: true,
      createdAt: TEST_INSTANT,
      updatedAt: TEST_INSTANT,
    }),
  )
})

afterEach(async () => {
  await fixture.destroy()
})

function sampleProject(overrides: { updatedAt?: string; supplierIds?: string[] } = {}): Project {
  const supplierIds = overrides.supplierIds ?? [SUPPLIER_A, SUPPLIER_B]
  return createProject({
    id: PROJECT_ID,
    name: 'Tıbbi Cihaz Alımı',
    baseCurrency: 'TRY',
    createdAt: TEST_INSTANT,
    updatedAt: overrides.updatedAt ?? TEST_INSTANT,
    requirements: [
      createRequirementItem({
        id: REQUIREMENT_ID,
        productName: 'Infusion pump',
        sku: 'IP-900',
        requiredQuantity: AWKWARD_QUANTITY,
        comparisonUnit: 'pcs',
      }),
    ],
    suppliers: supplierIds.map((id) =>
      createSupplier({ id, displayName: id === SUPPLIER_A ? 'Alpha Tedarik' : 'Beta Supply' }),
    ),
    quotes: [
      createQuote({
        id: QUOTE_ID,
        supplierId: SUPPLIER_A,
        currency: 'EUR',
        quoteDate: '2026-09-01',
        incoterm: 'FOB',
        items: [
          createQuoteItem({
            id: QUOTE_ITEM_ID,
            requirementId: REQUIREMENT_ID,
            quotedUnitPrice: Money.fromString(AWKWARD_PRICE, 'EUR'),
            quotedUnit: 'box',
            unitsPerQuotedUnit: Quantity.fromString('12.5'),
            moq: Quantity.fromString('3'),
          }),
        ],
      }),
    ],
  })
}

describe('project aggregate round trip', () => {
  it('stores the project with supplier ids and loads it with supplier objects', async () => {
    await saveProject(database, sampleProject())

    const record = await database.read(['projects'], (scope) =>
      readProjectRecord(scope, PROJECT_ID),
    )
    expect(record?.supplierIds).toEqual([SUPPLIER_A, SUPPLIER_B])
    expect(record).not.toHaveProperty('suppliers')

    const loaded = await loadProject(database, PROJECT_ID)
    expect(loaded.suppliers.map((supplier) => supplier.id)).toEqual([SUPPLIER_A, SUPPLIER_B])
    expect(loaded.suppliers[0]?.displayName).toBe('Alpha Tedarik')
  })

  it('preserves decimal values exactly, character for character', async () => {
    await saveProject(database, sampleProject())
    const loaded = await loadProject(database, PROJECT_ID)

    const item = loaded.quotes[0]?.items[0]
    expect(item?.quotedUnitPrice.toDecimalString()).toBe(AWKWARD_PRICE)
    expect(item?.quotedUnitPrice.currency).toBe('EUR')
    expect(loaded.requirements[0]?.requiredQuantity.toDecimalString()).toBe(AWKWARD_QUANTITY)
    expect(item?.unitsPerQuotedUnit?.toDecimalString()).toBe('12.5')
    expect(item?.moq?.toDecimalString()).toBe('3')
  })

  it('stores monetary values as decimal strings, never as numbers', async () => {
    await saveProject(database, sampleProject())
    const record = await database.read(['projects'], (scope) =>
      readProjectRecord(scope, PROJECT_ID),
    )
    const price = record?.quotes[0]?.items[0]?.quotedUnitPrice
    expect(typeof price?.amount).toBe('string')
    expect(price?.amount).toBe(AWKWARD_PRICE)
    expect(typeof record?.requirements[0]?.requiredQuantity.value).toBe('string')
  })

  it('stores no class instances — the record survives a JSON round trip unchanged', async () => {
    await saveProject(database, sampleProject())
    const record = await database.read(['projects'], (scope) =>
      readProjectRecord(scope, PROJECT_ID),
    )
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })

  it('preserves timestamps and business dates exactly', async () => {
    await saveProject(database, sampleProject())
    const loaded = await loadProject(database, PROJECT_ID)
    expect(loaded.createdAt).toBe(TEST_INSTANT)
    expect(loaded.updatedAt).toBe(TEST_INSTANT)
    // A business date stays a date; it never becomes an instant.
    expect(loaded.quotes[0]?.quoteDate).toBe('2026-09-01')
  })

  it('keeps ids stable across save, reload and reopen', async () => {
    await saveProject(database, sampleProject())
    fixture.database.close()

    const reopened = await openTestDatabase({ name: fixture.name })
    const loaded = await loadProject(reopened.database, PROJECT_ID)
    expect(loaded.id).toBe(PROJECT_ID)
    expect(loaded.requirements[0]?.id).toBe(REQUIREMENT_ID)
    expect(loaded.quotes[0]?.id).toBe(QUOTE_ID)
    expect(loaded.quotes[0]?.items[0]?.id).toBe(QUOTE_ITEM_ID)

    reopened.database.close()
    fixture = await openTestDatabase({ name: fixture.name })
    database = fixture.database
  })

  it('preserves supplier order, which the engine breaks ranking ties on', async () => {
    await saveProject(database, sampleProject({ supplierIds: [SUPPLIER_B, SUPPLIER_A] }))
    const loaded = await loadProject(database, PROJECT_ID)
    expect(loaded.suppliers.map((supplier) => supplier.id)).toEqual([SUPPLIER_B, SUPPLIER_A])
  })

  it('reports a missing project rather than returning undefined', async () => {
    await expect(loadProject(database, testUuid(999))).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    })
  })
})

describe('referential integrity', () => {
  it('refuses a project referencing a supplier that does not exist, writing nothing', async () => {
    const orphan = sampleProject({ supplierIds: [SUPPLIER_A, testUuid(404)] })

    await expect(saveProject(database, orphan)).rejects.toMatchObject({
      code: 'REFERENCE_MISSING',
    })

    const stored = await database.read(['projects'], (scope) => scope.count('projects'))
    expect(stored).toBe(0)
  })

  it('reports a dangling reference on load instead of hydrating a partial project', async () => {
    await saveProject(database, sampleProject())
    await database.write(['suppliers'], (scope) => scope.delete('suppliers', SUPPLIER_B))

    await expect(loadProject(database, PROJECT_ID)).rejects.toMatchObject({
      code: 'REFERENCE_MISSING',
    })
  })
})

describe('stale-write detection', () => {
  it('refuses a second create for an id that already exists', async () => {
    await saveProject(database, sampleProject())
    await expect(saveProject(database, sampleProject())).rejects.toMatchObject({
      code: 'STALE_WRITE',
    })
  })

  it('accepts an update that names the version it loaded', async () => {
    await saveProject(database, sampleProject())
    const next = sampleProject({ updatedAt: '2026-09-20T08:30:00.000Z' })

    await saveProject(database, next, { previousUpdatedAt: TEST_INSTANT })
    const loaded = await loadProject(database, PROJECT_ID)
    expect(loaded.updatedAt).toBe('2026-09-20T08:30:00.000Z')
  })

  it('refuses an update whose loaded version is no longer the stored one', async () => {
    await saveProject(database, sampleProject())
    // Another tab saved in between.
    await saveProject(database, sampleProject({ updatedAt: '2026-09-20T08:30:00.000Z' }), {
      previousUpdatedAt: TEST_INSTANT,
    })

    const error = await saveProject(
      database,
      sampleProject({ updatedAt: '2026-09-20T09:00:00.000Z' }),
      { previousUpdatedAt: TEST_INSTANT },
    ).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: 'STALE_WRITE' })

    // The refused write left the winning version in place, untouched.
    const loaded = await loadProject(database, PROJECT_ID)
    expect(loaded.updatedAt).toBe('2026-09-20T08:30:00.000Z')
  })

  it('refuses an update to a project that has been deleted', async () => {
    await expect(
      saveProject(database, sampleProject(), { previousUpdatedAt: TEST_INSTANT }),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' })
  })
})

describe('project list', () => {
  it('lists summaries newest first without hydrating the aggregates', async () => {
    await saveProject(database, sampleProject())
    await saveProject(
      database,
      createProject({
        id: testUuid(11),
        name: 'Second project',
        baseCurrency: 'USD',
        createdAt: TEST_INSTANT,
        updatedAt: '2026-09-25T10:00:00.000Z',
        suppliers: [createSupplier({ id: SUPPLIER_A, displayName: 'Alpha Tedarik' })],
      }),
    )

    const summaries = await listProjectSummaries(database)
    expect(summaries.map((summary) => summary.name)).toEqual([
      'Second project',
      'Tıbbi Cihaz Alımı',
    ])
    expect(summaries[0]).not.toHaveProperty('quotes')
  })

  it('deletes a project', async () => {
    await saveProject(database, sampleProject())
    await deleteProject(database, PROJECT_ID)
    expect(await listProjectSummaries(database)).toEqual([])
  })
})
