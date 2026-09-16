import { describe, expect, it } from 'vitest'
import { evaluateSupplier } from './SupplierEvaluation'
import { createAdditionalCost } from '../calculation/AdditionalCost'
import { Percentage } from '../calculation/Percentage'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, quote, quoteItem, requirement, supplier } from './testSupport'

const s1 = supplier('s1')
const minorUnit = 2

describe('evaluateSupplier — completeness', () => {
  it('is COMPLETE when the quote covers every required item', () => {
    const requirements = [requirement('r1'), requirement('r2')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [
        quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' }),
        quoteItem({ id: 'i2', requirementId: 'r2', price: '20', currency: 'TRY' }),
      ],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('COMPLETE')
    expect(result.issues).toEqual([])
    expect(result.exactCalculatedLandedTotal?.toDecimalString()).toBe('300')
  })

  it('is COMPLETE for a zero-priced item — free/sample/included items are a valid quotation', () => {
    const requirements = [requirement('r1'), requirement('r2')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [
        quoteItem({ id: 'i1', requirementId: 'r1', price: '0', currency: 'TRY' }),
        quoteItem({ id: 'i2', requirementId: 'r2', price: '20', currency: 'TRY' }),
      ],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('COMPLETE')
    expect(result.exactCalculatedLandedTotal?.toDecimalString()).toBe('200')
  })

  it('is INCOMPLETE when one required item is missing', () => {
    const requirements = [requirement('r1'), requirement('r2')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' })],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INCOMPLETE')
    expect(result.missingRequirementIds).toEqual(['r2'])
    expect(result.issues[0]?.code).toBe('MISSING_REQUIRED_ITEMS')
  })

  it('is INCOMPLETE with every missing id listed when several items are missing', () => {
    const requirements = [requirement('r1'), requirement('r2'), requirement('r3')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' })],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INCOMPLETE')
    expect(result.missingRequirementIds).toEqual(['r2', 'r3'])
  })

  it('is INCOMPLETE for an empty quote, not a zero-cost COMPLETE result', () => {
    const requirements = [requirement('r1')]
    const q = quote({ id: 'q1', supplierId: 's1', currency: 'TRY', items: [] })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INCOMPLETE')
    expect(result.issues[0]?.code).toBe('EMPTY_QUOTE')
    expect(result.missingRequirementIds).toEqual(['r1'])
  })

  it('is INCOMPLETE when the supplier has no quote at all', () => {
    const requirements = [requirement('r1'), requirement('r2')]
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INCOMPLETE')
    expect(result.issues[0]?.code).toBe('MISSING_QUOTE')
    expect(result.missingRequirementIds).toEqual(['r1', 'r2'])
  })

  it('stays COMPLETE when only optional quote metadata is missing', () => {
    const requirements = [requirement('r1')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' })],
    })
    // `quote()` never sets quoteDate/incoterm/paymentTerms/leadTime/warranty/notes.
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('COMPLETE')
  })

  it('is INVALID for a duplicate quote item on the same requirement', () => {
    const requirements = [requirement('r1')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [
        quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' }),
        quoteItem({ id: 'i2', requirementId: 'r1', price: '11', currency: 'TRY' }),
      ],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INVALID')
    expect(result.issues[0]?.code).toBe('DUPLICATE_QUOTE_ITEM')
  })

  it('is INVALID for a quote item referencing a requirement not in the project', () => {
    const requirements = [requirement('r1')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [
        quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' }),
        quoteItem({ id: 'i2', requirementId: 'ghost', price: '5', currency: 'TRY' }),
      ],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INVALID')
    expect(result.issues[0]?.code).toBe('UNKNOWN_REQUIREMENT_REFERENCE')
  })
})

describe('evaluateSupplier — calculation validity', () => {
  it('is INVALID when a required exchange rate is missing', () => {
    const requirements = [requirement('r1')]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'USD',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'USD' })],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'), // no USD rate configured
      minorUnit,
    })
    expect(result.status).toBe('INVALID')
    expect(result.issues[0]?.code).toBe('CALCULATION_ERROR')
    expect(result.issues[0]?.message).toContain('MissingExchangeRateError')
  })

  it('is INVALID for an invalid MOQ (zero — "no MOQ" must be undefined, not zero)', () => {
    const requirements = [requirement('r1', { requiredQuantity: '10' })]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY', moq: '0' })],
    })
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INVALID')
    expect(result.issues[0]?.code).toBe('CALCULATION_ERROR')
    expect(result.issues[0]?.message).toContain('InvalidMoqError')
  })

  it('is INVALID for an invalid cost configuration (discounts exceeding the merchandise total)', () => {
    const requirements = [requirement('r1', { requiredQuantity: '1' })]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '100', currency: 'TRY' })],
    })
    const costs = [
      createAdditionalCost({
        id: 'discount-a',
        kind: 'DISCOUNT',
        category: 'OTHER',
        percentage: { rate: Percentage.fromString('60'), base: 'MERCHANDISE' },
      }),
      createAdditionalCost({
        id: 'discount-b',
        kind: 'DISCOUNT',
        category: 'OTHER',
        percentage: { rate: Percentage.fromString('60'), base: 'MERCHANDISE' },
      }),
    ]
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs,
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INVALID')
    expect(result.issues[0]?.code).toBe('CALCULATION_ERROR')
    expect(result.issues[0]?.message).toContain('InvalidDiscountError')
  })

  it('can never receive a negative-priced quote item — rejected earlier, at QuoteItem construction', () => {
    // A negative quotedUnitPrice is now rejected by createQuoteItem (the
    // domain construction boundary), so it is impossible to build a `quote`
    // fixture that would even reach evaluateSupplier with one. This is the
    // corrected version of the "negative merchandise total" scenario this
    // audit originally caught via InvalidPercentageBaseError — see
    // QuoteItem.test.ts for the construction-time rejection, and
    // docs/CALCULATION_RULES.md, "Error capture boundary" for why that
    // moved InvalidPercentageBaseError's negative-merchandise-total throw
    // site from "live-reachable" to "structurally guarded".
    expect(() => quoteItem({ id: 'i1', requirementId: 'r1', price: '-10', currency: 'TRY' })).toThrow(
      'quotedUnitPrice must not be negative',
    )
  })

  it('is INVALID for a duplicate cost id within one supplier’s cost list', () => {
    const requirements = [requirement('r1', { requiredQuantity: '1' })]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '100', currency: 'TRY' })],
    })
    const costs = [
      createAdditionalCost({
        id: 'freight',
        kind: 'COST',
        category: 'FREIGHT',
        percentage: { rate: Percentage.fromString('1'), base: 'MERCHANDISE' },
      }),
      createAdditionalCost({
        id: 'freight',
        kind: 'COST',
        category: 'OTHER',
        percentage: { rate: Percentage.fromString('2'), base: 'MERCHANDISE' },
      }),
    ]
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs,
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('INVALID')
    expect(result.issues[0]?.code).toBe('CALCULATION_ERROR')
    expect(result.issues[0]?.message).toContain('InvalidCostDefinitionError')
  })

  it('stays COMPLETE with a warning when the allocation base is zero (all lines zero-priced)', () => {
    const requirements = [
      requirement('r1', { requiredQuantity: '1' }),
      requirement('r2', { requiredQuantity: '1' }),
    ]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [
        quoteItem({ id: 'i1', requirementId: 'r1', price: '0', currency: 'TRY' }),
        quoteItem({ id: 'i2', requirementId: 'r2', price: '0', currency: 'TRY' }),
      ],
    })
    const costs = [
      createAdditionalCost({
        id: 'freight',
        kind: 'COST',
        category: 'FREIGHT',
        fixedAmount: Money.fromString('100', 'TRY'),
        // BY_MERCHANDISE_VALUE (the default) has nothing to weight by when every line is zero-priced.
      }),
    ]
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs,
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    // The landed total is 100 TRY of freight on zero-value goods. That total
    // is correct; only the per-line explanation is impossible.
    expect(result.status).toBe('COMPLETE')
    expect(result.issues).toEqual([])
    expect(result.rankingAmount?.toDecimalString()).toBe('100')
    expect(result.costAllocation).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
    expect(result.warnings[0]?.reason).toBe('INVALID_ALLOCATION_BASE')
  })

  it('stays COMPLETE with a warning for BY_QUANTITY across mixed comparison units', () => {
    const requirements = [
      requirement('r1', { requiredQuantity: '1', comparisonUnit: 'pcs' }),
      requirement('r2', { requiredQuantity: '1', comparisonUnit: 'kg' }),
    ]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [
        quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' }),
        quoteItem({ id: 'i2', requirementId: 'r2', price: '10', currency: 'TRY' }),
      ],
    })
    const costs = [
      createAdditionalCost({
        id: 'freight',
        kind: 'COST',
        category: 'FREIGHT',
        fixedAmount: Money.fromString('50', 'TRY'),
        allocationMethod: 'BY_QUANTITY',
      }),
    ]
    const result = evaluateSupplier({
      supplier: s1,
      quotesForSupplier: [q],
      requirements,
      costs,
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit,
    })
    expect(result.status).toBe('COMPLETE')
    expect(result.issues).toEqual([])
    expect(result.rankingAmount?.toDecimalString()).toBe('70')
    expect(result.costAllocation).toBeUndefined()
    expect(result.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
    expect(result.warnings[0]?.reason).toBe('INCOMPATIBLE_ALLOCATION_UNITS')
  })
})
