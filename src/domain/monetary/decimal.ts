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
const ExactDecimal = Decimal.clone({
  precision: 34,
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
