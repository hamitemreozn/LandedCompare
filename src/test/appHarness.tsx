import { expect } from 'vitest'
import { render, screen, waitFor, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import i18n, { setLocale, type SupportedLocale } from '../i18n'
import { createMemoryCloudGateway, type MemoryCloud } from './memoryCloud'

export interface AppHarness {
  readonly gateway: MemoryCloud
  readonly user: ReturnType<typeof userEvent.setup>
  readonly view: RenderResult
  remount(): Promise<void>
  destroy(): Promise<void>
}

async function waitForReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('navigation', { name: i18n.t('nav.primaryLabel') })).toBeTruthy()
  }, { timeout: 5000 })
}

export async function renderApp(
  options: { locale?: SupportedLocale; hash?: string; gateway?: MemoryCloud } = {},
): Promise<AppHarness> {
  await setLocale(options.locale ?? 'tr')
  window.location.hash = options.hash ?? '#/dashboard'
  const gateway = options.gateway ?? createMemoryCloudGateway()
  const user = userEvent.setup()
  let view = render(<App options={{ gateway, inspectLegacy: false }} />)
  await waitForReady()

  return {
    gateway,
    user,
    get view() { return view },
    remount: async () => {
      view.unmount()
      view = render(<App options={{ gateway, inspectLegacy: false }} />)
      await waitForReady()
    },
    destroy: async () => { view.unmount() },
  }
}

export async function goTo(harness: AppHarness, navLabel: string, heading: string): Promise<void> {
  await harness.user.click(screen.getByRole('link', { name: navLabel }))
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy()
  })
}

/**
 * Opens the top-right account menu (identity, language, switch-company,
 * sign-out — see `src/features/shell/AccountMenu.tsx`). Its panel is
 * `hidden` until this runs, so any test reaching into it — the language
 * toggle, "switch company", "sign out" — has to call this first.
 */
export async function openAccountMenu(harness: AppHarness): Promise<void> {
  await harness.user.click(screen.getByRole('button', { name: i18n.t('shell.accountMenu') }))
}
