/**
 * Routing, in about forty lines and with no dependency.
 *
 * ## Why not a router library
 *
 * There are four screens, none of them nested, none of them parameterised,
 * and none of them loading data from a URL segment. A router brings a
 * matcher, a link component, a history abstraction and an outlet tree to solve
 * a problem that is currently "which of four words is in `location.hash`". The
 * dependency budget for this phase is better spent elsewhere, and the moment a
 * real routing need appears — a product detail URL, a nested editor — this
 * file is small enough to delete rather than work around.
 *
 * ## Why the hash, and not the History API
 *
 * `history.pushState` produces paths like `/products`, and a browser asked to
 * *reload* that path requests `/products` from the server. A dev server or a
 * static host answers 404 unless it is configured to rewrite every unknown
 * path to `index.html`. The pilot is a local application whose deployment is
 * "open it and it works", and a routing choice that quietly depends on server
 * configuration is a routing choice that breaks the day it is opened from
 * somewhere else.
 *
 * The hash never reaches a server, so `#/products` reloads into the products
 * screen from any host, including `file://`. Routing remains independent of
 * the cloud boot and catalogue gateway.
 */

export const ROUTE_IDS = ['dashboard', 'products', 'suppliers', 'customers', 'customer-statuses', 'organization'] as const

export type RouteId = (typeof ROUTE_IDS)[number]

export const DEFAULT_ROUTE: RouteId = 'dashboard'

export function hrefFor(route: RouteId): string {
  return `#/${route}`
}

/**
 * Reads a route from a hash, falling back to the dashboard.
 *
 * An unknown hash is not an error and is not a "404 screen": this is a local
 * application with four screens, and the only realistic way to arrive at an
 * unrecognised one is a stale bookmark or a typo. Landing on the overview is
 * the useful answer to both.
 */
export function routeFromHash(hash: string): RouteId {
  const candidate = hash.replace(/^#\/?/, '')
  return (ROUTE_IDS as readonly string[]).includes(candidate)
    ? (candidate as RouteId)
    : DEFAULT_ROUTE
}
