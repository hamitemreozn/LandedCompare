import { describe, expect, it } from 'vitest'
import { compareSuppliers, type SupplierComparisonEntry } from './SupplierComparison'
import { createAdditionalCost, type AdditionalCost } from '../calculation/AdditionalCost'
import { ExchangeRate } from '../calculation/ExchangeRate'
import { ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { Percentage } from '../calculation/Percentage'
import { Money } from '../domain/monetary/Money'
import type { QuoteItem } from '../domain/quote/QuoteItem'
import type { RequirementItem } from '../domain/requirement/RequirementItem'
import { project, quote, quoteItem, requirement, supplier } from './testSupport'
import {
  reference,
  referenceAdd,
  referenceMultiply,
  referencePercentageOf,
  referenceRoundHalfUp,
  referenceSubtract,
  referenceToString,
  type ExactReference,
} from '../domain/monetary/exactReference.testSupport'

/**
 * Cross-feature integration. Every other suite in this repository isolates one
 * protection: the authoritative total (`AuthoritativeTotal.test.ts`), discount
 * validity against an unrelated allocation failure
 * (`DiscountLineValidation.test.ts`), monetary precision
 * (`MonetaryPrecision.test.ts`), non-negative per-line settlement
 * (`NonNegativeLineSettlement.test.ts`). Each is right, and each proves its own
 * rule against a deliberately minimal quote.
 *
 * A supplier a user actually enters is not minimal. It carries a MOQ *and* a
 * pack *and* a foreign currency *and* a fixed freight *and* a percentage duty
 * *and* a discount, all at once, and the four protections have to hold
 * **together** on it. This file exercises exactly that overlap, and only that:
 * where a scenario here would restate what a focused suite already pins, it
 * asserts the combined behaviour instead of repeating the isolated one.
 *
 * Expected totals are computed against `exactReference.testSupport.ts` — the
 * `BigInt` reference that shares no code with `decimal.ts` — so an integrated
 * expectation cannot be satisfied by the implementation agreeing with itself.
 */

const TRY_RATES = ExchangeRateTable.create('TRY', [
  ExchangeRate.fromString('USD', 'TRY', '40.55'),
  ExchangeRate.fromString('EUR', 'TRY', '45.1234'),
])

/** The four invariants CP1–CP4 promise, asserted together on one `COMPLETE` supplier. */
function expectIntegratedInvariants(entry: SupplierComparisonEntry, minorUnit: number): void {
  expect(entry.status).toBe('COMPLETE')
  const costResult = entry.costResult!

  // Authoritative commercial total.
  expect(entry.rankingAmount!.toDecimalString()).toBe(costResult.settledLandedTotal.toDecimalString())
  expect(entry.rankingAmount!.toDecimalString()).toBe(
    referenceToString(
      referenceRoundHalfUp(
        reference(entry.exactCalculatedLandedTotal!.toDecimalString()),
        minorUnit,
      ),
    ),
  )

  // Breakdown reconciliation.
  const fromComponents = costResult.entries.reduce(
    (total, costEntry) => total.add(costEntry.settledEffect),
    costResult.settledMerchandiseTotal,
  )
  expect(fromComponents.toDecimalString()).toBe(costResult.settledLandedTotal.toDecimalString())

  // Per-line reconciliation and non-negative settlement, when a breakdown exists.
  if (entry.costAllocation !== undefined) {
    const perLine = entry.lines!.reduce(
      (total, line) => total.add(line.settledLandedValue!),
      Money.zero(costResult.baseCurrency),
    )
    expect(perLine.toDecimalString()).toBe(costResult.settledLandedTotal.toDecimalString())
    for (const line of entry.lines!) {
      expect(line.settledLandedValue!.isNegative()).toBe(false)
    }
    // Each entry's per-line shares sum to the effect the header counted.
    for (const breakdown of entry.costAllocation.byEntry) {
      const summed = breakdown.allocations.reduce(
        (total, allocation) => total.add(allocation.amount),
        Money.zero(costResult.baseCurrency),
      )
      expect(summed.toDecimalString()).toBe(breakdown.settledAmount.toDecimalString())
    }
  }
}

function entryOf(
  result: ReturnType<typeof compareSuppliers>,
  supplierId: string,
): SupplierComparisonEntry {
  return result.supplierResults.find((entry) => entry.supplierId === supplierId)!
}

// ---------------------------------------------------------------------------
// Scenario A — every feature the pipeline has, on two competing suppliers
// ---------------------------------------------------------------------------

/**
 * Scenario A. MOQ and pack resolution, a foreign quote currency, a fixed
 * freight, a percentage duty on the CIF-like base, a percentage discount,
 * per-line allocation and a ranking between two suppliers — one quote.
 *
 * `moqSupplier` quotes in USD and is constrained twice: requirement A's MOQ of
 * 200 forces 95 units more than the project needs, and requirement B's pack of
 * 4 rounds 30 up to 32. It still wins, because its unit prices are low enough
 * to absorb both — which is the point of resolving quantity before pricing
 * rather than after.
 *
 *   moqSupplier   (200 x 1.25 + 8 x 3.10) USD = 274.80 USD -> x 40.55
 *   packSupplier  (150 x 1.10 + 30 x 2.80) EUR = 249.00 EUR -> x 45.1234
 */
describe('Scenario A — MOQ, pack, FX, freight, duty, discount, allocation and ranking together', () => {
  const requirements: RequirementItem[] = [
    requirement('A', { requiredQuantity: '105' }),
    requirement('B', { requiredQuantity: '30' }),
  ]

  const moqSupplierCosts: AdditionalCost[] = [
    createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      percentage: { rate: Percentage.fromString('2.5'), base: 'MERCHANDISE' },
      allocationMethod: 'BY_MERCHANDISE_VALUE',
    }),
    createAdditionalCost({
      id: 'freight',
      kind: 'COST',
      category: 'FREIGHT',
      fixedAmount: Money.fromString('500', 'TRY'),
      allocationMethod: 'EQUAL_PER_LINE',
    }),
    createAdditionalCost({
      id: 'duty',
      kind: 'COST',
      category: 'DUTY',
      percentage: {
        rate: Percentage.fromString('7.5'),
        base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
      },
      allocationMethod: 'BY_QUANTITY',
    }),
  ]

  const packSupplierCosts: AdditionalCost[] = [
    createAdditionalCost({
      id: 'freight',
      kind: 'COST',
      category: 'FREIGHT',
      fixedAmount: Money.fromString('10', 'EUR'),
      allocationMethod: 'BY_QUANTITY',
    }),
    createAdditionalCost({
      id: 'duty',
      kind: 'COST',
      category: 'DUTY',
      percentage: {
        rate: Percentage.fromString('7.5'),
        base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
      },
      allocationMethod: 'BY_MERCHANDISE_VALUE',
    }),
  ]

  function run() {
    const p = project({
      baseCurrency: 'TRY',
      requirements,
      suppliers: [supplier('moqSupplier'), supplier('packSupplier')],
      quotes: [
        quote({
          id: 'q-moq',
          supplierId: 'moqSupplier',
          currency: 'USD',
          items: [
            quoteItem({ id: 'ma', requirementId: 'A', price: '1.25', currency: 'USD', moq: '200' }),
            quoteItem({
              id: 'mb',
              requirementId: 'B',
              price: '3.10',
              currency: 'USD',
              unitsPerQuotedUnit: '4',
            }),
          ],
        }),
        quote({
          id: 'q-pack',
          supplierId: 'packSupplier',
          currency: 'EUR',
          items: [
            quoteItem({ id: 'pa', requirementId: 'A', price: '1.10', currency: 'EUR', moq: '150' }),
            quoteItem({ id: 'pb', requirementId: 'B', price: '2.80', currency: 'EUR' }),
          ],
        }),
      ],
    })
    return compareSuppliers({
      project: p,
      exchangeRateTable: TRY_RATES,
      costsBySupplierId: { moqSupplier: moqSupplierCosts, packSupplier: packSupplierCosts },
    })
  }

  /** merch - 2.5% + 500 + 7.5% x (merch - 2.5% + 500), all exact. */
  function moqSupplierReference(): ExactReference {
    const merchandise = referenceMultiply(reference('274.80'), reference('40.55'))
    const discount = referencePercentageOf(merchandise, reference('2.5'))
    const afterDiscount = referenceSubtract(merchandise, discount)
    const cif = referenceAdd(afterDiscount, reference('500'))
    return referenceAdd(cif, referencePercentageOf(cif, reference('7.5')))
  }

  it('resolves both quantity constraints and prices the resolved quantity', () => {
    const entry = entryOf(run(), 'moqSupplier')
    const [lineA, lineB] = entry.lines!

    expect(lineA!.moqApplied).toBe(true)
    expect(lineA!.resolvedQuantity.toDecimalString()).toBe('200')
    expect(lineA!.quotedUnitQuantity.toDecimalString()).toBe('200')
    expect(lineA!.excessQuantity.toDecimalString()).toBe('95')

    expect(lineB!.packApplied).toBe(true)
    expect(lineB!.quotedUnitQuantity.toDecimalString()).toBe('8')
    expect(lineB!.resolvedQuantity.toDecimalString()).toBe('32')
    expect(lineB!.excessQuantity.toDecimalString()).toBe('2')
  })

  it('produces the exact landed total an independent BigInt reference computes', () => {
    const entry = entryOf(run(), 'moqSupplier')
    expect(entry.exactCalculatedLandedTotal!.toDecimalString()).toBe(
      referenceToString(moqSupplierReference()),
    )
    expect(entry.rankingAmount!.toDecimalString()).toBe('12216.9')
  })

  it('holds all four integrated invariants on both suppliers at once', () => {
    const result = run()
    expectIntegratedInvariants(entryOf(result, 'moqSupplier'), result.minorUnit)
    expectIntegratedInvariants(entryOf(result, 'packSupplier'), result.minorUnit)
  })

  it('ranks the twice-constrained supplier first anyway', () => {
    const result = run()
    expect(entryOf(result, 'moqSupplier').rank).toBe(1)
    expect(entryOf(result, 'packSupplier').rank).toBe(2)
    expect(result.lowestSupplierIds).toEqual(['moqSupplier'])
    expect(entryOf(result, 'packSupplier').differenceFromLowest!.toDecimalString()).toBe('346.58')
  })
})

