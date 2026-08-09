import { describe, expect, it } from 'vitest'
import {
  createAdditionalCost,
  evaluationStageOf,
  InvalidCostAmountError,
  InvalidCostDefinitionError,
  InvalidDiscountError,
  InvalidPercentageBaseError,
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
