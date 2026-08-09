import { describe, expect, it } from 'vitest'
import { compareSuppliers } from './SupplierComparison'
import { createAdditionalCost } from '../calculation/AdditionalCost'
import { ExchangeRate } from '../calculation/ExchangeRate'
import { ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * Golden Scenario 1 — incomplete supplier trap. A supplier missing a
 * required item must never win, no matter how low its partial apparent
 * total looks. See docs/CALCULATION_RULES.md, "Golden scenarios".
 */
describe('Golden Scenario 1 — incomplete supplier trap', () => {
  it('never lets the incomplete supplier outrank the complete one', () => {
    const requirements = [requirement('A', { requiredQuantity: '1' }), requirement('B', { requiredQuantity: '1' })]
    const suppliers = [supplier('supplierA'), supplier('supplierB')]
    const quotes = [
      quote({
        id: 'q-supplierA',
        supplierId: 'supplierA',
        currency: 'TRY',
        items: [
          quoteItem({ id: 'a1', requirementId: 'A', price: '1000', currency: 'TRY' }),
          quoteItem({ id: 'a2', requirementId: 'B', price: '1000', currency: 'TRY' }),
        ],
      }),
      quote({
        id: 'q-supplierB',
        supplierId: 'supplierB',
        currency: 'TRY',
        items: [quoteItem({ id: 'b1', requirementId: 'A', price: '500', currency: 'TRY' })],
      }),
    ]
    const p = project({ baseCurrency: 'TRY', requirements, suppliers, quotes })
    const result = compareSuppliers({ project: p, exchangeRateTable: baseRateTable('TRY') })

    const a = result.supplierResults.find((r) => r.supplierId === 'supplierA')!
    const b = result.supplierResults.find((r) => r.supplierId === 'supplierB')!

    expect(a.status).toBe('COMPLETE')
    expect(a.exactCalculatedLandedTotal?.toDecimalString()).toBe('2000')
    expect(a.rank).toBe(1)

    expect(b.status).toBe('INCOMPLETE')
    expect(b.rank).toBeUndefined()
    expect(b.missingRequirementIds).toEqual(['B'])
    expect(result.rankedCompleteSuppliers.map((r) => r.supplierId)).toEqual(['supplierA'])
    expect(result.lowestSupplierIds).toEqual(['supplierA'])
  })
})

/**
 * Golden Scenario 2 — sub-minor-unit tie and the half-up boundary that
 * separates it. Ranking runs on `rankingAmount` (minor-unit settled), never
 * on the raw exact landed total.
 */
describe('Golden Scenario 2 — sub-minor-unit tie and half-up boundary', () => {
  function landedTotalsFor(exactA: string, exactB: string) {
    const requirements = [requirement('R', { requiredQuantity: '1' })]
    const suppliers = [supplier('a'), supplier('b')]
    const quotes = [
      quote({
        id: 'qa',
        supplierId: 'a',
        currency: 'TRY',
        items: [quoteItem({ id: 'ia', requirementId: 'R', price: exactA, currency: 'TRY' })],
      }),
      quote({
        id: 'qb',
        supplierId: 'b',
        currency: 'TRY',
        items: [quoteItem({ id: 'ib', requirementId: 'R', price: exactB, currency: 'TRY' })],
      }),
    ]
    const p = project({ baseCurrency: 'TRY', requirements, suppliers, quotes })
    return compareSuppliers({ project: p, exchangeRateTable: baseRateTable('TRY') })
  }

  it('ties 100.004 and 100.001 TRY once both settle to 100.00', () => {
    const result = landedTotalsFor('100.004', '100.001')
    const a = result.supplierResults.find((r) => r.supplierId === 'a')!
    const b = result.supplierResults.find((r) => r.supplierId === 'b')!

    expect(a.exactCalculatedLandedTotal?.toDecimalString()).toBe('100.004')
    expect(b.exactCalculatedLandedTotal?.toDecimalString()).toBe('100.001')
    expect(a.rankingAmount?.toDecimalString()).toBe('100')
    expect(b.rankingAmount?.toDecimalString()).toBe('100')
    expect(a.rank).toBe(1)
    expect(b.rank).toBe(1)
    expect([...result.lowestSupplierIds].sort()).toEqual(['a', 'b'])
    expect(result.insights).toContainEqual({
      code: 'TIED_LOWEST_CALCULATED_LANDED_COST',
      supplierIds: ['a', 'b'],
      rankingAmount: Money.fromString('100', 'TRY'),
    })
  })

  it('separates 100.005 (rounds up) from 100.004 (does not) at the half-up boundary', () => {
    const result = landedTotalsFor('100.005', '100.004')
    const a = result.supplierResults.find((r) => r.supplierId === 'a')!
    const b = result.supplierResults.find((r) => r.supplierId === 'b')!

    expect(a.rankingAmount?.toDecimalString()).toBe('100.01')
    expect(b.rankingAmount?.toDecimalString()).toBe('100')
    expect(b.rank).toBe(1)
    expect(a.rank).toBe(2)
    expect(result.lowestSupplierIds).toEqual(['b'])
  })
})

/**
 * Golden Scenario 3 — the lowest-merchandise supplier is not always the
 * lowest-landed-cost supplier.
 */
describe('Golden Scenario 3 — merchandise leader flips against landed-cost winner', () => {
  it('flags the merchandise leader when it does not win on landed cost', () => {
    const requirements = [requirement('R', { requiredQuantity: '1' })]
    const suppliers = [supplier('a'), supplier('b')]
    const quotes = [
      quote({
        id: 'qa',
        supplierId: 'a',
        currency: 'TRY',
        items: [quoteItem({ id: 'ia', requirementId: 'R', price: '1000', currency: 'TRY' })],
      }),
      quote({
        id: 'qb',
        supplierId: 'b',
        currency: 'TRY',
        items: [quoteItem({ id: 'ib', requirementId: 'R', price: '950', currency: 'TRY' })],
      }),
    ]
    const p = project({ baseCurrency: 'TRY', requirements, suppliers, quotes })
    const result = compareSuppliers({
      project: p,
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        a: [
          createAdditionalCost({
            id: 'freight-a',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('100', 'TRY'),
          }),
        ],
        b: [
          createAdditionalCost({
            id: 'freight-b',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('200', 'TRY'),
          }),
        ],
      },
    })

    const a = result.supplierResults.find((r) => r.supplierId === 'a')!
    const b = result.supplierResults.find((r) => r.supplierId === 'b')!
    expect(a.merchandiseTotal?.toDecimalString()).toBe('1000')
    expect(a.exactCalculatedLandedTotal?.toDecimalString()).toBe('1100')
    expect(b.merchandiseTotal?.toDecimalString()).toBe('950')
    expect(b.exactCalculatedLandedTotal?.toDecimalString()).toBe('1150')
    expect(a.rank).toBe(1)
    expect(b.rank).toBe(2)

    expect(result.insights).toContainEqual({
      code: 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST',
      lowestMerchandiseSupplierIds: ['b'],
      lowestLandedSupplierIds: ['a'],
      lowestMerchandiseAmount: Money.fromString('950', 'TRY'),
      lowestLandedRankingAmount: Money.fromString('1100', 'TRY'),
    })
  })
})