// ---------------------------------------------------------------------------
// Scenario B — high-precision FX under a discount and a per-line allocation
// ---------------------------------------------------------------------------

/**
 * Scenario B. A seven-decimal exchange rate makes every line value an awkward
 * decimal, then a percentage discount and a percentage duty are taken on it and
 * the result is split back across three lines.
 *
 * This is the overlap CP3 and CP4 share and neither owns: the precision suite
 * proves an exact product in isolation, the settlement suite proves a tiny line
 * never goes negative on round numbers. Here the long tails and the cent
 * distribution meet — the discount's remainder has to land on a line that can
 * absorb it *and* the whole thing still has to reconcile to a total derived
 * from a 30-odd digit intermediate.
 *
 * Line A is deliberately worth less than a lira: 7 x 0.001 USD is
 * 0.2838760533 TRY, which settles to 0.28. The 0.8516 TRY discount split
 * equally gives every line 0.2838666 — legal, because it stays under line A's
 * exact value — but settles to 0.85 across three lines that each truncate to
 * 0.28. The leftover kuruş is offered to line A first (every remainder is
 * identical, so the tie goes to the earliest line) and line A has no room for
 * it. That is the CP4 mechanism, reached here through a seven-decimal rate
 * rather than through round numbers.
 */
describe('Scenario B — long FX rate, percentage cost, discount and per-line allocation', () => {
  const RATE = '40.5537219'
  const rates = ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', RATE)])
  const DISCOUNT = '0.8516'

  const costs: AdditionalCost[] = [
    createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      fixedAmount: Money.fromString(DISCOUNT, 'TRY'),
      allocationMethod: 'EQUAL_PER_LINE',
    }),
    createAdditionalCost({
      id: 'duty',
      kind: 'COST',
      category: 'DUTY',
      percentage: { rate: Percentage.fromString('11.375'), base: 'MERCHANDISE_AFTER_DISCOUNT' },
      allocationMethod: 'BY_MERCHANDISE_VALUE',
    }),
  ]

  function runWith(supplierCosts: readonly AdditionalCost[]) {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [
        requirement('A', { requiredQuantity: '7' }),
        requirement('B', { requiredQuantity: '3' }),
        requirement('C', { requiredQuantity: '11' }),
      ],
      suppliers: [supplier('s1')],
      quotes: [
        quote({
          id: 'q1',
          supplierId: 's1',
          currency: 'USD',
          items: [
            quoteItem({ id: 'ia', requirementId: 'A', price: '0.001', currency: 'USD' }),
            quoteItem({ id: 'ib', requirementId: 'B', price: '12.3456789', currency: 'USD' }),
            quoteItem({ id: 'ic', requirementId: 'C', price: '7.7777777', currency: 'USD' }),
          ],
        }),
      ],
    })
    return entryOf(
      compareSuppliers({
        project: p,
        exchangeRateTable: rates,
        costsBySupplierId: { s1: supplierCosts },
      }),
      's1',
    )
  }

  const run = () => runWith(costs)

  /** (merch - 0.8516) x 1.11375, built from the same line arithmetic the engine performs. */
  function landedReference(): ExactReference {
    const merchandise = [
      referenceMultiply(reference('7'), reference('0.001')),
      referenceMultiply(reference('3'), reference('12.3456789')),
      referenceMultiply(reference('11'), reference('7.7777777')),
    ].reduce((total, line) => referenceAdd(total, line), reference('0'))
    const inBaseCurrency = referenceMultiply(merchandise, reference(RATE))
    const afterDiscount = referenceSubtract(inBaseCurrency, reference(DISCOUNT))
    return referenceAdd(afterDiscount, referencePercentageOf(afterDiscount, reference('11.375')))
  }

  it('keeps every digit of the exact total through FX, discount and duty', () => {
    expect(run().exactCalculatedLandedTotal!.toDecimalString()).toBe(
      referenceToString(landedReference()),
    )
  })

  it('settles that total once and reconciles the breakdown and the lines to it', () => {
    expectIntegratedInvariants(run(), 2)
  })

  it('lets the duty settled onto the sub-lira line pay for the leftover kuruş', () => {
    const entry = run()
    const tinyLine = entry.lines!.find((line) => line.requirementId === 'A')!

    expect(tinyLine.exactBaseCurrencyMerchandiseValue.toDecimalString()).toBe('0.2838760533')
    expect(tinyLine.settledMerchandiseValue.toDecimalString()).toBe('0.28')

    // Positive effects settle before discounts, so the 0.03 of duty on this
    // line is capacity the discount may then use: 0.28 + 0.03 - 0.29 = 0.02.
    const byEntry = new Map(
      entry.costAllocation!.byEntry.map((breakdown) => [
        breakdown.entryId,
        breakdown.allocations.map((allocation) => allocation.amount.toDecimalString()),
      ]),
    )
    expect(byEntry.get('duty')![0]).toBe('0.03')
    expect(byEntry.get('discount')).toEqual(['-0.29', '-0.28', '-0.28'])
    expect(tinyLine.allocatedCostTotal!.toDecimalString()).toBe('-0.26')
    expect(tinyLine.settledLandedValue!.toDecimalString()).toBe('0.02')
  })

  it('moves the leftover kuruş off that line as soon as the duty is gone', () => {
    // The same quote and the same discount, with nothing settling onto line A
    // first. Its whole capacity is now its own 0.28, the equal shares still
    // truncate to 0.28 each, and the spare kuruş has to go somewhere else.
    const entry = runWith([costs[0]!])
    const discountShares = entry.costAllocation!.byEntry[0]!.allocations.map((allocation) =>
      allocation.amount.toDecimalString(),
    )

    expect(discountShares).toEqual(['-0.28', '-0.29', '-0.28'])
    expect(entry.lines![0]!.settledLandedValue!.toDecimalString()).toBe('0')
    expectIntegratedInvariants(entry, 2)
  })
})

