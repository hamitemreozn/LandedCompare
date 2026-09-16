import {
  addExact,
  parseExactDecimal,
  proportionalShare,
  type Decimal,
} from '../domain/monetary/decimal'
import { CurrencyMismatchError, Money } from '../domain/monetary/Money'
import type { CurrencyCode } from '../domain/monetary/CurrencyCode'
import type { Quantity } from '../domain/quantity/Quantity'
import { assertSettleableAtMinorUnit } from './CurrencyMinorUnit'

/**
 * How a supplier-level shared amount is split across the lines it covers.
 * A closed set of three — there is no user-defined weighting formula. The
 * runtime tuple is the source of truth so a value arriving from outside
 * TypeScript can be checked against it.
 */
export const ALLOCATION_METHODS = ['BY_MERCHANDISE_VALUE', 'EQUAL_PER_LINE', 'BY_QUANTITY'] as const

export type AllocationMethod = (typeof ALLOCATION_METHODS)[number]

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
 *
 * It is deliberately **not** the error an out-of-range amount produces. An
 * amount too large to settle exactly at the currency's minor unit is rejected
 * up front with `PrecisionEnvelopeExceededError`, which names the real
 * problem; before that guard existed, such an amount reached the distribution
 * and surfaced here as if the allocator had a bug.
 */
export class AllocationInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationInvariantError'
  }
}

/**
 * A capacity-limited distribution could not be carried out: a line's ceiling
 * was missing, negative, or the lines' combined remaining capacity was too
 * small to absorb the amount without pushing one of them below zero.
 *
 * An `AllocationInvariantError` subclass because it is the same kind of
 * statement — the allocator was asked for something arithmetically impossible
 * — and because callers that already treat an allocation assertion as an
 * engine bug rather than a user-data problem should keep treating this one
 * that way.
 *
 * Within the supplier pipeline it is unreachable: a supplier's total settled
 * discount can never exceed its settled merchandise plus settled costs,
 * because the exact landed total is non-negative (discounts are capped at the
 * merchandise total) and the settled total is that figure rounded once. It is
 * raised rather than silently clamped so that, if that reasoning is ever
 * broken by a change elsewhere, the failure is visible instead of a quietly
 * invented minor unit.
 */
export class AllocationCapacityError extends AllocationInvariantError {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationCapacityError'
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
  /**
   * The same share before settlement: signed, full precision, this line's
   * exact proportion of `exactAmount`. Published so a check that has to
   * compare a share against another exact value (a line's own merchandise
   * value, say) can compare like precision with like, instead of measuring an
   * exact figure against a rounded one.
   */
  readonly exactAmount: Money
}

