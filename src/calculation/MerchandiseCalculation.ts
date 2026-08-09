import { parseCurrencyCode } from '../domain/monetary/CurrencyCode'
import { Money } from '../domain/monetary/Money'
import type { Quantity } from '../domain/quantity/Quantity'
import { convertToBaseCurrency } from './CurrencyConversion'
import type { ExchangeRateTable } from './ExchangeRateTable'

/**
 * One priced, quantified line ready for arithmetic. `calculationQuantity` is
 * an already-resolved input — this calculation engine does not derive it
 * from MOQ, pack size, or order quantity (that is Phase 3 scope; see
 * docs/ARCHITECTURE.md). It deliberately does not reference `QuoteItem` so
 * this engine stays independent of how a quantity was resolved.
 */
export interface MerchandiseLine {
  readonly unitPrice: Money
  readonly calculationQuantity: Quantity
}

/** Traceable breakdown of one quote's merchandise calculation. */
export interface QuoteMerchandiseCalculationResult {
  readonly lineSubtotals: readonly Money[]
  readonly quoteCurrencyMerchandiseTotal: Money
  readonly baseCurrencyMerchandiseTotal: Money
}

/** `unitPrice × calculationQuantity`, exact — no rounding. */
export function calculateLineSubtotal(line: MerchandiseLine): Money {
  return line.unitPrice.multiply(line.calculationQuantity.toDecimalString())
}

/**
 * Sums line subtotals, all expected in `quoteCurrency`. An empty line list
 * yields zero. A subtotal priced in a different currency throws
 * `CurrencyMismatchError` (from `Money.add`) rather than silently mixing
 * currencies.
 */
export function calculateMerchandiseTotal(
  lineSubtotals: readonly Money[],
  quoteCurrency: string,
): Money {
  const currency = parseCurrencyCode(quoteCurrency)
  return lineSubtotals.reduce((total, subtotal) => total.add(subtotal), Money.zero(currency))
}

/**
 * Full merchandise calculation for one quote: line subtotals, the
 * quote-currency merchandise total, and that total converted once into the
 * project base currency. The total is converted once (not line-by-line) —
 * see docs/CALCULATION_RULES.md for the rationale.
 */
export function calculateQuoteMerchandise(
  lines: readonly MerchandiseLine[],
  quoteCurrency: string,
  exchangeRateTable: ExchangeRateTable,
): QuoteMerchandiseCalculationResult {
  const lineSubtotals = lines.map(calculateLineSubtotal)
  const quoteCurrencyMerchandiseTotal = calculateMerchandiseTotal(lineSubtotals, quoteCurrency)
  const baseCurrencyMerchandiseTotal = convertToBaseCurrency(
    quoteCurrencyMerchandiseTotal,
    exchangeRateTable,
  )
  return { lineSubtotals, quoteCurrencyMerchandiseTotal, baseCurrencyMerchandiseTotal }
}
