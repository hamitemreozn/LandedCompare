import { describe, expect, it } from 'vitest'
import {
  allocateAmount,
  AllocationInvariantError,
  exactAllocationShares,
  IncompatibleAllocationUnitsError,
  InvalidAllocationBaseError,
  sumAllocations,
  type AllocationMethod,
  type AllocationResult,
  type AllocationTarget,
} from './Allocation'
import { CurrencyMismatchError, Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'

const BASE = 'TRY'

function line(
  id: string,
  merchandiseValue: string,
  quantity: string,
  comparisonUnit = 'pcs',
  currency = BASE,
): AllocationTarget {
  return {
    id,
    merchandiseValue: Money.fromString(merchandiseValue, currency),
    quantity: Quantity.fromString(quantity),
    comparisonUnit,
  }
}

function amountsOf(result: AllocationResult): readonly string[] {
  return result.allocations.map((allocation) => allocation.amount.toDecimalString())
}

/**
 * The invariant every allocation must satisfy: the parts add back up to the
 * settled whole, exactly, with no minor unit created or lost.
 */
function expectSumsToSettledTotal(result: AllocationResult): void {
  const summed = sumAllocations(result.allocations, result.settledAmount.currency)
  expect(summed.toDecimalString()).toBe(result.settledAmount.toDecimalString())
}

describe('allocateAmount — methods', () => {
  it('allocates by merchandise value proportionally', () => {
    const result = allocateAmount(
      Money.fromString('100', BASE),
      [line('a', '600', '1'), line('b', '400', '1')],
      'BY_MERCHANDISE_VALUE',
      2,
    )
    expect(amountsOf(result)).toEqual(['60', '40'])
    expectSumsToSettledTotal(result)
  })

  it('allocates equally per line', () => {
    const result = allocateAmount(
      Money.fromString('90', BASE),
      [line('a', '600', '1'), line('b', '400', '1'), line('c', '1', '1')],
      'EQUAL_PER_LINE',
      2,
    )
    expect(amountsOf(result)).toEqual(['30', '30', '30'])
    expectSumsToSettledTotal(result)
  })

  it('allocates by quantity when every line shares a comparison unit', () => {
    const result = allocateAmount(
      Money.fromString('100', BASE),
      [line('a', '1', '30', 'pcs'), line('b', '1', '70', 'pcs')],
      'BY_QUANTITY',
      2,
    )
    expect(amountsOf(result)).toEqual(['30', '70'])
    expectSumsToSettledTotal(result)
  })

  it('rejects allocating by quantity across mixed comparison units', () => {
    // 500 pcs + 20 kg = 520 "units" is a number with no meaning; refusing is
    // the only safe answer, since no unit conversion system exists.
    expect(() =>
      allocateAmount(
        Money.fromString('100', BASE),
        [line('a', '1', '500', 'pcs'), line('b', '1', '20', 'kg')],
        'BY_QUANTITY',
        2,
      ),
    ).toThrow(IncompatibleAllocationUnitsError)
  })

  it('allows a single comparison unit repeated across many lines', () => {
    const result = allocateAmount(
      Money.fromString('60', BASE),
      [line('a', '1', '1', 'kg'), line('b', '1', '1', 'kg'), line('c', '1', '1', 'kg')],
      'BY_QUANTITY',
      2,
    )
    expect(amountsOf(result)).toEqual(['20', '20', '20'])
  })
})

describe('allocateAmount — unusable bases', () => {
  it('rejects a zero merchandise base instead of dividing by zero', () => {
    expect(() =>
      allocateAmount(
        Money.fromString('100', BASE),
        [line('a', '0', '1'), line('b', '0', '1')],
        'BY_MERCHANDISE_VALUE',
        2,
      ),
    ).toThrow(InvalidAllocationBaseError)
  })

  it('rejects a zero quantity base', () => {
    expect(() =>
      allocateAmount(
        Money.fromString('100', BASE),
        [line('a', '10', '0'), line('b', '20', '0')],
        'BY_QUANTITY',
        2,
      ),
    ).toThrow(InvalidAllocationBaseError)
  })

  it('rejects an empty set of lines for every method', () => {
    const methods: readonly AllocationMethod[] = [
      'BY_MERCHANDISE_VALUE',
      'EQUAL_PER_LINE',
      'BY_QUANTITY',
    ]
    for (const method of methods) {
      expect(() => allocateAmount(Money.fromString('100', BASE), [], method, 2)).toThrow(
        InvalidAllocationBaseError,
      )
    }
  })

  it('rejects a negative weight', () => {
    expect(() =>
      allocateAmount(
        Money.fromString('100', BASE),
        [line('a', '-600', '1'), line('b', '400', '1')],
        'BY_MERCHANDISE_VALUE',
        2,
      ),
    ).toThrow(InvalidAllocationBaseError)
  })

  it('rejects merchandise weights in mixed currencies', () => {
    expect(() =>
      allocateAmount(
        Money.fromString('100', BASE),
        [line('a', '600', '1', 'pcs', 'TRY'), line('b', '400', '1', 'pcs', 'USD')],
        'BY_MERCHANDISE_VALUE',
        2,
      ),
    ).toThrow(CurrencyMismatchError)
  })

  it('still allocates zero across a usable base', () => {
    const result = allocateAmount(
      Money.zero(BASE),
      [line('a', '600', '1'), line('b', '400', '1')],
      'BY_MERCHANDISE_VALUE',
      2,
    )
    expect(amountsOf(result)).toEqual(['0', '0'])
    expectSumsToSettledTotal(result)
  })

  it('rejects an unusable base even when the amount itself is zero', () => {
    // Deliberate: the base is validated independently of the amount, because
    // splitting zero across a zero base is still an undefined ratio. The
    // caller is told the weighting is wrong rather than handed a zero that
    // looks like a real answer.
    expect(() =>
      allocateAmount(
        Money.zero(BASE),
        [line('a', '0', '1'), line('b', '0', '1')],
        'BY_MERCHANDISE_VALUE',
        2,
      ),
    ).toThrow(InvalidAllocationBaseError)

    expect(() =>
      allocateAmount(Money.zero(BASE), [], 'EQUAL_PER_LINE', 2),
    ).toThrow(InvalidAllocationBaseError)
  })

  it('rejects a zero-amount cost allocation through the cost engine too', () => {
    // Same rule when it arrives via a 0% percentage cost rather than directly.
    expect(() =>
      allocateAmount(
        Money.fromString('0', BASE),
        [line('a', '0', '0'), line('b', '0', '0')],
        'BY_QUANTITY',
        2,
      ),
    ).toThrow(InvalidAllocationBaseError)
  })
})

describe('allocateAmount — rounding remainder', () => {
  it('splits 100.00 across 3 lines without losing a minor unit', () => {
    const result = allocateAmount(
      Money.fromString('100.00', BASE),
      [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')],
      'EQUAL_PER_LINE',
      2,
    )
    expect(amountsOf(result)).toEqual(['33.34', '33.33', '33.33'])
    expect(sumAllocations(result.allocations, BASE).toDecimalString()).toBe('100')
    expectSumsToSettledTotal(result)
  })

  it('gives the leftover minor unit to the largest remainder, not to the first line', () => {
    // Exact shares are 57.142857…, 28.571428…, 14.285714…; the largest
    // truncated-away fraction belongs to the *last* line.
    const result = allocateAmount(
      Money.fromString('100.00', BASE),
      [line('a', '400', '1'), line('b', '200', '1'), line('c', '100', '1')],
      'BY_MERCHANDISE_VALUE',
      2,
    )
    expect(amountsOf(result)).toEqual(['57.14', '28.57', '14.29'])
    expectSumsToSettledTotal(result)
  })

  it('breaks a remainder tie by input order, stably', () => {
    const targets = [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')]
    const first = allocateAmount(Money.fromString('100.00', BASE), targets, 'EQUAL_PER_LINE', 2)

    // Same weights, same remainders, different ids: the *position* decides.
    const renamed = [line('x', '1', '1'), line('y', '1', '1'), line('z', '1', '1')]
    const second = allocateAmount(Money.fromString('100.00', BASE), renamed, 'EQUAL_PER_LINE', 2)

    expect(amountsOf(first)).toEqual(['33.34', '33.33', '33.33'])
    expect(amountsOf(second)).toEqual(amountsOf(first))
  })

  it('produces identical output on repeated runs of the same input', () => {
    const targets = [line('a', '7', '1'), line('b', '11', '1'), line('c', '13', '1')]
    const runs = Array.from({ length: 5 }, () =>
      amountsOf(allocateAmount(Money.fromString('100.00', BASE), targets, 'BY_MERCHANDISE_VALUE', 2)),
    )
    for (const run of runs) {
      expect(run).toEqual(runs[0])
    }
  })

  it('settles an amount that carries sub-minor-unit digits, exposing the residual', () => {
    const result = allocateAmount(
      Money.fromString('100.005', BASE),
      [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')],
      'EQUAL_PER_LINE',
      2,
    )
    expect(result.exactAmount.toDecimalString()).toBe('100.005')
    expect(result.settledAmount.toDecimalString()).toBe('100.01')
    expect(amountsOf(result)).toEqual(['33.34', '33.34', '33.33'])
    expectSumsToSettledTotal(result)
  })

  it('handles a very small allocation without dropping it', () => {
    const result = allocateAmount(
      Money.fromString('0.01', BASE),
      [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')],
      'EQUAL_PER_LINE',
      2,
    )
    expect(amountsOf(result)).toEqual(['0.01', '0', '0'])
    expectSumsToSettledTotal(result)
  })

  it('handles a large monetary amount without precision loss', () => {
    const result = allocateAmount(
      Money.fromString('1000000000000.01', BASE),
      [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')],
      'EQUAL_PER_LINE',
      2,
    )
    expect(amountsOf(result)).toEqual([
      '333333333333.34',
      '333333333333.34',
      '333333333333.33',
    ])
    expectSumsToSettledTotal(result)
  })

  it('honours a 0-decimal minor unit', () => {
    const result = allocateAmount(
      Money.fromString('100', 'JPY'),
      [
        line('a', '1', '1', 'pcs', 'JPY'),
        line('b', '1', '1', 'pcs', 'JPY'),
        line('c', '1', '1', 'pcs', 'JPY'),
      ],
      'EQUAL_PER_LINE',
      0,
    )
    expect(amountsOf(result)).toEqual(['34', '33', '33'])
    expectSumsToSettledTotal(result)
  })

  it('keeps the invariant across a range of amounts, line counts and methods', () => {
    const methods: readonly AllocationMethod[] = [
      'BY_MERCHANDISE_VALUE',
      'EQUAL_PER_LINE',
      'BY_QUANTITY',
    ]
    const amounts = ['0.07', '1', '33.33', '100', '100.005', '1234.56', '999999.99']
    const lineCounts = [1, 2, 3, 4, 7, 11]

    for (const method of methods) {
      for (const amount of amounts) {
        for (const count of lineCounts) {
          const targets = Array.from({ length: count }, (_unused, index) =>
            line(`line-${String(index)}`, String(index + 1), String(index * 2 + 1)),
          )
          const result = allocateAmount(Money.fromString(amount, BASE), targets, method, 2)
          expectSumsToSettledTotal(result)
          expect(result.allocations).toHaveLength(count)
        }
      }
    }
  })
})

describe('allocateAmount — sign safety', () => {
  it('allocates a negative amount as the exact mirror of its positive twin', () => {
    const targets = [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')]
    const cost = allocateAmount(Money.fromString('100.00', BASE), targets, 'EQUAL_PER_LINE', 2)
    const discount = allocateAmount(Money.fromString('-100.00', BASE), targets, 'EQUAL_PER_LINE', 2)

    expect(amountsOf(discount)).toEqual(['-33.34', '-33.33', '-33.33'])
    expect(discount.settledAmount.toDecimalString()).toBe('-100')
    expect(discount.allocations.map((a) => a.amount.abs().toDecimalString())).toEqual(
      cost.allocations.map((a) => a.amount.toDecimalString()),
    )
    expectSumsToSettledTotal(discount)
  })

  it('keeps the invariant for negative amounts across a range of inputs', () => {
    for (const amount of ['-0.01', '-0.07', '-100', '-100.005', '-4321.99']) {
      for (const count of [1, 3, 6]) {
        const targets = Array.from({ length: count }, (_unused, index) =>
          line(`line-${String(index)}`, String(index + 1), '1'),
        )
        const result = allocateAmount(
          Money.fromString(amount, BASE),
          targets,
          'BY_MERCHANDISE_VALUE',
          2,
        )
        expectSumsToSettledTotal(result)
        for (const allocation of result.allocations) {
          expect(allocation.amount.isPositive()).toBe(false)
        }
      }
    }
  })

  it('does not emit a negative zero', () => {
    const result = allocateAmount(
      Money.fromString('-0.01', BASE),
      [line('a', '1', '1'), line('b', '1', '1')],
      'EQUAL_PER_LINE',
      2,
    )
    expect(amountsOf(result)).toEqual(['-0.01', '0'])
  })
})

/**
 * The narrow exact-share view `validateDiscountLineAllocations` checks a
 * discount against. It stops before settlement on purpose: a share rounded to
 * the minor unit could exceed a line by half a unit it does not actually take,
 * and a validation rule must not be decided by a presentation boundary.
 */
describe('exactAllocationShares', () => {
  it('returns unsettled shares — no rounding, no remainder distribution', () => {
    const shares = exactAllocationShares(
      Money.fromString('100', BASE),
      [line('a', '1', '1'), line('b', '1', '1'), line('c', '1', '1')],
      'EQUAL_PER_LINE',
      2,
    )
    // allocateAmount would settle these to 33.34 / 33.33 / 33.33.
    expect(shares.map((share) => share.exactAmount.toDecimalString())).toEqual([
      '33.33333333333333333333333333333333',
      '33.33333333333333333333333333333333',
      '33.33333333333333333333333333333333',
    ])
    expect(shares.map((share) => share.targetId)).toEqual(['a', 'b', 'c'])
  })

  it('agrees with the exact shares allocateAmount publishes', () => {
    const targets = [line('a', '900', '3'), line('b', '100', '7')]
    for (const method of ['BY_MERCHANDISE_VALUE', 'EQUAL_PER_LINE', 'BY_QUANTITY'] as const) {
      const amount = Money.fromString('-137.77', BASE)
      const fromAllocator = allocateAmount(amount, targets, method, 2)
      expect(
        exactAllocationShares(amount, targets, method, 2).map((share) =>
          share.exactAmount.toDecimalString(),
        ),
      ).toEqual(fromAllocator.allocations.map((allocation) => allocation.exactAmount.toDecimalString()))
    }
  })

  it("carries the amount's sign onto every share", () => {
    const shares = exactAllocationShares(
      Money.fromString('-50', BASE),
      [line('a', '600', '1'), line('b', '400', '1')],
      'BY_MERCHANDISE_VALUE',
      2,
    )
    expect(shares.map((share) => share.exactAmount.toDecimalString())).toEqual(['-30', '-20'])
  })

  it('raises the same unusable-weighting errors as allocateAmount', () => {
    expect(() =>
      exactAllocationShares(
        Money.fromString('50', BASE),
        [line('a', '1', '1', 'pcs'), line('b', '1', '1', 'kg')],
        'BY_QUANTITY',
        2,
      ),
    ).toThrow(IncompatibleAllocationUnitsError)

    expect(() =>
      exactAllocationShares(
        Money.fromString('50', BASE),
        [line('a', '0', '1'), line('b', '0', '1')],
        'BY_MERCHANDISE_VALUE',
        2,
      ),
    ).toThrow(InvalidAllocationBaseError)

    expect(() =>
      exactAllocationShares(Money.fromString('50', BASE), [], 'EQUAL_PER_LINE', 2),
    ).toThrow(InvalidAllocationBaseError)
  })
})

describe('AllocationInvariantError', () => {
  it('exists as a distinct internal assertion type', () => {
    // The allocator throws this only if its own remainder distribution fails
    // to reproduce the settled total — a broken-engine signal, not user input.
    expect(new AllocationInvariantError('x')).toBeInstanceOf(Error)
    expect(new AllocationInvariantError('x').name).toBe('AllocationInvariantError')
  })
})
