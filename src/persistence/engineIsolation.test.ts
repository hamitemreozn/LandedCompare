/**
 * The engine must not notice that persistence exists.
 *
 * Phase 7 added a storage layer under an audited financial engine. The risk
 * that matters is not that a record fails to save — a test would catch that
 * immediately — but that a project which has been through the database
 * compares *slightly* differently from the one that has not: a decimal
 * truncated on the way out, a supplier reordered, an optional MOQ lost.
 *
 * So this suite runs the real comparison engine twice, on the in-memory
 * project and on the same project after a full save/load round trip, and
 * requires the two results to be identical.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'
import { createProject, type Project } from '../domain/project/Project'
import { createRequirementItem } from '../domain/requirement/RequirementItem'
import { createSupplier } from '../domain/supplier/Supplier'
import { createQuote } from '../domain/quote/Quote'
import { createQuoteItem } from '../domain/quote/QuoteItem'
import { ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { compareSuppliers, type SupplierComparisonResult } from '../comparison/SupplierComparison'
import type { Database } from './database'
import { toSupplierRecord } from './records/supplier'
import { loadProject, saveProject } from './stores/projectStore'
import { saveSupplier } from './stores/supplierStore'
import { openTestDatabase, TEST_INSTANT, testUuid, type TestDatabase } from './testSupport'

let fixture: TestDatabase
let database: Database

const SUPPLIER_CHEAP = testUuid(1)
const SUPPLIER_PRICEY = testUuid(2)
const REQUIREMENT_A = testUuid(10)
const REQUIREMENT_B = testUuid(11)

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
  for (const [id, name] of [
    [SUPPLIER_CHEAP, 'Cheap Supplier'],
    [SUPPLIER_PRICEY, 'Pricey Supplier'],
  ] as const) {
    await saveSupplier(
      database,
      toSupplierRecord(createSupplier({ id, displayName: name }), {
        active: true,
        createdAt: TEST_INSTANT,
        updatedAt: TEST_INSTANT,
      }),
    )
  }
})

afterEach(async () => {
  await fixture.destroy()
})

function comparableProject(): Project {
  return createProject({
    id: testUuid(100),
    name: 'Engine isolation project',
    baseCurrency: 'EUR',
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
    requirements: [
      createRequirementItem({
        id: REQUIREMENT_A,
        productName: 'Sensor',
        requiredQuantity: '137',
        comparisonUnit: 'pcs',
      }),
      createRequirementItem({
        id: REQUIREMENT_B,
        productName: 'Cable',
        requiredQuantity: '9.75',
        comparisonUnit: 'm',
      }),
    ],
    suppliers: [
      createSupplier({ id: SUPPLIER_CHEAP, displayName: 'Cheap Supplier' }),
      createSupplier({ id: SUPPLIER_PRICEY, displayName: 'Pricey Supplier' }),
    ],
    quotes: [
      createQuote({
        id: testUuid(200),
        supplierId: SUPPLIER_CHEAP,
        currency: 'EUR',
        items: [
          createQuoteItem({
            id: testUuid(201),
            requirementId: REQUIREMENT_A,
            quotedUnitPrice: Money.fromString('3.335', 'EUR'),
            quotedUnit: 'pack',
            unitsPerQuotedUnit: Quantity.fromString('12'),
            moq: Quantity.fromString('5'),
          }),
          createQuoteItem({
            id: testUuid(202),
            requirementId: REQUIREMENT_B,
            quotedUnitPrice: Money.fromString('0.005', 'EUR'),
            quotedUnit: 'm',
          }),
        ],
      }),
      createQuote({
        id: testUuid(210),
        supplierId: SUPPLIER_PRICEY,
        currency: 'EUR',
        items: [
          createQuoteItem({
            id: testUuid(211),
            requirementId: REQUIREMENT_A,
            quotedUnitPrice: Money.fromString('3.34', 'EUR'),
            quotedUnit: 'pcs',
          }),
          createQuoteItem({
            id: testUuid(212),
            requirementId: REQUIREMENT_B,
            quotedUnitPrice: Money.fromString('0.006', 'EUR'),
            quotedUnit: 'm',
          }),
        ],
      }),
    ],
  })
}

function compare(project: Project): SupplierComparisonResult {
  return compareSuppliers({ project, exchangeRateTable: ExchangeRateTable.create('EUR') })
}

/** A comparison result reduced to the figures a user would actually read. */
function readableResult(result: SupplierComparisonResult) {
  return {
    baseCurrency: result.baseCurrency,
    minorUnit: result.minorUnit,
    lowestSupplierIds: [...result.lowestSupplierIds],
    insights: result.insights.map((insight) => insight.code),
    suppliers: result.supplierResults.map((entry) => ({
      supplierId: entry.supplierId,
      status: entry.status,
      rank: entry.rank,
      rankingAmount: entry.rankingAmount?.toDecimalString(),
      settledLandedTotal: entry.costResult?.settledLandedTotal.toDecimalString(),
      calculatedLandedTotal: entry.costResult?.calculatedLandedTotal.toDecimalString(),
      differenceFromLowest: entry.differenceFromLowest?.toDecimalString(),
      lines: entry.lines?.map((line) => ({
        requirementId: line.requirementId,
        resolvedQuantity: line.resolvedQuantity?.toDecimalString(),
        excessQuantity: line.excessQuantity?.toDecimalString(),
      })),
    })),
  }
}

describe('financial behaviour across the persistence boundary', () => {
  it('produces an identical comparison before and after a save/load round trip', async () => {
    const original = comparableProject()
    const before = compare(original)

    await saveProject(database, original)
    const reloaded = await loadProject(database, original.id)
    const after = compare(reloaded)

    expect(readableResult(after)).toEqual(readableResult(before))
  })

  it('survives a database close and reopen', async () => {
    const original = comparableProject()
    const before = compare(original)

    await saveProject(database, original)
    database.close()

    const reopened = await openTestDatabase({ name: fixture.name })
    const reloaded = await loadProject(reopened.database, original.id)
    expect(readableResult(compare(reloaded))).toEqual(readableResult(before))

    reopened.database.close()
    fixture = await openTestDatabase({ name: fixture.name })
    database = fixture.database
  })

  it('rebuilds Money and Quantity as real value objects, not plain records', async () => {
    const original = comparableProject()
    await saveProject(database, original)
    const reloaded = await loadProject(database, original.id)

    const item = reloaded.quotes[0]?.items[0]
    expect(item?.quotedUnitPrice).toBeInstanceOf(Money)
    expect(item?.unitsPerQuotedUnit).toBeInstanceOf(Quantity)
    expect(reloaded.requirements[0]?.requiredQuantity).toBeInstanceOf(Quantity)
    // Rebuilt through the factories, so the arithmetic still works.
    expect(item?.quotedUnitPrice.multiply('2').toDecimalString()).toBe('6.67')
  })
})
