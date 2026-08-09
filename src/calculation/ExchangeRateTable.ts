import { parseCurrencyCode, type CurrencyCode } from '../domain/monetary/CurrencyCode'
import { CurrencyMismatchError } from '../domain/monetary/Money'
import { ExchangeRate } from './ExchangeRate'

export class MissingExchangeRateError extends Error {
  constructor(fromCurrency: CurrencyCode, toCurrency: CurrencyCode) {
    super(`Missing exchange rate from "${fromCurrency}" to "${toCurrency}"`)
    this.name = 'MissingExchangeRateError'
  }
}

/**
 * The manual exchange rates available for one project, all converting
 * directly into a single project base currency — there is no cross-rate
 * graph/FX matrix in this MVP. Every non-base quote currency needs its own
 * direct entry here (see docs/CALCULATION_RULES.md).
 *
 * If more than one rate is given for the same `fromCurrency`, the last one
 * wins — this mirrors ordinary object/map construction and is a
 * table-building convenience, not a calculation fallback.
 */
export class ExchangeRateTable {
  private readonly base: CurrencyCode
  private readonly ratesByFromCurrency: ReadonlyMap<CurrencyCode, ExchangeRate>

  private constructor(base: CurrencyCode, ratesByFromCurrency: ReadonlyMap<CurrencyCode, ExchangeRate>) {
    this.base = base
    this.ratesByFromCurrency = ratesByFromCurrency
  }

  static create(baseCurrency: string, rates: readonly ExchangeRate[] = []): ExchangeRateTable {
    const base = parseCurrencyCode(baseCurrency)
    const map = new Map<CurrencyCode, ExchangeRate>()
    for (const rate of rates) {
      if (rate.toCurrency !== base) {
        throw new CurrencyMismatchError(rate.toCurrency, base)
      }
      map.set(rate.fromCurrency, rate)
    }
    return new ExchangeRateTable(base, map)
  }

  get baseCurrency(): CurrencyCode {
    return this.base
  }

  /** Throws `MissingExchangeRateError` if no rate from `fromCurrency` was provided. */
  getRate(fromCurrency: string): ExchangeRate {
    const from = parseCurrencyCode(fromCurrency)
    const rate = this.ratesByFromCurrency.get(from)
    if (!rate) {
      throw new MissingExchangeRateError(from, this.base)
    }
    return rate
  }
}
