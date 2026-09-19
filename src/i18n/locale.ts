/**
 * Locale resolution and the lightweight UI language preference. Deliberately
 * separate from `index.ts` (the i18next wiring) so this logic — normalizing a
 * browser tag, reading/writing the stored preference, deciding the initial
 * locale — can be tested as plain functions with no i18next instance involved.
 */

export type SupportedLocale = 'tr' | 'en'

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['tr', 'en']

export const DEFAULT_LOCALE: SupportedLocale = 'en'

/** Namespaced so this UI preference is never mistaken for application/business data. */
export const LOCALE_STORAGE_KEY = 'landedcompare.locale'

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * Normalizes a BCP-47-ish language tag ("tr-TR", "en-US") to a supported
 * locale by matching its primary subtag. Returns `undefined` for anything
 * that isn't `tr` or `en` — callers decide what to fall back to.
 */
export function normalizeLocale(tag: string | null | undefined): SupportedLocale | undefined {
  if (!tag) {
    return undefined
  }
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
  return isSupportedLocale(primary) ? primary : undefined
}

/**
 * Reads the stored locale preference. An invalid, corrupted, or inaccessible
 * value (private-browsing storage errors included) is treated as "no
 * preference" rather than thrown — a bad `localStorage` entry must never
 * crash the app.
 */
export function readStoredLocale(storage: Pick<Storage, 'getItem'> = window.localStorage): SupportedLocale | undefined {
  try {
    return normalizeLocale(storage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return undefined
  }
}

export function writeStoredLocale(
  locale: SupportedLocale,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Best-effort preference persistence — a storage write failure must not block switching the language.
  }
}

/**
 * Deterministic initial-locale resolution: an explicit stored preference
 * wins; otherwise the browser's language list is matched against the
 * supported locales in order; otherwise `DEFAULT_LOCALE`.
 */
export function resolveInitialLocale(options?: {
  readonly storage?: Pick<Storage, 'getItem'>
  readonly browserLanguages?: readonly string[]
}): SupportedLocale {
  const stored = readStoredLocale(options?.storage)
  if (stored) {
    return stored
  }

  const browserLanguages =
    options?.browserLanguages ??
    (typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [])

  for (const tag of browserLanguages) {
    const normalized = normalizeLocale(tag)
    if (normalized) {
      return normalized
    }
  }

  return DEFAULT_LOCALE
}
