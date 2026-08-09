import { parseExactDecimal, type Decimal } from '../monetary/decimal'

/** Deterministic, JSON-safe representation of a Quantity value. */
export interface QuantitySnapshot {
  readonly value: string
}

export class InvalidQuantityError extends Error {
  constructor(value: string) {
    super(`Invalid quantity: "${value}" (must be a non-negative decimal)`)
    this.name = 'InvalidQuantityError'
  }
}

/**
 * Immutable exact-decimal quantity. Used anywhere a count of units needs
 * decimal precision (required quantity, order quantity, MOQ, pack size) so
 * calculation phases never fall back to native `number` arithmetic.
 *
 * This type intentionally carries no notion of "required" vs "actual order"
 * vs "MOQ" — those remain distinct concepts at the calculation level
 * (`src/calculation/QuantityResolution.ts`, Phase 3); Quantity is just the
 * decimal-safe value each of them is made of, plus the small set of
 * arithmetic operations (`max`, `multiply`, `subtract`, `ceilDivide`) that
 * quantity resolution needs without ever falling back to native `number`.
 */
export class Quantity {
  private readonly value: Decimal

  private constructor(value: Decimal) {
    this.value = value
  }

  static fromString(value: string): Quantity {
    const decimal = parseExactDecimal(value)
    if (decimal.isNegative()) {
      throw new InvalidQuantityError(value)
    }
    return new Quantity(decimal)
  }

  static fromJSON(snapshot: QuantitySnapshot): Quantity {
    return Quantity.fromString(snapshot.value)
  }

  isZero(): boolean {
    return this.value.isZero()
  }

  compareTo(other: Quantity): number {
    return this.value.comparedTo(other.value)
  }

  equals(other: Quantity): boolean {
    return this.value.equals(other.value)
  }

  /** The greater of the two quantities (ties return `this`). Used for MOQ resolution. */
  max(other: Quantity): Quantity {
    return this.compareTo(other) >= 0 ? this : other
  }

  /** Exact-decimal multiplication (e.g. a whole quoted-unit count by its pack size). */
  multiply(other: Quantity): Quantity {
    return new Quantity(this.value.times(other.value))
  }

  /**
   * Exact-decimal subtraction. Throws `InvalidQuantityError` if the result
   * would be negative — Quantity has no negative representation.
   */
  subtract(other: Quantity): Quantity {
    const result = this.value.minus(other.value)
    if (result.isNegative()) {
      throw new InvalidQuantityError(result.toFixed())
    }
    return new Quantity(result)
  }

  /**
   * Divides by `divisor` and rounds up to the nearest whole quantity — the
   * smallest whole `n` such that `n * divisor >= this`. Used to convert a
   * comparison-unit quantity into a whole quoted-unit (pack) count, since a
   * fractional pack cannot be ordered. Uses decimal.js's `.ceil()`, which
   * always rounds toward +Infinity regardless of the library's configured
   * rounding mode — never native `Math.ceil()` — so whole-pack rounding
   * stays on the exact-decimal foundation.
   */
  ceilDivide(divisor: Quantity): Quantity {
    return new Quantity(this.value.dividedBy(divisor.value).ceil())
  }

  toDecimalString(): string {
    return this.value.toFixed()
  }

  toJSON(): QuantitySnapshot {
    return { value: this.toDecimalString() }
  }
}
