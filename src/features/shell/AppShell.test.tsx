/**
 * Phase 12.7 shell behaviour that doesn't already have coverage in
 * `src/App.test.tsx`: sidebar collapse (and its persistence), the mobile
 * drawer's open/close/Escape/route-close lifecycle, the breadcrumb, and (from
 * Visual Polish Round 1) the account menu that replaced the sidebar's
 * identity/locale/sign-out footer. Round 2 fixed the collapsed-tooltip-
 * stuck-after-click bug and removed the avatar; Round 3 moved the collapse
 * control from the topbar into the sidebar's own brand row (§1) and widened
 * the content grid when collapsed (§3). Navigation between screens,
 * active-state `aria-current`, keyboard reach and the removed tagline are
 * covered in `src/App.test.tsx`, through the same real `App` + in-memory
 * cloud harness.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { goTo, openAccountMenu, renderApp, type AppHarness } from '../../test/appHarness'
import { SIDEBAR_COLLAPSED_KEY } from './useSidebarCollapsed'

function tooltipFor(control: HTMLElement): HTMLElement {
  const id = control.getAttribute('aria-describedby')
  expect(id).not.toBeNull()
  const tooltip = document.getElementById(id!)
  expect(tooltip).not.toBeNull()
  return tooltip!
}

const DESKTOP_WIDTH = 1024
const MOBILE_WIDTH = 500

/** Drives `useIsMobileViewport` the same way a real window resize would. */
function setViewportWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px })
  window.dispatchEvent(new Event('resize'))
}

let harness: AppHarness | undefined

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  await harness?.destroy()
  harness = undefined
  setViewportWidth(DESKTOP_WIDTH)
})

