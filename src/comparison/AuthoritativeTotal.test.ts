import { describe, expect, it } from 'vitest'
import {
  compareSuppliers,
  type SupplierComparisonEntry,
  type SupplierComparisonResult,
} from './SupplierComparison'
import { createAdditionalCost, type AdditionalCost, type CostKind } from '../calculation/AdditionalCost'
import type { MinorUnitOverrides } from '../calculation/CurrencyMinorUnit'
import { Percentage } from '../calculation/Percentage'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * The authoritative commercial total, and the invariance that depends on it.
 *
 * The rule under test:
 *
 *     rankingAmount == settledLandedTotal == roundHalfUp(exactCalculatedLandedTotal, minorUnit)
 *
 * The total is calculated exactly, rounded **once**, and the displayed
 * components are then reconciled to it. Summing separately rounded components
 * into the total instead makes the answer depend on how a user happened to
 * split the same money across rows: `20.008` ranked differently from
 * `10.004 + 10.004`, and — reproduced below — a genuinely more expensive
 * supplier could win. See docs/CALCULATION_RULES.md, "Authoritative
 * commercial total".
 */

interface Variant {
  readonly id: string
  readonly costs: readonly AdditionalCost[]
}

/** One single-line supplier per variant, all quoting the same unit price. */
function compareVariants(
  unitPrice: string,
  variants: readonly Variant[],
  options: { currency?: string; minorUnitOverrides?: MinorUnitOverrides } = {},
): SupplierComparisonResult {
  const currency = options.currency ?? 'TRY'
  return compareSuppliers({
    project: project({
      baseCurrency: currency,
      requirements: [requirement('r1', { requiredQuantity: '1' })],
      suppliers: variants.map((variant) => supplier(variant.id)),
      quotes: variants.map((variant) =>
        quote({
          id: `q-${variant.id}`,
          supplierId: variant.id,
          currency,
          items: [
            quoteItem({ id: `i-${variant.id}`, requirementId: 'r1', price: unitPrice, currency }),
          ],
        }),
      ),
    }),
    exchangeRateTable: baseRateTable(currency),
    costsBySupplierId: Object.fromEntries(variants.map((variant) => [variant.id, variant.costs])),
    minorUnitOverrides: options.minorUnitOverrides,
  })
}

function entryOf(result: SupplierComparisonResult, supplierId: string): SupplierComparisonEntry {
  return result.supplierResults.find((entry) => entry.supplierId === supplierId)!
}

function fixed(id: string, kind: CostKind, amount: string, currency = 'TRY'): AdditionalCost {
  return createAdditionalCost({
    id,
    kind,
    category: 'OTHER',
    fixedAmount: Money.fromString(amount, currency),
  })
}

/** A percentage entry on the merchandise base — the base every kind may use. */
function onMerchandise(id: string, kind: CostKind, rate: string): AdditionalCost {
  return createAdditionalCost({
    id,
    kind,
    category: 'OTHER',
    percentage: { rate: Percentage.fromString(rate), base: 'MERCHANDISE' },
  })
}

function repeated(count: number, kind: CostKind, amount: string): readonly AdditionalCost[] {
  return Array.from({ length: count }, (_, index) =>
    fixed(`c${String(index + 1).padStart(2, '0')}`, kind, amount),
  )
}

/**
 * Requirements 6, 7 and 8 in one place: the total is the rounded exact total,
 * the supplier-level breakdown adds up to it, and so does the per-line
 * breakdown whenever allocation was available.
 */
