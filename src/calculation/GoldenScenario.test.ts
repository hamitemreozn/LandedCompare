import { describe, expect, it } from 'vitest'
import { calculateQuoteMerchandise, type MerchandiseLine } from './MerchandiseCalculation'
import { ExchangeRateTable } from './ExchangeRateTable'
import { ExchangeRate } from './ExchangeRate'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'

/**
 * Phase 2 golden scenario (see docs/CALCULATION_RULES.md). Deterministic,
 * hand-computed reference values that pin down the whole
 * conversion + merchandise pipeline together, not just individual units.
 *
 * Project base currency: TRY
 * Quote currency: USD, rate 1 USD = 43.50 TRY
 * Product A: 12.50 USD x 100 = 1250 USD
 * Product B: 3.75 USD x 40 = 150 USD
 * Quote merchandise total: 1400 USD
 * Base merchandise total: 1400 x 43.50 = 60900 TRY
 */
describe('Phase 2 golden scenario', () => {
  it('matches the hand-computed reference totals exactly', () => {
    const baseCurrency = 'TRY'
    const quoteCurrency = 'USD'
    const rateTable = ExchangeRateTable.create(baseCurrency, [
      ExchangeRate.fromString(quoteCurrency, baseCurrency, '43.50'),
    ])

    const lines: MerchandiseLine[] = [
      { unitPrice: Money.fromString('12.50', quoteCurrency), calculationQuantity: Quantity.fromString('100') },
      { unitPrice: Money.fromString('3.75', quoteCurrency), calculationQuantity: Quantity.fromString('40') },
    ]

    const result = calculateQuoteMerchandise(lines, quoteCurrency, rateTable)

    expect(result.lineSubtotals[0]?.toDecimalString()).toBe('1250')
    expect(result.lineSubtotals[1]?.toDecimalString()).toBe('150')
    expect(result.quoteCurrencyMerchandiseTotal.toDecimalString()).toBe('1400')
    expect(result.quoteCurrencyMerchandiseTotal.currency).toBe('USD')
    expect(result.baseCurrencyMerchandiseTotal.toDecimalString()).toBe('60900')
    expect(result.baseCurrencyMerchandiseTotal.currency).toBe('TRY')
  })
})
