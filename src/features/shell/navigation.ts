/**
 * The single source of navigation truth for the shell.
 *
 * Sidebar (expanded and collapsed), breadcrumb, and the shell's tests all read
 * from this one model rather than each keeping its own copy of the route list,
 * its labels, and its icon. Adding a screen, or renaming one, is a change in
 * exactly one place.
 */
import type { LucideIcon } from 'lucide-react'
import { hrefFor, type RouteId } from '../../app/routes'
import { Icons } from '../../ui/icons'

export interface NavItem {
  readonly id: RouteId
  readonly labelKey: string
  readonly icon: LucideIcon
  readonly href: string
}

export interface NavGroup {
  readonly headingKey: string
  readonly items: readonly NavItem[]
}

/** A section named in the rail but not yet reachable — see AppShell's header comment. */
export interface FutureNavItem {
  readonly labelKey: string
  readonly icon: LucideIcon
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    headingKey: 'nav.masterData',
    items: [
      { id: 'dashboard', labelKey: 'nav.dashboard', icon: Icons.dashboard, href: hrefFor('dashboard') },
      { id: 'products', labelKey: 'nav.products', icon: Icons.products, href: hrefFor('products') },
      { id: 'suppliers', labelKey: 'nav.suppliers', icon: Icons.suppliers, href: hrefFor('suppliers') },
      { id: 'customers', labelKey: 'nav.customers', icon: Icons.customers, href: hrefFor('customers') },
      {
        id: 'customer-statuses',
        labelKey: 'nav.customerStatuses',
        icon: Icons.customerStatuses,
        href: hrefFor('customer-statuses'),
      },
    ],
  },
  {
    headingKey: 'nav.administration',
    items: [
      { id: 'organization', labelKey: 'nav.organization', icon: Icons.organization, href: hrefFor('organization') },
    ],
  },
]

export const FUTURE_NAV_ITEMS: readonly FutureNavItem[] = [
  { labelKey: 'nav.quoteAnalysis', icon: Icons.quotes },
  { labelKey: 'nav.purchases', icon: Icons.purchasing },
  { labelKey: 'nav.shipments', icon: Icons.outbound },
  { labelKey: 'nav.inventory', icon: Icons.inventory },
  { labelKey: 'nav.settings', icon: Icons.settings },
]

const ALL_NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

/** The label key for the current route's breadcrumb — falls back to the dashboard's, matching `routeFromHash`. */
export function labelKeyForRoute(route: RouteId): string {
  return ALL_NAV_ITEMS.find((item) => item.id === route)?.labelKey ?? 'nav.dashboard'
}

/** The heading key of the nav group the current route belongs to, for the breadcrumb's leading crumb. */
export function groupHeadingKeyForRoute(route: RouteId): string | undefined {
  return NAV_GROUPS.find((group) => group.items.some((item) => item.id === route))?.headingKey
}