/**
 * The required 3-supplier comparison golden scenario: two complete suppliers
 * (one with higher merchandise/lower costs, one with lower merchandise/
 * higher costs) and one incomplete supplier with a deceptively low apparent
 * partial total. Runs through the real, generic engines end to end.
 */
describe('Comparison golden scenario — three suppliers, one incomplete trap', () => {
  it('ranks only the complete suppliers and explains the merchandise/landed flip', () => {
    const requirements = [
      requirement('R1', { requiredQuantity: '10' }),
      requirement('R2', { requiredQuantity: '5' }),
    ]
    const suppliers = [supplier('supplierA'), supplier('supplierB'), supplier('supplierC')]
    const quotes = [
      quote({
        id: 'q-supplierA',
        supplierId: 'supplierA',
        currency: 'TRY',
        items: [
          quoteItem({ id: 'a-r1', requirementId: 'R1', price: '105', currency: 'TRY' }),
          quoteItem({ id: 'a-r2', requirementId: 'R2', price: '100', currency: 'TRY' }),
        ],
      }),
      quote({
        id: 'q-supplierB',
        supplierId: 'supplierB',
        currency: 'TRY',
        items: [
          quoteItem({ id: 'b-r1', requirementId: 'R1', price: '95', currency: 'TRY' }),
          quoteItem({ id: 'b-r2', requirementId: 'R2', price: '90', currency: 'TRY' }),
        ],
      }),
      quote({
        id: 'q-supplierC',
        supplierId: 'supplierC',
        currency: 'TRY',
        items: [quoteItem({ id: 'c-r1', requirementId: 'R1', price: '1', currency: 'TRY' })],
      }),
    ]
    const p = project({ baseCurrency: 'TRY', requirements, suppliers, quotes })
    const result = compareSuppliers({
      project: p,
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        supplierA: [
          createAdditionalCost({
            id: 'freight-a',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('50', 'TRY'),
          }),
        ],
        supplierB: [
          createAdditionalCost({
            id: 'freight-b',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('300', 'TRY'),
          }),
        ],
      },
    })

    const a = result.supplierResults.find((r) => r.supplierId === 'supplierA')!
    const b = result.supplierResults.find((r) => r.supplierId === 'supplierB')!
    const c = result.supplierResults.find((r) => r.supplierId === 'supplierC')!

    // Merchandise: A = 10x105 + 5x100 = 1550; B = 10x95 + 5x90 = 1400.
    expect(a.merchandiseTotal?.toDecimalString()).toBe('1550')
    expect(b.merchandiseTotal?.toDecimalString()).toBe('1400')
    // Landed: A = 1550 + 50 = 1600; B = 1400 + 300 = 1700.
    expect(a.exactCalculatedLandedTotal?.toDecimalString()).toBe('1600')
    expect(b.exactCalculatedLandedTotal?.toDecimalString()).toBe('1700')

    expect(c.status).toBe('INCOMPLETE')
    expect(c.rank).toBeUndefined()
    expect(result.rankedCompleteSuppliers.map((r) => r.supplierId)).toEqual(['supplierA', 'supplierB'])

    expect(a.rank).toBe(1)
    expect(b.rank).toBe(2)
    expect(b.differenceFromLowest?.toDecimalString()).toBe('100')
    expect(b.percentageDifferenceFromLowest?.toDecimalString()).toBe('6.25')

    expect(result.insights).toContainEqual({
      code: 'LOWEST_CALCULATED_LANDED_COST',
      supplierId: 'supplierA',
      rankingAmount: Money.fromString('1600', 'TRY'),
    })
    expect(result.insights).toContainEqual({
      code: 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST',
      lowestMerchandiseSupplierIds: ['supplierB'],
      lowestLandedSupplierIds: ['supplierA'],
      lowestMerchandiseAmount: Money.fromString('1400', 'TRY'),
      lowestLandedRankingAmount: Money.fromString('1600', 'TRY'),
    })
    expect(result.insights).toContainEqual({
      code: 'INCOMPLETE_QUOTE',
      supplierId: 'supplierC',
      missingRequirementIds: ['R2'],
    })
  })
})

