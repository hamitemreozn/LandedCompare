import { describe, expect, it } from 'vitest'
import { allocateAmount, settleTotalAcrossParts, type AllocationTarget } from './Allocation'
import { calculateSupplierCosts } from './CostCalculation'
import { createAdditionalCost } from './AdditionalCost'
import { PrecisionEnvelopeExceededError } from './CurrencyMinorUnit'
import { resolveOrderQuantity } from './QuantityResolution'
import { ExchangeRateTable } from './ExchangeRateTable'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'
import { compareSuppliers } from '../comparison/SupplierComparison'
import {
  baseRateTable,
  project,
  quote,
  quoteItem,
  requirement,
  supplier,
} from '../comparison/testSupport'

/**
 * decimal.js evaluates every operation at a fixed significant-digit budget
 * (34). Parsing keeps all the digits a string carries, so a value can enter
 * the engine exactly and lose digits on its first multiplication. The audit
 * found two places where that turned into a wrong business answer rather than
 * an imprecise one, and one documentation claim that was simply false.
 */

const HUGE_TARGETS: AllocationTarget[] = ['a', 'b', 'c'].map((id) => ({
  id,
  merchandiseValue: Money.fromString('1', 'TRY'),
  quantity: Quantity.fromString('1'),
  comparisonUnit: 'pcs',
}))

describe('whole-pack ceiling at the significant-digit boundary', () => {
  it('does not lose the last digit of a 35-digit quantity', () => {
    // 10^34 + 1 divided by 1 used to come back as 10^34 — one unit short —
    // because the quotient was rounded to 34 significant digits before the
    // ceiling was taken.
    const required = Quantity.fromString('10000000000000000000000000000000001')
    expect(required.ceilDivide(Quantity.fromString('1')).toDecimalString()).toBe(
      '10000000000000000000000000000000001',
    )
  })

  it('rounds up to a whole pack correctly past 34 digits', () => {
    const required = Quantity.fromString('10000000000000000000000000000000001')
    // ceil((10^34 + 1) / 2) = 5 x 10^33 + 1
    expect(required.ceilDivide(Quantity.fromString('2')).toDecimalString()).toBe(
      '5000000000000000000000000000000001',
    )
  })

  it('does not round a whole quotient up to an extra pack', () => {
    const required = Quantity.fromString('99999999999999999999999999999999999')
    expect(required.ceilDivide(Quantity.fromString('3')).toDecimalString()).toBe(
      '33333333333333333333333333333333333',
    )
  })

  it('multiplies a large pack count back exactly', () => {
    const packs = Quantity.fromString('5000000000000000000000000000000001')
    expect(packs.multiply(Quantity.fromString('2')).toDecimalString()).toBe(
      '10000000000000000000000000000000002',
    )
  })

  it('rejects a zero divisor instead of producing an infinite quantity', () => {
    expect(() => Quantity.fromString('10').ceilDivide(Quantity.fromString('0'))).toThrow(
      /cannot divide a quantity by zero/,
    )
  })

  it('keeps the excess quantity non-negative at the boundary', () => {
    // The failure this guards: a short resolved quantity made
    // `resolvedQuantity - requiredQuantity` negative, which surfaced as an
    // InvalidQuantityError and marked a perfectly ordinary supplier INVALID.
    for (const [required, pack] of [
      ['10000000000000000000000000000000001', '1'],
      ['10000000000000000000000000000000001', '2'],
      ['99999999999999999999999999999999999', '3'],
      ['12345678901234567890123456789012345', '7'],
    ]) {
      const resolution = resolveOrderQuantity({
        requiredQuantity: Quantity.fromString(required!),
        unitsPerQuotedUnit: Quantity.fromString(pack!),
      })
      expect(resolution.excessQuantity.compareTo(Quantity.fromString('0'))).toBeGreaterThanOrEqual(0)
      expect(
        resolution.resolvedQuantity.compareTo(resolution.requiredQuantity),
      ).toBeGreaterThanOrEqual(0)
    }
  })

  it('leaves ordinary pack arithmetic exactly as before', () => {
    const resolution = resolveOrderQuantity({
      requiredQuantity: Quantity.fromString('105'),
      unitsPerQuotedUnit: Quantity.fromString('10'),
    })
    expect(resolution.quotedUnitQuantity.toDecimalString()).toBe('11')
    expect(resolution.resolvedQuantity.toDecimalString()).toBe('110')
    expect(resolution.excessQuantity.toDecimalString()).toBe('5')
  })
})

