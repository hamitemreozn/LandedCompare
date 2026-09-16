import { describe, expect, it } from 'vitest'
import {
  assertValidAdditionalCost,
  createAdditionalCost,
  evaluationStageOf,
  InvalidCostAmountError,
  InvalidCostDefinitionError,
  InvalidDiscountError,
  InvalidPercentageBaseError,
  type AdditionalCost,
  type CostCategory,
  type CostKind,
  type PercentageBase,
} from './AdditionalCost'
import { Percentage } from './Percentage'
import { Money } from '../domain/monetary/Money'

function percentageOf(rate: string, base: PercentageBase) {
  return { rate: Percentage.fromString(rate), base }
}

describe('createAdditionalCost — structure', () => {
  it('applies the documented defaults', () => {
    const cost = createAdditionalCost({
      id: 'freight',
      kind: 'COST',
      category: 'FREIGHT',
      fixedAmount: Money.fromString('1000', 'TRY'),
    })
    expect(cost.includeInComparison).toBe(true)
    expect(cost.alreadyIncludedInQuote).toBe(false)
    expect(cost.allocationMethod).toBe('BY_MERCHANDISE_VALUE')
    expect(cost.label).toBeUndefined()
  })

  it('carries a custom label through untouched', () => {
    const cost = createAdditionalCost({
      id: 'other-1',
      kind: 'COST',
      category: 'OTHER',
      label: 'Palet ücreti',
      fixedAmount: Money.fromString('250', 'TRY'),
    })
    expect(cost.label).toBe('Palet ücreti')
  })

  it('requires exactly one of a fixed amount or a percentage', () => {
    expect(() =>
      createAdditionalCost({ id: 'x', kind: 'COST', category: 'OTHER' }),
    ).toThrow(InvalidCostDefinitionError)

    expect(() =>
      createAdditionalCost({
        id: 'x',
        kind: 'COST',
        category: 'OTHER',
        fixedAmount: Money.fromString('10', 'TRY'),
        percentage: percentageOf('5', 'MERCHANDISE'),
      }),
    ).toThrow(InvalidCostDefinitionError)
  })

  it('rejects an empty id or an empty label', () => {
    expect(() =>
      createAdditionalCost({
        id: '   ',
        kind: 'COST',
        category: 'OTHER',
        fixedAmount: Money.fromString('10', 'TRY'),
      }),
    ).toThrow(InvalidCostDefinitionError)

    expect(() =>
      createAdditionalCost({
        id: 'x',
        kind: 'COST',
        category: 'OTHER',
        label: '  ',
        fixedAmount: Money.fromString('10', 'TRY'),
      }),
    ).toThrow(InvalidCostDefinitionError)
  })
})

describe('createAdditionalCost — negative input semantics', () => {
  it('rejects a negative cost amount', () => {
    expect(() =>
      createAdditionalCost({
        id: 'freight',
        kind: 'COST',
        category: 'FREIGHT',
        fixedAmount: Money.fromString('-500', 'TRY'),
      }),
    ).toThrow(InvalidCostAmountError)
  })

  it('rejects a negative surcharge and a negative discount magnitude too', () => {
    for (const kind of ['SURCHARGE', 'DISCOUNT'] satisfies CostKind[]) {
      expect(() =>
        createAdditionalCost({
          id: 'x',
          kind,
          category: 'OTHER',
          fixedAmount: Money.fromString('-500', 'TRY'),
        }),
      ).toThrow(InvalidCostAmountError)
    }
  })

  it('accepts the same reduction expressed as a positive discount', () => {
    const discount = createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      fixedAmount: Money.fromString('500', 'TRY'),
    })
    expect(discount.kind).toBe('DISCOUNT')
    expect(discount.fixedAmount?.toDecimalString()).toBe('500')
  })
})

