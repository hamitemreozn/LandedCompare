import { describe, expect, it } from 'vitest'
import {
  allocateSupplierCosts,
  calculateSupplierCosts,
  DiscountAllocationValidationError,
  validateDiscountLineAllocations,
  type AppliedCostEntry,
  type SupplierCostCalculationResult,
} from './CostCalculation'
import {
  createAdditionalCost,
  InvalidDiscountError,
  InvalidPercentageBaseError,
  type AdditionalCost,
  type CostCategory,
  type CostKind,
  type PercentageBase,
} from './AdditionalCost'
import { Percentage } from './Percentage'
import {
  sumAllocations,
  type AllocationMethod,
  type AllocationTarget,
} from './Allocation'
import { ExchangeRate } from './ExchangeRate'
import { ExchangeRateTable, MissingExchangeRateError } from './ExchangeRateTable'
import { calculateQuoteMerchandise, type MerchandiseLine } from './MerchandiseCalculation'
import { resolveOrderQuantity } from './QuantityResolution'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'

const BASE = 'TRY'

/** TRY base with USD available at 43.50 — Phase 2's own reference rate. */
function ratesWithUsd(rate = '43.50'): ExchangeRateTable {
  return ExchangeRateTable.create(BASE, [ExchangeRate.fromString('USD', BASE, rate)])
}

function baseOnly(): ExchangeRateTable {
  return ExchangeRateTable.create(BASE)
}

interface CostOptions {
  currency?: string
  includeInComparison?: boolean
  alreadyIncludedInQuote?: boolean
  allocationMethod?: AllocationMethod
  kind?: CostKind
}

function fixed(
  id: string,
  category: CostCategory,
  amount: string,
  options: CostOptions = {},
): AdditionalCost {
  return createAdditionalCost({
    id,
    kind: options.kind ?? 'COST',
    category,
    fixedAmount: Money.fromString(amount, options.currency ?? BASE),
    includeInComparison: options.includeInComparison,
    alreadyIncludedInQuote: options.alreadyIncludedInQuote,
    allocationMethod: options.allocationMethod,
  })
}

function percentage(
  id: string,
  category: CostCategory,
  rate: string,
  base: PercentageBase,
  options: CostOptions = {},
): AdditionalCost {
  return createAdditionalCost({
    id,
    kind: options.kind ?? 'COST',
    category,
    percentage: { rate: Percentage.fromString(rate), base },
    includeInComparison: options.includeInComparison,
    alreadyIncludedInQuote: options.alreadyIncludedInQuote,
    allocationMethod: options.allocationMethod,
  })
}

function line(id: string, merchandiseValue: string, quantity: string, unit = 'pcs', currency = BASE): AllocationTarget {
  return {
    id,
    merchandiseValue: Money.fromString(merchandiseValue, currency),
    quantity: Quantity.fromString(quantity),
    comparisonUnit: unit,
  }
}

/** Every ordering of `items`, for proving a result does not depend on input order. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]]
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  )
}

function entryById(result: SupplierCostCalculationResult, id: string): AppliedCostEntry {
  const entry = result.entries.find((candidate) => candidate.id === id)
  if (entry === undefined) {
    throw new Error(`No entry "${id}" in result`)
  }
  return entry
}

/**
 * The landed total must be reproducible from the published breakdown alone —
 * if it is not, the breakdown is decoration rather than a trace.
 */
function expectTotalReconstructibleFromBreakdown(result: SupplierCostCalculationResult): void {
  const rebuilt = result.entries.reduce(
    (total, entry) => total.add(entry.signedEffect),
    result.merchandiseTotal,
  )
  expect(rebuilt.toDecimalString()).toBe(result.calculatedLandedTotal.toDecimalString())

  const byKind = result.merchandiseTotal
    .subtract(result.totalDiscounts)
    .add(result.totalSurcharges)
    .add(result.totalAdditionalCosts)
  expect(byKind.toDecimalString()).toBe(result.calculatedLandedTotal.toDecimalString())
}

