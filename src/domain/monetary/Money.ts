import { parseExactDecimal, roundHalfUp, truncateTowardZero, type Decimal } from './decimal'
import { parseCurrencyCode, type CurrencyCode } from './CurrencyCode'

/**
 * Deterministic, JSON-safe representation of a Money value. This — not the
 * internal Decimal instance — is the persistence/serialization contract.
 */
export interface MoneySnapshot {
  readonly amount: string
  readonly currency: string
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: cannot combine "${a}" with "${b}"`)
    this.name = 'CurrencyMismatchError'
  }
}

/**
 * Immutable exact-decimal monetary amount tied to a currency. This is the
 * only vocabulary the domain layer uses for money — no raw numbers.
 */
export class Money {
  private readonly amount: Decimal
  private readonly currencyCode: CurrencyCode

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.amount = amount
    this.currencyCode = currency
  }

  static fromString(amount: string, currency: string): Money {
    return new Money(parseExactDecimal(amount), parseCurrencyCode(currency))
  }

  static zero(currency: string): Money {
    return Money.fromString('0', currency)
  }

  static fromJSON(snapshot: MoneySnapshot): Money {
    return Money.fromString(snapshot.amount, snapshot.currency)
  }

  get currency(): CurrencyCode {
    return this.currencyCode
  }

  add(other: Money): Money {
    this.assertSameCurrency(other)
    return new Money(this.amount.plus(other.amount), this.currencyCode)
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other)
    return new Money(this.amount.minus(other.amount), this.currencyCode)
  }

  /** Scales the amount by an exact decimal factor. No rounding is applied. */
  multiply(factor: string): Money {
    return new Money(this.amount.times(parseExactDecimal(factor)), this.currencyCode)
  }

  compareTo(other: Money): number {
    this.assertSameCurrency(other)
    return this.amount.comparedTo(other.amount)
  }

  equals(other: Money): boolean {
    return this.currencyCode === other.currencyCode && this.amount.equals(other.amount)
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0
  }

  isZero(): boolean {
    return this.amount.isZero()
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero()
  }

  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero()
  }

  /**
   * Magnitude, discarding the sign. Phase 4's allocator runs entirely on
   * magnitudes and re-applies the sign at the end, so "largest remainder"
   * always means the same thing regardless of whether the amount being
   * allocated is a cost (positive) or a discount (negative).
   */
  abs(): Money {
    return new Money(this.amount.abs(), this.currencyCode)
  }

  /** Sign flip. Used to turn a discount's positive magnitude into its negative effect. */
  negate(): Money {
    return new Money(this.amount.negated(), this.currencyCode)
  }

  /**
   * Rounds to a currency's minor-unit precision (half-up), e.g. 2 for TRY.
   * This is a deliberate *settlement* boundary — Phase 1's rule that
   * arithmetic never rounds still holds for `add`/`subtract`/`multiply`; this
   * method exists so a calculation can round explicitly, at a boundary it
   * names. See docs/CALCULATION_RULES.md for where Phase 4 applies it.
   *
   * `minorUnitDigits` is a scale (digit count), not a monetary value.
   */
  roundToMinorUnit(minorUnitDigits: number): Money {
    return new Money(roundHalfUp(this.amount, minorUnitDigits), this.currencyCode)
  }

  /** Truncates toward zero at a currency's minor-unit precision. The "floor" step of allocation. */
  truncateToMinorUnit(minorUnitDigits: number): Money {
    return new Money(truncateTowardZero(this.amount, minorUnitDigits), this.currencyCode)
  }

  /** Canonical exact decimal string, e.g. "0.0047". Never exponential notation. */
  toDecimalString(): string {
    return this.amount.toFixed()
  }

  toJSON(): MoneySnapshot {
    return { amount: this.toDecimalString(), currency: this.currencyCode }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currencyCode !== other.currencyCode) {
      throw new CurrencyMismatchError(this.currencyCode, other.currencyCode)
    }
  }
}
