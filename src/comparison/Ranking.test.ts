import { describe, expect, it } from 'vitest'
import { rankCompleteSuppliers } from './Ranking'
import { Money } from '../domain/monetary/Money'

function ry(amount: string) {
  return Money.fromString(amount, 'TRY')
}

describe('rankCompleteSuppliers', () => {
  it('ranks two suppliers ascending by rankingAmount', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('200') },
      { supplierId: 'b', rankingAmount: ry('100') },
    ])
    expect(result.ranked.map((r) => [r.supplierId, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
    ])
  })

  it('applies dense ranking across three suppliers with a tie (1, 1, 2 — not 1, 1, 3)', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('100') },
      { supplierId: 'b', rankingAmount: ry('100') },
      { supplierId: 'c', rankingAmount: ry('110') },
    ])
    expect(result.ranked.map((r) => [r.supplierId, r.rank])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 2],
    ])
    expect(result.lowestSupplierIds).toEqual(['a', 'b'])
  })

  it('excludes nothing extra — only what is passed in participates', () => {
    const result = rankCompleteSuppliers([{ supplierId: 'a', rankingAmount: ry('50') }])
    expect(result.ranked).toHaveLength(1)
    expect(result.ranked[0]?.rank).toBe(1)
  })

  it('keeps stable input order for exact ties, not an alphabetic tie-break', () => {
    // "z" sorts after "a" alphabetically, but is listed first in input order and must stay first.
    const result = rankCompleteSuppliers([
      { supplierId: 'z', rankingAmount: ry('100') },
      { supplierId: 'a', rankingAmount: ry('100') },
    ])
    expect(result.ranked.map((r) => r.supplierId)).toEqual(['z', 'a'])
    expect(result.lowestSupplierIds).toEqual(['z', 'a'])
  })

  it('returns an empty ranking for no complete suppliers', () => {
    const result = rankCompleteSuppliers([])
    expect(result.ranked).toEqual([])
    expect(result.lowestSupplierIds).toEqual([])
    expect(result.lowestRankingAmount).toBeUndefined()
  })

  it('gives the single complete supplier rank 1', () => {
    const result = rankCompleteSuppliers([{ supplierId: 'only', rankingAmount: ry('9999') }])
    expect(result.ranked[0]?.rank).toBe(1)
    expect(result.lowestSupplierIds).toEqual(['only'])
  })

  it('ties two sub-minor-unit-different exact totals once both are rounded to 100.00', () => {
    // 100.004 and 100.001 TRY both settle, half-up, to 100.00 — a tie.
    const a = Money.fromString('100.004', 'TRY').roundToMinorUnit(2)
    const b = Money.fromString('100.001', 'TRY').roundToMinorUnit(2)
    expect(a.toDecimalString()).toBe('100')
    expect(b.toDecimalString()).toBe('100')

    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: a },
      { supplierId: 'b', rankingAmount: b },
    ])
    expect(result.ranked.map((r) => r.rank)).toEqual([1, 1])
    expect(result.lowestSupplierIds).toEqual(['a', 'b'])
  })

  it('separates suppliers at the half-up rounding boundary (100.005 rounds up, 100.004 does not)', () => {
    const a = Money.fromString('100.005', 'TRY').roundToMinorUnit(2)
    const b = Money.fromString('100.004', 'TRY').roundToMinorUnit(2)
    expect(a.toDecimalString()).toBe('100.01')
    expect(b.toDecimalString()).toBe('100')

    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: a },
      { supplierId: 'b', rankingAmount: b },
    ])
    expect(result.ranked.map((r) => [r.supplierId, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
    ])
  })

  it('computes the amount and percentage difference from the lowest rankingAmount', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('110') },
      { supplierId: 'b', rankingAmount: ry('100') },
    ])
    const a = result.ranked.find((r) => r.supplierId === 'a')!
    const b = result.ranked.find((r) => r.supplierId === 'b')!
    expect(a.differenceAmount.toDecimalString()).toBe('10')
    expect(a.percentageDifference?.toDecimalString()).toBe('10')
    expect(b.differenceAmount.toDecimalString()).toBe('0')
    expect(b.percentageDifference?.toDecimalString()).toBe('0')
  })

  it('gives a tie 0% difference', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('100') },
      { supplierId: 'b', rankingAmount: ry('100') },
    ])
    for (const entry of result.ranked) {
      expect(entry.differenceAmount.toDecimalString()).toBe('0')
      expect(entry.percentageDifference?.toDecimalString()).toBe('0')
    }
  })

  it('gives 0% when the best total is zero and every tied supplier is also zero', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('0') },
      { supplierId: 'b', rankingAmount: ry('0') },
    ])
    for (const entry of result.ranked) {
      expect(entry.differenceAmount.toDecimalString()).toBe('0')
      expect(entry.percentageDifference?.toDecimalString()).toBe('0')
    }
  })

  it('leaves percentageDifference unavailable (not Infinity/NaN) when the best total is zero and another is positive', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('0') },
      { supplierId: 'b', rankingAmount: ry('50') },
    ])
    const zero = result.ranked.find((r) => r.supplierId === 'a')!
    const positive = result.ranked.find((r) => r.supplierId === 'b')!
    expect(zero.percentageDifference?.toDecimalString()).toBe('0')
    expect(positive.differenceAmount.toDecimalString()).toBe('50')
    expect(positive.percentageDifference).toBeUndefined()
    expect(positive.exactPercentageDifference).toBeUndefined()
  })
})

