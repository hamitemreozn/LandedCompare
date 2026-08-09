import { parseExactDecimal, type Decimal } from '../domain/monetary/decimal'
import { CurrencyMismatchError, Money } from '../domain/monetary/Money'
import type { CurrencyCode } from '../domain/monetary/CurrencyCode'
import type { Quantity } from '../domain/quantity/Quantity'

/**
 * How a supplier-level shared amount is split across the lines it covers.
 * A closed set of three — there is no user-defined weighting formula.
 */
export type AllocationMethod = 'BY_MERCHANDISE_VALUE' | 'EQUAL_PER_LINE' | 'BY_QUANTITY'

export const DEFAULT_ALLOCATION_METHOD: AllocationMethod = 'BY_MERCHANDISE_VALUE'

/**
 * Covers every way the weighting side of an allocation can be unusable: no
 * lines to allocate onto, a total weight of zero, or a negative weight. All
 * three mean the same thing operationally — there is no defensible split, so
 * the calculation stops instead of dividing by zero or inventing one.
 */
export class InvalidAllocationBaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAllocationBaseError'
  }
}

export class IncompatibleAllocationUnitsError extends Error {
  constructor(units: readonly string[]) {
    super(
      `Cannot allocate by quantity across mixed comparison units (${units.join(', ')}): adding raw quantities in different units is meaningless`,
    )
    this.name = 'IncompatibleAllocationUnitsError'
  }
}

/**
 * An internal assertion, not a user-input error. It fires only if the
 * largest-remainder distribution failed to reproduce the settled total
 * exactly, which would mean the allocator itself is broken. It exists so that
 * failure is loud rather than a silently lost minor unit.
 */
export class AllocationInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationInvariantError'
  }
}

/**
 * One line a shared cost can be spread over. Array order is the stable
 * ordering used for remainder tie-breaking, so the caller controls
 * determinism by controlling the order it passes lines in.
 */
export interface AllocationTarget {
  readonly id: string
  /** The line's merchandise value. Weight source for `BY_MERCHANDISE_VALUE`. */
  readonly merchandiseValue: Money
  /** The line's resolved quantity (Phase 3 output). Weight source for `BY_QUANTITY`. */
  readonly quantity: Quantity
  /** The unit `quantity` is expressed in. Guards `BY_QUANTITY` against mixed units. */
  readonly comparisonUnit: string
}

export interface Allocation {
  readonly targetId: string
  /** Signed, settled to the currency's minor unit. */
  readonly amount: Money
}

export interface AllocationResult {
  readonly method: AllocationMethod
  readonly minorUnit: number
  /** The amount as calculated, at full precision, before the settlement boundary. */
  readonly exactAmount: Money
  /**
   * `exactAmount` rounded to the currency's minor unit. The allocations sum
   * to exactly this — never to `exactAmount`, which may carry sub-minor-unit
   * digits. Both are exposed so the residual between them is visible rather
   * than quietly absorbed into one line.
   */
  readonly settledAmount: Money
  readonly allocations: readonly Allocation[]
}

/**
 * Splits `amount` across `targets` so that the parts sum to exactly
 * `settledAmount` at the currency's minor-unit precision.
 *
 * Method: **largest remainder**.
 * 1. Settle the amount's magnitude to the minor unit.
 * 2. Give each line its exact proportional share (full precision, no rounding).
 * 3. Truncate each share down to the minor unit.
 * 4. Hand the leftover minor units out one at a time, to the lines with the
 *    largest truncated-away fraction first; ties go to the earlier line in
 *    the input order.
 *
 * **Sign safety.** The whole computation runs on the amount's magnitude and
 * the sign is re-applied at the end. A discount (negative effect) is
 * therefore allocated by exactly the same code path as a freight cost, and
 * "largest remainder" never has to mean two different things depending on
 * sign. Weights are required to be non-negative, so every allocation shares
 * the sign of the amount being allocated.
 *
 * Determinism: for the same amount, the same targets in the same order, the
 * same method and the same minor unit, the output is always identical.
 */
