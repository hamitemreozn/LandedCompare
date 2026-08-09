import { describe, expect, it } from 'vitest'
import { InvalidMinorUnitError, resolveMinorUnit } from './CurrencyMinorUnit'
import { InvalidCurrencyCodeError } from '../domain/monetary/CurrencyCode'

describe('resolveMinorUnit', () => {
  it('knows the currencies the MVP exercises', () => {
    expect(resolveMinorUnit('TRY')).toBe(2)
    expect(resolveMinorUnit('USD')).toBe(2)
    expect(resolveMinorUnit('EUR')).toBe(2)
  })

  it('blocks on an unknown currency instead of defaulting to 2', () => {
    // Silently assuming 2 would produce unpayable amounts for a 0-decimal
    // currency — the same reasoning as Phase 2's missing-rate rule.
    expect(() => resolveMinorUnit('JPY')).toThrow(InvalidMinorUnitError)
  })

  it('supports a 0-decimal currency through an explicit override', () => {
    expect(resolveMinorUnit('JPY', { JPY: 0 })).toBe(0)
  })

  it('lets an override win over the built-in table', () => {
    expect(resolveMinorUnit('USD', { USD: 4 })).toBe(4)
  })

  it('rejects a malformed override', () => {
    expect(() => resolveMinorUnit('TRY', { TRY: -1 })).toThrow(InvalidMinorUnitError)
    expect(() => resolveMinorUnit('TRY', { TRY: 2.5 })).toThrow(InvalidMinorUnitError)
    expect(() => resolveMinorUnit('TRY', { TRY: 1000 })).toThrow(InvalidMinorUnitError)
  })

  it('rejects a malformed currency code', () => {
    expect(() => resolveMinorUnit('try')).toThrow(InvalidCurrencyCodeError)
  })
})