describe('the desktop sidebar collapse preference', () => {
  it('starts expanded, with every nav label reachable by name', async () => {
    harness = await renderApp({ locale: 'en' })

    expect(screen.getByRole('link', { name: 'Products' })).toBeInTheDocument()
    expect(document.querySelector('.sidebar')).not.toHaveClass('sidebar--collapsed')
  })

  it('collapses on the toggle, keeps every link reachable by its accessible name, and persists the choice', async () => {
    harness = await renderApp({ locale: 'en' })

    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    await harness.user.click(toggle)

    expect(document.querySelector('.sidebar')).toHaveClass('sidebar--collapsed')
    // The label text is clipped, not removed — the link keeps its name.
    expect(screen.getByRole('link', { name: 'Products' })).toBeInTheDocument()
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1')

    await harness.remount()
    expect(document.querySelector('.sidebar')).toHaveClass('sidebar--collapsed')
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('expands again on a second toggle', async () => {
    harness = await renderApp({ locale: 'en' })
    await harness.user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    await harness.user.click(screen.getByRole('button', { name: 'Expand sidebar' }))

    expect(document.querySelector('.sidebar')).not.toHaveClass('sidebar--collapsed')
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0')
  })
})

describe('the breadcrumb', () => {
  it('names the current screen and marks it current', async () => {
    harness = await renderApp({ locale: 'en' })
    await goTo(harness, 'Suppliers', 'Suppliers')

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    const current = breadcrumb.querySelector('[aria-current="page"]')
    expect(current).not.toBeNull()
    expect(current).toHaveTextContent('Suppliers')
  })

  it('leads with the route\'s nav group, as non-clickable context', async () => {
    harness = await renderApp({ locale: 'en' })
    await goTo(harness, 'Suppliers', 'Suppliers')

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(breadcrumb).toHaveTextContent('Master data')
    expect(breadcrumb.querySelector('a')).toBeNull()

    await goTo(harness, 'Company', 'Company')
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Administration')
  })
})

describe('the account menu', () => {
  it('shows organisation and user in the topbar without needing to open it', async () => {
    harness = await renderApp({ locale: 'en' })
    const trigger = screen.getByRole('button', { name: 'Account menu' })
    expect(trigger).toHaveTextContent('Test Owner')
    expect(trigger).toHaveTextContent('Test Company')
  })

  it('is closed by default: no permanently visible language control, no full-width collapse row', async () => {
    harness = await renderApp({ locale: 'en' })

    expect(screen.queryByRole('button', { name: 'English' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Türkçe' })).toBeNull()
    // No full-width text row anywhere collapse has lived, and no leftover
    // control in either of its two earlier, since-abandoned homes — the
    // current (edge-handle) control is checked in its own describe block.
    expect(document.querySelector('.sidebar__footer')).toBeNull()
    expect(document.querySelector('.brand__collapse-toggle')).toBeNull()
    expect(document.querySelector('.topbar__collapse-trigger')).toBeNull()
  })

  it('shows no letter-initial avatar', async () => {
    harness = await renderApp({ locale: 'en' })
    const trigger = screen.getByRole('button', { name: 'Account menu' })

    expect(trigger.querySelector('.account-menu__avatar')).toBeNull()
    // The narrow-viewport fallback icon exists but is not what desktop shows.
    expect(trigger.querySelector('.account-menu__icon')).not.toBeNull()
  })

  it('opens on the trigger and closes on Escape, returning focus to the trigger', async () => {
    harness = await renderApp({ locale: 'en' })
    const trigger = screen.getByRole('button', { name: 'Account menu' })

    await harness.user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument()

    await harness.user.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'English' })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('switches language from inside the menu', async () => {
    harness = await renderApp({ locale: 'tr' })
    await openAccountMenu(harness)
    await harness.user.click(screen.getByRole('button', { name: 'English' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
  })

  it('signs out from inside the menu', async () => {
    harness = await renderApp({ locale: 'en' })
    await openAccountMenu(harness)
    await harness.user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })
})

describe('the sidebar edge-handle collapse control', () => {
  it('sits on the sidebar boundary, outside the brand row, not the topbar', async () => {
    harness = await renderApp({ locale: 'en' })
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })

    expect(toggle).toHaveClass('sidebar__collapse-toggle')
    expect(toggle.closest('.sidebar')).not.toBeNull()
    // Not inside the brand row — Round 3's placement there truncated the
    // wordmark to make room for it; Round 4 moved it out for good.
    expect(toggle.closest('.brand')).toBeNull()
    // Not inside the scrolling nav content either — a sibling of it, so it
    // can't affect the nav column's own width calculation.
    expect(toggle.closest('.sidebar__scroll')).toBeNull()
    expect(toggle.closest('.topbar')).toBeNull()

    // The topbar's leading slot is the breadcrumb alone on desktop (the
    // mobile drawer trigger is hidden there — see the mobile-viewport tests).
    const leading = screen.getByRole('navigation', { name: 'Breadcrumb' }).closest('.topbar__leading')
    expect(leading).not.toBeNull()
    expect(within(leading as HTMLElement).queryByRole('button', { name: /Collapse sidebar|Expand sidebar/ })).toBeNull()
  })

  // The handle sits flush against the top of the shell, where a
  // top-opening tooltip (Tooltip's default) gets clipped by the viewport
  // edge. It must request `side="right"` instead — see `Tooltip.tsx`'s own
  // "Placement" comment and `Tooltip.test.tsx` for the primitive-level
  // behaviour this only has to confirm is actually wired up here.
  it("its tooltip opens to the right, not above (avoids viewport-top clipping)", async () => {
    harness = await renderApp({ locale: 'en' })
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    const tooltip = document.getElementById(toggle.getAttribute('aria-describedby')!)
    expect(tooltip).toHaveAttribute('data-side', 'right')

    // Holds in the collapsed state too — same trigger, same tooltip.
    await harness.user.click(toggle)
    const expandToggle = screen.getByRole('button', { name: 'Expand sidebar' })
    const expandTooltip = document.getElementById(expandToggle.getAttribute('aria-describedby')!)
    expect(expandTooltip).toHaveAttribute('data-side', 'right')
  })

  // jsdom does no layout, so this cannot check the rendered pixel position —
  // but it does check the specific structural bug that put the button at
  // the bottom of the document in the browser: `Tooltip` wraps its trigger
  // in a `position: relative` span (`.tooltip-anchor`), which becomes the
  // nearest positioned ancestor — and therefore the containing block — for
  // anything `position: absolute` inside it. Positioning
  // `.sidebar__collapse-toggle-wrap` (a sibling of `.tooltip-anchor`'s own
  // parent) rather than the button itself keeps `.sidebar` as the
  // containing block instead.
  it('the positioned element is an ancestor of, not the same node as, Tooltip\'s own relative anchor', async () => {
    harness = await renderApp({ locale: 'en' })
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })

    const tooltipAnchor = toggle.closest('.tooltip-anchor')
    expect(tooltipAnchor).not.toBeNull()
    expect(tooltipAnchor).not.toHaveClass('sidebar__collapse-toggle-wrap')

    const wrap = toggle.closest('.sidebar__collapse-toggle-wrap')
    expect(wrap).not.toBeNull()
    // The wrap contains the tooltip anchor, not the other way around — so
    // the wrap's own `position: absolute` is what resolves against
    // `.sidebar`, unaffected by the anchor span nested inside it.
    expect(wrap!.contains(tooltipAnchor)).toBe(true)
    expect(wrap!.parentElement).toHaveClass('sidebar')
  })

  it('does not truncate or otherwise touch the expanded wordmark', async () => {
    harness = await renderApp({ locale: 'en' })
    const brand = document.querySelector('.brand') as HTMLElement
    expect(within(brand).getByText('LandedCompare')).toBeInTheDocument()
    // The handle is not a descendant of .brand at all (checked above); this
    // just re-confirms the wordmark text itself is exactly the app name,
    // never truncated/ellipsised by markup.
    expect(brand.querySelector('.brand__collapse-toggle')).toBeNull()
  })

  it('collapsed, the brand row holds only the mark (plus the mobile close button) — no stacked collapse control', async () => {
    harness = await renderApp({ locale: 'en' })
    await harness.user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

    const brand = document.querySelector('.brand') as HTMLElement
    expect(brand.querySelector('.sidebar__collapse-toggle')).toBeNull()
    expect(brand.querySelector('.brand__collapse-toggle')).toBeNull()
  })

  it('flips its accessible label with the collapsed state', async () => {
    harness = await renderApp({ locale: 'en' })
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })

    await harness.user.click(toggle)
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBe(toggle)
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull()

    await harness.user.click(toggle)
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBe(toggle)
  })
})

describe('collapsed sidebar tooltips', () => {
  it('does not stay stuck after a pointer click, without needing a click elsewhere', async () => {
    harness = await renderApp({ locale: 'en' })
    await harness.user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

    const link = screen.getByRole('link', { name: 'Products' })
    const tooltip = tooltipFor(link)

    await harness.user.hover(link)
    expect(tooltip).toHaveAttribute('data-visible', 'true')

    // Clicking (while hovering — exactly the reported sequence) must not
    // leave it open once the pointer subsequently leaves.
    await harness.user.click(link)
    await harness.user.unhover(link)
    await waitFor(() => expect(tooltip).not.toHaveAttribute('data-visible', 'true'))
  })

  it('still shows on keyboard (Tab) focus, and hides when focus moves away', async () => {
    harness = await renderApp({ locale: 'en' })
    await harness.user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

    const link = screen.getByRole('link', { name: 'Products' })
    const tooltip = tooltipFor(link)

    link.focus()
    await waitFor(() => expect(tooltip).toHaveAttribute('data-visible', 'true'))

    link.blur()
    await waitFor(() => expect(tooltip).not.toHaveAttribute('data-visible', 'true'))
  })
})

describe('the mobile navigation drawer', () => {
  it('opens from the topbar trigger and closes on the backdrop', async () => {
    harness = await renderApp({ locale: 'en' })

    expect(document.querySelector('.sidebar')).not.toHaveClass('sidebar--mobile-open')
    await harness.user.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(document.querySelector('.sidebar')).toHaveClass('sidebar--mobile-open')

    const backdrop = document.querySelector('.shell__backdrop')
    expect(backdrop).not.toBeNull()
    await harness.user.click(backdrop as Element)
    expect(document.querySelector('.sidebar')).not.toHaveClass('sidebar--mobile-open')
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    harness = await renderApp({ locale: 'en' })
    const trigger = screen.getByRole('button', { name: 'Open menu' })
    await harness.user.click(trigger)
    expect(document.querySelector('.sidebar')).toHaveClass('sidebar--mobile-open')

    await harness.user.keyboard('{Escape}')
    expect(document.querySelector('.sidebar')).not.toHaveClass('sidebar--mobile-open')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('closes when a route is selected from inside it', async () => {
    harness = await renderApp({ locale: 'en' })
    await harness.user.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(document.querySelector('.sidebar')).toHaveClass('sidebar--mobile-open')

    await harness.user.click(screen.getByRole('link', { name: 'Suppliers' }))
    await waitFor(() => expect(document.querySelector('.sidebar')).not.toHaveClass('sidebar--mobile-open'))
  })
})

describe('F12.7-01 — mobile drawer accessibility', () => {
  it('on desktop, neither the sidebar nor the content is ever made inert, whichever drawer state the app happens to be in', async () => {
    harness = await renderApp({ locale: 'en' }) // default jsdom width, 1024 — above the 900px breakpoint
    const sidebar = document.getElementById('app-sidebar')!
    const main = document.querySelector('.shell__main')!

    expect(sidebar).not.toHaveAttribute('inert')
    expect(main).not.toHaveAttribute('inert')

    await harness.user.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(sidebar).not.toHaveAttribute('inert')
    expect(main).not.toHaveAttribute('inert')
  })

  it('at the mobile breakpoint, a closed drawer is genuinely inert: unfocusable and structurally hidden from assistive tech', async () => {
    setViewportWidth(MOBILE_WIDTH)
    harness = await renderApp({ locale: 'en' })
    const sidebar = document.getElementById('app-sidebar')!

    // The real mechanism the accessibility tree and tab order are built
    // from — not a CSS class standing in for it.
    expect(sidebar).toHaveAttribute('inert')

    const hiddenLink = within(sidebar).getByRole('link', { name: 'Suppliers' })
    hiddenLink.focus()
    expect(document.activeElement).not.toBe(hiddenLink)
  })

  it('the trigger reports aria-expanded and aria-controls, flipping with drawer state', async () => {
    setViewportWidth(MOBILE_WIDTH)
    harness = await renderApp({ locale: 'en' })
    const trigger = screen.getByRole('button', { name: 'Open menu' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-controls', 'app-sidebar')

    await harness.user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('open, the background becomes inert: it cannot take focus, and Tab/Shift+Tab never land there', async () => {
    setViewportWidth(MOBILE_WIDTH)
    harness = await renderApp({ locale: 'en' })
    const main = document.querySelector('.shell__main')!
    await harness.user.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(main).toHaveAttribute('inert')

    const backgroundControl = within(main as HTMLElement).getByRole('button', { name: 'Account menu' })
    backgroundControl.focus()
    expect(document.activeElement).not.toBe(backgroundControl)

    for (let i = 0; i < 6; i++) {
      await harness.user.tab()
      expect(main.contains(document.activeElement)).toBe(false)
    }
    for (let i = 0; i < 6; i++) {
      await harness.user.tab({ shift: true })
      expect(main.contains(document.activeElement)).toBe(false)
    }
  })

  it('switching viewport from mobile to desktop mid-session lifts inert from the sidebar and leaves navigation usable', async () => {
    setViewportWidth(MOBILE_WIDTH)
    harness = await renderApp({ locale: 'en' })
    const sidebar = document.getElementById('app-sidebar')!
    expect(sidebar).toHaveAttribute('inert')

    setViewportWidth(DESKTOP_WIDTH)
    await waitFor(() => expect(sidebar).not.toHaveAttribute('inert'))
    expect(document.querySelector('.shell__main')).not.toHaveAttribute('inert')

    const link = within(sidebar).getByRole('link', { name: 'Suppliers' })
    link.focus()
    expect(document.activeElement).toBe(link)
  })
})

describe('the shell without a company switch', () => {
  it('still shows the current organisation and user, unchanged in meaning', async () => {
    harness = await renderApp({ locale: 'en' })
    expect(screen.getByTestId('shell-organization')).toHaveTextContent('Test Company')
    expect(screen.getByTestId('shell-user')).toHaveTextContent('Test Owner · OWNER')
  })
})
