import { describe, expect, it } from 'vitest'
import { compareSuppliers, type SupplierComparisonEntry } from './SupplierComparison'
import { createAdditionalCost, type AdditionalCost } from '../calculation/AdditionalCost'
import { Percentage } from '../calculation/Percentage'
import { ExchangeRate } from '../calculation/ExchangeRate'
import { ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * The header total and the breakdown under it must be the same number, and
 * the header must be the exact total rounded once.
 *
 * Both halves of that came out of the audit. The header and the breakdown
 * disagreed by 0.01 and 0.02 in reproductions, because `round(a + b)` is not
 * `round(a) + round(b)`. Making the *sum of rounded parts* authoritative
 * closed the gap but broke something worse: how a user split the same money
 * across rows started to decide the ranking. So the direction of authority is
 * the other way round — round the total once, then reconcile the parts to it.
 * See docs/CALCULATION_RULES.md, "Authoritative commercial total".
 */

/** Every reconciliation the settled total promises, asserted together. */
function expectSettlementReconciles(entry: SupplierComparisonEntry): void {
  const costResult = entry.costResult!
  const rankingAmount = entry.rankingAmount!

  // 1. The header is the settled total, which is the exact total rounded once.
  expect(rankingAmount.toDecimalString()).toBe(costResult.settledLandedTotal.toDecimalString())
  expect(rankingAmount.toDecimalString()).toBe(
    entry.exactCalculatedLandedTotal!.roundToMinorUnit(costResult.minorUnit).toDecimalString(),
  )

  // 2. Supplier-level breakdown: settled merchandise + settled cost effects.
  const fromEntries = costResult.entries.reduce(
    (total, costEntry) => total.add(costEntry.settledEffect),
    costResult.settledMerchandiseTotal,
  )
  expect(fromEntries.toDecimalString()).toBe(rankingAmount.toDecimalString())

  // 3. Per-line breakdown, when allocation was available.
  const lines = entry.lines!
  if (lines.every((line) => line.settledLandedValue !== undefined)) {
    const fromLines = lines.reduce(
      (total, line) => total.add(line.settledLandedValue!),
      Money.zero(rankingAmount.currency),
    )
    expect(fromLines.toDecimalString()).toBe(rankingAmount.toDecimalString())
  }

  // 4. Per-line merchandise adds up to the merchandise figure shown.
  const merchandiseFromLines = lines.reduce(
    (total, line) => total.add(line.settledMerchandiseValue),
    Money.zero(rankingAmount.currency),
  )
  expect(merchandiseFromLines.toDecimalString()).toBe(
    entry.merchandiseRankingAmount!.toDecimalString(),
  )
}

function singleSupplier(costs: readonly AdditionalCost[]): SupplierComparisonEntry {
  const result = compareSuppliers({
    project: project({
      baseCurrency: 'TRY',
      requirements: [
        requirement('r1', { requiredQuantity: '2000' }),
        requirement('r2', { requiredQuantity: '3' }),
      ],
      suppliers: [supplier('s1')],
      quotes: [
        quote({
          id: 'q1',
          supplierId: 's1',
          currency: 'TRY',
          items: [
            // 2000 x 0.500002 = 1000.004 — sub-minor-unit digits by design
            quoteItem({ id: 'i1', requirementId: 'r1', price: '0.500002', currency: 'TRY' }),
            quoteItem({ id: 'i2', requirementId: 'r2', price: '1', currency: 'TRY' }),
          ],
        }),
      ],
    }),
    exchangeRateTable: baseRateTable('TRY'),
    costsBySupplierId: { s1: costs },
  })
  return result.supplierResults[0]!
}

function fixedCost(id: string, amount: string): AdditionalCost {
  return createAdditionalCost({
    id,
    kind: 'COST',
    category: 'OTHER',
    fixedAmount: Money.fromString(amount, 'TRY'),
  })
}

describe('header total equals the breakdown', () => {
  it('one cost whose fraction would round the other way in a combined total', () => {
    const entry = singleSupplier([fixedCost('freight', '20.004')])

    // Merchandise 1003.004 settles to 1003.00 on its own, and the total
    // 1023.008 rounds to 1023.01 — so the freight is reconciled to 20.01, one
    // kuruş above its own rounded 20.00, rather than the total being pulled
    // down to what the parts happened to round to.
    expect(entry.exactCalculatedLandedTotal?.toDecimalString()).toBe('1023.008')
    expect(entry.rankingAmount?.toDecimalString()).toBe('1023.01')
    expect(entry.merchandiseRankingAmount?.toDecimalString()).toBe('1003')
    expect(entry.costResult?.entries[0]?.settledEffect.toDecimalString()).toBe('20.01')
    expectSettlementReconciles(entry)
  })

  it('four small fractions that used to compound into a two-kuruş gap', () => {
    const entry = singleSupplier([
      fixedCost('c1', '10.004'),
      fixedCost('c2', '10.004'),
      fixedCost('c3', '10.004'),
      fixedCost('c4', '10.004'),
    ])

    expect(entry.exactCalculatedLandedTotal?.toDecimalString()).toBe('1043.02')
    expect(entry.rankingAmount?.toDecimalString()).toBe('1043.02')
    expectSettlementReconciles(entry)
  })

  it('reconciles with a percentage cost that produces a long decimal tail', () => {
    const entry = singleSupplier([
      fixedCost('freight', '20.004'),
      createAdditionalCost({
        id: 'duty',
        kind: 'COST',
        category: 'DUTY',
        percentage: { rate: Percentage.fromString('3.33'), base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE' },
      }),
    ])
    expectSettlementReconciles(entry)
  })

  it('reconciles with a discount, a surcharge and a foreign-currency cost together', () => {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [
          requirement('a', { requiredQuantity: '7' }),
          requirement('b', { requiredQuantity: '13' }),
          requirement('c', { requiredQuantity: '3' }),
        ],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'USD',
            items: [
              quoteItem({ id: 'i1', requirementId: 'a', price: '1.117', currency: 'USD' }),
              quoteItem({ id: 'i2', requirementId: 'b', price: '0.333', currency: 'USD' }),
              quoteItem({ id: 'i3', requirementId: 'c', price: '9.909', currency: 'USD' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: ExchangeRateTable.create('TRY', [
        ExchangeRate.fromString('USD', 'TRY', '40.5537'),
      ]),
      costsBySupplierId: {
        s1: [
          createAdditionalCost({
            id: 'promo',
            kind: 'DISCOUNT',
            category: 'OTHER',
            percentage: { rate: Percentage.fromString('7.77'), base: 'MERCHANDISE' },
          }),
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('37.77', 'USD'),
            allocationMethod: 'EQUAL_PER_LINE',
          }),
          createAdditionalCost({
            id: 'duty',
            kind: 'COST',
            category: 'DUTY',
            percentage: { rate: Percentage.fromString('11.11'), base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE' },
            allocationMethod: 'BY_QUANTITY',
          }),
          createAdditionalCost({
            id: 'fuel',
            kind: 'SURCHARGE',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('3.333', 'TRY'),
          }),
        ],
      },
    })

    expectSettlementReconciles(result.supplierResults[0]!)
  })
})

describe('the settled total decides the ranking', () => {
  /** Two single-line suppliers, each with its own unit price and cost list. */
  function twoSuppliers(
    priceA: string,
    costsA: readonly AdditionalCost[],
    priceB: string,
    costsB: readonly AdditionalCost[],
  ) {
    return compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [requirement('r1', { requiredQuantity: '1' })],
        suppliers: [supplier('s1'), supplier('s2')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [quoteItem({ id: 'i1', requirementId: 'r1', price: priceA, currency: 'TRY' })],
          }),
          quote({
            id: 'q2',
            supplierId: 's2',
            currency: 'TRY',
            items: [quoteItem({ id: 'i2', requirementId: 'r1', price: priceB, currency: 'TRY' })],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: { s1: costsA, s2: costsB },
    })
  }

  it('ties two suppliers whose exact totals settle to the same figure', () => {
    // s1 exact 1020.008, s2 exact 1020.007 — indistinguishable at kuruş
    // precision, so they tie. The old model separated them, but only because
    // it summed separately rounded components: s1's merchandise happened to
    // round down and s2's up. That same mechanism is what made 20.008 rank
    // differently from 10.004 + 10.004.
    const result = twoSuppliers(
      '1000.004',
      [fixedCost('c', '20.004')],
      '1000.006',
      [fixedCost('c', '20.001')],
    )

    const s1 = result.supplierResults[0]!
    const s2 = result.supplierResults[1]!

    expect(s1.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.008')
    expect(s2.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.007')
    expect(s1.rankingAmount?.toDecimalString()).toBe('1020.01')
    expect(s2.rankingAmount?.toDecimalString()).toBe('1020.01')

    expect(s1.rank).toBe(1)
    expect(s2.rank).toBe(1)
    expect([...result.lowestSupplierIds].sort()).toEqual(['s1', 's2'])
    expect(s2.differenceFromLowest?.toDecimalString()).toBe('0')

    expectSettlementReconciles(s1)
    expectSettlementReconciles(s2)
  })

  it('separates two suppliers across the half-up boundary of the exact total', () => {
    // exact 1020.004 -> 1020.00, exact 1020.006 -> 1020.01.
    const result = twoSuppliers('1000.004', [fixedCost('c', '20')], '1000.006', [fixedCost('c', '20')])

    const s1 = result.supplierResults[0]!
    const s2 = result.supplierResults[1]!

    expect(s1.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.004')
    expect(s2.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.006')
    expect(s1.rankingAmount?.toDecimalString()).toBe('1020')
    expect(s2.rankingAmount?.toDecimalString()).toBe('1020.01')

    expect(s1.rank).toBe(1)
    expect(s2.rank).toBe(2)
    expect(result.lowestSupplierIds).toEqual(['s1'])
    expect(s2.differenceFromLowest?.toDecimalString()).toBe('0.01')

    expectSettlementReconciles(s1)
    expectSettlementReconciles(s2)
  })
})
