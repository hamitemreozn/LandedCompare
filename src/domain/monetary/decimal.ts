import Decimal from 'decimal.js'

// Single point of configuration for the decimal library. Nothing else in the
// domain layer should configure decimal.js directly.
//
// `Decimal.clone(...)` (rather than mutating `Decimal.set(...)` on the
// shared package export) creates a constructor whose configuration is
// isolated: no other consumer of the `decimal.js` package can change
// LandedCompare's precision/rounding by calling `.set()` on their own
// import, and this configuration cannot leak out and affect them either.
//
// Precision is set high (34 significant digits, on par with IEEE 754
// decimal128) so that intermediate calculations in later phases
// (proportional allocation, exchange rate application) are calculated under
// that configured precision rather than losing digits before a deliberate
// rounding boundary is reached. This is *not* unlimited/infinite-precision
// arithmetic — it is exact base-10 input representation combined with
// deterministic decimal arithmetic evaluated at a fixed, generous precision.
// Business rounding boundaries (e.g. rounding a final total to a currency's
// minor unit) are a separate decision, defined per calculation in Phase 2+
// (see docs/CALCULATION_RULES.md), not applied here.
// `toExpNeg`/`toExpPos` are widened so `toString()`/`toFixed()` never switch
// to exponential notation for realistic monetary magnitudes, which keeps
// serialized output readable and diff-friendly.
/**
 * Significant digits every ordinary operation is evaluated at. Exported
 * because it is not a private tuning knob: it is the boundary that decides
 * which amounts this engine can settle exactly, and callers derive explicit
 * preconditions from it rather than discovering it as a rounding surprise.
 */
export const DECIMAL_PRECISION = 34

const ExactDecimal = Decimal.clone({
  precision: DECIMAL_PRECISION,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
})

// Only the type is exported. The configured constructor stays private to
// this module so every Decimal value entering the domain layer is forced
// through `parseExactDecimal` below — there is no public `new Decimal(...)`
// entry point that would accept a raw JS `number` (and therefore a value
// that may already have passed through native binary floating-point
// arithmetic, e.g. the result of `0.1 + 0.2`) without going through the
// string-parsing and validation this module performs.
export type { Decimal } from 'decimal.js'

export class InvalidDecimalError extends Error {
  constructor(value: unknown) {
    super(`Invalid decimal value: "${String(value)}"`)
    this.name = 'InvalidDecimalError'
  }
}

/**
 * Parses a canonical decimal string into an exact Decimal. Deliberately
 * typed and runtime-checked to accept only `string` — a raw JS `number`
 * (which may already carry binary floating-point error, e.g. `0.1 + 0.2`)
 * is rejected rather than silently coerced. Also rejects empty/malformed
 * input, NaN, and Infinity so callers never silently receive a non-finite
 * monetary value.
 */
export function parseExactDecimal(value: string): Decimal {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidDecimalError(value)
  }

  let decimal: Decimal
  try {
    decimal = new ExactDecimal(value)
  } catch {
    throw new InvalidDecimalError(value)
  }

  if (!decimal.isFinite()) {
    throw new InvalidDecimalError(value)
  }

  return decimal
}

/**
 * Rounds to `decimalPlaces` using half-up (0.005 → 0.01). This is the only
 * place a rounding *mode* is named outside the configuration above, so the
 * settlement behaviour of the whole application is decided here rather than
 * per call site. Half-up is the commercial-invoicing convention this product
 * targets; it is deliberately not banker's rounding, which would make an
 * allocation's remainder depend on the parity of the digit before it.
 *
 * `decimalPlaces` is a *scale* (a count of digits), not a financial value, so
 * a native `number` is the correct type here — no exact-decimal guarantee is
 * being weakened.
 */
export function roundHalfUp(value: Decimal, decimalPlaces: number): Decimal {
  return value.toDecimalPlaces(decimalPlaces, ExactDecimal.ROUND_HALF_UP)
}

/**
 * Truncates toward zero at `decimalPlaces` (0.019 → 0.01, -0.019 → -0.01).
 * Used as the "floor" step of largest-remainder allocation; see
 * docs/CALCULATION_RULES.md. Allocation only ever applies it to non-negative
 * magnitudes, where truncation toward zero and flooring coincide.
 */
