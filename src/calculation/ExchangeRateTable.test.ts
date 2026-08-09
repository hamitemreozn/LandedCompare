import { describe, expect, it } from 'vitest'
import { ExchangeRateTable, MissingExchangeRateError } from './ExchangeRateTable'
import { ExchangeRate } from './ExchangeRate'
import { CurrencyMismatchError } from '../domain/monetary/Money'

describe('ExchangeRateTable', () => {
  it('returns the configured rate for a quote currency', () => {
    const table = ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', '43.50')])
    expect(table.baseCurrency).toBe('TRY')
    expect(table.getRate('USD').toDecimalString()).toBe('43.5')
  })

  it('throws MissingExchangeRateError when no rate was provided for a currency', () => {
    const table = ExchangeRateTable.create('TRY', [])
    expect(() => table.getRate('USD')).toThrow(MissingExchangeRateError)
  })

  it('supports multiple currencies converting into the same base', () => {
    const table = ExchangeRateTable.create('TRY', [
      ExchangeRate.fromString('USD', 'TRY', '43.50'),
      ExchangeRate.fromString('EUR', 'TRY', '50.20'),
    ])
    expect(table.getRate('USD').toDecimalString()).toBe('43.5')
    expect(table.getRate('EUR').toDecimalString()).toBe('50.2')
  })

  it('rejects a rate whose toCurrency does not match the table base currency', () => {
    expect(() =>
      ExchangeRateTable.create('TRY', [ExchangeRate.fromString('EUR', 'USD', '1.08')]),
    ).toThrow(CurrencyMismatchError)
  })

  it('lets the last rate win when the same fromCurrency is provided twice', () => {
    const table = ExchangeRateTable.create('TRY', [
      ExchangeRate.fromString('USD', 'TRY', '43.50'),
      ExchangeRate.fromString('USD', 'TRY', '44.00'),
    ])
    expect(table.getRate('USD').toDecimalString()).toBe('44')
  })
})
