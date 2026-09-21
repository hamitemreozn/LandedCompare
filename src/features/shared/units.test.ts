import { describe, expect, it } from 'vitest'
import en from '../../i18n/resources/en'
import tr from '../../i18n/resources/tr'
import { CANONICAL_UNITS, isCanonicalUnit, UNIT_TRANSLATION_KEY, unitLabel } from './units'

/** Resolves a translation key against a catalog, the way `t` would. */
const lookup = (catalog: unknown) => (key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog) as string

describe('the canonical vocabulary', () => {
  it('is locale-independent: the codes are not words in either language', () => {
    expect([...CANONICAL_UNITS]).toEqual([
      'PIECE',
      'BOX',
      'PACKAGE',
      'CARTON',
      'SET',
      'METER',
      'KILOGRAM',
      'LITER',
    ])
  })

  it('has a translation for every code, in both languages', () => {
    for (const unit of CANONICAL_UNITS) {
      expect(lookup(tr)(UNIT_TRANSLATION_KEY[unit]), unit).toBeTypeOf('string')
      expect(lookup(en)(UNIT_TRANSLATION_KEY[unit]), unit).toBeTypeOf('string')
    }
  })

  it('tells a code apart from a company own unit without a second field', () => {
    expect(isCanonicalUnit('PIECE')).toBe(true)
    expect(isCanonicalUnit('Rulo')).toBe(false)
    // Case matters: the codes are identifiers, not words.
    expect(isCanonicalUnit('piece')).toBe(false)
    expect(isCanonicalUnit('Adet')).toBe(false)
  })
})

describe('how a stored unit is displayed', () => {
  it('translates a canonical code into the current language', () => {
    expect(unitLabel('PIECE', lookup(tr))).toBe('Adet')
    expect(unitLabel('PIECE', lookup(en))).toBe('Piece')
    expect(unitLabel('CARTON', lookup(tr))).toBe('Koli')
    expect(unitLabel('CARTON', lookup(en))).toBe('Carton')
  })

  it('returns a custom unit verbatim, in every language', () => {
    // Never passed through `t()`: that would render a missing-key string over
    // perfectly good data.
    expect(unitLabel('Rulo', lookup(tr))).toBe('Rulo')
    expect(unitLabel('Rulo', lookup(en))).toBe('Rulo')
  })

  it('leaves a legacy label-shaped value alone rather than mapping it back', () => {
    // Development records written before the canonical codes hold strings like
    // "Adet". They are custom units now, and that is the graceful outcome:
    // they display exactly as they were typed and nothing rewrites them.
    expect(unitLabel('Adet', lookup(en))).toBe('Adet')
    expect(unitLabel('adet', lookup(tr))).toBe('adet')
  })

  it('does not translate one language label into the other', () => {
    // The guarantee that matters for a shared database: display is derived
    // from the stored code, and a stored word is never re-derived.
    expect(unitLabel('Piece', lookup(tr))).toBe('Piece')
  })
})
