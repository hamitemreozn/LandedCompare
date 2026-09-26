/**
 * The application shell: sidebar, topbar, breadcrumb, and the app-level
 * advisories that have to be visible from every screen.
 *
 * Composed from `Sidebar`, `Topbar` and `Breadcrumbs` — see their own header
 * comments for what each owns. This file's own job is the parts that don't
 * belong to any one of them: the desktop sidebar's collapse preference
 * (`useSidebarCollapsed`), the mobile drawer's open/close/focus lifecycle, and
 * the runtime data (`useAppRuntime`) that both `Sidebar` and the advisories
 * below need.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RouteId } from '../../app/routes'
import { useAppRuntime } from '../../app/runtime'
import type { SupportedLocale } from '../../i18n'
import { Banner } from '../../ui/Feedback'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { useIsMobileViewport } from './useIsMobileViewport'
import { useSidebarCollapsed } from './useSidebarCollapsed'

export function AppShell({
  route,
  locale,
  onSignOut,
  onSwitchOrganization,
  children,
}: {
  readonly route: RouteId
  readonly locale: SupportedLocale
  readonly onSignOut: () => Promise<void>
  /** Present only when the user may enter more than one company. */
  readonly onSwitchOrganization?: () => void
  readonly children: ReactNode
}) {
  const { t } = useTranslation()
  const { organization, profile, role, choices, previousSelectionUnavailable } = useAppRuntime()
  const { collapsed, toggle } = useSidebarCollapsed()
  const isMobile = useIsMobileViewport()

  const [mobileOpen, setMobileOpen] = useState(false)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const wasMobileOpen = useRef(false)

  const openMobile = useCallback(() => setMobileOpen(true), [])
  const closeMobile = useCallback(() => setMobileOpen(false), [])

  // Moves focus into the drawer once it opens, so a keyboard/AT user who
  // triggered it isn't left with focus behind an off-canvas panel. On close,
  // restores it to the trigger — but only after this render commits, once
  // `shell__main`'s `inert` (F12.7-01) has actually been lifted; focusing it
  // any earlier is a silent no-op, since a browser refuses to focus anything
  // inside an inert subtree. The `wasMobileOpen` ref (rather than depending on
  // `mobileOpen` alone) is what keeps this from stealing focus on first mount,
  // when the drawer was never open to begin with.
  useEffect(() => {
    if (mobileOpen) {
      closeButtonRef.current?.focus()
    } else if (wasMobileOpen.current) {
      menuTriggerRef.current?.focus()
    }
    wasMobileOpen.current = mobileOpen
  }, [mobileOpen])

  useEffect(() => {
    if (!mobileOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMobile()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mobileOpen, closeMobile])

  // A route change — from a nav click, the back button, or a pasted URL —
  // always closes the mobile drawer, without every navigation path having to
  // remember to call closeMobile itself.
  useEffect(() => {
    setMobileOpen(false)
  }, [route])

  return (
    <div className="shell">
      {mobileOpen ? (
        <div className="shell__backdrop" aria-hidden="true" onClick={closeMobile} />
      ) : null}
      <Sidebar
        route={route}
        collapsed={collapsed}
        onToggleCollapse={toggle}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
        closeButtonRef={closeButtonRef}
        // F12.7-01: below the drawer breakpoint, a closed sidebar is
        // off-canvas in appearance only — `transform: translateX(-100%)`
        // leaves it fully present in the accessibility tree and tab order.
        // `inert` (native, no focus-trap library needed) removes it from
        // both while closed. Never applied on desktop, where the rail is
        // part of the permanent layout, not a drawer.
        inert={isMobile && !mobileOpen}
      />

      <div
        className="shell__main"
        // The other half of the same fix: while the mobile drawer is open,
        // the page behind it must not be reachable by Tab or AT — inert
        // gives both for free, which is also what contains keyboard focus
        // inside the drawer without a hand-rolled sentinel-based trap.
        inert={isMobile && mobileOpen}
      >
        <Topbar
          route={route}
          onOpenMobileNav={openMobile}
          menuTriggerRef={menuTriggerRef}
          mobileOpen={mobileOpen}
          organizationName={organization.name}
          userDisplayName={profile.displayName}
          role={role}
          locale={locale}
          onSignOut={onSignOut}
          onSwitchOrganization={onSwitchOrganization}
          canSwitchOrganization={onSwitchOrganization !== undefined && choices.length > 1}
        />
        <main className="shell__content">
          {previousSelectionUnavailable ? (
            <Banner tone="warning" label={t('common.warning')}>
              {t('shell.previousSelectionUnavailable', { organization: organization.name })}
            </Banner>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  )
}
