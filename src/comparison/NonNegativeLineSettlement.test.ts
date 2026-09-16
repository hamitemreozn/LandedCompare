import { describe, expect, it } from 'vitest'
import { compareSuppliers, type SupplierComparisonEntry } from './SupplierComparison'
import { createAdditionalCost, type AdditionalCost } from '../calculation/AdditionalCost'
import type { AllocationMethod } from '../calculation/Allocation'
import { Percentage } from '../calculation/Percentage'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * A valid product line must never be displayed at a negative landed cost.
 *
 * The supplier total was already right, and stayed right: the failure was
 * purely in how cents were distributed. Merchandise and discounts were
 * settled independently, so a line economically worth `0.004` — merchandise
 * settled to `0.00` — could still be handed the discount's leftover `0.01`
 * and come out at `-0.01`. The total reconciled; the line was nonsense.
 *
 * The fix is capacity-constrained settlement, not clamping: merchandise
 * first, then positive effects, then discounts, with each line's remaining
 * settled capacity deciding whether it may take another minor unit. A cent a
 * line cannot absorb moves to the next line that can, so nothing is created
 * and nothing is destroyed. See `allocateSupplierCosts` in
 * `calculation/CostCalculation.ts`.
 */

interface LineSpec {
  readonly id: string
  readonly price: string
  readonly quantity?: string
  readonly comparisonUnit?: string
}

function evaluate(opts: {
  lines: readonly LineSpec[]
  costs?: readonly AdditionalCost[]
  currency?: string
  minorUnit?: number
}): SupplierComparisonEntry {
  const currency = opts.currency ?? 'TRY'
  const result = compareSuppliers({
    project: project({
      baseCurrency: currency,
      requirements: opts.lines.map((line) =>
        requirement(line.id, {
          requiredQuantity: line.quantity ?? '1',
          comparisonUnit: line.comparisonUnit ?? 'pcs',
        }),
      ),
      suppliers: [supplier('s1')],
      quotes: [
        quote({
          id: 'q1',
          supplierId: 's1',
          currency,
          items: opts.lines.map((line) =>
            quoteItem({ id: `i-${line.id}`, requirementId: line.id, price: line.price, currency }),
          ),
        }),
      ],
    }),
    exchangeRateTable: baseRateTable(currency),
    costsBySupplierId: { s1: opts.costs ?? [] },
    minorUnitOverrides: opts.minorUnit === undefined ? undefined : { [currency]: opts.minorUnit },
  })
  return result.supplierResults[0]!
}

function discount(
  id: string,
  amount: string,
  allocationMethod: AllocationMethod,
  currency = 'TRY',
): AdditionalCost {
  return createAdditionalCost({
    id,
    kind: 'DISCOUNT',
    category: 'OTHER',
    fixedAmount: Money.fromString(amount, currency),
    allocationMethod,
  })
}

function positiveCost(
  id: string,
  amount: string,
  kind: 'COST' | 'SURCHARGE',
  allocationMethod: AllocationMethod,
  currency = 'TRY',
): AdditionalCost {
  return createAdditionalCost({
    id,
    kind,
    category: kind === 'COST' ? 'FREIGHT' : 'OTHER',
    fixedAmount: Money.fromString(amount, currency),
    allocationMethod,
  })
}

/** Every per-line settled landed value, as decimal strings, in display order. */
function landedValues(entry: SupplierComparisonEntry): readonly string[] {
  return entry.lines!.map((line) => line.settledLandedValue!.toDecimalString())
}

/**
 * The three guarantees CP4 has to hold simultaneously, asserted together
 * because holding any two of them is easy and worthless.
 */
function expectNonNegativeSettlement(entry: SupplierComparisonEntry): void {
  expect(entry.status).toBe('COMPLETE')
  const lines = entry.lines!
  const rankingAmount = entry.rankingAmount!
  const costResult = entry.costResult!

  // 1. No valid line is shown below zero. Every line's *exact* landed value is
  //    non-negative by construction — a discount that overdraws a line is
  //    refused outright — so this is the settled figure honouring the exact one.
  for (const line of lines) {
    expect(line.settledLandedValue).toBeDefined()
    expect(`${line.requirementId}=${line.settledLandedValue!.toDecimalString()}`).toBe(
      `${line.requirementId}=${line.settledLandedValue!.isNegative() ? 'NEGATIVE' : line.settledLandedValue!.toDecimalString()}`,
    )
  }

  // 2. No money created, none destroyed: the lines still add up to the total.
  const fromLines = lines.reduce(
    (sum, line) => sum.add(line.settledLandedValue!),
    Money.zero(rankingAmount.currency),
  )
  expect(fromLines.toDecimalString()).toBe(rankingAmount.toDecimalString())

  // 3. The authoritative total is untouched (CP1).
  expect(rankingAmount.toDecimalString()).toBe(costResult.settledLandedTotal.toDecimalString())
  expect(rankingAmount.toDecimalString()).toBe(
    entry.exactCalculatedLandedTotal!.roundToMinorUnit(costResult.minorUnit).toDecimalString(),
  )

  // 4. Each entry's own allocations still settle to what the total counted.
  for (const breakdown of entry.costAllocation!.byEntry) {
    const allocated = breakdown.allocations.reduce(
      (sum, allocation) => sum.add(allocation.amount),
      Money.zero(rankingAmount.currency),
    )
    expect(allocated.toDecimalString()).toBe(breakdown.settledAmount.toDecimalString())
  }
}