describe('calculateSupplierCosts — fixed costs', () => {
  it('adds a fixed cost already in the base currency', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [fixed('freight', 'FREIGHT', '1000')],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('11000')
    expectTotalReconstructibleFromBreakdown(result)
  })

  it('converts a fixed cost in a foreign currency with Phase 2s rate engine', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [fixed('freight', 'FREIGHT', '1000', { currency: 'USD' })],
      exchangeRateTable: ratesWithUsd(),
      minorUnit: 2,
    })

    const freight = entryById(result, 'freight')
    expect(freight.originalAmount?.toDecimalString()).toBe('1000')
    expect(freight.originalAmount?.currency).toBe('USD')
    expect(freight.baseCurrencyAmount.toDecimalString()).toBe('43500')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('53500')
  })

  it('blocks on a missing rate rather than falling back silently', () => {
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('10000', BASE),
        costs: [fixed('freight', 'FREIGHT', '1000', { currency: 'EUR' })],
        exchangeRateTable: ratesWithUsd(),
        minorUnit: 2,
      }),
    ).toThrow(MissingExchangeRateError)
  })

  it('blocks on a missing rate even for a cost that would not reach the total', () => {
    // An excluded cost is still shown in the breakdown, and showing it in a
    // different currency from everything else would defeat the comparison.
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('10000', BASE),
        costs: [fixed('freight', 'FREIGHT', '1000', { currency: 'EUR', includeInComparison: false })],
        exchangeRateTable: ratesWithUsd(),
        minorUnit: 2,
      }),
    ).toThrow(MissingExchangeRateError)
  })

  it('blocks on a missing rate for a cost that is already inside the quote', () => {
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('10000', BASE),
        costs: [
          fixed('freight', 'FREIGHT', '1000', { currency: 'EUR', alreadyIncludedInQuote: true }),
        ],
        exchangeRateTable: ratesWithUsd(),
        minorUnit: 2,
      }),
    ).toThrow(MissingExchangeRateError)
  })

  it('converts a non-contributing foreign-currency cost into the base currency', () => {
    // This is the pay-off for demanding the rate: the breakdown stays
    // comparable, in one currency, even for amounts the total never counted.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '1000', { currency: 'USD', alreadyIncludedInQuote: true }),
        fixed('tax', 'TAX', '200', { currency: 'USD', includeInComparison: false }),
      ],
      exchangeRateTable: ratesWithUsd(),
      minorUnit: 2,
    })

    const freight = entryById(result, 'freight')
    const tax = entryById(result, 'tax')
    expect(freight.baseCurrencyAmount.toDecimalString()).toBe('43500')
    expect(freight.baseCurrencyAmount.currency).toBe(BASE)
    expect(freight.originalAmount?.currency).toBe('USD')
    expect(tax.baseCurrencyAmount.toDecimalString()).toBe('8700')
    expect(tax.baseCurrencyAmount.currency).toBe(BASE)

    // Converted and traceable, but neither one reaches the total.
    expect(freight.signedEffect.toDecimalString()).toBe('0')
    expect(tax.signedEffect.toDecimalString()).toBe('0')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('10000')
  })
})

