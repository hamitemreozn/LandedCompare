/**
 * The application shell: the navigation rail, the language switch, and the
 * app-level advisories that have to be visible from every screen.
 *
 * ## Future sections are shown, and shown as unavailable
 *
 * Quote analysis, purchasing, shipments, inventory and settings appear in the
 * rail as disabled entries carrying the word "later". The alternative — an
 * empty rail that grows by surprise — hides the shape of the product from the
 * person who is going to use it, and the alternative to *that* — a working
 * looking link to a stub screen — is worse still: a section that opens and
 * does nothing is indistinguishable from one that is broken.
 *
 * They are rendered as `<span>`s with `aria-disabled`, not as links or
 * buttons, so they are read as labels rather than offered as controls.
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { hrefFor, type RouteId } from '../../app/routes'
import { useAppRuntime } from '../../app/runtime'
import { setLocale, SUPPORTED_LOCALES, type SupportedLocale } from '../../i18n'

const PRIMARY_ROUTES: readonly { id: RouteId; labelKey: string }[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard' },
  { id: 'products', labelKey: 'nav.products' },
  { id: 'suppliers', labelKey: 'nav.suppliers' },
  { id: 'customers', labelKey: 'nav.customers' },
  { id: 'customer-statuses', labelKey: 'nav.customerStatuses' },
]

const FUTURE_SECTIONS: readonly string[] = [
  'nav.quoteAnalysis',
  'nav.purchases',
  'nav.shipments',
  'nav.inventory',
  'nav.settings',
]

export function AppShell({
  route,
  locale,
  onSignOut,
  children,
}: {
  readonly route: RouteId
  readonly locale: SupportedLocale
  readonly onSignOut: () => Promise<void>
  readonly children: ReactNode
}) {
  const { t } = useTranslation()
  const { organization, profile, role } = useAppRuntime()

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            LC
          </span>
          <span>
            <span className="brand__name">{t('common.appName')}</span>
            <span className="brand__tagline">{t('common.appTagline')}</span>
          </span>
        </div>

        <nav className="nav" aria-label={t('nav.primaryLabel')}>
          <div className="nav__group">
            <h2 className="nav__heading">{t('nav.masterData')}</h2>
            {PRIMARY_ROUTES.map((entry) => (
              <a
                key={entry.id}
                className="nav__link"
                href={hrefFor(entry.id)}
                aria-current={route === entry.id ? 'page' : undefined}
              >
                {t(entry.labelKey)}
              </a>
            ))}
          </div>

          <div className="nav__group">
            <h2 className="nav__heading">{t('nav.operations')}</h2>
            {FUTURE_SECTIONS.map((labelKey) => (
              <span
                key={labelKey}
                className="nav__link nav__link--disabled"
                aria-disabled="true"
                title={t('nav.notAvailableYet')}
              >
                {t(labelKey)}
                <span className="nav__soon">{t('nav.comingSoon')}</span>
              </span>
            ))}
          </div>
        </nav>

        <div className="sidebar__footer">
          {/*
            Who is signed in, and into which company. All tabs share one
            session, so this is what makes a change of identity visible rather
            than something a user has to infer from the data (Audit A, A-M2).
          */}
          <dl className="sidebar__identity" aria-label={t('shell.identityLabel')}>
            <dt className="visually-hidden">{t('shell.organization')}</dt>
            <dd className="sidebar__identity-organization" data-testid="shell-organization">{organization.name}</dd>
            <dt className="visually-hidden">{t('shell.user')}</dt>
            <dd className="sidebar__identity-user" data-testid="shell-user">
              {profile.displayName} · {role}
            </dd>
          </dl>
          <div
            className="locale-switch"
            role="group"
            aria-label={t('common.language')}
          >
            {SUPPORTED_LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                className="locale-switch__option"
                aria-pressed={locale === option}
                onClick={() => void setLocale(option)}
              >
                {t(`language.${option}`)}
              </button>
            ))}
          </div>
          <button type="button" className="button button--small" onClick={() => void onSignOut()}>
            {t('cloudAuth.signOut')}
          </button>
        </div>
      </aside>

      <main className="shell__main">
        {children}
      </main>
    </div>
  )
}