describe('createAdditionalCost — discount percentage bound', () => {
  it('rejects a percentage discount above 100%', () => {
    expect(() =>
      createAdditionalCost({
        id: 'discount',
        kind: 'DISCOUNT',
        category: 'OTHER',
        percentage: percentageOf('100.01', 'MERCHANDISE'),
      }),
    ).toThrow(InvalidDiscountError)
  })

  it('accepts exactly 100% — a zero merchandise base is degenerate, not negative', () => {
    const discount = createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      percentage: percentageOf('100', 'MERCHANDISE'),
    })
    expect(discount.percentage?.rate.toDecimalString()).toBe('100')
  })

  it('imposes no upper bound on a percentage cost or surcharge', () => {
    for (const kind of ['COST', 'SURCHARGE'] satisfies CostKind[]) {
      const entry = createAdditionalCost({
        id: 'x',
        kind,
        category: 'OTHER',
        percentage: percentageOf('250', 'MERCHANDISE'),
      })
      expect(entry.percentage?.rate.toDecimalString()).toBe('250')
    }
  })
})

describe('evaluationStageOf', () => {
  it('derives the stage from kind and category', () => {
    expect(evaluationStageOf({ kind: 'DISCOUNT', category: 'OTHER' })).toBe('DISCOUNT')
    expect(evaluationStageOf({ kind: 'SURCHARGE', category: 'FREIGHT' })).toBe('SURCHARGE')
    expect(evaluationStageOf({ kind: 'COST', category: 'FREIGHT' })).toBe('FREIGHT_INSURANCE')
    expect(evaluationStageOf({ kind: 'COST', category: 'INSURANCE' })).toBe('FREIGHT_INSURANCE')
    expect(evaluationStageOf({ kind: 'COST', category: 'DUTY' })).toBe('OTHER_COST')
    expect(evaluationStageOf({ kind: 'COST', category: 'TAX' })).toBe('OTHER_COST')
  })
})