// ---------------------------------------------------------------------------
// Scenario C — input ordering, on the two axes the cost-ordering suites do not
// ---------------------------------------------------------------------------

/**
 * Scenario C. `AuthoritativeTotal.test.ts` and `NonNegativeLineSettlement.test.ts`
 * already pin that reordering the **cost rows** changes nothing. The other two
 * orderings a user controls were not covered anywhere: the order of the
 * project's requirements, and the order of the items inside a quote.
 *
 * They are not the same kind of ordering. Quote items are matched to
 * requirements by id, so their order is pure input noise and must change
 * literally nothing. Requirement order *is* meaningful — it is the tie-break
 * order for remainder distribution, and the order lines are reported in — so
 * the guarantee is narrower and worth stating exactly: the total, the ranking
 * amount, the settled cost effects and the winner are identical; which line
 * receives a leftover minor unit may differ, and that is presentation.
 */
describe('Scenario C — requirement and quote-item ordering', () => {
  const requirements: RequirementItem[] = [
    requirement('A', { requiredQuantity: '105' }),
    requirement('B', { requiredQuantity: '7' }),
    requirement('C', { requiredQuantity: '33' }),
  ]

  const items: QuoteItem[] = [
    quoteItem({ id: 'ia', requirementId: 'A', price: '1.017', currency: 'USD', moq: '200' }),
    quoteItem({
      id: 'ib',
      requirementId: 'B',
      price: '9.333',
      currency: 'USD',
      unitsPerQuotedUnit: '4',
    }),
    quoteItem({ id: 'ic', requirementId: 'C', price: '2.505', currency: 'USD' }),
  ]

  const costs: AdditionalCost[] = [
    createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      percentage: { rate: Percentage.fromString('3.7'), base: 'MERCHANDISE' },
      allocationMethod: 'EQUAL_PER_LINE',
    }),
    createAdditionalCost({
      id: 'freight',
      kind: 'COST',
      category: 'FREIGHT',
      fixedAmount: Money.fromString('137.77', 'EUR'),
      allocationMethod: 'BY_QUANTITY',
    }),
    createAdditionalCost({
      id: 'duty',
      kind: 'COST',
      category: 'DUTY',
      percentage: {
        rate: Percentage.fromString('8.5'),
        base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
      },
    }),
    createAdditionalCost({
      id: 'surcharge',
      kind: 'SURCHARGE',
      category: 'BANK_FEE',
      fixedAmount: Money.fromString('11.113', 'TRY'),
      allocationMethod: 'EQUAL_PER_LINE',
    }),
  ]

  function run(
    orderedRequirements: readonly RequirementItem[],
    orderedItems: readonly QuoteItem[],
  ): SupplierComparisonEntry {
    const p = project({
      baseCurrency: 'TRY',
      requirements: orderedRequirements,
      suppliers: [supplier('s1')],
      quotes: [quote({ id: 'q1', supplierId: 's1', currency: 'USD', items: orderedItems })],
    })
    return entryOf(
      compareSuppliers({
        project: p,
        exchangeRateTable: TRY_RATES,
        costsBySupplierId: { s1: costs },
      }),
      's1',
    )
  }

  const forward = () => run(requirements, items)

  it('changes nothing at all when the quote lists its items in another order', () => {
    const shuffled = run(requirements, [items[2]!, items[0]!, items[1]!])
    expect(shuffled.exactCalculatedLandedTotal!.toDecimalString()).toBe(
      forward().exactCalculatedLandedTotal!.toDecimalString(),
    )
    expect(shuffled.lines!.map((line) => [line.requirementId, line.settledLandedValue!.toDecimalString()])).toEqual(
      forward().lines!.map((line) => [line.requirementId, line.settledLandedValue!.toDecimalString()]),
    )
  })

  it('keeps the total, the ranking amount and every settled cost effect when requirements are reordered', () => {
    const reversed = run([...requirements].reverse(), items)
    const base = forward()

    expect(reversed.exactCalculatedLandedTotal!.toDecimalString()).toBe(
      base.exactCalculatedLandedTotal!.toDecimalString(),
    )
    expect(reversed.rankingAmount!.toDecimalString()).toBe(base.rankingAmount!.toDecimalString())
    expect(
      reversed.costResult!.entries.map((entry) => [entry.id, entry.settledEffect.toDecimalString()]),
    ).toEqual(base.costResult!.entries.map((entry) => [entry.id, entry.settledEffect.toDecimalString()]))
    expectIntegratedInvariants(reversed, 2)
  })

  it('does not let requirement order decide the winner', () => {
    const p = (orderedRequirements: readonly RequirementItem[]) =>
      project({
        baseCurrency: 'TRY',
        requirements: orderedRequirements,
        suppliers: [supplier('forward'), supplier('reversed')],
        quotes: [
          quote({ id: 'qf', supplierId: 'forward', currency: 'USD', items }),
          quote({
            id: 'qr',
            supplierId: 'reversed',
            currency: 'USD',
            items: [...items].reverse(),
          }),
        ],
      })
    const result = compareSuppliers({
      project: p([...requirements].reverse()),
      exchangeRateTable: TRY_RATES,
      costsBySupplierId: { forward: costs, reversed: [...costs].reverse() },
    })
    expect(entryOf(result, 'forward').rank).toBe(1)
    expect(entryOf(result, 'reversed').rank).toBe(1)
    expect([...result.lowestSupplierIds].sort()).toEqual(['forward', 'reversed'])
  })

  it('moves only which line absorbs the leftover minor unit', () => {
    const base = forward()
    const reversed = run([...requirements].reverse(), items)

    const byRequirement = (entry: SupplierComparisonEntry) =>
      new Map(entry.lines!.map((line) => [line.requirementId, line.settledLandedValue!.toDecimalString()]))
    const a = byRequirement(base)
    const b = byRequirement(reversed)

    // Same set of requirements, same total, at most a minor unit of movement
    // on any single line — the remainder tie-break, and nothing else.
    for (const [requirementId, value] of a) {
      const other = Money.fromString(b.get(requirementId)!, 'TRY')
      const difference = Money.fromString(value, 'TRY').subtract(other).abs()
      expect(difference.isGreaterThan(Money.fromString('0.01', 'TRY'))).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Scenarios D and E — an unusable weighting, with and without a bad discount
// ---------------------------------------------------------------------------

/**
 * Scenarios D and E. The two are the same quote with one field changed, and
 * that is the whole point: an unusable allocation weighting is present in both,
 * so the *only* thing deciding `COMPLETE` from `INVALID` is whether the
 * discount is financially legal. `DiscountLineValidation.test.ts` proves the
 * separation on a bare two-line quote; here it has to survive a foreign
 * currency, a MOQ and a percentage duty on top, with a rival supplier whose
 * rank moves depending on the verdict.
 */
describe('Scenarios D and E — allocation unavailable, with and without an invalid discount', () => {
  const requirements: RequirementItem[] = [
    requirement('BULK', { requiredQuantity: '9', comparisonUnit: 'pcs' }),
    requirement('WEIGHED', { requiredQuantity: '2', comparisonUnit: 'kg' }),
  ]

  // BY_QUANTITY across pcs and kg: no defensible weighting, explanatory only.
  const unallocatableFreight = createAdditionalCost({
    id: 'freight',
    kind: 'COST',
    category: 'FREIGHT',
    fixedAmount: Money.fromString('2', 'EUR'),
    allocationMethod: 'BY_QUANTITY',
  })
  const duty = createAdditionalCost({
    id: 'duty',
    kind: 'COST',
    category: 'DUTY',
    percentage: { rate: Percentage.fromString('6'), base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE' },
  })

  function run(costs: readonly AdditionalCost[]) {
    const p = project({
      baseCurrency: 'TRY',
      requirements,
      suppliers: [supplier('warned'), supplier('rival')],
      quotes: [
        quote({
          id: 'q-warned',
          supplierId: 'warned',
          currency: 'USD',
          items: [
            quoteItem({ id: 'w1', requirementId: 'BULK', price: '1', currency: 'USD', moq: '10' }),
            quoteItem({ id: 'w2', requirementId: 'WEIGHED', price: '0.5', currency: 'USD' }),
          ],
        }),
        quote({
          id: 'q-rival',
          supplierId: 'rival',
          currency: 'TRY',
          items: [
            quoteItem({ id: 'r1', requirementId: 'BULK', price: '90', currency: 'TRY' }),
            quoteItem({ id: 'r2', requirementId: 'WEIGHED', price: '90', currency: 'TRY' }),
          ],
        }),
      ],
    })
    return compareSuppliers({
      project: p,
      exchangeRateTable: TRY_RATES,
      costsBySupplierId: { warned: costs },
    })
  }

  it('D: keeps the warned supplier COMPLETE, ranked first, with a trustworthy total', () => {
    const result = run([unallocatableFreight, duty])
    const warned = entryOf(result, 'warned')

    expect(warned.status).toBe('COMPLETE')
    expect(warned.warnings.map((w) => w.code)).toEqual(['ALLOCATION_UNAVAILABLE'])
    expect(warned.costAllocation).toBeUndefined()
    expect(warned.rank).toBe(1)
    expect(entryOf(result, 'rival').rank).toBe(2)

    // MOQ still resolved 9 -> 10, FX and duty still applied, total still settled once.
    expect(warned.lines![0]!.resolvedQuantity.toDecimalString()).toBe('10')
    expectIntegratedInvariants(warned, result.minorUnit)

    // Every per-line cost share is absent, and nothing pretends otherwise.
    for (const line of warned.lines!) {
      expect(line.allocatedCostTotal).toBeUndefined()
      expect(line.settledLandedValue).toBeUndefined()
    }
  })

  it('E: the same quote is INVALID once a discount overdraws a line, and the rival takes rank 1', () => {
    const overdrawingDiscount = createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      // 300 TRY split equally is 150 a line; the weighed line is worth 1 USD ~ 40.55 TRY.
      fixedAmount: Money.fromString('300', 'TRY'),
      allocationMethod: 'EQUAL_PER_LINE',
    })
    const result = run([unallocatableFreight, duty, overdrawingDiscount])
    const warned = entryOf(result, 'warned')

    expect(warned.status).toBe('INVALID')
    expect(warned.issues.map((issue) => issue.code)).toEqual(['CALCULATION_ERROR'])
    expect(warned.issues[0]!.message).toContain('InvalidDiscountError')
    // Not downgraded into the warning channel, and not ranked.
    expect(warned.warnings).toEqual([])
    expect(warned.rank).toBeUndefined()
    expect(warned.rankingAmount).toBeUndefined()

    expect(entryOf(result, 'rival').rank).toBe(1)
    expect(result.lowestSupplierIds).toEqual(['rival'])
  })

  it('E: the verdict is the same whichever of the three costs is listed first', () => {
    const overdrawingDiscount = createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      fixedAmount: Money.fromString('300', 'TRY'),
      allocationMethod: 'EQUAL_PER_LINE',
    })
    const orderings: AdditionalCost[][] = [
      [overdrawingDiscount, unallocatableFreight, duty],
      [unallocatableFreight, duty, overdrawingDiscount],
      [duty, overdrawingDiscount, unallocatableFreight],
    ]
    for (const costs of orderings) {
      const warned = entryOf(run(costs), 'warned')
      expect(warned.status).toBe('INVALID')
      expect(warned.issues[0]!.message).toContain('InvalidDiscountError')
    }
  })
})
