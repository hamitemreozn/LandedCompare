import { afterEach, describe, expect, it } from 'vitest'
import i18n, { DEFAULT_LOCALE, setLocale } from './index'
import {
  COMPARISON_INSIGHT_TRANSLATION_KEY,
  SUPPLIER_ISSUE_TRANSLATION_KEY,
  SUPPLIER_WARNING_TRANSLATION_KEY,
} from './engineText'

/**
 * Verifies the UI/i18n boundary described in the Phase 6 architecture rule:
 * the engine's stable codes (imported here only as types) resolve to real,
 * distinct, non-empty human-readable text in both supported languages — never
 * the raw i18next key, which is what a missing translation would return.
 */
describe('engine code -> translation key mapping', () => {
  afterEach(async () => {
    await setLocale(DEFAULT_LOCALE)
  })

  it('resolves the ALLOCATION_UNAVAILABLE warning in both languages', async () => {
    const key = SUPPLIER_WARNING_TRANSLATION_KEY.ALLOCATION_UNAVAILABLE

    await setLocale('en')
    const englishText = i18n.t(key)
    await setLocale('tr')
    const turkishText = i18n.t(key)

    expect(englishText).not.toBe(key)
    expect(turkishText).not.toBe(key)
    expect(englishText).not.toBe(turkishText)
    expect(englishText.length).toBeGreaterThan(0)
    expect(turkishText.length).toBeGreaterThan(0)
  })

  it('resolves every supplier issue code in both languages', async () => {
    for (const key of Object.values(SUPPLIER_ISSUE_TRANSLATION_KEY)) {
      await setLocale('en')
      expect(i18n.t(key)).not.toBe(key)
      await setLocale('tr')
      expect(i18n.t(key)).not.toBe(key)
    }
  })

  it('resolves every comparison insight code in both languages', async () => {
    for (const key of Object.values(COMPARISON_INSIGHT_TRANSLATION_KEY)) {
      await setLocale('en')
      expect(i18n.t(key)).not.toBe(key)
      await setLocale('tr')
      expect(i18n.t(key)).not.toBe(key)
    }
  })
})
