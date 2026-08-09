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
})
