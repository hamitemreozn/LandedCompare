import { parseExactDecimal, type Decimal } from '../domain/monetary/decimal'
import type { Money } from '../domain/monetary/Money'

export class InvalidPercentageError extends Error {
  constructor(value: string, reason: string) {
    super(`Invalid percentage: "${value}" (${reason})`)
    this.name = 'InvalidPercentageError'
  }
}

const ONE_HUNDRED = parseExactDecimal('100')

/**
 * An exact-decimal percentage in the single, fixed convention used everywhere
 * in this application:
 *
 *     "5" means 5% — the applied factor is 5 / 100 = 0.05
 *
 * The alternative convention (`"0.05"` meaning 5%) is deliberately **not**
 * supported anywhere. Accepting both would make `0.05` ambiguous between
 * 5% and 0.05%, a 100x error in a duty or discount, with no way for the
 * engine to tell which the user meant.
 *
 * Validation is intentionally asymmetric and documented in
 * docs/CALCULATION_RULES.md:
 * - malformed input surfaces Phase 1's `InvalidDecimalError`;
 * - a negative percentage is rejected — a "negative cost" must be expressed
 *   as a discount instead;
 * - **zero is accepted.** A 0% duty is a real business statement ("this line
 *   is duty-free"), and rejecting it would force the user to delete the cost
 *   line and lose the information that duty was considered at all;
 * - no upper bound is imposed here. A >100% surcharge is unusual but not
 *   nonsense, and Phase 2 already established that this engine does not
 *   invent bounds. The one real upper bound — a percentage *discount* above
 *   100% — is enforced where discount semantics live
 *   (`AdditionalCost.ts`), not here.
 */
export class Percentage {
  private readonly rate: Decimal

  private constructor(rate: Decimal) {
    this.rate = rate
  }

  static fromString(value: string): Percentage {
    const rate = parseExactDecimal(value)
    if (rate.isNegative() && !rate.isZero()) {
      throw new InvalidPercentageError(value, 'must not be negative; express a reduction as a discount')
    }
    return new Percentage(rate)
  }

  isZero(): boolean {
    return this.rate.isZero()
  }

  /** True if this percentage exceeds 100%. Used by the discount rule. */
  exceedsOneHundred(): boolean {
    return this.rate.comparedTo(ONE_HUNDRED) > 0
  }

  /** Canonical percentage string as entered, e.g. "5" for 5%. */
  toDecimalString(): string {
    return this.rate.toFixed()
  }

  /**
   * The multiplication factor, e.g. "0.05" for 5%. Dividing by 100 is a pure
   * exponent shift in base 10, so this conversion is exact for any decimal
   * rate — no precision is lost before the multiplication.
   */
  toFactorString(): string {
    return this.rate.dividedBy(ONE_HUNDRED).toFixed()
  }

  /**
   * `base x rate / 100`, exact. No minor-unit rounding is applied — a
   * percentage cost stays at full calculation precision like every other
   * Phase 2/4 intermediate value.
   */
  applyTo(base: Money): Money {
    return base.multiply(this.toFactorString())
  }
}