describe('calculateSupplierCosts — multiple discounts', () => {
  it('takes every percentage discount on the original merchandise base, not sequentially', () => {
    // 10% + 10% is 20% in this MVP, not 19%. Sequential/compounding discount
    // chains are not supported — see docs/CALCULATION_RULES.md.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('100', BASE),
      costs: [
        percentage('d1', 'OTHER', '10', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        percentage('d2', 'OTHER', '10', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })

    expect(entryById(result, 'd1').percentageBaseAmount?.toDecimalString()).toBe('100')
    expect(entryById(result, 'd2').percentageBaseAmount?.toDecimalString()).toBe('100')
    expect(entryById(result, 'd2').baseCurrencyAmount.toDecimalString()).toBe('10')
    expect(result.totalDiscounts.toDecimalString()).toBe('20')
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('80')
    // Explicitly not the sequential result:
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).not.toBe('81')
  })

  it('gives an identical result for every input order of mixed discounts', () => {
    const discounts = [
      percentage('pct-10', 'OTHER', '10', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      fixed('flat-15', 'OTHER', '15', { kind: 'DISCOUNT' }),
      percentage('pct-25', 'OTHER', '25', 'MERCHANDISE', { kind: 'DISCOUNT' }),
    ]

    const results = permutations(discounts).map((costs) =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('1000', BASE),
        costs,
        exchangeRateTable: baseOnly(),
        minorUnit: 2,
      }),
    )

    expect(results).toHaveLength(6)
    for (const result of results) {
      expect(result.totalDiscounts.toDecimalString()).toBe('365')
      expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('635')
      expect(result.calculatedLandedTotal.toDecimalString()).toBe('635')
    }
  })

  it('stays order-independent when the discounts carry sub-minor-unit precision', () => {
    const discounts = [
      percentage('pct-333', 'OTHER', '3.33', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      percentage('pct-111', 'OTHER', '1.11', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      fixed('flat', 'OTHER', '0.005', { kind: 'DISCOUNT' }),
    ]

    for (const costs of permutations(discounts)) {
      const result = calculateSupplierCosts({
        merchandiseTotal: Money.fromString('1000.005', BASE),
        costs,
        exchangeRateTable: baseOnly(),
        minorUnit: 2,
      })
      expect(entryById(result, 'pct-333').baseCurrencyAmount.toDecimalString()).toBe('33.3001665')
      expect(entryById(result, 'pct-111').baseCurrencyAmount.toDecimalString()).toBe('11.1000555')
      expect(result.totalDiscounts.toDecimalString()).toBe('44.405222')
      expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('955.599778')
    }
  })

  it('lets two 50% discounts consume the merchandise total exactly', () => {
    // Sequential stacking would leave 25; parallel stacking leaves 0. This
    // pins which of the two the engine implements.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('100', BASE),
      costs: [
        percentage('d1', 'OTHER', '50', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        percentage('d2', 'OTHER', '50', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.totalDiscounts.toDecimalString()).toBe('100')
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('0')
  })

  it('rejects three 50% discounts that sequential stacking would have allowed', () => {
    // Sequential: 50 + 25 + 12.5 = 87.5, which would fit. Parallel: 150,
    // which does not — and the rejection is the proof.
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('100', BASE),
        costs: [
          percentage('d1', 'OTHER', '50', 'MERCHANDISE', { kind: 'DISCOUNT' }),
          percentage('d2', 'OTHER', '50', 'MERCHANDISE', { kind: 'DISCOUNT' }),
          percentage('d3', 'OTHER', '50', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        ],
        exchangeRateTable: baseOnly(),
        minorUnit: 2,
      }),
    ).toThrow(InvalidDiscountError)
  })

  it('rejects an over-large discount set whatever order it arrives in', () => {
    const discounts = [
      percentage('pct-60', 'OTHER', '60', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      percentage('pct-45', 'OTHER', '45', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      fixed('flat-5', 'OTHER', '5', { kind: 'DISCOUNT' }),
    ]

    for (const costs of permutations(discounts)) {
      expect(() =>
        calculateSupplierCosts({
          merchandiseTotal: Money.fromString('100', BASE),
          costs,
          exchangeRateTable: baseOnly(),
          minorUnit: 2,
        }),
      ).toThrow(InvalidDiscountError)
    }
  })
})

describe('calculateSupplierCosts — inclusion behaviour', () => {
  it('does not add a cost that is already inside the quoted price', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [fixed('freight', 'FREIGHT', '1000', { alreadyIncludedInQuote: true })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })

    const freight = entryById(result, 'freight')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('10000')
    expect(freight.contributes).toBe(false)
    expect(freight.exclusionReason).toBe('ALREADY_INCLUDED_IN_QUOTE')
    // Still traceable: the amount is known, it just did not reach the total.
    expect(freight.baseCurrencyAmount.toDecimalString()).toBe('1000')
    expect(freight.signedEffect.toDecimalString()).toBe('0')
    expect(result.alreadyIncludedEntries).toHaveLength(1)
    expect(result.appliedEntries).toHaveLength(0)
  })

  it('keeps a cost out of the comparison total when the user excludes it', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [fixed('tax', 'TAX', '1800', { includeInComparison: false })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })

    const tax = entryById(result, 'tax')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('10000')
    expect(tax.exclusionReason).toBe('EXCLUDED_FROM_COMPARISON')
    expect(tax.baseCurrencyAmount.toDecimalString()).toBe('1800')
    expect(result.excludedEntries).toHaveLength(1)
  })

  it('reports the structural reason first when both exclusions apply', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '1000', {
          alreadyIncludedInQuote: true,
          includeInComparison: false,
        }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(entryById(result, 'freight').exclusionReason).toBe('ALREADY_INCLUDED_IN_QUOTE')
    expect(result.excludedEntries).toHaveLength(0)
    expect(result.alreadyIncludedEntries).toHaveLength(1)
  })
})

