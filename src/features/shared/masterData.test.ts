import { describe, expect, it } from 'vitest'
import {
  compareText,
  compareUpdatedAtDescending,
  countActive,
  matchesActiveFilter,
  matchesSearch,
  optionalText,
} from './masterData'

describe('the active/inactive filter', () => {
  it('is decided in the application layer, over records already read', () => {
    expect(matchesActiveFilter(true, 'ACTIVE')).toBe(true)
    expect(matchesActiveFilter(false, 'ACTIVE')).toBe(false)
    expect(matchesActiveFilter(false, 'INACTIVE')).toBe(true)
    expect(matchesActiveFilter(true, 'INACTIVE')).toBe(false)
    expect(matchesActiveFilter(true, 'ALL')).toBe(true)
    expect(matchesActiveFilter(false, 'ALL')).toBe(true)
  })

  it('counts both sides without a stored total', () => {
    expect(countActive([{ active: true }, { active: false }, { active: true }])).toEqual({
      total: 3,
      active: 2,
      inactive: 1,
    })
  })
})

describe('search', () => {
  it('matches case-insensitively, including the Turkish dotted I', () => {
    // `toLowerCase()` turns "İ" into "i" plus a combining dot, so a plain
    // comparison fails here. The locale-aware fold is what makes the obvious
    // search work.
    expect(matchesSearch(['İSTANBUL ÇELİK'], 'istanbul', 'tr')).toBe(true)
    expect(matchesSearch(['İSTANBUL ÇELİK'], 'çelik', 'tr')).toBe(true)
  })

  it('matches the dotless ı the same way', () => {
    expect(matchesSearch(['IŞIK Makine'], 'ışık', 'tr')).toBe(true)
  })

  it('searches every field it is given, and skips absent ones', () => {
    expect(matchesSearch(['Alfa', undefined, 'MUS-7788'], '7788', 'tr')).toBe(true)
    expect(matchesSearch(['Alfa', undefined], 'beta', 'tr')).toBe(false)
  })

  it('treats an empty or whitespace term as no filter at all', () => {
    expect(matchesSearch(['anything'], '', 'tr')).toBe(true)
    expect(matchesSearch(['anything'], '   ', 'tr')).toBe(true)
  })
})

describe('sorting', () => {
  it('orders Turkish letters by the Turkish alphabet, not by code point', () => {
    const names = ['Zeytin', 'Çelik', 'Demir', 'İnci', 'Ilgaz']
    const sorted = [...names].sort((a, b) => compareText(a, b, 'tr'))

    // Ç between C and D; I before İ. Code-unit order would put Ç and İ last.
    expect(sorted).toEqual(['Çelik', 'Demir', 'Ilgaz', 'İnci', 'Zeytin'])
  })

  it('is deterministic when two names differ only in case', () => {
    // The collator treats them as equal at `sensitivity: 'base'`, so without a
    // tie-break the order would depend on the order the store returned them.
    expect(compareText('ACME', 'acme', 'tr')).not.toBe(0)
    expect(compareText('ACME', 'acme', 'tr')).toBe(-compareText('acme', 'ACME', 'tr'))
  })

  it('orders by most recently updated, breaking exact ties on id', () => {
    const a = { id: 'aaa', updatedAt: '2026-09-21T10:00:00.000Z' }
    const b = { id: 'bbb', updatedAt: '2026-09-22T10:00:00.000Z' }
    const sameInstant = { id: 'zzz', updatedAt: a.updatedAt }

    expect([a, b].sort(compareUpdatedAtDescending)).toEqual([b, a])
    expect([sameInstant, a].sort(compareUpdatedAtDescending)).toEqual([a, sameInstant])
  })
})

describe('optional form text', () => {
  it('reports a cleared field as absent, not as an empty string', () => {
    // The record validators reject `note: ''` outright, and they are right to:
    // an empty optional is a key that should not exist.
    expect(optionalText('   ')).toBeUndefined()
    expect(optionalText('')).toBeUndefined()
    expect(optionalText('  bir not  ')).toBe('bir not')
  })
})