describe('allocation inside the settlement precision envelope', () => {
  it('splits a large amount without losing a minor unit', () => {
    // 31 integer digits at 2 minor-unit digits — comfortably inside the
    // envelope, and previously the kind of magnitude that made the allocator
    // fail its own invariant.
    const amount = Money.fromString('1234567890123456789012345678901.23', 'TRY')
    const result = allocateAmount(amount, HUGE_TARGETS, 'EQUAL_PER_LINE', 2)
    const sum = result.allocations.reduce((total, a) => total.add(a.amount), Money.zero('TRY'))
    expect(sum.toDecimalString()).toBe(result.settledAmount.toDecimalString())
  })

  it('splits at a high minor-unit scale without losing a minor unit', () => {
    const amount = Money.fromString('123456789012.12345678901234567890', 'XYZ')
    const result = allocateAmount(amount, [...HUGE_TARGETS].map(withCurrency('XYZ')), 'EQUAL_PER_LINE', 20)
    const sum = result.allocations.reduce((total, a) => total.add(a.amount), Money.zero('XYZ'))
    expect(sum.toDecimalString()).toBe(result.settledAmount.toDecimalString())
  })

  it('distributes across many awkwardly weighted lines exactly', () => {
    const targets: AllocationTarget[] = Array.from({ length: 40 }, (_, index) => ({
      id: `t${String(index)}`,
      merchandiseValue: Money.fromString(String(index + 1), 'TRY'),
      quantity: Quantity.fromString(String(index + 1)),
      comparisonUnit: 'pcs',
    }))
    for (const amount of ['100.00', '0.07', '1000000000000000000000000000000.01']) {
      const result = allocateAmount(Money.fromString(amount, 'TRY'), targets, 'BY_MERCHANDISE_VALUE', 2)
      const sum = result.allocations.reduce((total, a) => total.add(a.amount), Money.zero('TRY'))
      expect(sum.toDecimalString()).toBe(result.settledAmount.toDecimalString())
    }
  })
})

describe('outside the envelope the engine says so, explicitly', () => {
  it('rejects an amount that cannot be settled exactly, by name', () => {
    // 34 integer digits + 2 minor-unit digits needs 36 significant digits.
    // This used to surface as AllocationInvariantError — an internal "the
    // allocator is broken" assertion — for an input that was simply out of
    // range.
    expect(() =>
      allocateAmount(
        Money.fromString('1234567890123456789012345678901234.56', 'TRY'),
        HUGE_TARGETS,
        'EQUAL_PER_LINE',
        2,
      ),
    ).toThrow(PrecisionEnvelopeExceededError)
  })

  it('rejects a high minor-unit scale that pushes an ordinary amount out of range', () => {
    expect(() =>
      allocateAmount(
        Money.fromString('100000000000000000.12345678901234567890', 'XYZ'),
        [...HUGE_TARGETS].map(withCurrency('XYZ')),
        'EQUAL_PER_LINE',
        20,
      ),
    ).toThrow(PrecisionEnvelopeExceededError)
  })

  it('rejects it at the commercial total too, before anything is rounded', () => {
    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString('1234567890123456789012345678901234', 'TRY'),
        costs: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('100', 'TRY'),
          }),
        ],
        exchangeRateTable: ExchangeRateTable.create('TRY'),
        minorUnit: 2,
      }),
    ).toThrow(PrecisionEnvelopeExceededError)
  })

  it('explains itself as a precision limit, not a maximum amount', () => {
    try {
      allocateAmount(
        Money.fromString('1234567890123456789012345678901234.56', 'TRY'),
        HUGE_TARGETS,
        'EQUAL_PER_LINE',
        2,
      )
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('34 significant digits')
      expect((error as Error).message).toContain('not a maximum amount')
    }
  })
})

