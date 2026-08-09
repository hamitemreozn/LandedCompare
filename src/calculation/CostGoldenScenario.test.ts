import { describe, expect, it } from 'vitest'
import { allocateSupplierCosts, calculateSupplierCosts } from './CostCalculation'
import { createAdditionalCost } from './AdditionalCost'
import { Percentage } from './Percentage'
import { sumAllocations, type AllocationTarget } from './Allocation'
import { ExchangeRate } from './ExchangeRate'
import { ExchangeRateTable } from './ExchangeRateTable'
import { calculateQuoteMerchandise, type MerchandiseLine } from './MerchandiseCalculation'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'

/**
 * Phase 4 golden scenario (see docs/CALCULATION_RULES.md). Hand-computed
 * reference values pinning the whole pipeline together — merchandise,
 * conversion, discount, fixed costs, a percentage cost on the CIF-like base,
 * the landed total, and allocation — rather than any single step.
 *
 * Base currency: TRY. Quote currency: USD at 1 USD = 40 TRY.
 *   A: 100 x 10 USD = 1,000 USD
 *   B:  50 x 20 USD = 1,000 USD
 *   merchandise                 2,000 USD -> 80,000 TRY
 *   discount 5% of merchandise           -   4,000 TRY  -> after 76,000
 *   freight (fixed)                      +  10,000 TRY
 *   insurance (fixed)                    +   2,000 TRY
 *   duty 10% of 76,000+10,000+2,000      +   8,800 TRY
 *   brokerage (fixed)                    +   1,500 TRY
 *   calculated landed total                 98,300 TRY
 *
 * Nothing here is special-cased: these values come out of the same
 * `calculateSupplierCosts` / `allocateSupplierCosts` used everywhere else.
 */
describe('Phase 4 golden scenario — integrated landed total', () => {
  const quoteCurrency = 'USD'
  const rateTable = ExchangeRateTable.create('TRY', [
    ExchangeRate.fromString(quoteCurrency, 'TRY', '40'),
  ])

  const lines: MerchandiseLine[] = [
    { unitPrice: Money.fromString('10', quoteCurrency), calculationQuantity: Quantity.fromString('100') },
    { unitPrice: Money.fromString('20', quoteCurrency), calculationQuantity: Quantity.fromString('50') },
  ]

  const costs = [
    createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      percentage: { rate: Percentage.fromString('5'), base: 'MERCHANDISE' },
    }),
    createAdditionalCost({
      id: 'freight',
      kind: 'COST',
      category: 'FREIGHT',
      fixedAmount: Money.fromString('10000', 'TRY'),
    }),
    createAdditionalCost({
      id: 'insurance',
      kind: 'COST',
      category: 'INSURANCE',
      fixedAmount: Money.fromString('2000', 'TRY'),
    }),
    createAdditionalCost({
      id: 'duty',
      kind: 'COST',
      category: 'DUTY',
      percentage: {
        rate: Percentage.fromString('10'),
        base: 'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
      },
    }),
    createAdditionalCost({
      id: 'brokerage',
      kind: 'COST',
      category: 'BROKERAGE',
      fixedAmount: Money.fromString('1500', 'TRY'),
    }),
  ]

  function run() {
    const merchandise = calculateQuoteMerchandise(lines, quoteCurrency, rateTable)
    const costResult = calculateSupplierCosts({
      merchandiseTotal: merchandise.baseCurrencyMerchandiseTotal,
      costs,
      exchangeRateTable: rateTable,
    })
    return { merchandise, costResult }
  }

  it('matches the hand-computed reference totals exactly', () => {
    const { merchandise, costResult } = run()

    expect(merchandise.quoteCurrencyMerchandiseTotal.toDecimalString()).toBe('2000')
    expect(costResult.merchandiseTotal.toDecimalString()).toBe('80000')
    expect(costResult.totalDiscounts.toDecimalString()).toBe('4000')
    expect(costResult.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('76000')
    expect(costResult.percentageBases.merchandisePlusFreightInsurance.toDecimalString()).toBe('88000')
    expect(costResult.calculatedLandedTotal.toDecimalString()).toBe('98300')
    expect(costResult.calculatedLandedTotal.currency).toBe('TRY')
  })

  it('pins each component of the breakdown, not just the total', () => {
    const { costResult } = run()
    const amounts = Object.fromEntries(
      costResult.entries.map((entry) => [entry.id, entry.signedEffect.toDecimalString()]),
    )
    expect(amounts).toEqual({
      discount: '-4000',
      freight: '10000',
      insurance: '2000',
      duty: '8800',
      brokerage: '1500',
    })
  })

  it('lets the total be rebuilt from the breakdown alone', () => {
    const { costResult } = run()
    const rebuilt = costResult.entries.reduce(
      (total, entry) => total.add(entry.signedEffect),
      costResult.merchandiseTotal,
    )
    expect(rebuilt.toDecimalString()).toBe('98300')
  })

  it('allocates every shared amount so the parts sum back to the original', () => {
    const { costResult } = run()
    const targets: readonly AllocationTarget[] = [
      {
        id: 'A',
        merchandiseValue: Money.fromString('1000', quoteCurrency),
        quantity: Quantity.fromString('100'),
        comparisonUnit: 'pcs',
      },
      {
        id: 'B',
        merchandiseValue: Money.fromString('1000', quoteCurrency),
        quantity: Quantity.fromString('50'),
        comparisonUnit: 'pcs',
      },
    ]

    const allocation = allocateSupplierCosts({ costResult, targets, exchangeRateTable: rateTable })

    for (const entry of allocation.byEntry) {
      expect(sumAllocations(entry.allocations, 'TRY').toDecimalString()).toBe(
        entry.settledAmount.toDecimalString(),
      )
    }

    expect(
      Object.fromEntries(
        allocation.byEntry.map((entry) => [
          entry.entryId,
          entry.allocations.map((a) => a.amount.toDecimalString()),
        ]),
      ),
    ).toEqual({
      discount: ['-2000', '-2000'],
      freight: ['5000', '5000'],
      insurance: ['1000', '1000'],
      duty: ['4400', '4400'],
      brokerage: ['750', '750'],
    })

    // Every line's allocated share adds up to the supplier-level effect.
    expect(allocation.byLine.map((l) => l.allocatedCostTotal.toDecimalString())).toEqual([
      '9150',
      '9150',
    ])
    const allocatedTotal = allocation.byLine.reduce(
      (total, l) => total.add(l.allocatedCostTotal),
      Money.zero('TRY'),
    )
    expect(costResult.merchandiseTotal.add(allocatedTotal).toDecimalString()).toBe('98300')
  })

  it('produces the same numbers on every run', () => {
    const first = run().costResult.calculatedLandedTotal.toDecimalString()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(run().costResult.calculatedLandedTotal.toDecimalString()).toBe(first)
    }
  })
})

