// @vitest-environment jsdom
/**
 * Audit A, A-L7 — one user, two companies, the real App over the real local
 * GoTrue + PostgREST.
 *
 *   - two ACTIVE memberships and no choice: the selector, nothing behind it;
 *   - a choice enters that company, and only its rows are ever on screen;
 *   - switching A → B leaves nothing of A;
 *   - the selected membership disabled on the server while in use: the app
 *     reboots into the remaining company and says so;
 *   - a remembered choice is only ever a preference — a stale one fails closed;
 *   - another tab switching company is followed.
 *
 * A MutationObserver records the shell's company every time a product name
 * appears, so "A's row under B's name" is caught at any moment, not only at
 * the end.
 */
import { createElement, type FunctionComponent } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import App from '../App'
import type { ApplicationBootOptions } from './useApplicationBoot'
import { setLocale } from '../i18n'
import { createCloudClient } from '../cloud/client'
import { createDataGateway, type DataGateway } from '../cloud/gateway'
import { freshUser, MemoryStorage, type FreshUser } from '../cloud/security/fixtures'
import { localStack, SEED, sql } from '../cloud/security/localStack'
import { ORGANIZATION_PREFERENCE_KEY } from './organizationPreference'

if (typeof globalThis.localStorage?.getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
}

const AppWithOptions = App as unknown as FunctionComponent<{ options: ApplicationBootOptions }>

function tab(storage: Storage): DataGateway {
  const { apiUrl, publishableKey } = localStack()
  return createDataGateway(createCloudClient({ url: apiUrl, publishableKey }, { storage }), { storage })
}

interface TwoCompanies {
  readonly user: FreshUser
  readonly first: { id: string; name: string; product: string }
  readonly second: { id: string; name: string; product: string }
}

/** A fresh user who is an ACTIVE member of two fresh companies, each with one product. */
async function twoCompanies(label: string): Promise<TwoCompanies> {
  const user = await freshUser(label, 'OWNER')
  const secondId = crypto.randomUUID()
  const secondName = `${label} Second ${secondId.slice(0, 4)}`
  await sql(
    `select set_config('app.actor_user_id', '${user.userId}', false); ` +
      `insert into app_data.organizations (id, name) values ('${secondId}', '${secondName}'); ` +
      `insert into app_data.memberships (organization_id, user_id, role, status) values ('${secondId}', '${user.userId}', 'MEMBER', 'ACTIVE'); ` +
      `insert into app_data.products (organization_id, sku, name, stock_unit) values ` +
      `('${user.organizationId}', 'F-1', '${label} product of first', 'PIECE'), ('${secondId}', 'S-1', '${label} product of second', 'PIECE');`,
  )
  return {
    user,
    first: { id: user.organizationId, name: user.organizationName, product: `${label} product of first` },
    second: { id: secondId, name: secondName, product: `${label} product of second` },
  }
}