describe('calculateSupplierCosts — discounts and surcharges', () => {
  it('applies a fixed discount as a negative effect', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [fixed('discount', 'OTHER', '500', { kind: 'DISCOUNT' })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(entryById(result, 'discount').baseCurrencyAmount.toDecimalString()).toBe('500')
    expect(entryById(result, 'discount').signedEffect.toDecimalString()).toBe('-500')
    expect(result.totalDiscounts.toDecimalString()).toBe('500')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('9500')
    expectTotalReconstructibleFromBreakdown(result)
  })

  it('applies a percentage discount', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [percentage('discount', 'OTHER', '5', 'MERCHANDISE', { kind: 'DISCOUNT' })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('9500')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('9500')
  })

  it('applies a fixed surcharge as a positive effect', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [fixed('rush', 'OTHER', '300', { kind: 'SURCHARGE' })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(entryById(result, 'rush').signedEffect.toDecimalString()).toBe('300')
    expect(result.totalSurcharges.toDecimalString()).toBe('300')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('10300')
    expectTotalReconstructibleFromBreakdown(result)
  })

  it('applies a percentage surcharge', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [percentage('rush', 'OTHER', '3', 'MERCHANDISE', { kind: 'SURCHARGE' })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('10300')
  })

  it('keeps discounts and surcharges as separate totals, not one signed bucket', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        fixed('discount', 'OTHER', '500', { kind: 'DISCOUNT' }),
        fixed('rush', 'OTHER', '300', { kind: 'SURCHARGE' }),
        fixed('freight', 'FREIGHT', '200'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.totalDiscounts.toDecimalString()).toBe('500')
    expect(result.totalSurcharges.toDecimalString()).toBe('300')
    expect(result.totalAdditionalCosts.toDecimalString()).toBe('200')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('10000')
    expectTotalReconstructibleFromBreakdown(result)
  })

  it('rejects a fixed discount larger than the merchandise total', () => {
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('10000', BASE),
        costs: [fixed('discount', 'OTHER', '20000', { kind: 'DISCOUNT' })],
        exchangeRateTable: baseOnly(),
        minorUnit: 2,
      }),
    ).toThrow(InvalidDiscountError)
  })

  it('rejects stacked percentage discounts that together exceed the base', () => {
    // Each is individually legal at 60%; together they would drive the
    // discounted merchandise base negative.
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('10000', BASE),
        costs: [
          percentage('d1', 'OTHER', '60', 'MERCHANDISE', { kind: 'DISCOUNT' }),
          percentage('d2', 'OTHER', '60', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        ],
        exchangeRateTable: baseOnly(),
        minorUnit: 2,
      }),
    ).toThrow(InvalidDiscountError)
  })

  it('allows a discount that lands exactly on the merchandise total', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [fixed('discount', 'OTHER', '10000', { kind: 'DISCOUNT' })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('0')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('0')
  })

  it('ignores an excluded discount when checking the discount ceiling', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        fixed('applied', 'OTHER', '6000', { kind: 'DISCOUNT' }),
        fixed('in-quote', 'OTHER', '9000', { kind: 'DISCOUNT', alreadyIncludedInQuote: true }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.totalDiscounts.toDecimalString()).toBe('6000')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('4000')
  })

  it('rejects a negative merchandise total outright', () => {
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('-1', BASE),
        costs: [],
        exchangeRateTable: baseOnly(),
        minorUnit: 2,
      }),
    ).toThrow(InvalidPercentageBaseError)
  })
})

