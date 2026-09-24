// @vitest-environment jsdom
/**
 * Audit A, A-M2 — the application never stays READY under a stale identity.
 *
 * The real App, the real gateway and the real local GoTrue + PostgREST. Every
 * "tab" is a separate Supabase client over ONE shared storage — exactly what
 * two tabs of one origin are — so session changes travel between them the
 * way they do in a browser (storage plus Supabase's BroadcastChannel).
 *
 *   R2  a membership disabled on the server while the catalogue is open
 *   R3  another tab signs in as a different user
 *   —   another tab signs out
 *   —   the refresh token is revoked and the next request cannot refresh
 *   N-1 another tab signs in as someone else BETWEEN two boot reads
 *
 * A MutationObserver watches the whole run: no screen may ever show "your
 * catalogue is empty" for an organisation the signed-in user cannot read, and
 * no screen may ever show one user's data under another's identity.
 */
import { createElement, type FunctionComponent } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import App from '../App'
import type { ApplicationBootOptions } from './useApplicationBoot'
import { setLocale } from '../i18n'
import { bootstrapCloudSession } from '../cloud/boot'
import { createCloudClient } from '../cloud/client'
import { createDataGateway, type DataGateway } from '../cloud/gateway'
import { CLOUD_SESSION_STORAGE_KEY } from '../cloud/client'
import { freshUser, MemoryStorage } from '../cloud/security/fixtures'
import { localStack, SEED, sql } from '../cloud/security/localStack'

// Node's own `localStorage` global is a non-functional stub unless a file is
// configured; jsdom does not replace it. The shared storage below is what the
// clients use, and this keeps anything else from touching the stub.
if (typeof globalThis.localStorage?.getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
}

const EMPTY_PRODUCTS = 'Henüz ürün eklenmemiş'
const EMPTY_SUPPLIERS = 'Henüz tedarikçi eklenmemiş'
const DEACTIVATED = 'Hesabınızın bu şirketteki erişimi pasife alınmış. Yöneticinize başvurun.'

const AppWithOptions = App as unknown as FunctionComponent<{ options: ApplicationBootOptions }>

function renderApp(gateway: DataGateway) {
  return render(createElement(AppWithOptions, { options: { gateway, inspectLegacy: false } }))
}

function tab(storage: Storage): DataGateway {
  const { apiUrl, publishableKey } = localStack()
  return createDataGateway(createCloudClient({ url: apiUrl, publishableKey }, { storage }), { storage })
}

/** Records every moment the page claimed a catalogue was empty, with the shell identity at that moment. */
function watchEmptyClaims(): { claims: { organization: string; text: string }[]; stop: () => void } {
  const claims: { organization: string; text: string }[] = []
  const observer = new MutationObserver(() => {
    const text = document.body.textContent ?? ''
    for (const empty of [EMPTY_PRODUCTS, EMPTY_SUPPLIERS]) {
      if (text.includes(empty)) {
        claims.push({ organization: screen.queryByTestId('shell-organization')?.textContent ?? '', text: empty })
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return { claims, stop: () => observer.disconnect() }
}

async function waitForShell(organizationName: string) {
  await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(organizationName), { timeout: 20_000 })
}

async function go(label: string) {
  fireEvent.click(screen.getByRole('link', { name: label }))
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: label })).toBeTruthy(), { timeout: 10_000 })
}

beforeAll(async () => {
  await setLocale('tr')
})

afterEach(() => {
  cleanup()
  window.location.hash = '#/dashboard'
})

describe('R2 — a membership disabled while the catalogue is open', () => {
  it('reboots into the deactivated-membership screen and never claims the catalogue is empty', async () => {
    const user = await freshUser('R2')
    await sql(`insert into app_data.products (organization_id, sku, name, stock_unit) values ('${user.organizationId}', 'R2-1', 'R2 visible product', 'PIECE');`)
    const storage = new MemoryStorage()
    const gateway = tab(storage)
    await gateway.signInWithPassword(user.email, SEED.password)

    window.location.hash = '#/products'
    const watch = watchEmptyClaims()
    renderApp(gateway)
    await waitForShell(user.organizationName)
    await waitFor(() => expect(screen.getByText('R2 visible product')).toBeTruthy(), { timeout: 10_000 })

    await sql(`update app_data.memberships set status = 'DISABLED' where user_id = '${user.userId}';`)
    await go('Tedarikçiler')

    await waitFor(() => expect(screen.getByText(DEACTIVATED)).toBeTruthy(), { timeout: 20_000 })
    expect(screen.queryByRole('navigation', { name: 'Ana menü' })).toBeNull()
    watch.stop()
    expect(watch.claims).toEqual([])
  }, 60_000)
})