function expectAuthoritativeTotal(entry: SupplierComparisonEntry, minorUnit: number): void {
  const costResult = entry.costResult!
  const settledLandedTotal = costResult.settledLandedTotal
  const rounded = entry.exactCalculatedLandedTotal!.roundToMinorUnit(minorUnit)

  expect(settledLandedTotal.toDecimalString()).toBe(rounded.toDecimalString())
  expect(entry.rankingAmount!.toDecimalString()).toBe(settledLandedTotal.toDecimalString())

  const fromComponents = costResult.entries.reduce(
    (total, costEntry) => total.add(costEntry.settledEffect),
    costResult.settledMerchandiseTotal,
  )
  expect(fromComponents.toDecimalString()).toBe(settledLandedTotal.toDecimalString())

  expect(costResult.settledMerchandiseTotal.toDecimalString()).toBe(
    costResult.merchandiseTotal.roundToMinorUnit(minorUnit).toDecimalString(),
  )

  const lines = entry.lines!
  if (lines.every((line) => line.settledLandedValue !== undefined)) {
    const fromLines = lines.reduce(
      (total, line) => total.add(line.settledLandedValue!),
      Money.zero(settledLandedTotal.currency),
    )
    expect(fromLines.toDecimalString()).toBe(settledLandedTotal.toDecimalString())
  }

  // Reconciliation must never flip an entry across zero: a cost stays a cost,
  // a discount stays a discount, and an entry that contributes nothing
  // contributes exactly nothing.
  for (const costEntry of costResult.entries) {
    expect(signOf(costEntry.settledEffect)).toBe(
      costEntry.settledEffect.isZero() ? 0 : signOf(costEntry.signedEffect),
    )
    if (!costEntry.contributes) {
      expect(costEntry.settledEffect.isZero()).toBe(true)
    }
  }
}

function signOf(value: Money): number {
  if (value.isZero()) {
    return 0
  }
  return value.isNegative() ? -1 : 1
}

function settledEffectsById(entry: SupplierComparisonEntry): Record<string, string> {
  return Object.fromEntries(
    entry.costResult!.entries.map((costEntry) => [
      costEntry.id,
      costEntry.settledEffect.toDecimalString(),
    ]),
  )
}

