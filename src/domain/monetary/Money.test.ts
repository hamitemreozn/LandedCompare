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

// Added in Phase 4 for the cost/allocation engine: sign handling and the
// explicit minor-unit settlement boundary (see docs/CALCULATION_RULES.md).
describe('Money — sign', () => {
  it('classifies sign, treating zero as neither positive nor negative', () => {
    const negative = Money.fromString('-5', 'TRY')
    const positive = Money.fromString('5', 'TRY')
    const zero = Money.zero('TRY')

    expect(negative.isNegative()).toBe(true)
    expect(negative.isPositive()).toBe(false)
    expect(positive.isPositive()).toBe(true)
    expect(positive.isNegative()).toBe(false)
    expect(zero.isZero()).toBe(true)
    expect(zero.isNegative()).toBe(false)
    expect(zero.isPositive()).toBe(false)
  })

  it('does not report a signed zero as negative', () => {
    // decimal.js keeps a signed zero; the allocator relies on -0 not being
    // treated as a negative amount when it re-applies a sign.
    expect(Money.fromString('-0', 'TRY').isNegative()).toBe(false)
  })

  it('takes magnitude and flips sign exactly', () => {
    const discount = Money.fromString('-1234.5678', 'TRY')
    expect(discount.abs().toDecimalString()).toBe('1234.5678')
    expect(discount.negate().toDecimalString()).toBe('1234.5678')
    expect(discount.abs().negate().equals(discount)).toBe(true)
  })
})

describe('Money — minor-unit settlement', () => {
  it('rounds half-up at the minor unit', () => {
    expect(Money.fromString('33.335', 'TRY').roundToMinorUnit(2).toDecimalString()).toBe('33.34')
    expect(Money.fromString('33.334', 'TRY').roundToMinorUnit(2).toDecimalString()).toBe('33.33')
    // Half-up, not banker's rounding: 33.345 must not round down to 33.34.
    expect(Money.fromString('33.345', 'TRY').roundToMinorUnit(2).toDecimalString()).toBe('33.35')
  })

  it('supports a zero-decimal currency scale', () => {
    expect(Money.fromString('1234.5', 'JPY').roundToMinorUnit(0).toDecimalString()).toBe('1235')
  })

  it('truncates toward zero rather than rounding', () => {
    expect(Money.fromString('33.339', 'TRY').truncateToMinorUnit(2).toDecimalString()).toBe('33.33')
    expect(Money.fromString('-33.339', 'TRY').truncateToMinorUnit(2).toDecimalString()).toBe('-33.33')
  })

  it('leaves arithmetic itself unrounded — settlement is opt-in', () => {
    const product = Money.fromString('0.0047', 'TRY').multiply('3')
    expect(product.toDecimalString()).toBe('0.0141')
    expect(product.roundToMinorUnit(2).toDecimalString()).toBe('0.01')
  })
})
