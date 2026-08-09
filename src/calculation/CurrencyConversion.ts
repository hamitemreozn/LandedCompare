import { parseExactDecimal } from '../domain/monetary/decimal'
import { Money } from '../domain/monetary/Money'
import type { ExchangeRateTable } from './ExchangeRateTable'

/**
 * Converts `amount` into `rateTable`'s base currency.
 *
 * If `amount` is already in that currency, the conversion factor is
 * implicitly 1 and no rate lookup happens — no rate needs to be configured
 * for the base currency. Otherwise `rateTable` must hold a direct rate for
 * `amount`'s currency, or `ExchangeRateTable.getRate` throws
 * `MissingExchangeRateError`.
 *
 * The multiplication runs on the Phase 1 exact-decimal foundation
 * (`parseExactDecimal`), never native `number`. No minor-unit rounding is
 * applied to the result — that boundary belongs to a later calculation
 * phase (see docs/CALCULATION_RULES.md).
 */
export function convertToBaseCurrency(amount: Money, rateTable: ExchangeRateTable): Money {
  if (amount.currency === rateTable.baseCurrency) {
    return amount
  }

  const rate = rateTable.getRate(amount.currency)
  const convertedAmount = parseExactDecimal(amount.toDecimalString()).times(
    parseExactDecimal(rate.toDecimalString()),
  )
  return Money.fromString(convertedAmount.toFixed(), rateTable.baseCurrency)
}
