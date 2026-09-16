import {
  addExact,
  exceedsSettlementPrecision,
  multiplyExact,
  parseExactDecimal,
  roundHalfUp,
  subtractExact,
  truncateTowardZero,
  type Decimal,
} from './decimal'
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

  /**
   * Exact sum. `addExact` rather than `Decimal#plus` because the plain
   * operator rounds its result to the configured significant-digit budget:
   * adding a cent to a thirty-digit total used to return the total unchanged.
   * See the derived-precision section of `decimal.ts`.
   */
  add(other: Money): Money {
    this.assertSameCurrency(other)
    return new Money(addExact(this.amount, other.amount), this.currencyCode)
  }

  /** Exact difference, for the same reason as `add`. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other)
    return new Money(subtractExact(this.amount, other.amount), this.currencyCode)
  }

  /**
   * Scales the amount by an exact decimal factor. No rounding is applied —
   * and, since the product is evaluated at a precision derived from both
   * operands, none happens implicitly either. This is the operation a
   * percentage cost and an FX conversion are both built on, so a product
   * truncated here would surface as a wrong cent with no other symptom.
   */
  multiply(factor: string): Money {
    return new Money(multiplyExact(this.amount, parseExactDecimal(factor)), this.currencyCode)
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

  /**
   * True when this amount is too large to be settled exactly at
   * `minorUnitDigits` under the configured decimal precision — see
   * `exceedsSettlementPrecision` in `decimal.ts`. Callers use it to reject
   * such an amount explicitly instead of letting a later sum silently lose a
   * minor unit. Exposed as a method so the internal `Decimal` stays private.
   */
  exceedsSettlementPrecision(minorUnitDigits: number): boolean {
    return exceedsSettlementPrecision(this.amount, minorUnitDigits)
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