export function allocateAmount(
  amount: Money,
  targets: readonly AllocationTarget[],
  method: AllocationMethod,
  minorUnit: number,
): AllocationResult {
  if (targets.length === 0) {
    throw new InvalidAllocationBaseError(
      `Cannot allocate ${amount.toDecimalString()} ${amount.currency} by ${method}: there are no lines to allocate onto`,
    )
  }

  const weighted = resolveWeights(targets, method)
  const totalWeight = weighted.reduce<Decimal>((sum, entry) => sum.plus(entry.weight), ZERO_DECIMAL)

  if (totalWeight.isZero()) {
    throw new InvalidAllocationBaseError(
      `Cannot allocate by ${method}: the allocation base is zero across all ${String(targets.length)} line(s)`,
    )
  }

  const currency = amount.currency
  const isNegativeAmount = amount.isNegative()
  const settledMagnitude = amount.abs().roundToMinorUnit(minorUnit)
  const settledMagnitudeDecimal = parseExactDecimal(settledMagnitude.toDecimalString())
  const step = minorUnitStep(minorUnit, currency)

  const slots = weighted.map<AllocationSlot>((entry, order) => {
    const exactShare = Money.fromString(
      settledMagnitudeDecimal.times(entry.weight).dividedBy(totalWeight).toFixed(),
      currency,
    )
    const truncated = exactShare.truncateToMinorUnit(minorUnit)
    return {
      targetId: entry.target.id,
      order,
      remainder: exactShare.subtract(truncated),
      allocated: truncated,
    }
  })

  // The leftover is derived from the settled total, not from the sum of the
  // exact shares, so a share that cannot be represented exactly (1/3, say)
  // cannot leak a lost minor unit into the result.
  let undistributed = settledMagnitude.subtract(
    slots.reduce((sum, slot) => sum.add(slot.allocated), Money.zero(currency)),
  )
  if (undistributed.isNegative()) {
    throw new AllocationInvariantError(
      `Allocation of ${settledMagnitude.toDecimalString()} ${currency} over-distributed by ${undistributed.abs().toDecimalString()}`,
    )
  }

  for (const slot of orderByLargestRemainder(slots)) {
    if (undistributed.isZero()) {
      break
    }
    slot.allocated = slot.allocated.add(step)
    undistributed = undistributed.subtract(step)
  }

  if (!undistributed.isZero()) {
    throw new AllocationInvariantError(
      `Allocation of ${settledMagnitude.toDecimalString()} ${currency} left ${undistributed.toDecimalString()} undistributed across ${String(slots.length)} line(s)`,
    )
  }

  const applySign = (value: Money): Money =>
    isNegativeAmount && !value.isZero() ? value.negate() : value

  return {
    method,
    minorUnit,
    exactAmount: amount,
    settledAmount: applySign(settledMagnitude),
    allocations: slots.map((slot) => ({ targetId: slot.targetId, amount: applySign(slot.allocated) })),
  }
}

/** Sums allocation amounts. Zero for an empty list, in `currency`. */
export function sumAllocations(allocations: readonly Allocation[], currency: string): Money {
  return allocations.reduce((sum, allocation) => sum.add(allocation.amount), Money.zero(currency))
}

interface AllocationSlot {
  readonly targetId: string
  readonly order: number
  readonly remainder: Money
  allocated: Money
}

interface WeightedTarget {
  readonly target: AllocationTarget
  readonly weight: Decimal
}

const ZERO_DECIMAL = parseExactDecimal('0')
const ONE_DECIMAL = parseExactDecimal('1')

function resolveWeights(
  targets: readonly AllocationTarget[],
  method: AllocationMethod,
): readonly WeightedTarget[] {
  switch (method) {
    case 'EQUAL_PER_LINE':
      return targets.map((target) => ({ target, weight: ONE_DECIMAL }))

    case 'BY_MERCHANDISE_VALUE': {
      assertSingleCurrency(targets)
      return targets.map((target) =>
        weightedTarget(target, target.merchandiseValue.toDecimalString(), method),
      )
    }

    case 'BY_QUANTITY': {
      assertSingleComparisonUnit(targets)
      return targets.map((target) => weightedTarget(target, target.quantity.toDecimalString(), method))
    }
  }
}

function weightedTarget(
  target: AllocationTarget,
  rawWeight: string,
  method: AllocationMethod,
): WeightedTarget {
  const weight = parseExactDecimal(rawWeight)
  if (weight.isNegative()) {
    throw new InvalidAllocationBaseError(
      `Cannot allocate by ${method}: line "${target.id}" has a negative weight (${weight.toFixed()})`,
    )
  }
  return { target, weight }
}

function assertSingleCurrency(targets: readonly AllocationTarget[]): void {
  let expected: CurrencyCode | undefined
  for (const target of targets) {
    const currency = target.merchandiseValue.currency
    if (expected === undefined) {
      expected = currency
    } else if (currency !== expected) {
      throw new CurrencyMismatchError(expected, currency)
    }
  }
}

/**
 * `BY_QUANTITY` is only meaningful when every line counts the same kind of
 * thing. Summing 500 pcs with 20 kg to build a ratio would produce a
 * confident-looking number with no meaning, so mixed units are rejected
 * rather than silently added together.
 */
function assertSingleComparisonUnit(targets: readonly AllocationTarget[]): void {
  const units = [...new Set(targets.map((target) => target.comparisonUnit))]
  if (units.length > 1) {
    throw new IncompatibleAllocationUnitsError(units)
  }
}

/**
 * Descending by truncated-away fraction, ties broken by the line's original
 * position. The tie-break is explicit rather than relying on `Array#sort`
 * stability, because determinism here is a financial guarantee.
 */
function orderByLargestRemainder(slots: readonly AllocationSlot[]): readonly AllocationSlot[] {
  return [...slots].sort((a, b) => {
    const byRemainder = b.remainder.compareTo(a.remainder)
    return byRemainder !== 0 ? byRemainder : a.order - b.order
  })
}

/** The smallest representable amount at `minorUnit` digits, e.g. 0.01 for 2. */
function minorUnitStep(minorUnit: number, currency: CurrencyCode): Money {
  const value = minorUnit === 0 ? '1' : `0.${'0'.repeat(minorUnit - 1)}1`
  return Money.fromString(value, currency)
}
