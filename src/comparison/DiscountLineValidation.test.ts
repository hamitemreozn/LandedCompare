import { describe, expect, it } from 'vitest'
import { compareSuppliers, type SupplierComparisonEntry } from './SupplierComparison'
import { createAdditionalCost, type AdditionalCost } from '../calculation/AdditionalCost'
import { Percentage } from '../calculation/Percentage'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * Allocation does two jobs, and only one of them is allowed to fail quietly.
 *
 * *Validation-critical* discount allocation answers "does this discount take
 * more off a line than that line is worth?" — a question about whether the
 * quote is economically valid at all. *Explanatory* allocation answers "which
 * line did this freight land on?" — a question about presentation, whose
 * answer the landed total does not depend on.
 *
 * They used to run as one pass, with the discount rule checked at the end of
 * it. So an unrelated cost with an unusable weighting threw first, the caller
 * correctly read that as "no breakdown available", and the discount rule was
 * never evaluated: a supplier whose discount overdrew a line was published as
 * `COMPLETE` with a warning. Which cost happened to fail first decided whether
 * a financial rule was enforced at all.
 *
 * These are the audit reproductions of that, plus the behaviour that had to
 * survive the split. See docs/CALCULATION_RULES.md, "Discount validation vs
 * explanatory allocation".
 */

/** 900 TRY on a `pcs` line, 100 TRY on a `kg` line — 1,000 TRY of merchandise. */
const BIG = requirement('big', { requiredQuantity: '1', comparisonUnit: 'pcs' })
const SMALL = requirement('small', { requiredQuantity: '1', comparisonUnit: 'kg' })

/**
 * 600 TRY split `EQUAL_PER_LINE` puts 300 TRY on a line worth 100 TRY.
 * Nothing about the allocation *method* is wrong; the discount itself does
 * not fit the quote.
 */
const OVERDRAWING_DISCOUNT = createAdditionalCost({
  id: 'rebate',
  kind: 'DISCOUNT',
  category: 'OTHER',
  fixedAmount: Money.fromString('600', 'TRY'),
  allocationMethod: 'EQUAL_PER_LINE',
})

/** Fits both lines: 30 TRY each, against 900 TRY and 100 TRY. */
const FITTING_DISCOUNT = createAdditionalCost({
  id: 'rebate',
  kind: 'DISCOUNT',
  category: 'OTHER',
  fixedAmount: Money.fromString('60', 'TRY'),
  allocationMethod: 'EQUAL_PER_LINE',
})

/** `BY_QUANTITY` cannot weight 1 pcs against 1 kg — there is no conversion. */
const UNALLOCATABLE_FREIGHT = createAdditionalCost({
  id: 'freight',
  kind: 'COST',
  category: 'FREIGHT',
  fixedAmount: Money.fromString('50', 'TRY'),
  allocationMethod: 'BY_QUANTITY',
})

const ALLOCATABLE_FREIGHT = createAdditionalCost({
  id: 'freight',
  kind: 'COST',
  category: 'FREIGHT',
  fixedAmount: Money.fromString('50', 'TRY'),
  allocationMethod: 'BY_MERCHANDISE_VALUE',
})

const DUTY = createAdditionalCost({
  id: 'duty',
  kind: 'COST',
  category: 'DUTY',
  fixedAmount: Money.fromString('30', 'TRY'),
})

