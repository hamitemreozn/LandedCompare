/**
 * The breadcrumb: names the current screen, and the nav group it belongs to,
 * for orientation and for assistive technology.
 *
 * The application has no real Home/Section hierarchy above its top-level
 * screens (`src/app/routes.ts`) — only the sidebar's existing nav groups
 * (Ana Veriler / Yönetim / Operasyon). The leading crumb borrows those group
 * headings rather than inventing a `Home > Section > Screen` trail that
 * doesn't exist, and is never a link: none of the groups is itself a route.
 * A route with no group (there isn't one today, but `groupHeadingKeyForRoute`
 * can return `undefined`) simply omits the leading crumb.
 */
import { useTranslation } from 'react-i18next'
import type { RouteId } from '../../app/routes'
import { Icons } from '../../ui/icons'
import { groupHeadingKeyForRoute, labelKeyForRoute } from './navigation'

export function Breadcrumbs({ route }: { readonly route: RouteId }) {
  const { t } = useTranslation()
  const groupHeadingKey = groupHeadingKeyForRoute(route)

  return (
    <nav className="breadcrumb" aria-label={t('shell.breadcrumbLabel')}>
      <ol className="breadcrumb__list">
        {groupHeadingKey !== undefined ? (
          <li className="breadcrumb__item breadcrumb__item--group">
            {t(groupHeadingKey)}
            <Icons.chevronRight size={14} aria-hidden="true" className="breadcrumb__separator" />
          </li>
        ) : null}
        <li className="breadcrumb__item breadcrumb__item--current" aria-current="page">
          {t(labelKeyForRoute(route))}
        </li>
      </ol>
    </nav>
  )
}