describe('decomposition invariance — how the same money is split into rows cannot change the answer', () => {
  it('a fixed cost of 20.008 ranks exactly like 10.004 + 10.004', () => {
    const result = compareVariants('1000', [
      { id: 'merged', costs: [fixed('c1', 'COST', '20.008')] },
      { id: 'split', costs: repeated(2, 'COST', '10.004') },
    ])

    const merged = entryOf(result, 'merged')
    const split = entryOf(result, 'split')

    expect(merged.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.008')
    expect(split.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.008')
    expect(merged.rankingAmount?.toDecimalString()).toBe('1020.01')
    expect(split.rankingAmount?.toDecimalString()).toBe('1020.01')

    expect(merged.rank).toBe(1)
    expect(split.rank).toBe(1)
    expect([...result.lowestSupplierIds].sort()).toEqual(['merged', 'split'])

    expectAuthoritativeTotal(merged, 2)
    expectAuthoritativeTotal(split, 2)
  })

  it('a surcharge of 20.008 ranks exactly like 10.004 + 10.004', () => {
    const result = compareVariants('1000', [
      { id: 'merged', costs: [fixed('s1', 'SURCHARGE', '20.008')] },
      { id: 'split', costs: repeated(2, 'SURCHARGE', '10.004') },
    ])

    const merged = entryOf(result, 'merged')
    const split = entryOf(result, 'split')

    expect(merged.rankingAmount?.toDecimalString()).toBe('1020.01')
    expect(split.rankingAmount?.toDecimalString()).toBe('1020.01')
    expect(result.rankedCompleteSuppliers.every((ranked) => ranked.rank === 1)).toBe(true)

    expectAuthoritativeTotal(merged, 2)
    expectAuthoritativeTotal(split, 2)
  })

  it('a discount of 20.008 ranks exactly like 10.004 + 10.004', () => {
    const result = compareVariants('1000', [
      { id: 'merged', costs: [fixed('d1', 'DISCOUNT', '20.008')] },
      { id: 'split', costs: repeated(2, 'DISCOUNT', '10.004') },
    ])

    const merged = entryOf(result, 'merged')
    const split = entryOf(result, 'split')

    expect(merged.exactCalculatedLandedTotal?.toDecimalString()).toBe('979.992')
    expect(split.exactCalculatedLandedTotal?.toDecimalString()).toBe('979.992')
    expect(merged.rankingAmount?.toDecimalString()).toBe('979.99')
    expect(split.rankingAmount?.toDecimalString()).toBe('979.99')
    expect([...result.lowestSupplierIds].sort()).toEqual(['merged', 'split'])

    expectAuthoritativeTotal(merged, 2)
    expectAuthoritativeTotal(split, 2)
  })

  it('a 20% cost ranks exactly like two parallel 10% costs', () => {
    // 10% of 1000.05 is 100.005 — a sub-minor-unit tail that rounds up on its
    // own, so two of them used to add up to one kuruş more than the single
    // 20% entry they are economically identical to.
    const result = compareVariants('1000.05', [
      { id: 'merged', costs: [onMerchandise('p1', 'COST', '20')] },
      { id: 'split', costs: [onMerchandise('p1', 'COST', '10'), onMerchandise('p2', 'COST', '10')] },
    ])

    const merged = entryOf(result, 'merged')
    const split = entryOf(result, 'split')

    expect(merged.exactCalculatedLandedTotal?.toDecimalString()).toBe('1200.06')
    expect(split.exactCalculatedLandedTotal?.toDecimalString()).toBe('1200.06')
    expect(merged.rankingAmount?.toDecimalString()).toBe('1200.06')
    expect(split.rankingAmount?.toDecimalString()).toBe('1200.06')
    expect([...result.lowestSupplierIds].sort()).toEqual(['merged', 'split'])

    expectAuthoritativeTotal(merged, 2)
    expectAuthoritativeTotal(split, 2)
  })

  it('a 20% discount ranks exactly like two parallel 10% discounts (never a sequential 19%)', () => {
    const result = compareVariants('1000.05', [
      { id: 'merged', costs: [onMerchandise('p1', 'DISCOUNT', '20')] },
      {
        id: 'split',
        costs: [onMerchandise('p1', 'DISCOUNT', '10'), onMerchandise('p2', 'DISCOUNT', '10')],
      },
    ])

    const merged = entryOf(result, 'merged')
    const split = entryOf(result, 'split')

    // Parallel/additive: both take 20% of the *same* merchandise base. A
    // sequential reading (0.9 x 0.9 = 19% off) would give 810.0405.
    expect(merged.exactCalculatedLandedTotal?.toDecimalString()).toBe('800.04')
    expect(split.exactCalculatedLandedTotal?.toDecimalString()).toBe('800.04')
    expect(split.costResult?.totalDiscounts.toDecimalString()).toBe('200.01')
    expect(merged.rankingAmount?.toDecimalString()).toBe('800.04')
    expect(split.rankingAmount?.toDecimalString()).toBe('800.04')

    expectAuthoritativeTotal(merged, 2)
    expectAuthoritativeTotal(split, 2)
  })
})

describe('winner inversion — the genuinely cheaper supplier wins', () => {
  it('ranks one 16.02 cost ahead of sixteen 1.004 costs', () => {
    const result = compareVariants('1000', [
      { id: 'many', costs: repeated(16, 'COST', '1.004') },
      { id: 'one', costs: [fixed('c01', 'COST', '16.02')] },
    ])

    const many = entryOf(result, 'many')
    const one = entryOf(result, 'one')

    // 16 x 1.004 = 16.064 is genuinely more expensive than a single 16.02.
    expect(many.exactCalculatedLandedTotal?.toDecimalString()).toBe('1016.064')
    expect(one.exactCalculatedLandedTotal?.toDecimalString()).toBe('1016.02')
    expect(many.rankingAmount?.toDecimalString()).toBe('1016.06')
    expect(one.rankingAmount?.toDecimalString()).toBe('1016.02')

    expect(one.rank).toBe(1)
    expect(many.rank).toBe(2)
    expect(result.lowestSupplierIds).toEqual(['one'])
    expect(many.differenceFromLowest?.toDecimalString()).toBe('0.04')

    expectAuthoritativeTotal(many, 2)
    expectAuthoritativeTotal(one, 2)
  })
})

describe('order invariance — the input order of cost rows changes nothing', () => {
  const costsInOrder = (): readonly AdditionalCost[] => [
    onMerchandise('discount', 'DISCOUNT', '3.33'),
    fixed('freight', 'COST', '100.007'),
    fixed('handling', 'COST', '0.005'),
    onMerchandise('duty', 'COST', '7.77'),
    fixed('fuel', 'SURCHARGE', '3.333'),
  ]

  it('produces the same total, the same rank and the same settled components either way', () => {
    const forward = costsInOrder()
    const reversed = [...costsInOrder()].reverse()

    const result = compareVariants('1234.567', [
      { id: 'forward', costs: forward },
      { id: 'reversed', costs: reversed },
    ])

    const a = entryOf(result, 'forward')
    const b = entryOf(result, 'reversed')

    expect(a.exactCalculatedLandedTotal?.toDecimalString()).toBe(
      b.exactCalculatedLandedTotal?.toDecimalString(),
    )
    expect(a.rankingAmount?.toDecimalString()).toBe(b.rankingAmount?.toDecimalString())
    expect(a.rank).toBe(1)
    expect(b.rank).toBe(1)
    expect([...result.lowestSupplierIds].sort()).toEqual(['forward', 'reversed'])

    // Stronger than the ranking guarantee: every individual component settles
    // to the same figure, because remainders are broken on the semantic cost
    // id rather than on the row's position in the array.
    expect(settledEffectsById(a)).toEqual(settledEffectsById(b))

    expectAuthoritativeTotal(a, 2)
    expectAuthoritativeTotal(b, 2)
  })
})

describe('per-line reconciliation across a multi-line supplier', () => {
  it('adds the per-line landed values back up to the authoritative total', () => {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [
          requirement('r1', { requiredQuantity: '3' }),
          requirement('r2', { requiredQuantity: '7' }),
          requirement('r3', { requiredQuantity: '11' }),
        ],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'i1', requirementId: 'r1', price: '1.011', currency: 'TRY' }),
              quoteItem({ id: 'i2', requirementId: 'r2', price: '2.022', currency: 'TRY' }),
              quoteItem({ id: 'i3', requirementId: 'r3', price: '3.033', currency: 'TRY' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        s1: [
          onMerchandise('discount', 'DISCOUNT', '5'),
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('100.007', 'TRY'),
            allocationMethod: 'EQUAL_PER_LINE',
          }),
          createAdditionalCost({
            id: 'duty',
            kind: 'COST',
            category: 'DUTY',
            percentage: {
              rate: Percentage.fromString('10'),
              base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
            },
            allocationMethod: 'BY_QUANTITY',
          }),
        ],
      },
    })

    const entry = result.supplierResults[0]!
    expect(entry.status).toBe('COMPLETE')
    expect(entry.costAllocation).toBeDefined()
    expectAuthoritativeTotal(entry, 2)
  })
})

