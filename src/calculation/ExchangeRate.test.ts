import { describe, expect, it } from 'vitest'
import { ExchangeRate, InvalidExchangeRateError } from './ExchangeRate'
import { InvalidDecimalError } from '../domain/monetary/decimal'
import { InvalidCurrencyCodeError } from '../domain/monetary/CurrencyCode'

describe('ExchangeRate', () => {
  it('represents "1 fromCurrency = rate toCurrency"', () => {
    const rate = ExchangeRate.fromString('USD', 'TRY', '43.50')
    expect(rate.fromCurrency).toBe('USD')
    expect(rate.toCurrency).toBe('TRY')
    expect(rate.toDecimalString()).toBe('43.5')
  })

  it('rejects a zero rate', () => {
    expect(() => ExchangeRate.fromString('USD', 'TRY', '0')).toThrow(InvalidExchangeRateError)
  })

  it('rejects a negative rate', () => {
    expect(() => ExchangeRate.fromString('USD', 'TRY', '-43.50')).toThrow(InvalidExchangeRateError)
  })

  it('rejects a malformed decimal rate with the Phase 1 decimal error', () => {
    expect(() => ExchangeRate.fromString('USD', 'TRY', 'not-a-number')).toThrow(InvalidDecimalError)
    expect(() => ExchangeRate.fromString('USD', 'TRY', 'Infinity')).toThrow(InvalidDecimalError)
    expect(() => ExchangeRate.fromString('USD', 'TRY', 'NaN')).toThrow(InvalidDecimalError)
  })

  it('accepts a very small but positive rate without an invented business minimum', () => {
    const rate = ExchangeRate.fromString('JPY', 'USD', '0.0000001')
    expect(rate.toDecimalString()).toBe('0.0000001')
  })

  it('rejects an invalid currency code', () => {
    expect(() => ExchangeRate.fromString('usd', 'TRY', '43.50')).toThrow(InvalidCurrencyCodeError)
  })

  it('round-trips through JSON serialization exactly', () => {
    const original = ExchangeRate.fromString('EUR', 'TRY', '50.20')
    const restored = ExchangeRate.fromJSON(JSON.parse(JSON.stringify(original.toJSON())))
    expect(restored.fromCurrency).toBe('EUR')
    expect(restored.toCurrency).toBe('TRY')
    expect(restored.toDecimalString()).toBe(original.toDecimalString())
  })
})