describe('calculateSupplierCosts — percentage bases', () => {
  it('takes a percentage on the merchandise base', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        percentage('discount', 'OTHER', '10', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        percentage('duty', 'DUTY', '5', 'MERCHANDISE'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const duty = entryById(result, 'duty')
    expect(duty.percentageBaseAmount?.toDecimalString()).toBe('10000')
    expect(duty.baseCurrencyAmount.toDecimalString()).toBe('500')
  })

  it('takes a percentage on the merchandise-after-discount base', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        percentage('discount', 'OTHER', '10', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        percentage('duty', 'DUTY', '5', 'MERCHANDISE_AFTER_DISCOUNT'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const duty = entryById(result, 'duty')
    expect(duty.percentageBaseAmount?.toDecimalString()).toBe('9000')
    expect(duty.baseCurrencyAmount.toDecimalString()).toBe('450')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('9450')
  })

  it('takes a percentage on the merchandise + freight + insurance base', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        percentage('discount', 'OTHER', '10', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        fixed('freight', 'FREIGHT', '1000'),
        fixed('insurance', 'INSURANCE', '500'),
        percentage('duty', 'DUTY', '5', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandisePlusFreightInsurance.toDecimalString()).toBe('10500')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('525')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('11025')
    expectTotalReconstructibleFromBreakdown(result)
  })

  it('leaves freight out of the CIF-like base when it is already inside the quote', () => {
    // Double-counting protection has to reach the percentage base too, or the
    // duty would be charged on freight the quote already contains.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '1000', { alreadyIncludedInQuote: true }),
        fixed('insurance', 'INSURANCE', '500'),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandisePlusFreightInsurance.toDecimalString()).toBe('10500')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('1050')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('11550')
  })

  it('keeps an insurance cost excluded from the comparison inside the CIF-like base', () => {
    // `includeInComparison: false` is a statement about what to compare, not
    // about whether the money exists. The insurance was still paid, so duty is
    // still charged on it — only the insurance's own amount stays out of the
    // comparison total.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        fixed('insurance', 'INSURANCE', '500', { includeInComparison: false }),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandisePlusFreightInsurance.toDecimalString()).toBe('10500')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('1050')
    expect(entryById(result, 'insurance').affectsPercentageBases).toBe(true)
    expect(entryById(result, 'insurance').contributes).toBe(false)
    // 10,000 + 1,050 duty. The excluded 500 never reaches the total.
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('11050')
  })

  it('is the decided freight example: excluded freight still builds the duty base', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '200', { includeInComparison: false }),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandisePlusFreightInsurance.toDecimalString()).toBe('1200')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('120')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('1120')
  })

  it('keeps a discount excluded from the comparison inside the after-discount base', () => {
    // The mirror of the freight rule: the price reduction is real, so a duty
    // taken on "merchandise after discount" sees it — but the comparison total
    // the user asked not to reduce is not reduced.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('promo', 'OTHER', '100', { kind: 'DISCOUNT', includeInComparison: false }),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_AFTER_DISCOUNT'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('900')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('90')
    expect(result.totalDiscounts.toDecimalString()).toBe('0')
    expect(result.baseAffectingDiscounts.toDecimalString()).toBe('100')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('1090')
  })

  it('leaves a discount already inside the quote out of the after-discount base', () => {
    // The opposite statement: the quoted price already reflects it, so
    // subtracting it again would double the reduction.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('settled', 'OTHER', '100', { kind: 'DISCOUNT', alreadyIncludedInQuote: true }),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_AFTER_DISCOUNT'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('1000')
    expect(result.baseAffectingDiscounts.toDecimalString()).toBe('0')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('1100')
  })

  it('rejects base-affecting discounts that exceed the merchandise total even when none of them contribute', () => {
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('1000', BASE),
        costs: [
          fixed('a', 'OTHER', '700', { kind: 'DISCOUNT', includeInComparison: false }),
          fixed('b', 'OTHER', '600', { kind: 'DISCOUNT', includeInComparison: false }),
        ],
        exchangeRateTable: baseOnly(),
        minorUnit: 2,
      }),
    ).toThrow(InvalidDiscountError)
  })

  it('does not let a freight-categorised surcharge enter the CIF-like base', () => {
    // Surcharges are evaluated after percentage costs, so they cannot be part
    // of a base without creating a cycle.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        fixed('fuel', 'FREIGHT', '400', { kind: 'SURCHARGE' }),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandisePlusFreightInsurance.toDecimalString()).toBe('10000')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('11400')
  })

  it('chains an insurance percentage into the base a duty percentage then uses', () => {
    // insurance = 1% of 10000 = 100; base = 10000 + 100; duty = 10% of 10100.
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('10000', BASE),
      costs: [
        percentage('insurance', 'INSURANCE', '1', 'MERCHANDISE'),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(result.percentageBases.merchandisePlusFreightInsurance.toDecimalString()).toBe('10100')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('1010')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('11110')
  })

  it('never rounds a percentage base to the minor unit', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000.005', BASE),
      costs: [
        percentage('discount', 'OTHER', '1', 'MERCHANDISE', { kind: 'DISCOUNT' }),
        percentage('duty', 'DUTY', '10', 'MERCHANDISE_AFTER_DISCOUNT'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(entryById(result, 'discount').baseCurrencyAmount.toDecimalString()).toBe('10.00005')
    expect(result.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('990.00495')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('99.000495')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('1089.005445')
    expectTotalReconstructibleFromBreakdown(result)
  })

  it('computes a percentage on the converted base, not the quote-currency one', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', 'USD'),
      costs: [percentage('duty', 'DUTY', '10', 'MERCHANDISE')],
      exchangeRateTable: ratesWithUsd('40'),
      minorUnit: 2,
    })
    expect(result.merchandiseTotal.toDecimalString()).toBe('40000')
    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('4000')
    expect(entryById(result, 'duty').baseCurrencyAmount.currency).toBe(BASE)
  })
})

/**
 * The validation-critical half of allocation, split out from the explanatory
 * half so that an unrelated cost's unusable weighting can no longer stop the
 * per-line discount rule from being evaluated. See
 * docs/CALCULATION_RULES.md, "Discount validation vs explanatory allocation".
 */