describe('a valid line never settles negative', () => {
  it('the original reproduction: 0.005 / 0.005 / 100 with a 0.015 discount', () => {
    const entry = evaluate({
      lines: [
        { id: 'l1', price: '0.005' },
        { id: 'l2', price: '0.005' },
        { id: 'l3', price: '100' },
      ],
      costs: [discount('d1', '0.015', 'EQUAL_PER_LINE')],
    })

    expect(entry.exactCalculatedLandedTotal?.toDecimalString()).toBe('99.995')
    expect(entry.rankingAmount?.toDecimalString()).toBe('100')
    expect(landedValues(entry)).toEqual(['0', '0', '100'])
    expectNonNegativeSettlement(entry)
  })

  it('the stronger reproduction: 0.004 / 10 / 10 with a 0.012 discount', () => {
    const entry = evaluate({
      lines: [
        { id: 'c', price: '0.004' },
        { id: 'a', price: '10' },
        { id: 'b', price: '10' },
      ],
      costs: [discount('d1', '0.012', 'EQUAL_PER_LINE')],
    })

    // Each line's exact share is 0.004, so the discount is valid at exact
    // precision. The tiny line settles its merchandise to 0.00 and therefore
    // has no capacity: the leftover kuruş goes to the next line that has room,
    // instead of showing line "c" at -0.01.
    expect(entry.exactCalculatedLandedTotal?.toDecimalString()).toBe('19.992')
    expect(entry.rankingAmount?.toDecimalString()).toBe('19.99')
    expect(landedValues(entry)).toEqual(['0', '9.99', '10'])
    expectNonNegativeSettlement(entry)
  })

  it('BY_QUANTITY: the leftover skips a tiny line with no settled capacity', () => {
    const entry = evaluate({
      lines: [
        { id: 'tiny', price: '0.0005', quantity: '8' },
        { id: 'bulk1', price: '5', quantity: '8' },
        { id: 'bulk2', price: '5', quantity: '8' },
      ],
      costs: [discount('d1', '0.009', 'BY_QUANTITY')],
    })

    expectNonNegativeSettlement(entry)
    expect(landedValues(entry).some((value) => value.startsWith('-'))).toBe(false)
  })

  it('BY_MERCHANDISE_VALUE: proportional weighting keeps every line non-negative', () => {
    const entry = evaluate({
      lines: [
        { id: 'tiny', price: '0.004' },
        { id: 'mid', price: '7.77' },
        { id: 'big', price: '333.333' },
      ],
      costs: [discount('d1', '11.11', 'BY_MERCHANDISE_VALUE')],
    })

    expectNonNegativeSettlement(entry)
  })

  it('several valid discounts on one supplier', () => {
    const entry = evaluate({
      lines: [
        { id: 'tiny', price: '0.004' },
        { id: 'a', price: '10' },
        { id: 'b', price: '10' },
      ],
      // Together these take 0.003 off the tiny line, which is worth 0.004, so
      // every one of them is valid at exact precision — the question CP4 asks
      // is only where their settled kuruş land.
      costs: [
        discount('d1', '0.006', 'EQUAL_PER_LINE'),
        discount('d2', '0.003', 'EQUAL_PER_LINE'),
        createAdditionalCost({
          id: 'd3',
          kind: 'DISCOUNT',
          category: 'OTHER',
          percentage: { rate: Percentage.fromString('0.01'), base: 'MERCHANDISE' },
          allocationMethod: 'BY_MERCHANDISE_VALUE',
        }),
      ],
    })

    expectNonNegativeSettlement(entry)
  })

  it('positive effects create capacity before discounts are placed', () => {
    const entry = evaluate({
      lines: [
        { id: 'tiny', price: '0.004' },
        { id: 'a', price: '10' },
        { id: 'b', price: '10' },
      ],
      costs: [
        positiveCost('freight', '0.03', 'COST', 'EQUAL_PER_LINE'),
        positiveCost('handling', '0.06', 'SURCHARGE', 'EQUAL_PER_LINE'),
        discount('d1', '0.012', 'EQUAL_PER_LINE'),
      ],
    })

    // The freight and the surcharge each put a whole kuruş on the tiny line,
    // so by the time the discount is settled that line has capacity to absorb
    // a kuruş of it — and does, without going below zero.
    expect(entry.lines![0]!.settledMerchandiseValue.toDecimalString()).toBe('0')
    expectNonNegativeSettlement(entry)
  })

  it('the display order of the breakdown is unchanged by the settlement order', () => {
    const costs = [
      discount('z-discount', '0.012', 'EQUAL_PER_LINE'),
      positiveCost('a-freight', '0.03', 'COST', 'EQUAL_PER_LINE'),
    ]
    const entry = evaluate({
      lines: [
        { id: 'tiny', price: '0.004' },
        { id: 'a', price: '10' },
        { id: 'b', price: '10' },
      ],
      costs,
    })

    // Discounts are settled last, but the breakdown still reads in the order
    // the costs were supplied.
    expect(entry.costAllocation!.byEntry.map((breakdown) => breakdown.entryId)).toEqual([
      'z-discount',
      'a-freight',
    ])
    expect(entry.costResult!.entries.map((costEntry) => costEntry.id)).toEqual([
      'z-discount',
      'a-freight',
    ])
    expectNonNegativeSettlement(entry)
  })
})

