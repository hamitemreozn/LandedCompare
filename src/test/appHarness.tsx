/**
 * Renders the real application against a real (fake-indexeddb) database.
 *
 * Nothing is mocked. The boot sequence runs, the migration chain is consulted,
 * a daily snapshot is taken and every write goes through the same typed stores
 * production uses — the only substitution is the database *name*, so files
 * running in parallel cannot see each other's data and no test can reach the
 * production database by forgetting a parameter.
 *
 * That matters for what these tests are able to prove. A screen tested against
 * a stubbed service can only show that it calls the stub; a screen tested
 * against the real store proves that the record it built is one the validators
 * accept, that the SKU check fires inside the transaction, and that what is
 * read back on the next mount is what was written.
 */

import { expect } from 'vitest'
import { render, screen, waitFor, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { deleteDatabase } from '../persistence'
import { createTestDatabaseName } from '../persistence/testSupport'
import i18n, { setLocale, type SupportedLocale } from '../i18n'

export interface AppHarness {
  readonly databaseName: string
  readonly user: ReturnType<typeof userEvent.setup>
  readonly view: RenderResult
  /** Unmounts, which closes the connection, then mounts a second application. */
  remount(): Promise<void>
  destroy(): Promise<void>
}

async function waitForReady(): Promise<void> {
  // The shell's navigation is the first thing that only exists once the
  // database is open. Waiting for it rather than for "not loading" is what
  // makes a test fail loudly if the boot gate is ever removed.
  await waitFor(
    () => {
      expect(screen.getByRole('navigation', { name: i18n.t('nav.primaryLabel') })).toBeTruthy()
    },
    { timeout: 5000 },
  )
}

export async function renderApp(
  options: { locale?: SupportedLocale; databaseName?: string; hash?: string } = {},
): Promise<AppHarness> {
  await setLocale(options.locale ?? 'tr')
  window.location.hash = options.hash ?? '#/dashboard'

  const databaseName = options.databaseName ?? createTestDatabaseName('ui')
  const user = userEvent.setup()
  let view = render(<App options={{ databaseName, requestStorage: false }} />)
  await waitForReady()

  return {
    databaseName,
    user,
    get view() {
      return view
    },
    remount: async () => {
      view.unmount()
      view = render(<App options={{ databaseName, requestStorage: false }} />)
      await waitForReady()
    },
    destroy: async () => {
      view.unmount()
      await deleteDatabase(databaseName)
    },
  }
}

/** Follows a sidebar link, then waits for the screen it names. */
export async function goTo(harness: AppHarness, navLabel: string, heading: string): Promise<void> {
  await harness.user.click(screen.getByRole('link', { name: navLabel }))
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy()
  })
}