describe('validateDiscountLineAllocations', () => {
  const mixedUnitLines = [line('a', '900', '1', 'pcs'), line('b', '100', '1', 'kg')]

  function costs(entries: readonly AdditionalCost[]): SupplierCostCalculationResult {
    return calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: entries,
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
  }

  function validate(entries: readonly AdditionalCost[]): void {
    validateDiscountLineAllocations({
      costResult: costs(entries),
      targets: mixedUnitLines,
      exchangeRateTable: baseOnly(),
    })
  }

  it('accepts a discount that fits every line', () => {
    expect(() =>
      validate([fixed('discount', 'OTHER', '60', { kind: 'DISCOUNT', allocationMethod: 'EQUAL_PER_LINE' })]),
    ).not.toThrow()
  })

  it('rejects an overdrawing discount even though a freight cost cannot be allocated at all', () => {
    // The freight's BY_QUANTITY weighting is unusable across pcs and kg. That
    // used to throw first and take the discount check down with it.
    expect(() =>
      validate([
        fixed('discount', 'OTHER', '600', { kind: 'DISCOUNT', allocationMethod: 'EQUAL_PER_LINE' }),
        fixed('freight', 'FREIGHT', '50', { allocationMethod: 'BY_QUANTITY' }),
      ]),
    ).toThrow(InvalidDiscountError)
  })

  it('rejects a non-zero discount whose own weighting cannot be established', () => {
    expect(() =>
      validate([fixed('discount', 'OTHER', '200', { kind: 'DISCOUNT', allocationMethod: 'BY_QUANTITY' })]),
    ).toThrow(DiscountAllocationValidationError)
  })

  it('ignores a zero-value discount with the same unusable weighting', () => {
    // No money moves, so no line can be overdrawn and there is nothing to
    // prove. The explanatory pass still reports the missing breakdown.
    expect(() =>
      validate([fixed('discount', 'OTHER', '0', { kind: 'DISCOUNT', allocationMethod: 'BY_QUANTITY' })]),
    ).not.toThrow()
  })

  it('checks a discount kept out of the compared total — the money still exists', () => {
    // `includeInComparison: false` has a signedEffect of zero, but it still
    // lowers merchandiseAfterDiscount and everything taken on that base, and
    // the supplier-level ceiling already bounds it. The per-line rule has to
    // agree, or the same 600 TRY is real at supplier level and absent here.
    expect(() =>
      validate([
        fixed('excluded', 'OTHER', '600', {
          kind: 'DISCOUNT',
          allocationMethod: 'EQUAL_PER_LINE',
          includeInComparison: false,
        }),
      ]),
    ).toThrow(InvalidDiscountError)
  })

  it('ignores a discount already inside the quoted price', () => {
    // The opposite statement: the money is in the line prices already, so it
    // affects no base and checking it against a line would count it twice.
    expect(() =>
      validate([
        fixed('inQuote', 'OTHER', '600', {
          kind: 'DISCOUNT',
          allocationMethod: 'EQUAL_PER_LINE',
          alreadyIncludedInQuote: true,
        }),
      ]),
    ).not.toThrow()
  })

  it('says nothing about an ordinary cost that cannot be allocated', () => {
    expect(() => validate([fixed('freight', 'FREIGHT', '50', { allocationMethod: 'BY_QUANTITY' })])).not.toThrow()
  })

  it('reaches the same verdict in every cost ordering', () => {
    const entries = [
      fixed('discount', 'OTHER', '600', { kind: 'DISCOUNT', allocationMethod: 'EQUAL_PER_LINE' }),
      fixed('freight', 'FREIGHT', '50', { allocationMethod: 'BY_QUANTITY' }),
      fixed('duty', 'DUTY', '30'),
    ]
    for (const ordering of permutations(entries)) {
      expect(() => validate(ordering)).toThrow(InvalidDiscountError)
    }
  })
})

