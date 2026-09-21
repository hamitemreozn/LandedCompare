import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n, { DEFAULT_LOCALE, getLocale, LOCALE_STORAGE_KEY, setLocale } from './index'

describe('i18n runtime', () => {
  afterEach(async () => {
    await setLocale(DEFAULT_LOCALE)
  })

  it('initializes with a supported language', () => {
    expect(['tr', 'en']).toContain(i18n.language)
  })

  it('resolves a locale-invariant brand string', () => {
    expect(i18n.t('common.appName')).toBe('LandedCompare')
  })

  it('switches languages and updates translated output immediately', async () => {
    await setLocale('tr')
    expect(i18n.t('common.save')).toBe('Kaydet')
    expect(getLocale()).toBe('tr')

    await setLocale('en')
    expect(i18n.t('common.save')).toBe('Save')
    expect(getLocale()).toBe('en')
  })

  it('persists the selected language for reload', async () => {
    await setLocale('tr')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('tr')
  })
})

describe('interpolation and pluralization', () => {
  afterEach(async () => {
    await setLocale(DEFAULT_LOCALE)
  })

  it('interpolates variables into a translated string', async () => {
    await setLocale('en')
    expect(i18n.t('dashboard.activeOfTotal', { active: 3, total: 7 })).toBe(
      '3 of 7 records are active',
    )

    await setLocale('tr')
    expect(i18n.t('dashboard.activeOfTotal', { active: 3, total: 7 })).toBe(
      '7 kayıttan 3 tanesi aktif',
    )
  })

  it('selects the correct plural form by count in English', async () => {
    await setLocale('en')
    expect(i18n.t('comparison.suppliersCompared', { count: 1 })).toBe('1 supplier compared')
    expect(i18n.t('comparison.suppliersCompared', { count: 3 })).toBe('3 suppliers compared')
  })

  it('renders the count-interpolated string in Turkish, which has no distinct plural form', async () => {
    await setLocale('tr')
    expect(i18n.t('comparison.suppliersCompared', { count: 1 })).toBe('1 tedarikçi karşılaştırıldı')
    expect(i18n.t('comparison.suppliersCompared', { count: 3 })).toBe('3 tedarikçi karşılaştırıldı')
  })
})

describe('i18n initialization with a corrupted stored preference', () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'not-a-real-locale')
  })

  afterEach(() => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
  })

  it('falls back safely instead of crashing on re-initialization', async () => {
    const { resolveInitialLocale } = await import('./locale')
    expect(() => resolveInitialLocale()).not.toThrow()
    expect(['tr', 'en']).toContain(resolveInitialLocale())
  })
})
