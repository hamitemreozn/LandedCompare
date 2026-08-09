import { parseExactDecimal, type Decimal } from '../domain/monetary/decimal'
import { parseCurrencyCode, type CurrencyCode } from '../domain/monetary/CurrencyCode'

/** Deterministic, JSON-safe representation of an ExchangeRate value. */
export interface ExchangeRateSnapshot {
  readonly fromCurrency: string
  readonly toCurrency: string
  readonly rate: string
}

export class InvalidExchangeRateError extends Error {
  constructor(value: string) {
    super(`Invalid exchange rate: "${value}" (must be a positive decimal)`)
    this.name = 'InvalidExchangeRateError'
  }
}

/**
 * A manual exchange rate in the fixed direction `1 fromCurrency = rate
 * toCurrency` (e.g. fromCurrency "USD", toCurrency "TRY", rate "43.50" means
 * 1 USD = 43.50 TRY). There is no inverse/cross-rate derivation anywhere in
 * this domain — a rate is only usable in the direction it was declared.
 *
 * Malformed decimal strings surface Phase 1's `InvalidDecimalError` (via
 * `parseExactDecimal`); only well-formed but non-positive values (zero or
 * negative) surface `InvalidExchangeRateError`.
 */
export class ExchangeRate {
  private readonly from: CurrencyCode
  private readonly to: CurrencyCode
  private readonly rateValue: Decimal

  private constructor(from: CurrencyCode, to: CurrencyCode, rateValue: Decimal) {
    this.from = from
    this.to = to
    this.rateValue = rateValue
  }

  static fromString(fromCurrency: string, toCurrency: string, rate: string): ExchangeRate {
    const decimalRate = parseExactDecimal(rate)
    if (decimalRate.isZero() || decimalRate.isNegative()) {
      throw new InvalidExchangeRateError(rate)
    }
    return new ExchangeRate(
      parseCurrencyCode(fromCurrency),
      parseCurrencyCode(toCurrency),
      decimalRate,
    )
  }

  static fromJSON(snapshot: ExchangeRateSnapshot): ExchangeRate {
    return ExchangeRate.fromString(snapshot.fromCurrency, snapshot.toCurrency, snapshot.rate)
  }

  get fromCurrency(): CurrencyCode {
    return this.from
  }

  get toCurrency(): CurrencyCode {
    return this.to
  }

  /** Canonical exact decimal string of the rate, e.g. "43.5". Never exponential notation. */
  toDecimalString(): string {
    return this.rateValue.toFixed()
  }

  toJSON(): ExchangeRateSnapshot {
    return { fromCurrency: this.from, toCurrency: this.to, rate: this.toDecimalString() }
  }
}
