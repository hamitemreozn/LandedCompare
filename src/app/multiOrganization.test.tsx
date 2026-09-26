/**
 * Audit A, A-L7 — deterministic multi-organisation behaviour, through the
 * real App and boot hook over the in-memory cloud. The same scenarios run
 * against the real local stack in `multiOrganization.security.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { setLocale } from '../i18n'
import { createMemoryCloudGateway, type MemoryCloud } from '../test/memoryCloud'
import { ORGANIZATION_PREFERENCE_KEY } from './organizationPreference'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const ORG_C = '33333333-3333-4333-8333-333333333333'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

beforeEach(async () => {
  localStorage.clear()
  window.location.hash = '#/suppliers'
  await setLocale('tr')
})

afterEach(() => {
  window.location.hash = '#/dashboard'
})

async function companies(ids: readonly string[] = [ORG_A, ORG_B]): Promise<MemoryCloud> {
  const names: Record<string, string> = { [ORG_A]: 'Alfa Medikal', [ORG_B]: 'Beta Ticaret', [ORG_C]: 'Gama Lojistik' }
  const gateway = createMemoryCloudGateway({ organizations: ids.map((id) => ({ id, name: names[id], role: 'OWNER' })) })
  for (const id of ids) {
    await gateway.catalog.createSupplier(id, { id: crypto.randomUUID(), displayName: `Supplier of ${names[id]}` })
  }
  return gateway
}

function renderApp(gateway: MemoryCloud) {
  return render(<App options={{ gateway, inspectLegacy: false }} />)
}

async function shellShows(name: string) {
  await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(name), { timeout: 5000 })
}

async function choose(organizationId: string) {
  const option = await waitFor(() => {
    const button = document.querySelector(`[data-organization-id="${organizationId}"]`)
    expect(button).not.toBeNull()
    return button as HTMLButtonElement
  })
  await userEvent.click(option)
}

describe('how many ACTIVE memberships', () => {
  it('zero: the deactivated screen, and no business screen', async () => {
    const gateway = await companies([ORG_A])
    gateway.organizations[0].status = 'DISABLED'
    renderApp(gateway)
    expect(await screen.findByText(/erişimi pasife alınmış/)).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('one: entered automatically, no selector, and remembered', async () => {
    renderApp(await companies([ORG_A]))
    await shellShows('Alfa Medikal')
    expect(screen.queryByRole('button', { name: 'Şirket değiştir' })).toBeNull()
    expect(JSON.parse(localStorage.getItem(ORGANIZATION_PREFERENCE_KEY)!)).toEqual({ userId: USER, organizationId: ORG_A })
  })

  it('two and nothing remembered: the selector, with nothing business-related behind it', async () => {
    renderApp(await companies())
    expect(await screen.findByRole('heading', { name: 'Şirket seçin' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByText(/Supplier of/)).toBeNull()
  })
})

describe('selecting and switching', () => {
  it('a valid selection enters that company and shows only its data', async () => {
    renderApp(await companies())
    await choose(ORG_B)
    await shellShows('Beta Ticaret')
    expect(await screen.findByText('Supplier of Beta Ticaret')).toBeInTheDocument()
    expect(screen.queryByText('Supplier of Alfa Medikal')).toBeNull()
  })

  it('a remembered, still valid choice is entered directly on the next start', async () => {
    localStorage.setItem(ORGANIZATION_PREFERENCE_KEY, JSON.stringify({ userId: USER, organizationId: ORG_B }))
    renderApp(await companies())
    await shellShows('Beta Ticaret')
  })

  it('switching A → B leaves nothing of A on screen', async () => {
    renderApp(await companies())
    await choose(ORG_A)
    await shellShows('Alfa Medikal')
    expect(await screen.findByText('Supplier of Alfa Medikal')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Hesap menüsü' }))
    await userEvent.click(screen.getByRole('button', { name: 'Şirket değiştir' }))
    expect(await screen.findByRole('heading', { name: 'Şirket seçin' })).toBeInTheDocument()
    expect(screen.queryByText('Supplier of Alfa Medikal')).toBeNull()

    await choose(ORG_B)
    await shellShows('Beta Ticaret')
    expect(await screen.findByText('Supplier of Beta Ticaret')).toBeInTheDocument()
    expect(screen.queryByText('Supplier of Alfa Medikal')).toBeNull()
  })

  it('a stale remembered choice fails closed to the selector, and says why', async () => {
    localStorage.setItem(ORGANIZATION_PREFERENCE_KEY, JSON.stringify({ userId: USER, organizationId: ORG_C }))
    renderApp(await companies())
    expect(await screen.findByText(/En son kullandığınız şirkete hesabınızın erişimi artık yok. Başka bir şirket seçin./)).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('a preference written for another user is ignored', async () => {
    localStorage.setItem(ORGANIZATION_PREFERENCE_KEY, JSON.stringify({ userId: 'bbbbbbbb-0000-4000-8000-000000000001', organizationId: ORG_B }))
    renderApp(await companies())
    expect(await screen.findByRole('heading', { name: 'Şirket seçin' })).toBeInTheDocument()
  })
})

describe('the selected membership is withdrawn on the server', () => {
  it('while in use, with one other company left: reboots into it and says the previous one is gone', async () => {
    const gateway = await companies()
    renderApp(gateway)
    await choose(ORG_B)
    await shellShows('Beta Ticaret')
    await screen.findByText('Supplier of Beta Ticaret')

    gateway.organizations.find((organization) => organization.id === ORG_B)!.status = 'DISABLED'
    await userEvent.click(screen.getByRole('link', { name: 'Müşteriler' }))

    await shellShows('Alfa Medikal')
    expect(await screen.findByText(/Şu anda Alfa Medikal şirketinde çalışıyorsunuz/)).toBeInTheDocument()
    expect(screen.queryByText('Supplier of Beta Ticaret')).toBeNull()
  })

  it('while in use, with two other companies left: back to the selector, B not offered', async () => {
    const gateway = await companies([ORG_A, ORG_B, ORG_C])
    renderApp(gateway)
    await choose(ORG_B)
    await shellShows('Beta Ticaret')
    await screen.findByText('Supplier of Beta Ticaret')

    gateway.organizations.find((organization) => organization.id === ORG_B)!.status = 'DISABLED'
    await userEvent.click(screen.getByRole('link', { name: 'Müşteriler' }))

    expect(await screen.findByRole('heading', { name: 'Şirket seçin' })).toBeInTheDocument()
    expect(document.querySelector(`[data-organization-id="${ORG_B}"]`)).toBeNull()
    expect(document.querySelector(`[data-organization-id="${ORG_A}"]`)).not.toBeNull()
    expect(screen.getByText(/En son kullandığınız şirkete/)).toBeInTheDocument()
  })
})

describe('another tab switches company', () => {
  it('this tab reboots into the other tab\'s choice', async () => {
    renderApp(await companies())
    await choose(ORG_A)
    await shellShows('Alfa Medikal')
    await screen.findByText('Supplier of Alfa Medikal')

    const value = JSON.stringify({ userId: USER, organizationId: ORG_B })
    localStorage.setItem(ORGANIZATION_PREFERENCE_KEY, value)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ORGANIZATION_PREFERENCE_KEY, newValue: value }))
    })

    await shellShows('Beta Ticaret')
    expect(await screen.findByText('Supplier of Beta Ticaret')).toBeInTheDocument()
    expect(screen.queryByText('Supplier of Alfa Medikal')).toBeNull()
  })

  it('a tab waiting on the selector follows the other tab\'s choice', async () => {
    renderApp(await companies())
    await screen.findByRole('heading', { name: 'Şirket seçin' })
    const value = JSON.stringify({ userId: USER, organizationId: ORG_A })
    localStorage.setItem(ORGANIZATION_PREFERENCE_KEY, value)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ORGANIZATION_PREFERENCE_KEY, newValue: value }))
    })
    await shellShows('Alfa Medikal')
  })

  it('an unrelated storage change, or a malformed value, does nothing', async () => {
    renderApp(await companies())
    await choose(ORG_A)
    await shellShows('Alfa Medikal')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'landedcompare.locale', newValue: 'en' }))
      window.dispatchEvent(new StorageEvent('storage', { key: ORGANIZATION_PREFERENCE_KEY, newValue: '{"broken"' }))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByTestId('shell-organization').textContent).toBe('Alfa Medikal')
  })
})