export interface AllocationResult {
  readonly method: AllocationMethod
  readonly minorUnit: number
  /** The amount as calculated, at full precision, before the settlement boundary. */
  readonly exactAmount: Money
  /**
   * What the allocations sum to — never `exactAmount`, which may carry
   * sub-minor-unit digits. Both are exposed so the residual between them is
   * visible rather than quietly absorbed into one line.
   *
   * By default this is `exactAmount` rounded to the currency's minor unit.
   * When the caller supplies a `settlementTarget` it is that figure instead,
   * because the amount's place in a larger settled total has already been
   * decided and the split must not contradict it — see
   * `reconcileSettledEffects` in `CostCalculation.ts`.
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
 * 2. Give each line its exact proportional share, computed at a precision
 *    derived from the operands so the truncation in step 3 reads the true
 *    digit rather than one the default significant-digit budget invented.
 * 3. Truncate each share down to the minor unit.
 * 4. Hand the leftover minor units out one at a time, to the lines with the
 *    largest truncated-away fraction first; ties go to the earlier line in
 *    the input order.
 *
 * **Precision precondition.** An amount whose settled form would need more
 * significant digits than the decimal configuration provides is rejected
 * (`PrecisionEnvelopeExceededError`) before any of that runs — see
 * `assertSettleableAtMinorUnit`. Within that envelope the parts sum to
 * `settledAmount` exactly, for both signs, every method, any line count.
 *
 * **Sign safety.** The whole computation runs on the amount's magnitude and
 * the sign is re-applied at the end. A discount (negative effect) is
 * therefore allocated by exactly the same code path as a freight cost, and
 * "largest remainder" never has to mean two different things depending on
 * sign. Weights are required to be non-negative, so every allocation shares
 * the sign of the amount being allocated.
 *
 * **Settlement target.** By default the parts add up to the amount's own
 * rounded magnitude. A caller that has already decided what this amount
 * contributes to a larger settled total passes that figure as
 * `settlementTarget`, and the parts add up to *it* instead — otherwise the
 * per-line breakdown and the header could differ by a minor unit, which is
 * the disagreement the settled total exists to rule out. The target must
 * share the amount's sign, so the split can never turn a cost into a credit.
 *
 * **Capacity limits.** `capacityByTargetId` caps how much *magnitude* each
 * line may be handed. It exists for discounts: a line's rounded share of the
 * merchandise total is what it can give back, and a remainder minor unit
 * placed beyond that would display a valid line as a negative landed cost.
 * With a cap supplied, a line is never allocated more than it can absorb —
 * neither by the truncation step nor by a remainder unit — and the surplus
 * moves on to the next line that has room, in the same largest-remainder
 * order. The parts still sum to the settlement target exactly; nothing is
 * clamped away. See `allocateSupplierCosts` in `CostCalculation.ts`.
 *
 * Determinism: for the same amount, the same targets in the same order, the
 * same method, the same minor unit, the same settlement target and the same
 * capacities, the output is always identical.
 */
export function allocateAmount(
  amount: Money,
  targets: readonly AllocationTarget[],
  method: AllocationMethod,
  minorUnit: number,
  settlementTarget?: Money,
  capacityByTargetId?: ReadonlyMap<string, Money>,
): AllocationResult {
  const { weighted, totalWeight } = resolveWeighting(amount, targets, method)

  // Checked before anything is rounded or summed: an amount outside the
  // engine's settlement precision cannot produce parts that add back up to
  // it, and saying so explicitly is more useful than the invariant assertion
  // below firing on a total nobody can reconcile anyway.
  assertSettleableAtMinorUnit(amount.abs(), minorUnit, `Amount to allocate by ${method}`)

  const isNegativeAmount = amount.isNegative()
  const magnitude = amount.abs()
  const settledMagnitude =
    settlementTarget === undefined
      ? magnitude.roundToMinorUnit(minorUnit)
      : settlementMagnitudeOf(amount, settlementTarget, minorUnit)
  const weights = weighted.map((entry) => entry.weight)

  const capacities =
    capacityByTargetId === undefined
      ? undefined
      : resolveCapacities(weighted, capacityByTargetId, amount.currency, minorUnit)

  const settledShares = exactSharesOf(settledMagnitude, weights, totalWeight, minorUnit)
  const allocatedMagnitudes = distributeByLargestRemainder(
    settledMagnitude,
    settledShares,
    minorUnit,
    capacities,
  )
  const exactShares = exactSharesOf(magnitude, weights, totalWeight, minorUnit)

  const applySign = (value: Money): Money =>
    isNegativeAmount && !value.isZero() ? value.negate() : value

  return {
    method,
    minorUnit,
    exactAmount: amount,
    settledAmount: applySign(settledMagnitude),
    allocations: weighted.map((entry, index) => ({
      targetId: entry.target.id,
      amount: applySign(allocatedMagnitudes[index]!),
      exactAmount: applySign(exactShares[index]!),
    })),
  }
}

/**
 * Validates an explicit settlement target against the amount it settles, and
 * returns the magnitude to distribute.
 *
 * Three things have to hold, and all three are engine invariants rather than
 * user input, so a failure is an assertion: the target is in the same
 * currency; it does not contradict the amount's sign, so re-applying that
 * sign at the end cannot turn a cost into a credit; and it is already settled
 * at this minor unit, since a target carrying sub-minor-unit digits could
 * never be reached by handing out whole minor units.
 *
 * A **zero** target is compatible with any amount: nothing is distributed and
 * no sign is re-applied, which is exactly what an amount smaller than half a
 * minor unit settles to. The reverse — a non-zero target for an amount of
 * zero — is not, because there would be no sign to give the shares.
 */
function settlementMagnitudeOf(amount: Money, settlementTarget: Money, minorUnit: number): Money {
  if (settlementTarget.currency !== amount.currency) {
    throw new CurrencyMismatchError(amount.currency, settlementTarget.currency)
  }

  const signsAgree =
    settlementTarget.isZero() ||
    (!amount.isZero() && settlementTarget.isNegative() === amount.isNegative())
  if (!signsAgree) {
    throw new AllocationInvariantError(
      `Settlement target ${settlementTarget.toDecimalString()} ${settlementTarget.currency} does not share the sign of the ${amount.toDecimalString()} it settles`,
    )
  }

  const magnitude = settlementTarget.abs()
  assertSettleableAtMinorUnit(magnitude, minorUnit, 'Settlement target')
  if (!magnitude.roundToMinorUnit(minorUnit).equals(magnitude)) {
    throw new AllocationInvariantError(
      `Settlement target ${settlementTarget.toDecimalString()} ${settlementTarget.currency} is not settled at ${String(minorUnit)} minor-unit digit(s); allocations are distributed in whole minor units and could never reach it`,
    )
  }
  return magnitude
}

/**
 * Each line's ceiling, in `weighted` order, truncated to whole minor units.
 *
 * The truncation is defensive rather than expected: every capacity the engine
 * supplies is already a settled figure, and a ceiling carrying sub-minor-unit
 * digits could never be reached by handing out whole minor units anyway, so
 * rounding it *up* would be the only way it could ever authorise an extra
 * unit. It cannot.
 */
function resolveCapacities(
  weighted: readonly WeightedTarget[],
  capacityByTargetId: ReadonlyMap<string, Money>,
  currency: CurrencyCode,
  minorUnit: number,
): readonly Money[] {
  return weighted.map((entry) => {
    const capacity = capacityByTargetId.get(entry.target.id)
    if (capacity === undefined) {
      throw new AllocationCapacityError(
        `No settled capacity was supplied for line "${entry.target.id}", so there is no way to tell how much of this amount that line can absorb`,
      )
    }
    if (capacity.currency !== currency) {
      throw new CurrencyMismatchError(currency, capacity.currency)
    }
    if (capacity.isNegative()) {
      throw new AllocationCapacityError(
        `Line "${entry.target.id}" has a negative settled capacity (${capacity.toDecimalString()} ${currency}); a line can never absorb less than nothing`,
      )
    }
    return capacity.truncateToMinorUnit(minorUnit)
  })
}

/** One line's share of an allocated amount, before any settlement boundary. */
export interface ExactAllocationShare {
  readonly targetId: string
  /** Signed, full precision — this line's exact proportion of `amount`. */
  readonly exactAmount: Money
}

/**
 * Each line's **exact** share of `amount`, with nothing settled and nothing
 * distributed.
 *
 * This is the same weighting and the same proportional arithmetic
 * `allocateAmount` runs — `resolveWeighting` and `exactSharesOf` are shared,
 * not reimplemented — stopped one step earlier, at the point where a caller
 * that only has to *check* a share can read it. `allocateAmount` continues
 * from there into largest-remainder distribution, which is presentation work:
 * it decides which line absorbs a leftover minor unit.
 *
 * It exists for the validation-critical discount check
 * (`validateDiscountLineAllocations` in `CostCalculation.ts`), which has to
 * answer "does this discount make a line economically invalid?" *before*, and
 * independently of, whether a per-line breakdown can be produced for the
 * supplier as a whole. Because no settlement happens here, the shares are
 * directly comparable against other exact figures — see the exact-vs-exact
 * rule on `assertDiscountsFitEachLine`.
 *
 * `minorUnit` is still required: it is not a rounding instruction but the
 * scale the proportional division must stay accurate to, so a share this
 * function returns and the share `allocateAmount` computes are the same
 * number.
 *
 * The two unusable-weighting errors (`InvalidAllocationBaseError`,
 * `IncompatibleAllocationUnitsError`) are raised here exactly as they are in
 * `allocateAmount`. What they *mean* differs by caller, so the caller
 * classifies them; this function does not decide.
 */
export function exactAllocationShares(
  amount: Money,
  targets: readonly AllocationTarget[],
  method: AllocationMethod,
  minorUnit: number,
): readonly ExactAllocationShare[] {
  const { weighted, totalWeight } = resolveWeighting(amount, targets, method)
  const isNegativeAmount = amount.isNegative()
  const shares = exactSharesOf(
    amount.abs(),
    weighted.map((entry) => entry.weight),
    totalWeight,
    minorUnit,
  )

  return weighted.map((entry, index) => {
    const share = shares[index]!
    return {
      targetId: entry.target.id,
      exactAmount: isNegativeAmount && !share.isZero() ? share.negate() : share,
    }
  })
}

/**
 * Splits an already-settled `settledTotal` across the exact parts that make
 * it up, so the settled parts sum to exactly `settledTotal`.
 *
 * This is the same largest-remainder distribution `allocateAmount` uses, for
 * a different question. `allocateAmount` spreads a *shared* amount over lines
 * that had nothing to do with producing it, so a zero weighting base means
 * there is no defensible split and the caller is told. Here the total *is*
 * the sum of the parts, so a zero total across zero parts is not an undefined
 * ratio — it is arithmetic, and every part settles to zero.
 */
export function settleTotalAcrossParts(
  settledTotal: Money,
  exactParts: readonly Money[],
  minorUnit: number,
): readonly Money[] {
  const currency = settledTotal.currency
  if (exactParts.length === 0) {
    if (!settledTotal.isZero()) {
      throw new AllocationInvariantError(
        `Cannot settle ${settledTotal.toDecimalString()} ${currency} across zero parts`,
      )
    }
    return []
  }

  assertSettleableAtMinorUnit(settledTotal.abs(), minorUnit, 'Total to settle across its parts')

  const weights = exactParts.map((part) => {
    if (part.currency !== currency) {
      throw new CurrencyMismatchError(currency, part.currency)
    }
    if (part.isNegative()) {
      throw new AllocationInvariantError(
        `Cannot settle a total across a negative part (${part.toDecimalString()} ${currency})`,
      )
    }
    return parseExactDecimal(part.toDecimalString())
  })
  const totalWeight = weights.reduce<Decimal>((sum, weight) => addExact(sum, weight), ZERO_DECIMAL)

  if (totalWeight.isZero()) {
    if (!settledTotal.isZero()) {
      throw new AllocationInvariantError(
        `Cannot settle ${settledTotal.toDecimalString()} ${currency} across parts that are all zero`,
      )
    }
    return exactParts.map(() => Money.zero(currency))
  }

  const isNegativeTotal = settledTotal.isNegative()
  const magnitude = settledTotal.abs()
  const shares = exactSharesOf(magnitude, weights, totalWeight, minorUnit)
  const settledMagnitudes = distributeByLargestRemainder(magnitude, shares, minorUnit)
  return settledMagnitudes.map((value) =>
    isNegativeTotal && !value.isZero() ? value.negate() : value,
  )
}

/** Sums allocation amounts. Zero for an empty list, in `currency`. */
export function sumAllocations(allocations: readonly Allocation[], currency: string): Money {
  return allocations.reduce((sum, allocation) => sum.add(allocation.amount), Money.zero(currency))
}

/**
 * Each line's exact proportional share of `magnitude`, at a precision derived
 * from the operands rather than the default significant-digit budget. The
 * shares are read at minor-unit scale by the truncation step below, so a
 * share computed at too few digits would truncate to the wrong minor unit and
 * the distribution would fail to add up.
 */
function exactSharesOf(
  magnitude: Money,
  weights: readonly Decimal[],
  totalWeight: Decimal,
  minorUnit: number,
): readonly Money[] {
  const total = parseExactDecimal(magnitude.toDecimalString())
  return weights.map((weight) =>
    Money.fromString(proportionalShare(total, weight, totalWeight, minorUnit).toFixed(), magnitude.currency),
  )
}

/**
 * The largest-remainder step itself, shared by both callers: truncate every
 * share down to the minor unit, then hand the leftover out one minor unit at
 * a time, largest truncated-away fraction first.
 *
 * The leftover is derived from the settled total, not from the sum of the
 * exact shares, so a share that cannot be represented exactly (1/3, say)
 * cannot leak a lost minor unit into the result. Returns magnitudes in the
 * caller's original order.
 *
 * **Capacities**, when supplied, are per-line ceilings on the magnitude a
 * line may be handed, in the same order. They change two things and nothing
 * else: a truncated share above a line's ceiling is capped at it, and a line
 * with no room left is skipped when the leftover is handed out. The total
 * distributed is still exactly `settledMagnitude` — a unit a line cannot take
 * is placed on the next line that can, never dropped.
 */
function distributeByLargestRemainder(
  settledMagnitude: Money,
  exactShares: readonly Money[],
  minorUnit: number,
  capacities?: readonly Money[],
): readonly Money[] {
  const currency = settledMagnitude.currency
  const step = minorUnitStep(minorUnit, currency)

  const slots = exactShares.map<AllocationSlot>((share, order) => {
    const truncated = share.truncateToMinorUnit(minorUnit)
    const capacity = capacities?.[order]
    return {
      order,
      remainder: share.subtract(truncated),
      capacity,
      allocated: capacity !== undefined && truncated.isGreaterThan(capacity) ? capacity : truncated,
    }
  })

  let undistributed = settledMagnitude.subtract(
    slots.reduce((sum, slot) => sum.add(slot.allocated), Money.zero(currency)),
  )
  if (undistributed.isNegative()) {
    throw new AllocationInvariantError(
      `Allocation of ${settledMagnitude.toDecimalString()} ${currency} over-distributed by ${undistributed.abs().toDecimalString()}`,
    )
  }

  // One pass is the classic hand-out: at most one extra minor unit per line.
  // Unconstrained that is always enough, because each truncation loses less
  // than a whole minor unit and so there are fewer units left over than
  // lines. Capping a share at a line's ceiling can leave more over than that,
  // so a constrained distribution keeps passing over the lines that still
  // have room until nothing is left. Without capacities the loop runs exactly
  // once, and the result is what it has always been.
  const ordered = orderByLargestRemainder(slots)
  do {
    let placed = false
    for (const slot of ordered) {
      if (undistributed.isZero()) {
        break
      }
      if (slot.capacity !== undefined && slot.allocated.add(step).isGreaterThan(slot.capacity)) {
        continue
      }
      slot.allocated = slot.allocated.add(step)
      undistributed = undistributed.subtract(step)
      placed = true
    }
    if (!placed) {
      break
    }
  } while (capacities !== undefined && !undistributed.isZero())

  if (!undistributed.isZero()) {
    if (capacities === undefined) {
      throw new AllocationInvariantError(
        `Allocation of ${settledMagnitude.toDecimalString()} ${currency} left ${undistributed.toDecimalString()} undistributed across ${String(slots.length)} line(s)`,
      )
    }
    throw new AllocationCapacityError(
      `Allocation of ${settledMagnitude.toDecimalString()} ${currency} left ${undistributed.toDecimalString()} that no line can absorb: the ${String(slots.length)} line(s) have no settled capacity for it, and placing it anyway would show a line below zero`,
    )
  }

  return slots.map((slot) => slot.allocated)
}

interface AllocationSlot {
  readonly order: number
  readonly remainder: Money
  /** Ceiling on this line's magnitude, or `undefined` when unconstrained. */
  readonly capacity: Money | undefined
  allocated: Money
}

interface WeightedTarget {
  readonly target: AllocationTarget
  readonly weight: Decimal
}

const ZERO_DECIMAL = parseExactDecimal('0')
const ONE_DECIMAL = parseExactDecimal('1')

/**
 * The weighting side of an allocation, and the only place the three "there is
 * no defensible split" conditions live: no lines at all, a total weight of
 * zero, or a weighting the method cannot express over these lines (mixed
 * comparison units, mixed currencies). Shared by `allocateAmount` and
 * `exactAllocationShares` so the two can never disagree about whether a
 * weighting exists.
 */
function resolveWeighting(
  amount: Money,
  targets: readonly AllocationTarget[],
  method: AllocationMethod,
): { weighted: readonly WeightedTarget[]; totalWeight: Decimal } {
  if (targets.length === 0) {
    throw new InvalidAllocationBaseError(
      `Cannot allocate ${amount.toDecimalString()} ${amount.currency} by ${method}: there are no lines to allocate onto`,
    )
  }

  const weighted = resolveWeights(targets, method)
  const totalWeight = weighted.reduce<Decimal>(
    (sum, entry) => addExact(sum, entry.weight),
    ZERO_DECIMAL,
  )

  if (totalWeight.isZero()) {
    throw new InvalidAllocationBaseError(
      `Cannot allocate by ${method}: the allocation base is zero across all ${String(targets.length)} line(s)`,
    )
  }

  return { weighted, totalWeight }
}

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