describe('createAdditionalCost — percentage base availability', () => {
  it('limits a percentage discount to the merchandise base', () => {
    const cost = createAdditionalCost({
      id: 'discount',
      kind: 'DISCOUNT',
      category: 'OTHER',
      percentage: percentageOf('5', 'MERCHANDISE'),
    })
    expect(cost.percentage?.base).toBe('MERCHANDISE')

    for (const base of [
      'MERCHANDISE_AFTER_DISCOUNT',
      'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
    ] satisfies PercentageBase[]) {
      expect(() =>
        createAdditionalCost({
          id: 'discount',
          kind: 'DISCOUNT',
          category: 'OTHER',
          percentage: percentageOf('5', base),
        }),
      ).toThrow(InvalidPercentageBaseError)
    }
  })

  it('refuses a freight or insurance percentage taken on the base it helps build', () => {
    // This is the circular case: freight cannot be a percentage of
    // "merchandise + freight + insurance".
    for (const category of ['FREIGHT', 'INSURANCE'] satisfies CostCategory[]) {
      expect(() =>
        createAdditionalCost({
          id: 'x',
          kind: 'COST',
          category,
          percentage: percentageOf('5', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'),
        }),
      ).toThrow(InvalidPercentageBaseError)
    }
  })

  it('allows insurance as a percentage of an earlier base', () => {
    for (const base of ['MERCHANDISE', 'MERCHANDISE_AFTER_DISCOUNT'] satisfies PercentageBase[]) {
      const cost = createAdditionalCost({
        id: 'insurance',
        kind: 'COST',
        category: 'INSURANCE',
        percentage: percentageOf('0.5', base),
      })
      expect(cost.percentage?.base).toBe(base)
    }
  })

  it('allows every base for a later-stage cost or surcharge', () => {
    const bases: readonly PercentageBase[] = [
      'MERCHANDISE',
      'MERCHANDISE_AFTER_DISCOUNT',
      'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
    ]
    for (const base of bases) {
      expect(
        createAdditionalCost({
          id: 'duty',
          kind: 'COST',
          category: 'DUTY',
          percentage: percentageOf('10', base),
        }).percentage?.base,
      ).toBe(base)

      expect(
        createAdditionalCost({
          id: 'surcharge',
          kind: 'SURCHARGE',
          category: 'OTHER',
          percentage: percentageOf('2', base),
        }).percentage?.base,
      ).toBe(base)
    }
  })
})

/**
 * `AdditionalCost` is a plain readonly interface, so an object literal that
 * never met `createAdditionalCost` is structurally acceptable to TypeScript
 * and reaches the engine unchecked. The audit walked a negative "cost" in
 * that way and drove a landed total below zero. The factory and the engine
 * boundary therefore share one validator — these are its rules, applied to
 * objects that bypassed the factory entirely.
 */
describe('assertValidAdditionalCost — the shared rule set', () => {
  const valid = {
    id: 'x',
    kind: 'COST' as const,
    category: 'OTHER' as const,
    fixedAmount: Money.fromString('10', 'TRY'),
    includeInComparison: true,
    alreadyIncludedInQuote: false,
    allocationMethod: 'BY_MERCHANDISE_VALUE' as const,
  }

  function check(overrides: Record<string, unknown>) {
    return () => assertValidAdditionalCost({ ...valid, ...overrides } as unknown as AdditionalCost)
  }

  it('accepts a well-formed cost that never went through the factory', () => {
    expect(check({})).not.toThrow()
  })

  it('accepts what the factory produces, unchanged', () => {
    expect(() =>
      assertValidAdditionalCost(
        createAdditionalCost({ id: 'f', kind: 'COST', category: 'FREIGHT', fixedAmount: Money.fromString('1', 'TRY') }),
      ),
    ).not.toThrow()
  })

  it('rejects a negative fixed amount', () => {
    expect(check({ fixedAmount: Money.fromString('-5000', 'TRY') })).toThrow(InvalidCostAmountError)
  })

  it('rejects both a fixed amount and a percentage', () => {
    expect(check({ percentage: percentageOf('50', 'MERCHANDISE') })).toThrow(InvalidCostDefinitionError)
  })

  it('rejects neither a fixed amount nor a percentage', () => {
    expect(check({ fixedAmount: undefined })).toThrow(InvalidCostDefinitionError)
  })

  it('rejects a fixed amount that is not Money', () => {
    expect(check({ fixedAmount: 10 })).toThrow(InvalidCostDefinitionError)
    expect(check({ fixedAmount: '10' })).toThrow(InvalidCostDefinitionError)
  })

  it('rejects a percentage whose rate is not a Percentage', () => {
    expect(check({ fixedAmount: undefined, percentage: { rate: '5', base: 'MERCHANDISE' } })).toThrow(
      InvalidCostDefinitionError,
    )
  })

  it('rejects unknown enum values', () => {
    expect(check({ kind: 'REFUND' })).toThrow(InvalidCostDefinitionError)
    expect(check({ category: 'MYSTERY' })).toThrow(InvalidCostDefinitionError)
    expect(check({ allocationMethod: 'BY_WEIGHT' })).toThrow(InvalidCostDefinitionError)
    expect(
      check({ fixedAmount: undefined, percentage: { rate: Percentage.fromString('5'), base: 'EVERYTHING' } }),
    ).toThrow(InvalidPercentageBaseError)
  })

  it('rejects non-boolean inclusion flags', () => {
    expect(check({ includeInComparison: 'yes' })).toThrow(InvalidCostDefinitionError)
    expect(check({ alreadyIncludedInQuote: 1 })).toThrow(InvalidCostDefinitionError)
    expect(check({ includeInComparison: undefined })).toThrow(InvalidCostDefinitionError)
  })

  it('rejects an empty or non-string id', () => {
    expect(check({ id: '   ' })).toThrow(InvalidCostDefinitionError)
    expect(check({ id: 7 })).toThrow(InvalidCostDefinitionError)
  })

  it('rejects an empty label rather than silently dropping it', () => {
    expect(check({ label: '  ' })).toThrow(InvalidCostDefinitionError)
  })

  it('applies the discount and percentage-base rules to bypassed objects too', () => {
    expect(
      check({
        kind: 'DISCOUNT',
        fixedAmount: undefined,
        percentage: percentageOf('120', 'MERCHANDISE'),
      }),
    ).toThrow(InvalidDiscountError)

    expect(
      check({
        kind: 'DISCOUNT',
        fixedAmount: undefined,
        percentage: percentageOf('10', 'MERCHANDISE_AFTER_DISCOUNT'),
      }),
    ).toThrow(InvalidPercentageBaseError)
  })

  it('rejects a value that is not an object at all', () => {
    expect(() => assertValidAdditionalCost(null as unknown as AdditionalCost)).toThrow(
      InvalidCostDefinitionError,
    )
    expect(() => assertValidAdditionalCost('freight' as unknown as AdditionalCost)).toThrow(
      InvalidCostDefinitionError,
    )
  })
})
