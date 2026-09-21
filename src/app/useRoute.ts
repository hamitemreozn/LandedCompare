import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_ROUTE, hrefFor, routeFromHash, type RouteId } from './routes'

/**
 * The current route, kept in step with the address bar in both directions.
 *
 * `hashchange` covers the cases a click handler cannot: the back button, the
 * forward button, a pasted URL and a reload. Navigating by assigning the hash
 * rather than by setting state first means the URL is always the single
 * source of truth — there is no window in which the address bar and the
 * rendered screen disagree.
 */
export function useRoute(): { route: RouteId; navigate: (route: RouteId) => void } {
  const [route, setRoute] = useState<RouteId>(() =>
    typeof window === 'undefined' ? DEFAULT_ROUTE : routeFromHash(window.location.hash),
  )

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    // The hash may have changed between the initial state and this effect.
    onHashChange()
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: RouteId) => {
    window.location.hash = hrefFor(next)
  }, [])

  return { route, navigate }
}
