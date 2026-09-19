import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  readStoredLocale,
  resolveInitialLocale,
  writeStoredLocale,
} from './locale'

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    },
  }
}

function throwingStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  return {
    getItem: () => {
      throw new Error('storage unavailable')
    },
    setItem: () => {
      throw new Error('storage unavailable')
    },
  }
}

describe('isSupportedLocale', () => {
  it('accepts exactly tr and en', () => {
    expect(isSupportedLocale('tr')).toBe(true)
    expect(isSupportedLocale('en')).toBe(true)
  })

  it('rejects everything else, including non-strings', () => {
    expect(isSupportedLocale('fr')).toBe(false)
    expect(isSupportedLocale('de')).toBe(false)
    expect(isSupportedLocale('')).toBe(false)
    expect(isSupportedLocale(123)).toBe(false)
    expect(isSupportedLocale(undefined)).toBe(false)
  })
})

describe('normalizeLocale', () => {
  it('normalizes exact matches', () => {
    expect(normalizeLocale('tr')).toBe('tr')
    expect(normalizeLocale('en')).toBe('en')
  })

  it('normalizes regional variants to their primary subtag', () => {
    expect(normalizeLocale('tr-TR')).toBe('tr')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('en-GB')).toBe('en')
  })

  it('is case-insensitive', () => {
    expect(normalizeLocale('TR-tr')).toBe('tr')
    expect(normalizeLocale('EN')).toBe('en')
  })

  it('falls back to undefined for unsupported languages', () => {
    expect(normalizeLocale('de-DE')).toBeUndefined()
    expect(normalizeLocale('fr')).toBeUndefined()
  })

  it('handles missing input without throwing', () => {
    expect(normalizeLocale(null)).toBeUndefined()
    expect(normalizeLocale(undefined)).toBeUndefined()
    expect(normalizeLocale('')).toBeUndefined()
  })
})

describe('readStoredLocale', () => {
  it('reads a valid stored preference', () => {
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: 'tr' }))).toBe('tr')
  })

  it('ignores an invalid stored value', () => {
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: 'fr' }))).toBeUndefined()
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: 'garbage' }))).toBeUndefined()
  })

  it('returns undefined when nothing is stored', () => {
    expect(readStoredLocale(fakeStorage())).toBeUndefined()
  })

  it('does not throw when storage access fails', () => {
    expect(() => readStoredLocale(throwingStorage())).not.toThrow()
    expect(readStoredLocale(throwingStorage())).toBeUndefined()
  })
})

describe('writeStoredLocale', () => {
  it('persists the locale under the namespaced key', () => {
    const storage = fakeStorage()
    writeStoredLocale('tr', storage)
    expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe('tr')
  })

  it('does not throw when storage access fails', () => {
    expect(() => writeStoredLocale('en', throwingStorage())).not.toThrow()
  })
})

describe('resolveInitialLocale', () => {
  it('prioritizes a valid stored preference over the browser language', () => {
    const locale = resolveInitialLocale({
      storage: fakeStorage({ [LOCALE_STORAGE_KEY]: 'tr' }),
      browserLanguages: ['en-US'],
    })
    expect(locale).toBe('tr')
  })

  it('falls back to the browser language when nothing is stored', () => {
    expect(
      resolveInitialLocale({ storage: fakeStorage(), browserLanguages: ['tr-TR', 'en-US'] }),
    ).toBe('tr')
    expect(
      resolveInitialLocale({ storage: fakeStorage(), browserLanguages: ['en-US', 'tr-TR'] }),
    ).toBe('en')
  })

  it('falls back to the default locale for unsupported browser languages', () => {
    expect(
      resolveInitialLocale({ storage: fakeStorage(), browserLanguages: ['fr-FR', 'de-DE'] }),
    ).toBe(DEFAULT_LOCALE)
  })

  it('falls back to the default locale when there is no signal at all', () => {
    expect(resolveInitialLocale({ storage: fakeStorage(), browserLanguages: [] })).toBe(DEFAULT_LOCALE)
  })

  it('treats an invalid stored value as absent and still checks the browser language', () => {
    expect(
      resolveInitialLocale({
        storage: fakeStorage({ [LOCALE_STORAGE_KEY]: 'xx' }),
        browserLanguages: ['tr'],
      }),
    ).toBe('tr')
  })
})