function evaluate(costs: readonly AdditionalCost[]): SupplierComparisonEntry {
  return compareSuppliers({
    project: project({
      baseCurrency: 'TRY',
      requirements: [BIG, SMALL],
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
    costsBySupplierId: { s1: costs },
  }).supplierResults[0]!
}

function issueMessage(entry: SupplierComparisonEntry): string {
  return entry.issues[0]?.message ?? ''
}

/** Every ordering of a cost list, deterministic and depth-first. */
function permutations<T>(items: readonly T[]): readonly (readonly T[])[] {
  if (items.length <= 1) {
    return [items]
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  )
}

describe('an unrelated allocation failure cannot mask a bad discount', () => {
  it('invalidates the supplier even when a freight cost fails to allocate first', () => {
    const result = evaluate([OVERDRAWING_DISCOUNT, UNALLOCATABLE_FREIGHT])

    expect(result.status).toBe('INVALID')
    expect(issueMessage(result)).toContain('InvalidDiscountError')
    expect(issueMessage(result)).toContain("exceeds that line's merchandise value")
    // Not a warning, and not ranked: this is a data problem, not a missing
    // explanation.
    expect(result.warnings).toEqual([])
    expect(result.rank).toBeUndefined()
    expect(result.rankingAmount).toBeUndefined()
  })

  it('reaches the same verdict whichever cost is listed first', () => {
    const reversed = evaluate([UNALLOCATABLE_FREIGHT, OVERDRAWING_DISCOUNT])

    expect(reversed.status).toBe('INVALID')
    expect(issueMessage(reversed)).toContain('InvalidDiscountError')
    expect(reversed.warnings).toEqual([])
  })

  it('checks a percentage discount the same way', () => {
    // 60% of 1,000 is the same 600 TRY, so the same line is overdrawn. The
    // rule is about the money, not about how the amount was expressed.
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        percentage: { rate: Percentage.fromString('60'), base: 'MERCHANDISE' },
        allocationMethod: 'EQUAL_PER_LINE',
      }),
      UNALLOCATABLE_FREIGHT,
    ])

    expect(result.status).toBe('INVALID')
    expect(issueMessage(result)).toContain('InvalidDiscountError')
  })
})

describe('a discount whose own weighting cannot be established', () => {
  it('invalidates the supplier rather than warning', () => {
    // 200 TRY of real money, and no way to say how much of it lands on each
    // line — so "does it overdraw a line?" has no answer. An unanswerable
    // financial check is not a passed one.
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        fixedAmount: Money.fromString('200', 'TRY'),
        allocationMethod: 'BY_QUANTITY',
      }),
    ])

    expect(result.status).toBe('INVALID')
    expect(issueMessage(result)).toContain('DiscountAllocationValidationError')
    expect(issueMessage(result)).toContain('BY_QUANTITY')
    expect(result.warnings).toEqual([])
    expect(result.rank).toBeUndefined()
  })

  it('does not report it as ALLOCATION_UNAVAILABLE', () => {
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        percentage: { rate: Percentage.fromString('20'), base: 'MERCHANDISE' },
        allocationMethod: 'BY_QUANTITY',
      }),
    ])

    expect(result.status).toBe('INVALID')
    expect(result.warnings.some((warning) => warning.code === 'ALLOCATION_UNAVAILABLE')).toBe(false)
  })
})

describe('a zero-value discount is not a financial problem', () => {
  it('does not invalidate a supplier just because it cannot be allocated', () => {
    // Nothing is being taken off any line, so there is no per-line rule to
    // break. Inventing a validation failure for 0 TRY would reject a
    // configuration that costs the user nothing.
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        fixedAmount: Money.fromString('0', 'TRY'),
        allocationMethod: 'BY_QUANTITY',
      }),
    ])

    expect(result.status).toBe('COMPLETE')
    expect(result.rankingAmount?.toDecimalString()).toBe('1000')
    expect(result.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
    expect(result.warnings[0]?.reason).toBe('INCOMPATIBLE_ALLOCATION_UNITS')
    expect(result.costAllocation).toBeUndefined()
  })

  it('treats a 0% discount the same way', () => {
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        percentage: { rate: Percentage.fromString('0'), base: 'MERCHANDISE' },
        allocationMethod: 'BY_QUANTITY',
      }),
    ])

    expect(result.status).toBe('COMPLETE')
    expect(result.rankingAmount?.toDecimalString()).toBe('1000')
    expect(result.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
  })

  it('leaves a real discount on the same quote fully checked', () => {
    // The zero-value entry is skipped; the one carrying money is not.
    const result = evaluate([
      createAdditionalCost({
        id: 'nil',
        kind: 'DISCOUNT',
        category: 'OTHER',
        fixedAmount: Money.fromString('0', 'TRY'),
        allocationMethod: 'BY_QUANTITY',
      }),
      OVERDRAWING_DISCOUNT,
    ])

    expect(result.status).toBe('INVALID')
    expect(issueMessage(result)).toContain('InvalidDiscountError')
  })
})

