import { describe, expect, it } from 'vitest'
import { InvalidCurrencyCodeError, isValidCurrencyCode, parseCurrencyCode } from './CurrencyCode'

describe('CurrencyCode', () => {
  it('accepts three-letter uppercase codes', () => {
    expect(isValidCurrencyCode('USD')).toBe(true)
    expect(parseCurrencyCode('EUR')).toBe('EUR')
  })

  it('rejects lowercase, wrong length, and malformed codes', () => {
    expect(isValidCurrencyCode('usd')).toBe(false)
    expect(isValidCurrencyCode('US')).toBe(false)
    expect(isValidCurrencyCode('USDD')).toBe(false)
    expect(isValidCurrencyCode('12A')).toBe(false)
    expect(isValidCurrencyCode('')).toBe(false)
  })

  it('throws a typed error for invalid codes instead of silently accepting them', () => {
    expect(() => parseCurrencyCode('usd')).toThrow(InvalidCurrencyCodeError)
  })
})
