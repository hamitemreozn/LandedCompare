import { describe, expect, it } from 'vitest'
import { InvalidQuantityError, Quantity } from './Quantity'
import { InvalidDecimalError } from '../monetary/decimal'

describe('Quantity', () => {
  it('preserves decimal precision', () => {
    expect(Quantity.fromString('12.375').toDecimalString()).toBe('12.375')
  })

  it('rejects negative quantities', () => {
    expect(() => Quantity.fromString('-1')).toThrow(InvalidQuantityError)
  })

  it('rejects malformed decimal input', () => {
    expect(() => Quantity.fromString('abc')).toThrow(InvalidDecimalError)
  })

  it('rejects a raw JS number even if the type system is bypassed', () => {
    expect(() => Quantity.fromString((0.1 + 0.2) as unknown as string)).toThrow(
      InvalidDecimalError,
    )
  })

  it('round-trips through JSON serialization exactly', () => {
    const original = Quantity.fromString('1000.5')
    const restored = Quantity.fromJSON(JSON.parse(JSON.stringify(original.toJSON())))
    expect(restored.equals(original)).toBe(true)
  })

  it('compares quantities', () => {
    expect(Quantity.fromString('1').compareTo(Quantity.fromString('2'))).toBeLessThan(0)
  })

  it('max returns the greater of two quantities regardless of argument order', () => {
    expect(Quantity.fromString('50').max(Quantity.fromString('100')).toDecimalString()).toBe('100')
    expect(Quantity.fromString('100').max(Quantity.fromString('50')).toDecimalString()).toBe('100')
  })

  it('multiplies two quantities exactly', () => {
    expect(Quantity.fromString('11').multiply(Quantity.fromString('10')).toDecimalString()).toBe(
      '110',
    )
  })

  it('subtracts two quantities exactly', () => {
    expect(Quantity.fromString('110').subtract(Quantity.fromString('100')).toDecimalString()).toBe(
      '10',
    )
  })

  it('rejects a subtraction that would go negative', () => {
    expect(() => Quantity.fromString('100').subtract(Quantity.fromString('110'))).toThrow(
      InvalidQuantityError,
    )
  })

  it('ceilDivide rounds up to the next whole quantity on a fractional division', () => {
    expect(Quantity.fromString('105').ceilDivide(Quantity.fromString('10')).toDecimalString()).toBe(
      '11',
    )
  })

  it('ceilDivide leaves an exact division unchanged', () => {
    expect(Quantity.fromString('100').ceilDivide(Quantity.fromString('10')).toDecimalString()).toBe(
      '10',
    )
  })

  it('ceilDivide plus multiply stays exact where native floating point would drift (0.3 / 0.1)', () => {
    const packs = Quantity.fromString('0.3').ceilDivide(Quantity.fromString('0.1'))
    expect(packs.toDecimalString()).toBe('3')
    expect(packs.multiply(Quantity.fromString('0.1')).toDecimalString()).toBe('0.3')
  })
})
