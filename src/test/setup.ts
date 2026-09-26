import '@testing-library/jest-dom/vitest'
// jsdom ships no IndexedDB implementation, so the Phase 7 persistence tests
// would have nothing to run against. `fake-indexeddb/auto` installs a real,
// spec-following implementation on the global scope — the persistence layer is
// exercised as written rather than mocked into agreeing with itself. It adds
// the `indexedDB`/`IDBKeyRange` globals and nothing else, so no other suite
// changes behaviour.
import 'fake-indexeddb/auto'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// This project's vitest config does not enable `globals: true`, so
// @testing-library/react's own auto-cleanup (which looks for framework
// globals like a global `afterEach`) never registers. Without it, `render()`
// output from one test accumulates in the DOM for the next.
afterEach(() => {
  cleanup()
})

/**
 * Recent Node versions ship a built-in `localStorage` global (backed by an
 * on-disk file via `--localstorage-file`) that is left non-functional when no
 * such file is configured. vitest-environment-jsdom does not override a
 * global that already exists, so this stub shadows jsdom's own working
 * `Storage` implementation. Replace it with a simple in-memory store so
 * `window.localStorage` behaves like it does in a real browser.
 */
class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

if (typeof globalThis.localStorage?.getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  })
}

/**
 * jsdom implements neither the Pointer Capture methods nor `scrollIntoView`
 * — real gaps in its DOM, not something this project chose. `Select.tsx`
 * (`@radix-ui/react-select`) calls both as part of its own pointer/keyboard
 * item-selection handling, which otherwise throws mid-interaction in every
 * test that opens a select. These are behaviourless stand-ins, not mocks of
 * anything this codebase owns.
 */
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
}
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {}
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = () => {}
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

/**
 * jsdom parses and reflects the `inert` HTML attribute but enforces none of
 * its behaviour: `.focus()` on a descendant of an inert element still
 * succeeds, unlike in a real browser. `AppShell`'s mobile-drawer accessibility
 * fix (F12.7-01) depends on that enforcement — the background becoming
 * genuinely unfocusable while the drawer is open, and vice versa — so a test
 * asserting it needs `.focus()` to actually behave like it does in a browser,
 * not merely check that the `inert` attribute is present.
 */
{
  const nativeFocus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args) {
    if (this.closest('[inert]') !== null) return
    nativeFocus.apply(this, args)
  }
}

/**
 * jsdom implements no `window.matchMedia` at all. `useIsMobileViewport`
 * (`src/features/shell/useIsMobileViewport.ts`) needs a real one — one that
 * actually tracks `window.innerWidth` and fires `change`, not a stub that
 * always reports `matches: false` — so a test can resize the window (set
 * `innerWidth`, dispatch `resize`) and see the mobile-drawer accessibility
 * wiring react, the same way it would in a real browser.
 */
if (typeof window.matchMedia !== 'function') {
  class FakeMediaQueryList extends EventTarget implements MediaQueryList {
    readonly media: string
    private readonly maxWidth: number
    matches: boolean
    onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null = null

    constructor(query: string) {
      super()
      this.media = query
      const match = /max-width:\s*(\d+)px/.exec(query)
      this.maxWidth = match ? Number(match[1]) : Infinity
      this.matches = window.innerWidth <= this.maxWidth
    }

    recompute(): void {
      const next = window.innerWidth <= this.maxWidth
      if (next === this.matches) return
      this.matches = next
      const event = Object.assign(new Event('change'), { matches: next, media: this.media }) as MediaQueryListEvent
      this.onchange?.call(this, event)
      this.dispatchEvent(event)
    }

    addListener(listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void): void {
      this.addEventListener('change', listener as EventListener)
    }
    removeListener(listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void): void {
      this.removeEventListener('change', listener as EventListener)
    }
  }

  const liveQueries = new Set<FakeMediaQueryList>()

  window.addEventListener('resize', () => {
    for (const query of liveQueries) query.recompute()
  })

  window.matchMedia = (query: string) => {
    const mql = new FakeMediaQueryList(query)
    liveQueries.add(mql)
    return mql
  }
}