describe('minor units other than two digits', () => {
  it('0 digits (JPY): the leftover yen skips the line that settled to zero', () => {
    const entry = evaluate({
      currency: 'JPY',
      minorUnit: 0,
      lines: [
        { id: 'tiny', price: '0.4' },
        { id: 'a', price: '100' },
        { id: 'b', price: '100' },
      ],
      costs: [discount('d1', '1.2', 'EQUAL_PER_LINE', 'JPY')],
    })

    expect(entry.exactCalculatedLandedTotal?.toDecimalString()).toBe('199.2')
    expect(entry.rankingAmount?.toDecimalString()).toBe('199')
    expect(landedValues(entry)).toEqual(['0', '99', '100'])
    expectNonNegativeSettlement(entry)
  })

  it('3 digits (BHD): the same shape one decimal place deeper', () => {
    const entry = evaluate({
      currency: 'BHD',
      minorUnit: 3,
      lines: [
        { id: 'tiny', price: '0.0004' },
        { id: 'a', price: '10' },
        { id: 'b', price: '10' },
      ],
      costs: [discount('d1', '0.0012', 'EQUAL_PER_LINE', 'BHD')],
    })

    expect(entry.exactCalculatedLandedTotal?.toDecimalString()).toBe('19.9992')
    expect(landedValues(entry).some((value) => value.startsWith('-'))).toBe(false)
    expectNonNegativeSettlement(entry)
  })

  it('2 digits, for completeness, on the same shape', () => {
    const entry = evaluate({
      currency: 'EUR',
      lines: [
        { id: 'tiny', price: '0.004' },
        { id: 'a', price: '10' },
        { id: 'b', price: '10' },
      ],
      costs: [discount('d1', '0.012', 'EQUAL_PER_LINE', 'EUR')],
    })

    expectNonNegativeSettlement(entry)
  })
})

describe('settlement does not depend on the order costs were entered', () => {
  const lines: readonly LineSpec[] = [
    { id: 'tiny', price: '0.004' },
    { id: 'a', price: '10' },
    { id: 'b', price: '10' },
  ]
  const entered = [
    discount('d-alpha', '0.009', 'EQUAL_PER_LINE'),
    positiveCost('c-freight', '0.03', 'COST', 'EQUAL_PER_LINE'),
    discount('d-beta', '0.006', 'BY_MERCHANDISE_VALUE'),
    positiveCost('c-handling', '0.05', 'SURCHARGE', 'BY_QUANTITY'),
  ]

  it('reordering the cost entries changes neither the total nor any line', () => {
    const forward = evaluate({ lines, costs: entered })
    const reversed = evaluate({ lines, costs: [...entered].reverse() })
    const shuffled = evaluate({ lines, costs: [entered[2]!, entered[0]!, entered[3]!, entered[1]!] })

    for (const other of [reversed, shuffled]) {
      expect(other.rankingAmount!.toDecimalString()).toBe(forward.rankingAmount!.toDecimalString())
      expect(other.costResult!.settledLandedTotal.toDecimalString()).toBe(
        forward.costResult!.settledLandedTotal.toDecimalString(),
      )
      // Per-line values too, not just the total: which line absorbs a
      // remainder kuruş is settled on the entry's id, never on its row.
      expect(sortedLandedByLine(other)).toEqual(sortedLandedByLine(forward))
    }

    expectNonNegativeSettlement(forward)
    expectNonNegativeSettlement(reversed)
    expectNonNegativeSettlement(shuffled)
  })

  it('two suppliers whose identical costs are entered in different orders tie', () => {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: lines.map((line) => requirement(line.id, { requiredQuantity: '1' })),
        suppliers: [supplier('s1'), supplier('s2')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: lines.map((line) =>
              quoteItem({ id: `s1-${line.id}`, requirementId: line.id, price: line.price, currency: 'TRY' }),
            ),
          }),
          quote({
            id: 'q2',
            supplierId: 's2',
            currency: 'TRY',
            items: lines.map((line) =>
              quoteItem({ id: `s2-${line.id}`, requirementId: line.id, price: line.price, currency: 'TRY' }),
            ),
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: { s1: entered, s2: [...entered].reverse() },
    })

    expect(result.lowestSupplierIds).toEqual(['s1', 's2'])
    for (const entry of result.supplierResults) {
      expectNonNegativeSettlement(entry)
    }
  })
})