/**
 * Phase 4 rounding golden scenario. Three equal lines, one shared cost of
 * 100.00 TRY. Rounding each equal share to kuruş independently would give
 * 33.33 x 3 = 99.99 and quietly lose a kuruş; largest-remainder distribution
 * must give 33.34 / 33.33 / 33.33 and sum to exactly 100.00, every time.
 */
describe('Phase 4 golden scenario — allocation rounding', () => {
  const rateTable = ExchangeRateTable.create('TRY')

  const targets: readonly AllocationTarget[] = ['a', 'b', 'c'].map((id) => ({
    id,
    merchandiseValue: Money.fromString('100', 'TRY'),
    quantity: Quantity.fromString('10'),
    comparisonUnit: 'pcs',
  }))

  function runWith(allocationMethod: 'EQUAL_PER_LINE' | 'BY_MERCHANDISE_VALUE' | 'BY_QUANTITY') {
    const costResult = calculateSupplierCosts({
      merchandiseTotal: Money.fromString('300', 'TRY'),
      costs: [
        createAdditionalCost({
          id: 'shared',
          kind: 'COST',
          category: 'OTHER',
          fixedAmount: Money.fromString('100.00', 'TRY'),
          allocationMethod,
        }),
      ],
      exchangeRateTable: rateTable,
    })
    return allocateSupplierCosts({ costResult, targets, exchangeRateTable: rateTable })
  }

  it('splits 100.00 TRY three ways without losing a kuruş', () => {
    const allocation = runWith('EQUAL_PER_LINE')
    const shared = allocation.byEntry[0]

    expect(shared?.allocations.map((a) => a.amount.toDecimalString())).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ])
    expect(sumAllocations(shared?.allocations ?? [], 'TRY').toDecimalString()).toBe('100')
    expect(shared?.settledAmount.toDecimalString()).toBe('100')
  })

  it('reaches the same split whichever equal-weight method is used', () => {
    for (const method of ['EQUAL_PER_LINE', 'BY_MERCHANDISE_VALUE', 'BY_QUANTITY'] as const) {
      expect(runWith(method).byEntry[0]?.allocations.map((a) => a.amount.toDecimalString())).toEqual([
        '33.34',
        '33.33',
        '33.33',
      ])
    }
  })

  it('gives byte-identical output on every run', () => {
    const first = JSON.stringify(
      runWith('EQUAL_PER_LINE').byEntry[0]?.allocations.map((a) => a.amount.toJSON()),
    )
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        JSON.stringify(runWith('EQUAL_PER_LINE').byEntry[0]?.allocations.map((a) => a.amount.toJSON())),
      ).toBe(first)
    }
  })
})
