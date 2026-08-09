import { describe, expect, it } from 'vitest'
import { InvalidPercentageError, Percentage } from './Percentage'
import { Money } from '../domain/monetary/Money'
import { InvalidDecimalError } from '../domain/monetary/decimal'

describe('Percentage', () => {
  it('uses the "5" means 5% convention', () => {
    const rate = Percentage.fromString('5')
    expect(rate.toDecimalString()).toBe('5')
    expect(rate.toFactorString()).toBe('0.05')
    expect(rate.applyTo(Money.fromString('10000', 'USD')).toDecimalString()).toBe('500')
  })

  it('does not interpret "0.05" as 5%', () => {
    // The other convention is deliberately unsupported: 0.05 is 0.05%, and
    // reading it as 5% would be a 100x error.
    expect(Percentage.fromString('0.05').applyTo(Money.fromString('10000', 'USD')).toDecimalString()).toBe(
      '5',
    )
  })

  it('applies a fractional rate without rounding to the minor unit', () => {
    const duty = Percentage.fromString('3.5')
    expect(duty.applyTo(Money.fromString('1234.567', 'TRY')).toDecimalString()).toBe('43.209845')
  })

  it('keeps sub-minor-unit precision on a repeating-style rate', () => {
    const rate = Percentage.fromString('0.125')
    expect(rate.toFactorString()).toBe('0.00125')
    expect(rate.applyTo(Money.fromString('1000.004', 'TRY')).toDecimalString()).toBe('1.250005')
  })

  it('accepts zero — a 0% duty is a real statement, not a missing value', () => {
    const rate = Percentage.fromString('0')
    expect(rate.isZero()).toBe(true)
    expect(rate.applyTo(Money.fromString('10000', 'TRY')).toDecimalString()).toBe('0')
  })

  it('rejects a negative percentage', () => {
    expect(() => Percentage.fromString('-5')).toThrow(InvalidPercentageError)
  })

  it('rejects malformed input with Phase 1s decimal error', () => {
    expect(() => Percentage.fromString('five')).toThrow(InvalidDecimalError)
    expect(() => Percentage.fromString('')).toThrow(InvalidDecimalError)
    expect(() => Percentage.fromString((0.1 + 0.2) as unknown as string)).toThrow(InvalidDecimalError)
  })

  it('imposes no upper bound of its own, but can report crossing 100%', () => {
    const surcharge = Percentage.fromString('150')
    expect(surcharge.exceedsOneHundred()).toBe(true)
    expect(surcharge.applyTo(Money.fromString('100', 'TRY')).toDecimalString()).toBe('150')

    expect(Percentage.fromString('100').exceedsOneHundred()).toBe(false)
    expect(Percentage.fromString('99.999').exceedsOneHundred()).toBe(false)
  })
})
