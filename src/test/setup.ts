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