describe('Integration — MOQ trap survives the full comparison pipeline', () => {
  it('ranks the supplier with no binding MOQ ahead of the lower-unit-price supplier whose MOQ forces a larger order', () => {
    const requirements = [requirement('pcs', { requiredQuantity: '100', comparisonUnit: 'pcs' })]
    const suppliers = [supplier('noMoq'), supplier('boundByMoq')]
    const quotes = [
      quote({
        id: 'q-noMoq',
        supplierId: 'noMoq',
        currency: 'USD',
        items: [quoteItem({ id: 'i1', requirementId: 'pcs', price: '11', currency: 'USD' })],
      }),
      quote({
        id: 'q-boundByMoq',
        supplierId: 'boundByMoq',
        currency: 'USD',
        items: [quoteItem({ id: 'i2', requirementId: 'pcs', price: '9', currency: 'USD', moq: '150' })],
      }),
    ]
    const p = project({ baseCurrency: 'USD', requirements, suppliers, quotes })
    const result = compareSuppliers({ project: p, exchangeRateTable: baseRateTable('USD') })

    const noMoq = result.supplierResults.find((r) => r.supplierId === 'noMoq')!
    const boundByMoq = result.supplierResults.find((r) => r.supplierId === 'boundByMoq')!

    expect(noMoq.exactCalculatedLandedTotal?.toDecimalString()).toBe('1100')
    expect(boundByMoq.exactCalculatedLandedTotal?.toDecimalString()).toBe('1350')
    expect(noMoq.rank).toBe(1)
    expect(boundByMoq.rank).toBe(2)
  })
})

