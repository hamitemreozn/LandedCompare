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
 * vs "MOQ" — those remain distinct concepts at the entity level (Phase 3);
 * Quantity is just the decimal-safe value each of them will be made of.
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

  toDecimalString(): string {
    return this.value.toFixed()
  }

  toJSON(): QuantitySnapshot {
    return { value: this.toDecimalString() }
  }
}