function sortedLandedByLine(entry: SupplierComparisonEntry): readonly string[] {
  return entry
    .lines!.map((line) => `${line.requirementId}=${line.settledLandedValue!.toDecimalString()}`)
    .sort()
}

/**
 * A bounded, seeded sweep rather than a stress test: enough shapes to catch a
 * distribution rule that only works on the two hand-written reproductions,
 * small enough to stay a fast unit test. The generator is deterministic, so a
 * failure is reproducible from the seed alone.
 */
describe('property sweep: every settled line is non-negative and the lines add up', () => {
  const PRICES = ['0.001', '0.004', '0.005', '0.009', '1', '3.333', '10', '100', '0.017']
  const QUANTITIES = ['1', '2', '7']
  const METHODS: readonly AllocationMethod[] = [
    'EQUAL_PER_LINE',
    'BY_QUANTITY',
    'BY_MERCHANDISE_VALUE',
  ]
  const DISCOUNTS = ['0.006', '0.012', '0.015', '0.03', '0.5']
  const COSTS = ['0.03', '0.05', '0.07', '1.11']

  function randomFrom(seed: number): () => number {
    let state = (seed * 2654435761) >>> 0
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
  }

  function pick<T>(next: () => number, pool: readonly T[]): T {
    return pool[Math.floor(next() * pool.length)]!
  }

  it('holds across 200 generated scenarios', () => {
    let complete = 0

    for (let seed = 1; seed <= 200; seed += 1) {
      const next = randomFrom(seed)
      const lineCount = 2 + Math.floor(next() * 4)
      const lines: LineSpec[] = Array.from({ length: lineCount }, (_, index) => ({
        id: `l${String(index)}`,
        price: pick(next, PRICES),
        quantity: pick(next, QUANTITIES),
      }))

      const costs: AdditionalCost[] = []
      const positiveCount = Math.floor(next() * 3)
      for (let index = 0; index < positiveCount; index += 1) {
        costs.push(
          positiveCost(
            `cost-${String(index)}`,
            pick(next, COSTS),
            next() < 0.5 ? 'COST' : 'SURCHARGE',
            pick(next, METHODS),
          ),
        )
      }
      const discountCount = 1 + Math.floor(next() * 3)
      for (let index = 0; index < discountCount; index += 1) {
        costs.push(discount(`disc-${String(index)}`, pick(next, DISCOUNTS), pick(next, METHODS)))
      }

      const entry = evaluate({ lines, costs })

      // An `INVALID` supplier is a legitimate outcome here — a generated
      // discount may genuinely overdraw a line, which is CP2's job to refuse
      // and not CP4's to paper over. Only a completed settlement is asserted.
      if (entry.status !== 'COMPLETE' || entry.lines === undefined) {
        continue
      }
      if (entry.lines.some((line) => line.settledLandedValue === undefined)) {
        continue
      }
      complete += 1

      const rankingAmount = entry.rankingAmount!
      const negative = entry.lines
        .filter((line) => line.settledLandedValue!.isNegative())
        .map((line) => `${line.requirementId}=${line.settledLandedValue!.toDecimalString()}`)
      expect(`seed ${String(seed)}: ${negative.join(', ')}`).toBe(`seed ${String(seed)}: `)

      const fromLines = entry.lines.reduce(
        (sum, line) => sum.add(line.settledLandedValue!),
        Money.zero(rankingAmount.currency),
      )
      expect(`seed ${String(seed)}: ${fromLines.toDecimalString()}`).toBe(
        `seed ${String(seed)}: ${rankingAmount.toDecimalString()}`,
      )
      expect(rankingAmount.toDecimalString()).toBe(
        entry.exactCalculatedLandedTotal!.roundToMinorUnit(entry.costResult!.minorUnit).toDecimalString(),
      )
    }

    // Guards the sweep against quietly becoming vacuous if generation drifts.
    expect(complete).toBeGreaterThan(80)
  })
})
