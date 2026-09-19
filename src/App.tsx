import { useTranslation } from 'react-i18next'
import { setLocale, SUPPORTED_LOCALES } from './i18n'

function App() {
  const { t, i18n } = useTranslation()

  return (
    <main>
      <h1>{t('common.appName')}</h1>
      <p>{t('app.underDevelopment')}</p>
      <p>{t('app.currentLanguage', { language: t(`language.${i18n.language}`) })}</p>
      <div role="group" aria-label="language">
        {SUPPORTED_LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            aria-pressed={i18n.language === locale}
            onClick={() => void setLocale(locale)}
          >
            {t(`language.${locale}`)}
          </button>
        ))}
      </div>
    </main>
  )
}

export default App
