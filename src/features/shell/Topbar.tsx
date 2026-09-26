/**
 * The topbar: breadcrumb (and, only on narrow viewports, the mobile drawer
 * trigger) on the left, the account control on the right.
 *
 * Visual Polish Round 1 moved identity/organisation/locale/sign-out here from
 * the sidebar footer, behind one `AccountMenu` disclosure (see its own header
 * comment) — a permanent full-width block for something used a few times a
 * session read as a navigation destination, and this is the one place those
 * controls now live, not duplicated between sidebar and topbar.
 *
 * Round 2, §5 moved the desktop sidebar's collapse control here, before the
 * breadcrumb. Round 3, §1 moved it back out, into the sidebar's own brand row
 * (`Sidebar.tsx`) — sitting here pushed the breadcrumb rightward by the
 * control's own width, breaking its alignment with the page title below
 * (§2), and it reads more like shell chrome for the rail than for the page.
 * The topbar's left edge is the breadcrumb, full stop, on desktop; the
 * mobile menu trigger is the one exception, since below the width the rail
 * becomes an off-canvas drawer it has nowhere else to live.
 *
 * `.topbar__inner` mirrors `.page`'s own
 * `max-width`/`margin-inline`/`padding-inline` exactly, so the breadcrumb and
 * the page title share a left edge at every viewport width — see that rule's
 * own comment in `components.css`.
 */
import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type { RouteId } from '../../app/routes'
import type { SupportedLocale } from '../../i18n'
import { Icons } from '../../ui/icons'
import { AccountMenu } from './AccountMenu'
import { Breadcrumbs } from './Breadcrumbs'

export function Topbar({
  route,
  onOpenMobileNav,
  menuTriggerRef,
  mobileOpen,
  organizationName,
  userDisplayName,
  role,
  locale,
  onSignOut,
  onSwitchOrganization,
  canSwitchOrganization,
}: {
  readonly route: RouteId
  readonly onOpenMobileNav: () => void
  readonly menuTriggerRef: Ref<HTMLButtonElement>
  readonly mobileOpen: boolean
  readonly organizationName: string
  readonly userDisplayName: string
  readonly role: string
  readonly locale: SupportedLocale
  readonly onSignOut: () => Promise<void>
  readonly onSwitchOrganization?: () => void
  readonly canSwitchOrganization: boolean
}) {
  const { t } = useTranslation()
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <div className="topbar__leading">
          <button
            ref={menuTriggerRef}
            type="button"
            className="topbar__menu-trigger"
            aria-label={t('shell.openMenu')}
            aria-haspopup="true"
            aria-expanded={mobileOpen}
            aria-controls="app-sidebar"
            onClick={onOpenMobileNav}
          >
            <Icons.menu size={20} aria-hidden="true" />
          </button>
          <Breadcrumbs route={route} />
        </div>
        <AccountMenu
          organizationName={organizationName}
          userDisplayName={userDisplayName}
          role={role}
          locale={locale}
          onSignOut={onSignOut}
          onSwitchOrganization={onSwitchOrganization}
          canSwitchOrganization={canSwitchOrganization}
        />
      </div>
    </header>
  )
}
