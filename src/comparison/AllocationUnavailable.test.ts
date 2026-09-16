import { describe, expect, it } from 'vitest'
import { compareSuppliers } from './SupplierComparison'
import { createAdditionalCost } from '../calculation/AdditionalCost'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * Allocation is an explanation layer, not a correctness prerequisite for the
 * landed total. These are the audit reproductions that proved the opposite
 * used to be true: a supplier whose landed cost was thousands of lira lower
 * was dropped out of the comparison entirely because its *breakdown* could
 * not be computed, handing "lowest calculated landed cost" to a supplier that
 * was not the lowest. See docs/CALCULATION_RULES.md, "Allocation
 * availability".
 */
describe('allocation failure never changes who is cheapest', () => {
  const pcsRequirement = requirement('r-pcs', { requiredQuantity: '500', comparisonUnit: 'pcs' })
  const kgRequirement = requirement('r-kg', { requiredQuantity: '20', comparisonUnit: 'kg' })

  function mixedUnitComparison() {
    return compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [pcsRequirement, kgRequirement],
        suppliers: [supplier('cheap'), supplier('pricey')],
        quotes: [
          quote({
            id: 'q-cheap',
            supplierId: 'cheap',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'c1', requirementId: 'r-pcs', price: '10', currency: 'TRY' }),
              quoteItem({ id: 'c2', requirementId: 'r-kg', price: '40', currency: 'TRY' }),
            ],
          }),
          quote({
            id: 'q-pricey',
            supplierId: 'pricey',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'p1', requirementId: 'r-pcs', price: '14', currency: 'TRY' }),
              quoteItem({ id: 'p2', requirementId: 'r-kg', price: '110', currency: 'TRY' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        // BY_QUANTITY cannot weight 500 pcs against 20 kg — no unit conversion
        // exists, and adding the raw numbers would be meaningless.
        cheap: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('1000', 'TRY'),
            allocationMethod: 'BY_QUANTITY',
          }),
        ],
        pricey: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('1000', 'TRY'),
          }),
        ],
      },
    })
  }

  it('keeps the cheaper supplier ranked first when its allocation cannot be computed', () => {
    const result = mixedUnitComparison()
    const cheap = result.supplierResults.find((entry) => entry.supplierId === 'cheap')!
    const pricey = result.supplierResults.find((entry) => entry.supplierId === 'pricey')!

    // 500 x 10 + 20 x 40 + 1,000 freight
    expect(cheap.status).toBe('COMPLETE')
    expect(cheap.rankingAmount?.toDecimalString()).toBe('6800')
    expect(cheap.rank).toBe(1)

    // 500 x 14 + 20 x 110 + 1,000 freight
    expect(pricey.status).toBe('COMPLETE')
    expect(pricey.rankingAmount?.toDecimalString()).toBe('10200')
    expect(pricey.rank).toBe(2)

    expect(result.lowestSupplierIds).toEqual(['cheap'])
    expect(result.insights[0]).toEqual({
      code: 'LOWEST_CALCULATED_LANDED_COST',
      supplierId: 'cheap',
      rankingAmount: cheap.rankingAmount,
    })
  })

  it('reports the missing breakdown as a warning, not an issue', () => {
    const cheap = mixedUnitComparison().supplierResults.find((entry) => entry.supplierId === 'cheap')!

    expect(cheap.issues).toEqual([])
    expect(cheap.costAllocation).toBeUndefined()
    expect(cheap.warnings).toHaveLength(1)
    expect(cheap.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
    expect(cheap.warnings[0]?.reason).toBe('INCOMPATIBLE_ALLOCATION_UNITS')
  })

  it('does not emit an INVALID_QUOTE insight for a warned supplier', () => {
    const result = mixedUnitComparison()
    expect(result.insights.some((insight) => insight.code === 'INVALID_QUOTE')).toBe(false)
  })

  it('free sample: zero merchandise plus real freight still produces a landed total', () => {
    // Everything is quoted at zero, so BY_MERCHANDISE_VALUE has nothing to
    // weight by — but 20 TRY of freight is still 20 TRY of landed cost.
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [requirement('r1', { requiredQuantity: '10' })],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '0', currency: 'TRY' })],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        s1: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('20', 'TRY'),
          }),
        ],
      },
    })

    const only = result.supplierResults[0]!
    expect(only.status).toBe('COMPLETE')
    expect(only.rankingAmount?.toDecimalString()).toBe('20')
    expect(only.merchandiseRankingAmount?.toDecimalString()).toBe('0')
    expect(only.rank).toBe(1)
    expect(only.warnings[0]?.reason).toBe('INVALID_ALLOCATION_BASE')
  })

  it('a zero-amount cost with an unusable base does not invalidate the supplier', () => {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [requirement('r1', { requiredQuantity: '10' })],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '0', currency: 'TRY' })],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        s1: [
          createAdditionalCost({
            id: 'duty',
            kind: 'COST',
            category: 'DUTY',
            fixedAmount: Money.fromString('0', 'TRY'),
          }),
        ],
      },
    })

    const only = result.supplierResults[0]!
    expect(only.status).toBe('COMPLETE')
    expect(only.rankingAmount?.toDecimalString()).toBe('0')
    expect(only.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
  })

  it('still rejects a discount that does not fit a line — that is a data problem, not a weighting one', () => {
    // Proves the catch around allocation is narrow: an InvalidDiscountError
    // raised *during* allocation keeps its own meaning and invalidates the
    // supplier, instead of being swallowed into "allocation unavailable".
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [
          requirement('big', { requiredQuantity: '1' }),
          requirement('small', { requiredQuantity: '1' }),
        ],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'i1', requirementId: 'big', price: '900', currency: 'TRY' }),
              quoteItem({ id: 'i2', requirementId: 'small', price: '100', currency: 'TRY' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        s1: [
          createAdditionalCost({
            id: 'rebate',
            kind: 'DISCOUNT',
            category: 'OTHER',
            fixedAmount: Money.fromString('600', 'TRY'),
            allocationMethod: 'EQUAL_PER_LINE',
          }),
        ],
      },
    })

    const only = result.supplierResults[0]!
    expect(only.status).toBe('INVALID')
    expect(only.warnings).toEqual([])
    expect(only.issues[0]?.message).toContain('InvalidDiscountError')
  })
})