export function truncateTowardZero(value: Decimal, decimalPlaces: number): Decimal {
  return value.toDecimalPlaces(decimalPlaces, ExactDecimal.ROUND_DOWN)
}

// ---------------------------------------------------------------------------
// Derived-precision arithmetic
// ---------------------------------------------------------------------------
//
// `DECIMAL_PRECISION` bounds *every* decimal.js operation, not just the final
// result: `a.times(b)`, `a.dividedBy(b)` and even `a.plus(b)` round their
// result to that many significant digits. Parsing does not — a string keeps
// all of its digits — so a value can enter the domain layer exactly and then
// lose digits on its first operation.
//
// Every operation the monetary pipeline depends on is therefore evaluated on
// a constructor whose precision is derived from the operands themselves, so
// the result is exact — or, for a division that cannot terminate, accurate
// far beyond the digit the subsequent ceiling or truncation reads. This is
// not "infinite precision": it is a per-operation precision computed from a
// provable bound on how many digits that specific operation needs, and for
// ordinary business magnitudes the bound sits below `DECIMAL_PRECISION`, so
// nothing extra is allocated.
//
// The distinction that matters: `DECIMAL_PRECISION` still defines the
// **settlement envelope** (`exceedsSettlementPrecision`), the range of
// amounts this engine promises to settle at a currency's minor unit. Derived
// precision makes the arithmetic *inside* that envelope truthful; it does not
// widen the envelope, and the envelope is not a limit on intermediate digits.
//
// Clones are cached because `Decimal.clone` builds a whole constructor, and
// realistic inputs hit only a handful of distinct precisions.

const PRECISION_GUARD_DIGITS = 10

type ExactDecimalConstructor = typeof ExactDecimal

const constructorsByPrecision = new Map<number, ExactDecimalConstructor>()

function decimalAt(requiredPrecision: number): ExactDecimalConstructor {
  const precision = Math.max(DECIMAL_PRECISION, Math.ceil(requiredPrecision))
  if (precision === DECIMAL_PRECISION) {
    return ExactDecimal
  }
  const cached = constructorsByPrecision.get(precision)
  if (cached !== undefined) {
    return cached
  }
  const created = ExactDecimal.clone({ precision })
  constructorsByPrecision.set(precision, created)
  return created
}

/**
 * Digits before the decimal point (at least 1, so `0.5` counts as one).
 * `Decimal#e` is the base-10 exponent of the normalised value, which is the
 * cheap way to ask this without materialising the digit string.
 */
function integerDigitsOf(value: Decimal): number {
  if (value.isZero()) {
    return 1
  }
  return Math.max(1, value.e + 1)
}

/** Every digit that has to be represented: integer part plus decimal places. */
function totalDigitsOf(value: Decimal): number {
  return integerDigitsOf(value) + Math.max(0, value.decimalPlaces())
}

/**
 * `a × b`, exact. A product of two exact decimals needs at most
 * `significantDigits(a) + significantDigits(b)` digits, so that precision
 * makes the multiplication lossless for any pair of operands.
 */
export function multiplyExact(a: Decimal, b: Decimal): Decimal {
  const Ctor = decimalAt(a.precision() + b.precision())
  return new Ctor(a).times(new Ctor(b))
}

/**
 * Precision that makes `a ± b` exact: the sum spans the widest integer part
 * and the longest decimal tail of the two operands, plus one digit for the
 * carry an addition can produce (`9.9 + 0.1`).
 */
function additivePrecisionOf(a: Decimal, b: Decimal): number {
  return (
    Math.max(integerDigitsOf(a), integerDigitsOf(b)) +
    Math.max(a.decimalPlaces(), b.decimalPlaces()) +
    1
  )
}

/**
 * `a + b`, exact. Adding two exact decimals is lossless as soon as the result
 * has room for every digit either operand occupies — see
 * `additivePrecisionOf`. At the default budget it is not: `plus` rounds its
 * result like any other operation, so a small amount added to a large one
 * silently disappears.
 */