describe('minor units other than two digits', () => {
  it('settles a 0-digit currency by rounding the total once', () => {
    const result = compareVariants(
      '1000',
      [
        { id: 'merged', costs: [fixed('c1', 'COST', '1', 'JPY')] },
        { id: 'split', costs: repeated(2, 'COST', '0.5').map(withCurrency('JPY')) },
      ],
      { currency: 'JPY', minorUnitOverrides: { JPY: 0 } },
    )

    const merged = entryOf(result, 'merged')
    const split = entryOf(result, 'split')

    expect(result.minorUnit).toBe(0)
    expect(merged.exactCalculatedLandedTotal?.toDecimalString()).toBe('1001')
    expect(split.exactCalculatedLandedTotal?.toDecimalString()).toBe('1001')
    expect(merged.rankingAmount?.toDecimalString()).toBe('1001')
    expect(split.rankingAmount?.toDecimalString()).toBe('1001')

    expectAuthoritativeTotal(merged, 0)
    expectAuthoritativeTotal(split, 0)
  })

  it('rounds a 0-digit currency half-up on the total, not on the parts', () => {
    const result = compareVariants(
      '1000',
      [{ id: 'only', costs: [fixed('c1', 'COST', '0.5', 'JPY')] }],
      { currency: 'JPY', minorUnitOverrides: { JPY: 0 } },
    )

    const only = entryOf(result, 'only')
    expect(only.exactCalculatedLandedTotal?.toDecimalString()).toBe('1000.5')
    expect(only.rankingAmount?.toDecimalString()).toBe('1001')
    expectAuthoritativeTotal(only, 0)
  })

  it('settles a 3-digit currency by rounding the total once', () => {
    const result = compareVariants(
      '1000',
      [
        { id: 'merged', costs: [fixed('c1', 'COST', '20.0008', 'BHD')] },
        { id: 'split', costs: repeated(2, 'COST', '10.0004').map(withCurrency('BHD')) },
      ],
      { currency: 'BHD', minorUnitOverrides: { BHD: 3 } },
    )

    const merged = entryOf(result, 'merged')
    const split = entryOf(result, 'split')

    expect(result.minorUnit).toBe(3)
    expect(merged.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.0008')
    expect(split.exactCalculatedLandedTotal?.toDecimalString()).toBe('1020.0008')
    expect(merged.rankingAmount?.toDecimalString()).toBe('1020.001')
    expect(split.rankingAmount?.toDecimalString()).toBe('1020.001')
    expect([...result.lowestSupplierIds].sort()).toEqual(['merged', 'split'])

    expectAuthoritativeTotal(merged, 3)
    expectAuthoritativeTotal(split, 3)
  })
})

describe('reconciliation across the settlement grid', () => {
  /** A two-line supplier, so the per-line identity is exercised too. */
  function sweep(price: string, costs: readonly AdditionalCost[], minorUnit: number) {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [
          requirement('r1', { requiredQuantity: '1' }),
          requirement('r2', { requiredQuantity: '1' }),
        ],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'i1', requirementId: 'r1', price, currency: 'TRY' }),
              quoteItem({ id: 'i2', requirementId: 'r2', price: '0.001', currency: 'TRY' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: { s1: costs },
      minorUnitOverrides: { TRY: minorUnit },
    })
    return result.supplierResults[0]!
  }

  it('moves a mixed ledger by a whole minor unit without breaking either sign', () => {
    // The hard case for reconciliation: merchandise 1000.004 settles down,
    // the exact total 990.005 settles up, and the residual is a full kuruş on
    // a ledger that has both a cost and a larger discount. The cost side is
    // 0.006 exact and has to settle to 0.02 — two minor units above its own
    // rounded 0.01 — while the discount side absorbs none of it.
    const entry = sweep(
      '1000.003',
      [fixed('a', 'COST', '0.006'), fixed('b', 'DISCOUNT', '10.005')],
      2,
    )

    expect(entry.merchandiseTotal?.toDecimalString()).toBe('1000.004')
    expect(entry.costResult?.settledMerchandiseTotal.toDecimalString()).toBe('1000')
    expect(entry.exactCalculatedLandedTotal?.toDecimalString()).toBe('990.005')
    expect(entry.rankingAmount?.toDecimalString()).toBe('990.01')
    expect(settledEffectsById(entry)).toEqual({ a: '0.02', b: '-10.01' })
    expectAuthoritativeTotal(entry, 2)
  })

  it('holds for every combination of sub-minor-unit tails at 0, 2 and 3 digits', () => {
    const tails = ['0', '0.001', '0.004', '0.005', '0.006', '0.009', '0.01', '0.014']
    let cases = 0

    for (const minorUnit of [0, 2, 3]) {
      for (const merchandiseTail of tails) {
        for (const costTail of tails) {
          for (const discountTail of tails) {
            for (const surchargeTail of ['0', '0.005', '0.014']) {
              const entry = sweep(
                `1000${merchandiseTail === '0' ? '' : merchandiseTail.slice(1)}`,
                [
                  fixed('c1', 'COST', costTail),
                  fixed('c2', 'COST', '0.007'),
                  fixed('d1', 'DISCOUNT', discountTail),
                  fixed('s1', 'SURCHARGE', surchargeTail),
                ],
                minorUnit,
              )
              expectAuthoritativeTotal(entry, minorUnit)
              cases += 1
            }
          }
        }
      }
    }

    expect(cases).toBe(4608)
  })
})

/** Rebuilds a fixed cost in another currency — `repeated` defaults to TRY. */
function withCurrency(currency: string): (cost: AdditionalCost) => AdditionalCost {
  return (cost) =>
    createAdditionalCost({
      id: cost.id,
      kind: cost.kind,
      category: cost.category,
      fixedAmount: Money.fromString(cost.fixedAmount!.toDecimalString(), currency),
    })
}