/**
 * A percentage difference is a figure a buyer reads and repeats, not an
 * intermediate value. The audit found 3 -> 4 publishing
 * "33.33333333333333333333333333333333%", which is a calculation artefact
 * escaping as a commercial statement.
 */
describe('percentage difference is published at two decimals, half-up', () => {
  it('shortens a repeating ratio', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('3') },
      { supplierId: 'b', rankingAmount: ry('4') },
    ])
    const b = result.ranked.find((entry) => entry.supplierId === 'b')!
    expect(b.percentageDifference?.toDecimalString()).toBe('33.33')
  })

  it('keeps the exact ratio available for audit', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('3') },
      { supplierId: 'b', rankingAmount: ry('4') },
    ])
    const b = result.ranked.find((entry) => entry.supplierId === 'b')!
    expect(b.exactPercentageDifference?.toDecimalString()).toMatch(/^33\.3333333333/)
  })

  it('rounds half-up at the third decimal', () => {
    // 6.255% of the lowest amount: 1000 -> 1062.55 is 6.255%, published 6.26.
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('1000') },
      { supplierId: 'b', rankingAmount: ry('1062.55') },
    ])
    const b = result.ranked.find((entry) => entry.supplierId === 'b')!
    expect(b.exactPercentageDifference?.toDecimalString()).toBe('6.255')
    expect(b.percentageDifference?.toDecimalString()).toBe('6.26')
  })

  it('never publishes more than two decimals, for any pair', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('7') },
      { supplierId: 'b', rankingAmount: ry('11') },
      { supplierId: 'c', rankingAmount: ry('13.37') },
      { supplierId: 'd', rankingAmount: ry('999.99') },
    ])
    for (const entry of result.ranked) {
      const published = entry.percentageDifference?.toDecimalString() ?? '0'
      const decimals = published.split('.')[1] ?? ''
      expect(decimals.length).toBeLessThanOrEqual(2)
      expect(published).not.toMatch(/Infinity|NaN/)
    }
  })

  it('does not let rounding touch the monetary difference', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('3') },
      { supplierId: 'b', rankingAmount: ry('4') },
    ])
    const b = result.ranked.find((entry) => entry.supplierId === 'b')!
    expect(b.differenceAmount.toDecimalString()).toBe('1')
    expect(b.rankingAmount.toDecimalString()).toBe('4')
  })

  it('reports a zero-versus-zero tie as 0%', () => {
    const result = rankCompleteSuppliers([
      { supplierId: 'a', rankingAmount: ry('0') },
      { supplierId: 'b', rankingAmount: ry('0') },
    ])
    for (const entry of result.ranked) {
      expect(entry.percentageDifference?.toDecimalString()).toBe('0')
    }
  })
})
