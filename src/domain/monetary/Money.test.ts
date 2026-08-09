import { describe, expect, it } from 'vitest'
import { CurrencyMismatchError, Money } from './Money'
import { InvalidDecimalError } from './decimal'

describe('Money', () => {
  it('adds decimal amounts exactly, unlike native floating-point (0.1 + 0.2)', () => {
    const sum = Money.fromString('0.1', 'USD').add(Money.fromString('0.2', 'USD'))
    expect(sum.toDecimalString()).toBe('0.3')
    // proves this is not relying on native binary floating-point:
    expect(0.1 + 0.2).not.toBe(0.3)
  })

  it('preserves sub-cent decimal precision (e.g. unit prices like 0.0047)', () => {
    const price = Money.fromString('0.0047', 'USD')
    expect(price.toDecimalString()).toBe('0.0047')
  })

  it('preserves precision for large monetary values', () => {
    const large = Money.fromString('123456789123456789.123456789', 'USD')
    expect(large.toDecimalString()).toBe('123456789123456789.123456789')
  })

  it('subtracts and multiplies exactly', () => {
    const a = Money.fromString('10.50', 'USD')
    const b = Money.fromString('3.25', 'USD')
    expect(a.subtract(b).toDecimalString()).toBe('7.25')
    expect(a.multiply('3').toDecimalString()).toBe('31.5')
  })

  it('compares amounts within the same currency', () => {
    const small = Money.fromString('1.00', 'USD')
    const large = Money.fromString('2.00', 'USD')
    expect(small.isLessThan(large)).toBe(true)
    expect(large.isGreaterThan(small)).toBe(true)
    expect(small.equals(Money.fromString('1.00', 'USD'))).toBe(true)
  })

  it('refuses to add two different currencies', () => {
    const usd = Money.fromString('10', 'USD')
    const eur = Money.fromString('10', 'EUR')
    expect(() => usd.add(eur)).toThrow(CurrencyMismatchError)
  })

  it('refuses to compare two different currencies', () => {
    const usd = Money.fromString('10', 'USD')
    const eur = Money.fromString('10', 'EUR')
    expect(() => usd.compareTo(eur)).toThrow(CurrencyMismatchError)
  })

  it('rejects malformed decimal input', () => {
    expect(() => Money.fromString('not-a-number', 'USD')).toThrow(InvalidDecimalError)
    expect(() => Money.fromString('', 'USD')).toThrow(InvalidDecimalError)
    expect(() => Money.fromString('1.2.3', 'USD')).toThrow(InvalidDecimalError)
    expect(() => Money.fromString('Infinity', 'USD')).toThrow(InvalidDecimalError)
  })

  it('rejects a raw JS number even if the type system is bypassed', () => {
    // Simulates a caller (e.g. untyped JS, or a lax `any`) trying to feed a
    // number that may already carry native binary floating-point error
    // (0.7 + 0.1 !== 0.8) straight into Money instead of a decimal string.
    const contaminated = 0.7 + 0.1
    expect(() => Money.fromString(contaminated as unknown as string, 'USD')).toThrow(
      InvalidDecimalError,
    )
  })

  it('rejects a factor passed as a raw JS number', () => {
    const price = Money.fromString('10', 'USD')
    expect(() => price.multiply((0.1 + 0.2) as unknown as string)).toThrow(InvalidDecimalError)
  })

  it('round-trips through JSON serialization exactly', () => {
    const original = Money.fromString('1999.995', 'EUR')
    const restored = Money.fromJSON(JSON.parse(JSON.stringify(original.toJSON())))
    expect(restored.equals(original)).toBe(true)
    expect(restored.toDecimalString()).toBe('1999.995')
    expect(restored.currency).toBe('EUR')
  })

  it('serializes to a plain, deterministic shape (not library internals)', () => {
    const snapshot = Money.fromString('42.5', 'USD').toJSON()
    expect(snapshot).toEqual({ amount: '42.5', currency: 'USD' })
  })
})
