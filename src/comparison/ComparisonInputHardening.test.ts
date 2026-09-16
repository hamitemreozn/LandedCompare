import { describe, expect, it } from 'vitest'
import { compareSuppliers } from './SupplierComparison'
import { InvalidComparisonInputError } from './ComparisonStructuralValidation'
import { rankCompleteSuppliers, RankingInvariantError } from './Ranking'
import { createAdditionalCost, type AdditionalCost } from '../calculation/AdditionalCost'
import { Percentage } from '../calculation/Percentage'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * `compareSuppliers` receives two things it cannot take on trust: supplier
 * ids, which are user-typed text used as object keys, and additional costs,
 * which are a plain readonly interface anything structurally similar can
 * satisfy. The audit turned both into whole-comparison crashes.
 */

/** Prototype members that a `Record<string, T>` lookup returns instead of `undefined`. */
const PROTOTYPE_KEYS = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']

function comparisonWithSupplierId(
  supplierId: string,
  costsBySupplierId?: Readonly<Record<string, readonly AdditionalCost[]>>,
) {
  return compareSuppliers({
    project: project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1', { requiredQuantity: '10' })],
      suppliers: [supplier(supplierId)],
      quotes: [
        quote({
          id: 'q1',
          supplierId,
          currency: 'TRY',
          items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '5', currency: 'TRY' })],
        }),
      ],
    }),
    exchangeRateTable: baseRateTable('TRY'),
    costsBySupplierId,
  })
}

describe('supplier ids never resolve data through the prototype chain', () => {
  for (const supplierId of PROTOTYPE_KEYS) {
    it(`compares a supplier called "${supplierId}" without crashing`, () => {
      // Before the fix every one of these died with "costs is not iterable":
      // the lookup returned an inherited function or Object.prototype, which
      // `?? []` cannot catch because it is not nullish.
      const result = comparisonWithSupplierId(supplierId, {})
      const only = result.supplierResults[0]!
      expect(only.status).toBe('COMPLETE')
      expect(only.rankingAmount?.toDecimalString()).toBe('50')
      expect(only.costResult?.entries).toEqual([])
    })

    it(`still reads real costs for a supplier called "${supplierId}"`, () => {
      const result = comparisonWithSupplierId(supplierId, {
        [supplierId]: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('7', 'TRY'),
          }),
        ],
      })
      expect(result.supplierResults[0]?.rankingAmount?.toDecimalString()).toBe('57')
    })
  }

  it('treats a missing supplier key as no costs, as before', () => {
    const result = comparisonWithSupplierId('ordinary', {})
    expect(result.supplierResults[0]?.rankingAmount?.toDecimalString()).toBe('50')
  })
})

describe('a malformed cost list blocks the whole comparison', () => {
  for (const malformed of ['not-an-array', 42, {}, null]) {
    it(`rejects ${JSON.stringify(malformed)} as a supplier's cost list`, () => {
      // The container the caller passed is broken, not one supplier's
      // commercial data — ranking the others would present a comparison built
      // on an input the engine could not read.
      expect(() =>
        comparisonWithSupplierId('s1', {
          s1: malformed as unknown as readonly AdditionalCost[],
        }),
      ).toThrow(InvalidComparisonInputError)
    })
  }

  it('names the structural code', () => {
    try {
      comparisonWithSupplierId('s1', { s1: 'nope' as unknown as readonly AdditionalCost[] })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidComparisonInputError)
      expect((error as InvalidComparisonInputError).code).toBe('INVALID_SUPPLIER_COST_LIST')
    }
  })
})