describe('allocateSupplierCosts', () => {
  const twoLines = [line('a', '600', '30'), line('b', '400', '20')]

  it('spreads a shared cost across lines so the parts sum to the whole', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [fixed('freight', 'FREIGHT', '100')],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: twoLines,
      exchangeRateTable: baseOnly(),
    })

    const freight = allocation.byEntry[0]
    expect(freight?.allocations.map((a) => a.amount.toDecimalString())).toEqual(['60', '40'])
    expect(sumAllocations(freight?.allocations ?? [], BASE).toDecimalString()).toBe(
      freight?.settledAmount.toDecimalString(),
    )
    expect(allocation.byLine.map((l) => l.allocatedCostTotal.toDecimalString())).toEqual(['60', '40'])
    expect(allocation.minorUnit).toBe(2)
  })

  it('honours a per-cost allocation method', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '100', { allocationMethod: 'BY_MERCHANDISE_VALUE' }),
        fixed('brokerage', 'BROKERAGE', '100', { allocationMethod: 'EQUAL_PER_LINE' }),
        fixed('transport', 'LOCAL_TRANSPORT', '100', { allocationMethod: 'BY_QUANTITY' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: twoLines,
      exchangeRateTable: baseOnly(),
    })

    expect(allocation.byEntry.map((entry) => entry.allocations.map((a) => a.amount.toDecimalString()))).toEqual([
      ['60', '40'],
      ['50', '50'],
      ['60', '40'],
    ])
    expect(allocation.byLine.map((l) => l.allocatedCostTotal.toDecimalString())).toEqual(['170', '130'])
  })

  it('allocates a discount as a negative amount on each line', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '100'),
        fixed('discount', 'OTHER', '50', { kind: 'DISCOUNT' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: twoLines,
      exchangeRateTable: baseOnly(),
    })

    expect(allocation.byEntry[1]?.allocations.map((a) => a.amount.toDecimalString())).toEqual([
      '-30',
      '-20',
    ])
    expect(allocation.byLine.map((l) => l.allocatedCostTotal.toDecimalString())).toEqual(['30', '20'])
  })

  it('does not allocate an entry that never reached the total', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '100', { alreadyIncludedInQuote: true }),
        fixed('tax', 'TAX', '180', { includeInComparison: false }),
        fixed('brokerage', 'BROKERAGE', '50'),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: twoLines,
      exchangeRateTable: baseOnly(),
    })

    expect(allocation.byEntry.map((entry) => entry.entryId)).toEqual(['brokerage'])
    expect(allocation.byLine.map((l) => l.allocatedCostTotal.toDecimalString())).toEqual(['30', '20'])
  })

  it('rejects a flat discount split that would push a small line negative', () => {
    // 300 split equally is 150 per line, but line "b" is only worth 100.
    // Clamping it would break the sum-to-the-whole invariant, so the
    // configuration is refused instead of quietly redistributed.
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('discount', 'OTHER', '300', { kind: 'DISCOUNT', allocationMethod: 'EQUAL_PER_LINE' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(() =>
      allocateSupplierCosts({
        costResult,
        targets: [line('a', '900', '1'), line('b', '100', '1')],
        exchangeRateTable: baseOnly(),
      }),
    ).toThrow(InvalidDiscountError)
  })

  it('does not reject a discount that exactly equals the line, on a settlement artefact', () => {
    // Line values 10.004 and 989.996 sum to the full 1,000 discount. Settled,
    // the larger line's share rounds up to 990.00 and looks 0.004 too big —
    // but the exact share is exactly the line's value, so the configuration is
    // legal. Settlement is a presentation boundary; it must not decide
    // legality.
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        percentage('discount', 'OTHER', '100', 'MERCHANDISE', { kind: 'DISCOUNT' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: [line('a', '10.004', '1'), line('b', '989.996', '1')],
      exchangeRateTable: baseOnly(),
    })

    expect(allocation.byEntry[0]?.allocations.map((a) => a.amount.toDecimalString())).toEqual([
      '-10',
      '-990',
    ])
    expect(allocation.byEntry[0]?.allocations.map((a) => a.exactAmount.toDecimalString())).toEqual([
      '-10.004',
      '-989.996',
    ])
  })

  it('still rejects a discount that genuinely exceeds a line, before settlement', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [
        fixed('discount', 'OTHER', '500', { kind: 'DISCOUNT', allocationMethod: 'EQUAL_PER_LINE' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    expect(() =>
      allocateSupplierCosts({
        costResult,
        targets: [line('a', '900', '1'), line('b', '100', '1')],
        exchangeRateTable: baseOnly(),
      }),
    ).toThrow(InvalidDiscountError)
  })

  it('publishes an exact share alongside every settled allocation', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [fixed('freight', 'FREIGHT', '100', { allocationMethod: 'EQUAL_PER_LINE' })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')],
      exchangeRateTable: baseOnly(),
    })
    // Settled: 33.34 / 33.33 / 33.33. Exact: 33.333… each.
    expect(allocation.byEntry[0]?.allocations.map((a) => a.amount.toDecimalString())).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ])
    for (const share of allocation.byEntry[0]!.allocations) {
      expect(share.exactAmount.toDecimalString()).toMatch(/^33\.3333/)
    }
  })

  it('accepts the same discount when it is split proportionally', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1000', BASE),
      costs: [fixed('discount', 'OTHER', '300', { kind: 'DISCOUNT' })],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: [line('a', '900', '1'), line('b', '100', '1')],
      exchangeRateTable: baseOnly(),
    })
    expect(allocation.byEntry[0]?.allocations.map((a) => a.amount.toDecimalString())).toEqual([
      '-270',
      '-30',
    ])
  })

  it('keeps the sum-to-the-whole invariant for every entry it allocates', () => {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('1234.56', BASE),
      costs: [
        fixed('freight', 'FREIGHT', '100.005'),
        percentage('insurance', 'INSURANCE', '0.5', 'MERCHANDISE'),
        percentage('duty', 'DUTY', '7.3', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
        fixed('brokerage', 'BROKERAGE', '77.77', { allocationMethod: 'EQUAL_PER_LINE' }),
        fixed('discount', 'OTHER', '13.31', { kind: 'DISCOUNT' }),
      ],
      exchangeRateTable: baseOnly(),
      minorUnit: 2,
    })
    const allocation = allocateSupplierCosts({
      costResult,
      targets: [line('a', '411.52', '7'), line('b', '411.52', '11'), line('c', '411.52', '13')],
      exchangeRateTable: baseOnly(),
    })

    expect(allocation.byEntry).toHaveLength(5)
    for (const entry of allocation.byEntry) {
      expect(sumAllocations(entry.allocations, BASE).toDecimalString()).toBe(
        entry.settledAmount.toDecimalString(),
      )
    }
  })
})

