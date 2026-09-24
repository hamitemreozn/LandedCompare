/**
 * Exact decimal equality for the legacy cutover (source review, R-3).
 *
 * PostgreSQL `numeric` keeps the scale it was given, the domain's `Quantity`
 * writes the shortest form, and both are the same economic value. Equality is
 * decided on text alone — no value ever becomes a JavaScript `number`.
 */
import { describe, expect, it } from 'vitest'
import { canonicalDecimal, isCanonicalPositiveDecimal, sameExactDecimal } from './catalogRules'

describe('canonicalDecimal', () => {
  it('removes representation only: trailing fraction zeros, a bare point, leading integer zeros, negative zero', () => {
    expect(canonicalDecimal('1.20')).toBe('1.2')
    expect(canonicalDecimal('1.200')).toBe('1.2')
    expect(canonicalDecimal('12.000')).toBe('12')
    expect(canonicalDecimal('0.50')).toBe('0.5')
    expect(canonicalDecimal('007.5')).toBe('7.5')
    expect(canonicalDecimal('0.000')).toBe('0')
    expect(canonicalDecimal('-0.00')).toBe('0')
    expect(canonicalDecimal('-1.50')).toBe('-1.5')
    expect(canonicalDecimal('10')).toBe('10')
  })

  it('keeps every significant digit of a value no binary float could hold', () => {
    expect(canonicalDecimal('12345678901234567890.00470000')).toBe('12345678901234567890.0047')
    expect(canonicalDecimal('0.000000000000000000000000000001000')).toBe('0.000000000000000000000000000001')
  })

  it('is not a decimal parser for anything but plain decimal text', () => {
    for (const text of ['', '1e3', '1.', '.5', ' 1', '1,5', 'NaN', 'Infinity', '+1', '0x10']) {
      expect(canonicalDecimal(text), text).toBeUndefined()
    }
  })
})

describe('sameExactDecimal', () => {
  it('equal exact values are equal whatever their scale', () => {
    expect(sameExactDecimal('1.2', '1.20')).toBe(true)
    expect(sameExactDecimal('1.200', '1.2')).toBe(true)
    expect(sameExactDecimal('12345678901234567890.0047', '12345678901234567890.004700')).toBe(true)
    expect(sameExactDecimal('24', '24.0')).toBe(true)
  })

  it('different exact values stay different, down to the last digit', () => {
    expect(sameExactDecimal('1.2', '1.21')).toBe(false)
    expect(sameExactDecimal('12345678901234567890.0047', '12345678901234567890.0048')).toBe(false)
    // 2^53 + 1 and 2^53 are equal as JavaScript numbers; they are not equal here.
    expect(sameExactDecimal('9007199254740993', '9007199254740992')).toBe(false)
    expect(sameExactDecimal('0.1', '0.10000000000000001')).toBe(false)
  })

  it('absent equals absent only', () => {
    expect(sameExactDecimal(undefined, undefined)).toBe(true)
    expect(sameExactDecimal('1.2', undefined)).toBe(false)
    expect(sameExactDecimal(undefined, '1.2')).toBe(false)
  })

  it('text that is not a decimal equals nothing, not even itself', () => {
    expect(sameExactDecimal('NaN', 'NaN')).toBe(false)
    expect(sameExactDecimal('1e1', '10')).toBe(false)
  })

  it('does not loosen what the server accepts', () => {
    for (const refused of ['0', '0.00', '-1.5', '01.5', '1e3', '']) {
      expect(isCanonicalPositiveDecimal(refused), refused).toBe(false)
    }
    for (const accepted of ['1.2', '1.20', '0.5', '12345678901234567890.0047']) {
      expect(isCanonicalPositiveDecimal(accepted), accepted).toBe(true)
    }
  })
})
