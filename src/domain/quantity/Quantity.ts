import {
  divideCeil,
  multiplyExact,
  parseExactDecimal,
  subtractExact,
  type Decimal,
} from '../monetary/decimal'

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

  /**
   * Exact-decimal multiplication (e.g. a whole quoted-unit count by its pack
   * size). Evaluated at a precision derived from the operands, so a large
   * quantity does not lose its last digits to the default significant-digit
   * budget — `resolvedQuantity = quotedUnitQuantity × unitsPerQuotedUnit`
   * has to be exact for the excess-quantity invariant to hold.
   */
  multiply(other: Quantity): Quantity {
    return new Quantity(multiplyExact(this.value, other.value))
  }

  /**
   * Exact-decimal subtraction. Throws `InvalidQuantityError` if the result
   * would be negative — Quantity has no negative representation.
   */
  subtract(other: Quantity): Quantity {
    const result = subtractExact(this.value, other.value)
    if (result.isNegative()) {
      throw new InvalidQuantityError(result.toFixed())
    }
    return new Quantity(result)
  }

  /**
   * Divides by `divisor` and rounds up to the nearest whole quantity — the
   * smallest whole `n` such that `n * divisor >= this`. Used to convert a
   * comparison-unit quantity into a whole quoted-unit (pack) count, since a
   * fractional pack cannot be ordered.
   *
   * The division is evaluated at a precision derived from the operands
   * (`divideCeil`), because rounding the *quotient* to the default
   * significant-digit budget first and only then taking the ceiling can move
   * the answer a whole pack in either direction. The ceiling itself is
   * decimal.js's `.ceil()` — always toward +Infinity, regardless of the
   * configured rounding mode, and never native `Math.ceil()`.
   */
  ceilDivide(divisor: Quantity): Quantity {
    if (divisor.isZero()) {
      throw new InvalidQuantityError('0 (cannot divide a quantity by zero)')
    }
    return new Quantity(divideCeil(this.value, divisor.value))
  }

  toDecimalString(): string {
    return this.value.toFixed()
  }

  toJSON(): QuantitySnapshot {
    return { value: this.toDecimalString() }
  }
}