describe('a discount kept out of the comparison total is still economically real', () => {
  /**
   * `includeInComparison: false` says "do not add this to the total I am
   * comparing". It does not say the money stopped existing:
   * `alreadyIncludedInQuote` is `false`, so the engine still lets this
   * discount lower `merchandiseAfterDiscount` and every percentage taken on
   * it. The supplier-level ceiling already treats it that way — it is
   * `baseAffectingDiscounts`, not `totalDiscounts`, that may not exceed the
   * merchandise total. The per-line rule has to agree, or the same money is
   * economically real at supplier level and imaginary at line level.
   */
  const EXCLUDED_OVERDRAWING_DISCOUNT = createAdditionalCost({
    id: 'rebate',
    kind: 'DISCOUNT',
    category: 'OTHER',
    fixedAmount: Money.fromString('600', 'TRY'),
    allocationMethod: 'EQUAL_PER_LINE',
    includeInComparison: false,
  })

  it('invalidates the supplier when its exact per-line share overdraws a line', () => {
    const result = evaluate([EXCLUDED_OVERDRAWING_DISCOUNT])

    expect(result.status).toBe('INVALID')
    expect(issueMessage(result)).toContain('InvalidDiscountError')
    expect(issueMessage(result)).toContain("exceeds that line's merchandise value")
    expect(result.warnings).toEqual([])
    expect(result.rank).toBeUndefined()
  })

  it('reaches exactly the verdict the included variant reaches', () => {
    const excluded = evaluate([EXCLUDED_OVERDRAWING_DISCOUNT])
    const included = evaluate([OVERDRAWING_DISCOUNT])

    expect(excluded.status).toBe(included.status)
    expect(excluded.issues.map((issue) => issue.code)).toEqual(
      included.issues.map((issue) => issue.code),
    )
    // The same 300 TRY on the same 100 TRY line, named the same way.
    expect(issueMessage(excluded)).toBe(issueMessage(included))
  })

  it('holds when an unrelated cost cannot be allocated either', () => {
    const result = evaluate([EXCLUDED_OVERDRAWING_DISCOUNT, UNALLOCATABLE_FREIGHT])

    expect(result.status).toBe('INVALID')
    expect(issueMessage(result)).toContain('InvalidDiscountError')
    expect(result.warnings).toEqual([])
  })

  it('still ignores a discount already inside the quoted price', () => {
    // The opposite kind of statement: this money is already in the line
    // prices, so counting it again — at supplier level or at line level —
    // would double it. It affects no base and validates against no line.
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        fixedAmount: Money.fromString('600', 'TRY'),
        allocationMethod: 'EQUAL_PER_LINE',
        alreadyIncludedInQuote: true,
      }),
    ])

    expect(result.status).toBe('COMPLETE')
    expect(result.rankingAmount?.toDecimalString()).toBe('1000')
  })

  it('leaves an excluded discount that fits every line valid', () => {
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        fixedAmount: Money.fromString('60', 'TRY'),
        allocationMethod: 'EQUAL_PER_LINE',
        includeInComparison: false,
      }),
    ])

    // Validated, passed, and still kept out of the compared total.
    expect(result.status).toBe('COMPLETE')
    expect(result.rankingAmount?.toDecimalString()).toBe('1000')
    expect(result.costResult?.percentageBases.merchandiseAfterDiscount.toDecimalString()).toBe('940')
  })
})

describe('a discount that fits every line stays valid', () => {
  it('is COMPLETE, ranked, and fully allocated', () => {
    const result = evaluate([FITTING_DISCOUNT, ALLOCATABLE_FREIGHT, DUTY])

    // 1,000 merchandise - 60 discount + 50 freight + 30 duty
    expect(result.status).toBe('COMPLETE')
    expect(result.issues).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.rankingAmount?.toDecimalString()).toBe('1020')
    expect(result.rank).toBe(1)
    expect(result.costAllocation).toBeDefined()

    // The per-line breakdown still reconciles to the authoritative total.
    const perLine = result.lines!.map((line) => line.settledLandedValue!)
    const summed = perLine.reduce((total, value) => total.add(value), Money.zero('TRY'))
    expect(summed.toDecimalString()).toBe('1020')
  })

  it('allows a discount that exactly equals the line it sits on', () => {
    // 200 TRY split equally is 100 TRY on a 100 TRY line: it fits exactly.
    // The comparison is exact-vs-exact, so no rounding may push it over.
    const result = evaluate([
      createAdditionalCost({
        id: 'rebate',
        kind: 'DISCOUNT',
        category: 'OTHER',
        fixedAmount: Money.fromString('200', 'TRY'),
        allocationMethod: 'EQUAL_PER_LINE',
      }),
    ])

    expect(result.status).toBe('COMPLETE')
    expect(result.rankingAmount?.toDecimalString()).toBe('800')
  })

  it('still rejects a discount that overdraws a line with nothing else going wrong', () => {
    const result = evaluate([OVERDRAWING_DISCOUNT])

    expect(result.status).toBe('INVALID')
    expect(issueMessage(result)).toContain('InvalidDiscountError')
    expect(result.warnings).toEqual([])
  })
})

