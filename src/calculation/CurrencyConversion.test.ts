import { describe, expect, it } from 'vitest'
import { convertToBaseCurrency } from './CurrencyConversion'
import { ExchangeRateTable, MissingExchangeRateError } from './ExchangeRateTable'
import { ExchangeRate } from './ExchangeRate'
import { Money } from '../domain/monetary/Money'

describe('convertToBaseCurrency', () => {
  it('requires no rate when the quote currency already matches the base currency', () => {
    const table = ExchangeRateTable.create('TRY', [])
    const converted = convertToBaseCurrency(Money.fromString('100', 'TRY'), table)
    expect(converted.toDecimalString()).toBe('100')
    expect(converted.currency).toBe('TRY')
  })

  it('converts using the exact rate: 100 USD at 43.50 -> 4350 TRY', () => {
    const table = ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', '43.50')])
    const converted = convertToBaseCurrency(Money.fromString('100', 'USD'), table)
    expect(converted.toDecimalString()).toBe('4350')
    expect(converted.currency).toBe('TRY')
  })

  it('does not apply premature minor-unit rounding for decimal rates', () => {
    const table = ExchangeRateTable.create('TRY', [
      ExchangeRate.fromString('USD', 'TRY', '43.5187'),
    ])
    const converted = convertToBaseCurrency(Money.fromString('12.3456', 'USD'), table)
    // 12.3456 * 43.5187 = 537.26446272 exactly; must not be cut to 2 decimals.
    expect(converted.toDecimalString()).toBe('537.26446272')
  })

  it('fails with MissingExchangeRateError instead of falling back to 0 or 1', () => {
    const table = ExchangeRateTable.create('TRY', [])
    expect(() => convertToBaseCurrency(Money.fromString('100', 'USD'), table)).toThrow(
      MissingExchangeRateError,
    )
  })

  it('preserves precision for large monetary values', () => {
    const table = ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', '2')])
    const converted = convertToBaseCurrency(
      Money.fromString('123456789123456789.123456789', 'USD'),
      table,
    )
    expect(converted.toDecimalString()).toBe('246913578246913578.246913578')
  })
})