describe('R3 — another tab signs in as a different user', () => {
  it('drops the first identity and reboots as the second, never mixing the two', async () => {
    const first = await freshUser('R3a')
    const second = await freshUser('R3b')
    await sql(
      `insert into app_data.products (organization_id, sku, name, stock_unit) values ` +
        `('${first.organizationId}', 'A-1', 'Product of the first company', 'PIECE'), ` +
        `('${second.organizationId}', 'B-1', 'Product of the second company', 'PIECE');`,
    )
    const shared = new MemoryStorage()
    const tab1 = tab(shared)
    await tab1.signInWithPassword(first.email, SEED.password)

    window.location.hash = '#/products'
    const watch = watchEmptyClaims()
    renderApp(tab1)
    await waitForShell(first.organizationName)
    await waitFor(() => expect(screen.getByText('Product of the first company')).toBeTruthy(), { timeout: 10_000 })

    const tab2 = tab(shared)
    await tab2.signInWithPassword(second.email, SEED.password)

    await waitForShell(second.organizationName)
    await waitFor(() => expect(screen.getByText('Product of the second company')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.queryByText('Product of the first company')).toBeNull()
    expect(screen.getByTestId('shell-user').textContent).toContain(second.displayName)
    watch.stop()
    expect(watch.claims).toEqual([])
  }, 60_000)
})

describe('another tab signs out', () => {
  it('takes this tab to the sign-in screen', async () => {
    const user = await freshUser('SignedOutElsewhere')
    const shared = new MemoryStorage()
    const tab1 = tab(shared)
    await tab1.signInWithPassword(user.email, SEED.password)
    renderApp(tab1)
    await waitForShell(user.organizationName)

    await tab(shared).signOut()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Giriş yap' })).toBeTruthy(), { timeout: 20_000 })
    expect(screen.queryByTestId('shell-organization')).toBeNull()
    expect(shared.getItem(CLOUD_SESSION_STORAGE_KEY)).toBeNull()
  }, 60_000)
})

describe('the session can no longer be refreshed', () => {
  it('a revoked refresh token ends READY at the next business request', async () => {
    const user = await freshUser('Revoked')
    const storage = new MemoryStorage()
    const gateway = tab(storage)
    await gateway.signInWithPassword(user.email, SEED.password)
    renderApp(gateway)
    await waitForShell(user.organizationName)

    // Server side: the refresh token is revoked. Client side: the access token
    // has expired, so the next request must refresh — and cannot.
    await sql(`delete from auth.refresh_tokens where user_id = '${user.userId}'; delete from auth.sessions where user_id = '${user.userId}';`)
    const stored = JSON.parse(storage.getItem(CLOUD_SESSION_STORAGE_KEY) ?? '{}') as { expires_at?: number }
    stored.expires_at = Math.floor(Date.now() / 1000) - 60
    storage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify(stored))

    await go('Ürünler')

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Giriş yap' })).toBeTruthy(), { timeout: 20_000 })
    expect(screen.queryByTestId('shell-organization')).toBeNull()
  }, 60_000)
})

describe('N-1 — another tab signs in as a different user in the middle of a boot', () => {
  it('the boot never publishes A\'s id beside B\'s company; it restarts and resolves as B', async () => {
    const first = await freshUser('N1a', 'OWNER')
    const second = await freshUser('N1b', 'OWNER')
    const shared = new MemoryStorage()
    const tab1 = tab(shared)
    await tab1.signInWithPassword(first.email, SEED.password)

    // The real gateway, with one pause: right after the profile read — the
    // first boot request made with A's token — tab 2 signs in as B.
    let switched = false
    const readOwnProfile = tab1.identity.readOwnProfile.bind(tab1.identity)
    const racing: DataGateway = {
      ...tab1,
      identity: {
        ...tab1.identity,
        async readOwnProfile() {
          const profile = await readOwnProfile()
          if (!switched) {
            switched = true
            await tab(shared).signInWithPassword(second.email, SEED.password)
          }
          return profile
        },
      },
    }

    const result = await bootstrapCloudSession(racing)
    expect(switched).toBe(true)
    expect(result).toMatchObject({ phase: 'READY', userId: second.userId })
    if (result.phase !== 'READY') return
    expect(result.profile.userId).toBe(second.userId)
    expect(result.membership.userId).toBe(second.userId)
    expect(result.organization.id).toBe(second.organizationId)
  }, 60_000)
})