describe('Integration — pack resolution and cost allocation feed into ranking', () => {
  it('ranks a pack-resolved, cost-allocated supplier correctly against a plain one', () => {
    const requirements = [requirement('pcs', { requiredQuantity: '105', comparisonUnit: 'pcs' })]
    const suppliers = [supplier('packed'), supplier('plain')]
    const quotes = [
      quote({
        id: 'q-packed',
        supplierId: 'packed',
        currency: 'USD',
        items: [
          quoteItem({
            id: 'i1',
            requirementId: 'pcs',
            price: '70',
            currency: 'USD',
            unitsPerQuotedUnit: '10',
          }),
        ],
      }),
      quote({
        id: 'q-plain',
        supplierId: 'plain',
        currency: 'USD',
        items: [quoteItem({ id: 'i2', requirementId: 'pcs', price: '8', currency: 'USD' })],
      }),
    ]
    const p = project({ baseCurrency: 'USD', requirements, suppliers, quotes })
    const result = compareSuppliers({
      project: p,
      exchangeRateTable: baseRateTable('USD'),
      costsBySupplierId: {
        packed: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('30', 'USD'),
          }),
        ],
      },
    })

    const packed = result.supplierResults.find((r) => r.supplierId === 'packed')!
    const plain = result.supplierResults.find((r) => r.supplierId === 'plain')!

    // 105 pcs / 10 pcs-per-box -> 11 boxes -> 110 pcs @ 70 USD/box = 770 USD; + 30 USD freight = 800 USD.
    expect(packed.merchandiseTotal?.toDecimalString()).toBe('770')
    expect(packed.exactCalculatedLandedTotal?.toDecimalString()).toBe('800')
    expect(packed.costAllocation?.byLine[0]?.allocatedCostTotal.toDecimalString()).toBe('30')

    // 105 pcs @ 8 USD/pcs = 840 USD, no additional costs.
    expect(plain.exactCalculatedLandedTotal?.toDecimalString()).toBe('840')

    expect(packed.rank).toBe(1)
    expect(plain.rank).toBe(2)
  })
})

describe('Integration — multi-currency complete supplier comparison', () => {
  it('converts every complete supplier into the base currency before ranking', () => {
    const requirements = [requirement('R', { requiredQuantity: '10' })]
    const suppliers = [supplier('usdSupplier'), supplier('eurSupplier')]
    const quotes = [
      quote({
        id: 'q-usd',
        supplierId: 'usdSupplier',
        currency: 'USD',
        items: [quoteItem({ id: 'i1', requirementId: 'R', price: '10', currency: 'USD' })],
      }),
      quote({
        id: 'q-eur',
        supplierId: 'eurSupplier',
        currency: 'EUR',
        items: [quoteItem({ id: 'i2', requirementId: 'R', price: '8', currency: 'EUR' })],
      }),
    ]
    const p = project({ baseCurrency: 'TRY', requirements, suppliers, quotes })
    const rateTable = ExchangeRateTable.create('TRY', [
      ExchangeRate.fromString('USD', 'TRY', '40'),
      ExchangeRate.fromString('EUR', 'TRY', '45'),
    ])
    const result = compareSuppliers({ project: p, exchangeRateTable: rateTable })

    const usdSupplier = result.supplierResults.find((r) => r.supplierId === 'usdSupplier')!
    const eurSupplier = result.supplierResults.find((r) => r.supplierId === 'eurSupplier')!

    // 10 x 10 USD = 100 USD -> 4000 TRY.
    expect(usdSupplier.exactCalculatedLandedTotal?.toDecimalString()).toBe('4000')
    // 10 x 8 EUR = 80 EUR -> 3600 TRY.
    expect(eurSupplier.exactCalculatedLandedTotal?.toDecimalString()).toBe('3600')

    expect(eurSupplier.rank).toBe(1)
    expect(usdSupplier.rank).toBe(2)
    expect(result.baseCurrency).toBe('TRY')
  })
})
