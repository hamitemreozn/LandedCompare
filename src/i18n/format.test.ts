import { describe, expect, it } from 'vitest'
import { Money } from '../domain/monetary/Money'
import { formatCurrency, formatNumber, formatPercentage } from './format'

describe('formatNumber', () => {
  it('uses comma grouping and a period decimal separator in English', () => {
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5')
  })

  it('uses period grouping and a comma decimal separator in Turkish', () => {
    expect(formatNumber(1234.5, 'tr')).toBe('1.234,5')
  })
})

describe('formatCurrency', () => {
  it('formats USD for an English locale', () => {
    const result = formatCurrency('1234.56', 'USD', 'en')
    expect(result).toContain('1,234.56')
    expect(result).toContain('$')
  })

  it('formats TRY for a Turkish locale using Turkish separators', () => {
    const result = formatCurrency('1234.56', 'TRY', 'tr')
    expect(result).toContain('1.234,56')
  })

  it('does not mutate or alter the underlying settled value', () => {
    const money = Money.fromString('1234.5678', 'USD')
    const decimalString = money.toDecimalString()

    formatCurrency(decimalString, 'USD', 'en')
    formatCurrency(decimalString, 'TRY', 'tr')

    expect(money.toDecimalString()).toBe(decimalString)
    expect(decimalString).toBe('1234.5678')
  })
})

describe('formatPercentage', () => {
  it('formats a fraction as a percentage in English', () => {
    expect(formatPercentage(0.1856, 'en', { maximumFractionDigits: 2 })).toBe('18.56%')
  })

  it('formats a fraction as a percentage in Turkish', () => {
    const result = formatPercentage(0.1856, 'tr', { maximumFractionDigits: 2 })
    expect(result).toContain('18,56')
    expect(result).toContain('%')
  })
})
