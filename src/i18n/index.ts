import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './resources/en'
import tr from './resources/tr'
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale, resolveInitialLocale, writeStoredLocale } from './locale'
import type { SupportedLocale } from './locale'

export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from './locale'
export type { SupportedLocale } from './locale'

const resources = {
  en: { translation: en },
  tr: { translation: tr },
} as const

void i18next.use(initReactI18next).init({
  resources,
  lng: resolveInitialLocale(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  interpolation: {
    // React escapes interpolated values when rendering text nodes, and this
    // app never uses dangerouslySetInnerHTML, so double-escaping here is not needed.
    escapeValue: false,
  },
  returnNull: false,
})

/** The one place the UI language is changed. Updates rendered text immediately and persists the preference. */
export async function setLocale(locale: SupportedLocale): Promise<void> {
  await i18next.changeLanguage(locale)
  writeStoredLocale(locale)
}

export function getLocale(): SupportedLocale {
  return normalizeLocale(i18next.language) ?? DEFAULT_LOCALE
}

export default i18next