export function addExact(a: Decimal, b: Decimal): Decimal {
  const Ctor = decimalAt(additivePrecisionOf(a, b))
  return new Ctor(a).plus(new Ctor(b))
}

/**
 * `a − b`, exact. Same bound as `addExact`, for the same reason.
 */
export function subtractExact(a: Decimal, b: Decimal): Decimal {
  const Ctor = decimalAt(additivePrecisionOf(a, b))
  return new Ctor(a).minus(new Ctor(b))
}

/**
 * `value / 10^exponent`, exact. Dividing by a power of ten in base 10 moves
 * the decimal point and changes nothing else: the quotient has exactly the
 * same significant digits as `value`, so evaluating the division at
 * `value.precision()` digits cannot round anything away. It is spelled as a
 * division rather than as exponent surgery so it stays inside decimal.js's
 * own normalisation rules, but it is a shift, and it is free.
 *
 * `exponent` is a digit count, not a financial value, so a native `number` is
 * the right type.
 */
export function divideByPowerOfTenExact(value: Decimal, exponent: number): Decimal {
  const Ctor = decimalAt(value.precision())
  return new Ctor(value).dividedBy(new Ctor(10).toPower(exponent))
}

/**
 * The smallest whole number `n` with `n × divisor >= numerator`, computed so
 * the ceiling is correct rather than a ceiling of an already-rounded quotient.
 *
 * Why the precision bound works. Write the operands as integers over powers
 * of ten, `a = A/10^p` and `b = B/10^q`. If `a / b` *is* a whole number, that
 * number has at most `totalDigits(a) + totalDigits(b)` digits, so the chosen
 * precision represents it exactly and the quotient is not perturbed off the
 * integer. If it is *not* a whole number, its distance to the nearest whole
 * number is at least `1/B`, i.e. at least `10^-totalDigits(b)`, while the
 * division error is smaller than that by the guard digits — so the quotient
 * stays strictly inside the same pair of integers and rounds up to the same
 * one. Either way `.ceil()` sees the truth. (`.ceil()` itself is a rounding
 * operation on the value, not a precision-bounded arithmetic step.)
 */
export function divideCeil(numerator: Decimal, divisor: Decimal): Decimal {
  const Ctor = decimalAt(
    totalDigitsOf(numerator) + totalDigitsOf(divisor) + PRECISION_GUARD_DIGITS,
  )
  return new Ctor(numerator).dividedBy(new Ctor(divisor)).ceil()
}

/**
 * `total × weight / totalWeight`, evaluated accurately enough that truncating
 * the result at `decimalPlaces` gives the same answer the exact rational
 * would. The share is only ever *read* at that scale (largest-remainder
 * allocation truncates it), so the bound covers the integer part, the minor
 * unit, and enough extra digits to separate the true value from a truncation
 * boundary it is not actually sitting on.
 */
export function proportionalShare(
  total: Decimal,
  weight: Decimal,
  totalWeight: Decimal,
  decimalPlaces: number,
): Decimal {
  const Ctor = decimalAt(
    totalDigitsOf(total) +
      totalDigitsOf(weight) +
      totalDigitsOf(totalWeight) +
      decimalPlaces +
      PRECISION_GUARD_DIGITS,
  )
  return new Ctor(total).times(new Ctor(weight)).dividedBy(new Ctor(totalWeight))
}

/**
 * True when settling `value` at `decimalPlaces` would need more significant
 * digits than `DECIMAL_PRECISION` — i.e. the settled amount is not exactly
 * representable, so the sums built from it (allocation reconciliation, a
 * settled landed total) cannot be trusted to the minor unit.
 *
 * This is a *derived* bound, read straight off the decimal configuration, in
 * the same spirit as `MAX_MINOR_UNIT_DIGITS` in
 * `src/calculation/CurrencyMinorUnit.ts`. It is not a commercial maximum
 * amount, and no such maximum is invented anywhere in this engine.
 */
export function exceedsSettlementPrecision(value: Decimal, decimalPlaces: number): boolean {
  return integerDigitsOf(value) + decimalPlaces > DECIMAL_PRECISION
}
