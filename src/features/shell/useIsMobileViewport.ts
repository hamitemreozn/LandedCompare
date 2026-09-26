/**
 * Whether the viewport is at or below the shell's mobile breakpoint — the
 * same `900px` the CSS off-canvas drawer rule uses (`components.css`,
 * `@media (max-width: 900px)`), read here in JS so `AppShell` can decide
 * *when* to apply `inert` to the sidebar/content (F12.7-01): only at the
 * breakpoint the drawer actually exists at, never on desktop, where the
 * sidebar is a permanent part of the layout rather than an off-canvas panel.
 *
 * `AppShell` (and so this hook) also renders inside `matchMedia`-less DOM
 * environments that are not this project's own jsdom test setup — the
 * behavioural security suite's `@vitest-environment jsdom` files render the
 * real `App` without `src/test/setup.ts`'s polyfills, on purpose: they are
 * proving server-side authorisation, not shell UI, and shouldn't inherit this
 * project's whole jsdom fixture set to do it. `false` (never mobile, `inert`
 * never applied) is the correct fallback there — those tests never resize a
 * viewport, and default AppShell behaviour is desktop.
 */
import { useEffect, useState } from 'react'

const MOBILE_QUERY = '(max-width: 900px)'

function hasMatchMedia(): boolean {
  return typeof window.matchMedia === 'function'
}

export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() => hasMatchMedia() && window.matchMedia(MOBILE_QUERY).matches)

  useEffect(() => {
    if (!hasMatchMedia()) return
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