describe('additional costs are validated at the engine boundary', () => {
  function comparisonWithRawCost(raw: unknown) {
    return compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [requirement('r1', { requiredQuantity: '10' })],
        suppliers: [supplier('bad'), supplier('good')],
        quotes: [
          quote({
            id: 'q-bad',
            supplierId: 'bad',
            currency: 'TRY',
            items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' })],
          }),
          quote({
            id: 'q-good',
            supplierId: 'good',
            currency: 'TRY',
            items: [quoteItem({ id: 'i2', requirementId: 'r1', price: '100', currency: 'TRY' })],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: { bad: [raw as AdditionalCost] },
    })
  }

  const validShape = {
    id: 'x',
    kind: 'COST',
    category: 'OTHER',
    includeInComparison: true,
    alreadyIncludedInQuote: false,
    allocationMethod: 'BY_MERCHANDISE_VALUE',
  }

  const malformedCosts: Record<string, unknown> = {
    'a negative fixed amount': { ...validShape, fixedAmount: Money.fromString('-5000', 'TRY') },
    'both a fixed amount and a percentage': {
      ...validShape,
      fixedAmount: Money.fromString('10', 'TRY'),
      percentage: { rate: Percentage.fromString('50'), base: 'MERCHANDISE' },
    },
    'neither a fixed amount nor a percentage': { ...validShape },
    'an unknown kind': { ...validShape, kind: 'REFUND', fixedAmount: Money.fromString('10', 'TRY') },
    'an unknown category': { ...validShape, category: 'MYSTERY', fixedAmount: Money.fromString('10', 'TRY') },
    'an unknown allocation method': {
      ...validShape,
      allocationMethod: 'BY_WEIGHT',
      fixedAmount: Money.fromString('10', 'TRY'),
    },
    'a raw number instead of Money': { ...validShape, fixedAmount: 10 },
    'a non-boolean inclusion flag': {
      ...validShape,
      includeInComparison: 'yes',
      fixedAmount: Money.fromString('10', 'TRY'),
    },
    'an empty id': { ...validShape, id: '  ', fixedAmount: Money.fromString('10', 'TRY') },
    'an unknown percentage base': {
      ...validShape,
      percentage: { rate: Percentage.fromString('5'), base: 'MERCHANDISE_PLUS_EVERYTHING' },
    },
    'a percentage discount above 100%': {
      ...validShape,
      kind: 'DISCOUNT',
      percentage: { rate: Percentage.fromString('120'), base: 'MERCHANDISE' },
    },
  }

  for (const [description, raw] of Object.entries(malformedCosts)) {
    it(`marks the supplier INVALID for ${description}, and keeps comparing the rest`, () => {
      const result = comparisonWithRawCost(raw)
      const bad = result.supplierResults.find((entry) => entry.supplierId === 'bad')!
      const good = result.supplierResults.find((entry) => entry.supplierId === 'good')!

      expect(bad.status).toBe('INVALID')
      expect(bad.issues[0]?.code).toBe('CALCULATION_ERROR')
      expect(bad.rankingAmount).toBeUndefined()

      // The comparison survives: the other supplier is still ranked.
      expect(good.status).toBe('COMPLETE')
      expect(good.rank).toBe(1)
    })
  }

  it('never lets a negative cost produce a negative landed total', () => {
    // The original crash path: landed total 100 - 5000 = -4900, ranked lowest,
    // then a negative percentage difference blew up inside Percentage.
    const result = comparisonWithRawCost(malformedCosts['a negative fixed amount'])
    for (const entry of result.supplierResults) {
      expect(entry.rankingAmount?.isNegative() ?? false).toBe(false)
    }
    expect(result.lowestSupplierIds).toEqual(['good'])
  })
})

describe('ranking defends its own inputs', () => {
  it('rejects a negative ranking amount with a named invariant error', () => {
    expect(() =>
      rankCompleteSuppliers([
        { supplierId: 'a', rankingAmount: Money.fromString('-1', 'TRY') },
        { supplierId: 'b', rankingAmount: Money.fromString('10', 'TRY') },
      ]),
    ).toThrow(RankingInvariantError)
  })

  it('does not surface a negative denominator as an InvalidPercentageError', () => {
    try {
      rankCompleteSuppliers([
        { supplierId: 'a', rankingAmount: Money.fromString('-100', 'TRY') },
        { supplierId: 'b', rankingAmount: Money.fromString('100', 'TRY') },
      ])
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).name).toBe('RankingInvariantError')
      expect((error as Error).message).toContain('cannot be negative')
    }
  })

  it('still accepts a zero ranking amount', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: Money.zero('TRY') },
      { supplierId: 'b', rankingAmount: Money.zero('TRY') },
    ])
    expect(result.ranked.map((entry) => entry.rank)).toEqual([1, 1])
  })
})