describe('Phase 2 / Phase 3 integration', () => {
  it('runs Phase 2 merchandise straight into the Phase 4 cost engine', () => {
    const quoteCurrency = 'USD'
    const rateTable = ratesWithUsd()
    const lines: MerchandiseLine[] = [
      { unitPrice: Money.fromString('12.50', quoteCurrency), calculationQuantity: Quantity.fromString('100') },
      { unitPrice: Money.fromString('3.75', quoteCurrency), calculationQuantity: Quantity.fromString('40') },
    ]
    const merchandise = calculateQuoteMerchandise(lines, quoteCurrency, rateTable)
    expect(merchandise.baseCurrencyMerchandiseTotal.toDecimalString()).toBe('60900')

    const result = calculateSupplierCosts({
      merchandiseTotal: merchandise.baseCurrencyMerchandiseTotal,
      costs: [fixed('freight', 'FREIGHT', '2000'), percentage('duty', 'DUTY', '5', 'MERCHANDISE')],
      exchangeRateTable: rateTable,
      minorUnit: 2,
    })

    expect(entryById(result, 'duty').baseCurrencyAmount.toDecimalString()).toBe('3045')
    expect(result.calculatedLandedTotal.toDecimalString()).toBe('65945')
    expectTotalReconstructibleFromBreakdown(result)
  })

  it('runs Phase 3 quantity resolution through merchandise and into costs', () => {
    const quoteCurrency = 'USD'
    const rateTable = ratesWithUsd('40')

    // 105 pcs needed, sold in 10-pcs boxes at 70 USD/box -> 11 boxes.
    const boxed = resolveOrderQuantity({
      requiredQuantity: Quantity.fromString('105'),
      unitsPerQuotedUnit: Quantity.fromString('10'),
    })
    // 50 pcs needed, but the supplier's MOQ is 80 pcs at 5 USD/pcs.
    const moqBound = resolveOrderQuantity({
      requiredQuantity: Quantity.fromString('50'),
      moq: Quantity.fromString('80'),
    })
    expect(boxed.quotedUnitQuantity.toDecimalString()).toBe('11')
    expect(moqBound.resolvedQuantity.toDecimalString()).toBe('80')

    const merchandise = calculateQuoteMerchandise(
      [
        { unitPrice: Money.fromString('70', quoteCurrency), calculationQuantity: boxed.quotedUnitQuantity },
        { unitPrice: Money.fromString('5', quoteCurrency), calculationQuantity: moqBound.quotedUnitQuantity },
      ],
      quoteCurrency,
      rateTable,
    )
    expect(merchandise.quoteCurrencyMerchandiseTotal.toDecimalString()).toBe('1170')
    expect(merchandise.baseCurrencyMerchandiseTotal.toDecimalString()).toBe('46800')

    const costResult = calculateSupplierCosts({
      merchandiseTotal: merchandise.baseCurrencyMerchandiseTotal,
      costs: [fixed('freight', 'FREIGHT', '1000'), percentage('duty', 'DUTY', '5', 'MERCHANDISE')],
      exchangeRateTable: rateTable,
      minorUnit: 2,
    })
    expect(costResult.calculatedLandedTotal.toDecimalString()).toBe('50140')

    // The two lines carry unequal merchandise value, so the shared freight
    // splits unevenly and the leftover kuruş has to land somewhere definite.
    const allocation = allocateSupplierCosts({
      costResult,
      targets: [
        line('boxed', '770', '110', 'pcs', quoteCurrency),
        line('moq', '400', '80', 'pcs', quoteCurrency),
      ],
      exchangeRateTable: rateTable,
    })
    expect(allocation.byEntry[0]?.allocations.map((a) => a.amount.toDecimalString())).toEqual([
      '658.12',
      '341.88',
    ])
    expect(sumAllocations(allocation.byEntry[0]?.allocations ?? [], BASE).toDecimalString()).toBe('1000')
  })
})