describe('settling a total across its own parts', () => {
  it('reproduces the total exactly when the shares do not divide evenly', () => {
    const parts = ['122.98815', '245.9763', '368.96445'].map((value) => Money.fromString(value, 'TRY'))
    const settled = settleTotalAcrossParts(Money.fromString('737.93', 'TRY'), parts, 2)
    expect(settled.map((value) => value.toDecimalString())).toEqual(['122.99', '245.98', '368.96'])
    const sum = settled.reduce((total, value) => total.add(value), Money.zero('TRY'))
    expect(sum.toDecimalString()).toBe('737.93')
  })

  it('settles a zero total across all-zero parts instead of rejecting the split', () => {
    // Unlike allocating a shared cost, the total here *is* the sum of the
    // parts, so zero over zero is arithmetic rather than an undefined ratio.
    const parts = [Money.zero('TRY'), Money.zero('TRY')]
    expect(settleTotalAcrossParts(Money.zero('TRY'), parts, 2).map((v) => v.toDecimalString())).toEqual(
      ['0', '0'],
    )
  })
})

function withCurrency(currency: string) {
  return (target: AllocationTarget): AllocationTarget => ({
    ...target,
    merchandiseValue: Money.fromString(target.merchandiseValue.toDecimalString(), currency),
  })
}

/**
 * The audit reached both cliffs through the public `compareSuppliers` API,
 * which is what made them real rather than theoretical. These pin the
 * end-to-end behaviour.
 */
describe('through the public comparison API', () => {
  it('no longer invalidates a supplier over a 35-digit required quantity', () => {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [
          requirement('r1', { requiredQuantity: '10000000000000000000000000000000001' }),
        ],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [
              quoteItem({
                id: 'i1',
                requirementId: 'r1',
                price: '0.00000000000000000000000000000001',
                currency: 'TRY',
                unitsPerQuotedUnit: '1',
              }),
            ],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
    })

    const only = result.supplierResults[0]!
    // Used to be INVALID with "InvalidQuantityError: -1" — the resolved
    // quantity came back one unit short of what was required.
    expect(only.status).toBe('COMPLETE')
    expect(only.lines?.[0]?.resolvedQuantity.toDecimalString()).toBe(
      '10000000000000000000000000000000001',
    )
    expect(only.lines?.[0]?.excessQuantity.toDecimalString()).toBe('0')
  })

  it('rejects an out-of-range amount as a supplier problem, not a crash', () => {
    const requirements = Array.from({ length: 40 }, (_, index) =>
      requirement(`r${String(index)}`, { requiredQuantity: String(index + 1) }),
    )
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements,
        suppliers: [supplier('huge'), supplier('ordinary')],
        quotes: [
          quote({
            id: 'q-huge',
            supplierId: 'huge',
            currency: 'TRY',
            items: requirements.map((r, index) =>
              quoteItem({
                id: `h${String(index)}`,
                requirementId: r.id,
                price: '1000000000000000000000000000000',
                currency: 'TRY',
              }),
            ),
          }),
          quote({
            id: 'q-ordinary',
            supplierId: 'ordinary',
            currency: 'TRY',
            items: requirements.map((r, index) =>
              quoteItem({ id: `o${String(index)}`, requirementId: r.id, price: '10', currency: 'TRY' }),
            ),
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
    })

    const huge = result.supplierResults.find((entry) => entry.supplierId === 'huge')!
    const ordinary = result.supplierResults.find((entry) => entry.supplierId === 'ordinary')!

    // Used to throw AllocationInvariantError straight out of compareSuppliers,
    // taking the whole comparison — including the perfectly ordinary supplier
    // — down with it.
    expect(huge.status).toBe('INVALID')
    expect(huge.issues[0]?.message).toContain('PrecisionEnvelopeExceededError')
    expect(ordinary.status).toBe('COMPLETE')
    expect(ordinary.rank).toBe(1)
  })
})