describe('the verdict does not depend on the order costs were entered in', () => {
  it('invalidates a bad discount in every ordering', () => {
    for (const costs of permutations([OVERDRAWING_DISCOUNT, UNALLOCATABLE_FREIGHT, DUTY])) {
      const result = evaluate(costs)
      expect(result.status).toBe('INVALID')
      expect(issueMessage(result)).toContain('InvalidDiscountError')
      expect(result.warnings).toEqual([])
    }
  })

  it('produces one ranking amount for a valid quote in every ordering', () => {
    for (const costs of permutations([FITTING_DISCOUNT, ALLOCATABLE_FREIGHT, DUTY])) {
      const result = evaluate(costs)
      expect(result.status).toBe('COMPLETE')
      expect(result.rankingAmount?.toDecimalString()).toBe('1020')
      expect(result.rank).toBe(1)
    }
  })
})

describe('explanatory allocation still fails softly', () => {
  function mixedUnitComparison(costsForCheap: readonly AdditionalCost[]) {
    return compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [BIG, SMALL],
        suppliers: [supplier('cheap'), supplier('pricey')],
        quotes: [
          quote({
            id: 'q-cheap',
            supplierId: 'cheap',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'c1', requirementId: 'big', price: '900', currency: 'TRY' }),
              quoteItem({ id: 'c2', requirementId: 'small', price: '100', currency: 'TRY' }),
            ],
          }),
          quote({
            id: 'q-pricey',
            supplierId: 'pricey',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'p1', requirementId: 'big', price: '1400', currency: 'TRY' }),
              quoteItem({ id: 'p2', requirementId: 'small', price: '300', currency: 'TRY' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: { cheap: costsForCheap, pricey: [ALLOCATABLE_FREIGHT] },
    })
  }

  it('keeps a supplier COMPLETE and ranked when only the breakdown is missing', () => {
    const result = mixedUnitComparison([UNALLOCATABLE_FREIGHT])
    const cheap = result.supplierResults.find((entry) => entry.supplierId === 'cheap')!

    expect(cheap.status).toBe('COMPLETE')
    expect(cheap.issues).toEqual([])
    expect(cheap.warnings).toHaveLength(1)
    expect(cheap.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
    expect(cheap.warnings[0]?.reason).toBe('INCOMPATIBLE_ALLOCATION_UNITS')
    expect(cheap.costAllocation).toBeUndefined()

    // 1,000 + 50 against 1,700 + 50 — the ranking is unaffected.
    expect(cheap.rankingAmount?.toDecimalString()).toBe('1050')
    expect(cheap.rank).toBe(1)
    expect(result.lowestSupplierIds).toEqual(['cheap'])
  })

  it('keeps that behaviour when a well-formed discount is also present', () => {
    const result = mixedUnitComparison([FITTING_DISCOUNT, UNALLOCATABLE_FREIGHT])
    const cheap = result.supplierResults.find((entry) => entry.supplierId === 'cheap')!

    // The discount was validated and passed; only the explanation is missing.
    expect(cheap.status).toBe('COMPLETE')
    expect(cheap.rankingAmount?.toDecimalString()).toBe('990')
    expect(cheap.rank).toBe(1)
    expect(cheap.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
  })

  it('free sample: zero merchandise with real freight keeps its landed total', () => {
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
            allocationMethod: 'BY_MERCHANDISE_VALUE',
          }),
        ],
      },
    })

    const only = result.supplierResults[0]!
    expect(only.status).toBe('COMPLETE')
    expect(only.rankingAmount?.toDecimalString()).toBe('20')
    expect(only.rank).toBe(1)
    expect(only.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')
    expect(only.warnings[0]?.reason).toBe('INVALID_ALLOCATION_BASE')
  })
})