/** Every time a product name is on screen, which company the shell claimed. */
function watchProducts(names: readonly string[]) {
  const seen: { product: string; shell: string }[] = []
  const observer = new MutationObserver(() => {
    const text = document.body.textContent ?? ''
    for (const name of names) {
      if (text.includes(name)) seen.push({ product: name, shell: screen.queryByTestId('shell-organization')?.textContent ?? '' })
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return { seen, stop: () => observer.disconnect() }
}

async function shellShows(name: string) {
  await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(name), { timeout: 20_000 })
}

async function choose(organizationId: string) {
  const option = await waitFor(() => {
    const button = document.querySelector(`[data-organization-id="${organizationId}"]`)
    expect(button).not.toBeNull()
    return button as HTMLButtonElement
  }, { timeout: 20_000 })
  fireEvent.click(option)
}

async function start(companies: TwoCompanies, preferenceStorage: Storage) {
  const storage = new MemoryStorage()
  const gateway = tab(storage)
  await gateway.signInWithPassword(companies.user.email, SEED.password)
  window.location.hash = '#/products'
  render(createElement(AppWithOptions, { options: { gateway, inspectLegacy: false, preferenceStorage } }))
}

beforeAll(async () => {
  await setLocale('tr')
})

afterEach(() => {
  cleanup()
  window.location.hash = '#/dashboard'
})

describe('A-L7 against the real server', () => {
  it('selects, switches A → B, and never shows one company\'s product under the other\'s name', async () => {
    const companies = await twoCompanies('ML1')
    const preferences = new MemoryStorage()
    const watch = watchProducts([companies.first.product, companies.second.product])
    await start(companies, preferences)

    expect(await screen.findByRole('heading', { name: 'Şirket seçin' }, { timeout: 20_000 })).toBeTruthy()
    expect(screen.queryByRole('navigation')).toBeNull()

    await choose(companies.first.id)
    await shellShows(companies.first.name)
    await screen.findByText(companies.first.product, undefined, { timeout: 10_000 })

    fireEvent.click(screen.getByRole('button', { name: 'Hesap menüsü' }))
    fireEvent.click(screen.getByRole('button', { name: 'Şirket değiştir' }))
    await choose(companies.second.id)
    await shellShows(companies.second.name)
    await screen.findByText(companies.second.product, undefined, { timeout: 10_000 })
    expect(screen.queryByText(companies.first.product)).toBeNull()

    watch.stop()
    for (const entry of watch.seen) {
      expect(entry.shell).toBe(entry.product === companies.first.product ? companies.first.name : companies.second.name)
    }
    expect(JSON.parse(preferences.getItem(ORGANIZATION_PREFERENCE_KEY)!)).toEqual({ userId: companies.user.userId, organizationId: companies.second.id })
  }, 90_000)

  it('the selected membership disabled while in use: reboots into the remaining company and says so', async () => {
    const companies = await twoCompanies('ML2')
    const preferences = new MemoryStorage()
    preferences.setItem(ORGANIZATION_PREFERENCE_KEY, JSON.stringify({ userId: companies.user.userId, organizationId: companies.second.id }))
    await start(companies, preferences)
    await shellShows(companies.second.name)
    await screen.findByText(companies.second.product, undefined, { timeout: 10_000 })

    await sql(`update app_data.memberships set status = 'DISABLED' where user_id = '${companies.user.userId}' and organization_id = '${companies.second.id}';`)
    fireEvent.click(screen.getByRole('link', { name: 'Tedarikçiler' }))

    await shellShows(companies.first.name)
    expect(await screen.findByText(new RegExp(`Şu anda ${companies.first.name} şirketinde çalışıyorsunuz`), undefined, { timeout: 10_000 })).toBeTruthy()
    expect(screen.queryByText(companies.second.product)).toBeNull()
  }, 90_000)

  it('a stale remembered company is never entered; a forged preference grants nothing', async () => {
    const companies = await twoCompanies('ML3')
    const stranger = await freshUser('ML3stranger')
    const preferences = new MemoryStorage()
    // A company this user was never a member of.
    preferences.setItem(ORGANIZATION_PREFERENCE_KEY, JSON.stringify({ userId: companies.user.userId, organizationId: stranger.organizationId }))
    await start(companies, preferences)
    expect(await screen.findByText(/En son kullandığınız şirkete hesabınızın erişimi artık yok/, undefined, { timeout: 20_000 })).toBeTruthy()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(document.querySelector(`[data-organization-id="${stranger.organizationId}"]`)).toBeNull()
  }, 90_000)

  it('another tab switches company: this tab follows, and drops the first company\'s rows', async () => {
    const companies = await twoCompanies('ML4')
    const preferences = new MemoryStorage()
    await start(companies, preferences)
    await choose(companies.first.id)
    await shellShows(companies.first.name)
    await screen.findByText(companies.first.product, undefined, { timeout: 10_000 })

    const value = JSON.stringify({ userId: companies.user.userId, organizationId: companies.second.id })
    preferences.setItem(ORGANIZATION_PREFERENCE_KEY, value)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ORGANIZATION_PREFERENCE_KEY, newValue: value }))
    })

    await shellShows(companies.second.name)
    await screen.findByText(companies.second.product, undefined, { timeout: 10_000 })
    expect(screen.queryByText(companies.first.product)).toBeNull()
  }, 90_000)
})
