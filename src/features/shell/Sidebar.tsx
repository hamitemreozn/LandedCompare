/**
 * The navigation rail: brand, primary navigation, and an edge-mounted
 * collapse handle that belongs to neither.
 *
 * Visual Polish Round 1 (§2–§4) moved identity/organisation/locale/sign-out
 * out of the sidebar footer into `AccountMenu` (rendered from `Topbar`) and
 * removed the full-width "Kenar çubuğunu daralt" row — a text nav row reads
 * as a destination, which collapsing the rail is not. The collapse control
 * itself then moved three more times: docked to the sidebar/content boundary
 * (Round 1) read as too easy to miss; the topbar (Round 2, before the
 * breadcrumb) pushed the breadcrumb rightward and broke its alignment with
 * the page title below it; inside the brand row itself (Round 3) truncated
 * "LandedCompare" to make room for it and, collapsed, stacked awkwardly under
 * the mark. Round 4's fix is the same boundary-docked idea as Round 1, with
 * the actual problem fixed instead of the location changed again: it's a
 * light `--surface-elevated` disc overlapping the sidebar/content edge, not
 * a dark control blending into the dark rail it sat on — see
 * `.sidebar__collapse-toggle` in `components.css`. It is a sibling of
 * `.sidebar__scroll`, not a child of `.brand`, specifically so it cannot
 * affect the brand row's own layout or width again.
 *
 * ## Future sections are shown, and shown as unavailable
 *
 * Quote analysis, purchasing, shipments, inventory and settings appear in the
 * rail as disabled entries carrying the word "later" (`nav.comingSoon`). The
 * alternative — an empty rail that grows by surprise — hides the shape of the
 * product from the person who is going to use it, and the alternative to
 * *that* — a working-looking link to a stub screen — is worse still: a
 * section that opens and does nothing is indistinguishable from one that is
 * broken. They are rendered as `<span>`s with `aria-disabled`, not as links
 * or buttons, so they are read as labels rather than offered as controls.
 *
 * ## One markup for both widths
 *
 * Collapsing the rail never swaps in a second, icon-only navigation list.
 * Every label stays in the DOM — `.nav__label` — and collapsed mode only
 * clips it visually (`.sidebar--collapsed .nav__label`, `src/ui/components.css`),
 * the same technique `.visually-hidden` uses elsewhere. That keeps each
 * control's accessible name correct in both states without a second source of
 * truth, and `Tooltip` (`src/ui/Tooltip.tsx`) surfaces that same label
 * on hover/focus once collapsed.
 */
import { type ReactElement, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type { RouteId } from '../../app/routes'
import { AppIconTile } from '../../ui/Brand'
import { Icons } from '../../ui/icons'
import { Tooltip } from '../../ui/Tooltip'
import { FUTURE_NAV_ITEMS, NAV_GROUPS } from './navigation'

function CollapsibleTooltip({
  collapsed,
  label,
  children,
}: {
  readonly collapsed: boolean
  readonly label: string
  readonly children: ReactElement<{
    'aria-describedby'?: string
    onFocus?: (e: React.FocusEvent) => void
    onBlur?: (e: React.FocusEvent) => void
    onMouseEnter?: (e: React.MouseEvent) => void
    onMouseLeave?: (e: React.MouseEvent) => void
  }>
}) {
  return collapsed ? <Tooltip content={label}>{children}</Tooltip> : children
}

export function Sidebar({
  route,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
  closeButtonRef,
  inert,
}: {
  readonly route: RouteId
  readonly collapsed: boolean
  readonly onToggleCollapse: () => void
  readonly mobileOpen: boolean
  readonly onCloseMobile: () => void
  readonly closeButtonRef: Ref<HTMLButtonElement>
  /** F12.7-01: true only below the drawer breakpoint while it's closed — see `AppShell.tsx`. */
  readonly inert?: boolean
}) {
  const { t } = useTranslation()
  const CollapseIcon = collapsed ? Icons.expandSidebar : Icons.collapseSidebar
  const collapseLabel = t(collapsed ? 'shell.expandSidebar' : 'shell.collapseSidebar')

  return (
    <aside
      id="app-sidebar"
      className={[
        'sidebar',
        collapsed ? 'sidebar--collapsed' : '',
        mobileOpen ? 'sidebar--mobile-open' : '',
      ].filter(Boolean).join(' ')}
      inert={inert}
    >
      <div className="sidebar__scroll">
        <div className="brand">
          <span className="brand__mark">
            <AppIconTile />
          </span>
          <span className="brand__name nav__label">{t('common.appName')}</span>
          {/* Mobile-only (hidden under 900px, see components.css) — the
              desktop collapse handle below is its counterpart, but lives
              outside this row entirely rather than beside it. */}
          <button
            ref={closeButtonRef}
            type="button"
            className="sidebar__mobile-close"
            aria-label={t('shell.closeMenu')}
            onClick={onCloseMobile}
          >
            <Icons.close size={18} aria-hidden="true" />
          </button>
        </div>

        <nav className="nav" aria-label={t('nav.primaryLabel')}>
          {NAV_GROUPS.map((group) => (
            <div className="nav__group" key={group.headingKey}>
              <h2 className="nav__heading">{t(group.headingKey)}</h2>
              {group.items.map((item) => {
                const Icon = item.icon
                const active = route === item.id
                return (
                  <CollapsibleTooltip key={item.id} collapsed={collapsed} label={t(item.labelKey)}>
                    <a
                      className="nav__link"
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      onClick={onCloseMobile}
                    >
                      <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="nav__icon" />
                      <span className="nav__label">{t(item.labelKey)}</span>
                    </a>
                  </CollapsibleTooltip>
                )
              })}
            </div>
          ))}

          <div className="nav__group">
            <h2 className="nav__heading">{t('nav.operations')}</h2>
            {FUTURE_NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <CollapsibleTooltip key={item.labelKey} collapsed={collapsed} label={t(item.labelKey)}>
                  <span className="nav__link nav__link--disabled" aria-disabled="true" title={t('nav.notAvailableYet')}>
                    <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="nav__icon" />
                    <span className="nav__label">{t(item.labelKey)}</span>
                    <span className="nav__soon">{t('nav.comingSoon')}</span>
                  </span>
                </CollapsibleTooltip>
              )
            })}
          </div>
        </nav>
      </div>

      {/*
        This wrapper, not the button itself, carries the absolute
        positioning against `.sidebar`'s boundary. `Tooltip` wraps its
        trigger in its own `position: relative` span (`.tooltip-anchor`,
        `src/ui/Tooltip.tsx`) — putting `position: absolute` on the button
        directly made THAT span the button's containing block instead of
        `.sidebar`, and since that span sits in normal flow as a sibling
        after the 100vh-tall `.sidebar__scroll`, the button rendered near
        the bottom of the document, not the sidebar's edge. Positioning this
        outer wrapper instead keeps Tooltip's own internal positioning
        self-contained inside a box that is already correctly placed.
      */}
      <div className="sidebar__collapse-toggle-wrap">
        <Tooltip content={collapseLabel} side="right">
          <button
            type="button"
            className="sidebar__collapse-toggle"
            aria-label={collapseLabel}
            aria-pressed={collapsed}
            onClick={onToggleCollapse}
          >
            <CollapseIcon size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </aside>
  )
}
