/**
 * The company screen: what an OWNER, an ADMIN and a MEMBER are offered, and
 * that every action goes to the server rather than being decided here.
 * Server authority itself is proved over HTTP in
 * `src/cloud/security/organizationAdministration.security.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { CloudError } from '../../cloud'
import { setLocale } from '../../i18n'
import { renderApp, type AppHarness } from '../../test/appHarness'
import { createMemoryCloudGateway, TEST_ORGANIZATION_ID, TEST_USER_ID, type MemoryCloud } from '../../test/memoryCloud'

let harness: AppHarness | undefined
const COLLEAGUE = 'cccccccc-cccc-4ccc-8ccc-000000000009'

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  await harness?.destroy()
  harness = undefined
  vi.restoreAllMocks()
  await setLocale('tr')
})

function withColleague(gateway: MemoryCloud, role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER'): MemoryCloud {
  gateway.membersFor(TEST_ORGANIZATION_ID).set(COLLEAGUE, {
    userId: COLLEAGUE, displayName: 'Berk Demir', email: 'berk@example.test', role, status: 'ACTIVE',
    version: 1, createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:00:00.000Z',
  })
  return gateway
}

/**
 * The member's row, once it is rendered. `waitFor` retries only while its
 * callback THROWS, so the query asserts rather than returning a possibly-null
 * element on the first attempt (P12-L1).
 */
async function memberRow(userId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-member-id="${userId}"]`)
    expect(row).not.toBeNull()
    return row!
  })
}

async function open(gateway: MemoryCloud, locale: 'tr' | 'en' = 'tr'): Promise<AppHarness> {
  harness = await renderApp({ gateway, locale, hash: '#/organization' })
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: locale === 'tr' ? 'Şirket' : 'Company' })).toBeInTheDocument())
  return harness
}

describe('the company screen for an OWNER', () => {
  it('shows the company, the live role and the user list with e-mail', async () => {
    await open(withColleague(createMemoryCloudGateway()))
    await waitFor(() => expect(screen.getByRole('table', { name: 'Kullanıcılar' })).toBeInTheDocument())
    expect(screen.getByTestId('organization-role').textContent).toBe('Sahip')
    const table = screen.getByRole('table', { name: 'Kullanıcılar' })
    expect(within(table).getByText('berk@example.test')).toBeInTheDocument()
    expect(within(table).getByText('(siz)')).toBeInTheDocument()
  })

  it('offers no control on the owner\'s own row', async () => {
    await open(withColleague(createMemoryCloudGateway()))
    const own = await memberRow(TEST_USER_ID)
    expect(within(own).queryByRole('button')).toBeNull()
    expect(within(own).queryByRole('combobox')).toBeNull()
  })

  it('disables a colleague only after confirmation, through the server, and shows the new state', async () => {
    const gateway = withColleague(createMemoryCloudGateway())
    const { user } = await open(gateway)
    const row = await memberRow(COLLEAGUE)
    await user.click(within(row).getByRole('button', { name: 'Erişimi kapat' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Hesapları silinmez/)).toBeInTheDocument()
    expect(gateway.adminCalls.some((call) => call.startsWith('setMemberStatus'))).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Onayla' }))
    await waitFor(() => expect(gateway.membersFor(TEST_ORGANIZATION_ID).get(COLLEAGUE)?.status).toBe('DISABLED'))
    expect(gateway.adminCalls).toContain(`setMemberStatus:${TEST_ORGANIZATION_ID}:${COLLEAGUE}:DISABLED`)
    await waitFor(() => expect(within(document.querySelector(`[data-member-id="${COLLEAGUE}"]`) as HTMLElement).getByText('Devre dışı')).toBeInTheDocument())
  })

  it('changes a role only after confirmation', async () => {
    const gateway = withColleague(createMemoryCloudGateway())
    const { user } = await open(gateway)
    const select = await screen.findByRole('combobox', { name: 'Berk Demir için rol' })
    await user.selectOptions(select, 'ADMIN')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Onayla' }))
    await waitFor(() => expect(gateway.membersFor(TEST_ORGANIZATION_ID).get(COLLEAGUE)?.role).toBe('ADMIN'))
  })

  it('adds a user with one neutral sentence and shows no credential of any kind', async () => {
    const gateway = createMemoryCloudGateway()
    const { user } = await open(gateway)
    await user.type(await screen.findByLabelText('E-posta'), 'Yeni@Example.test')
    await user.type(screen.getByLabelText('Ad soyad'), 'Yeni Kişi')
    await user.click(screen.getByRole('button', { name: 'Kullanıcıyı ekle' }))
    expect(await screen.findByText('yeni@example.test artık bu şirkete erişebiliyor.')).toBeInTheDocument()
    expect(gateway.adminCalls.find((call) => call.startsWith('provisionMember'))).toMatch(/:yeni@example\.test:MEMBER$/)
    expect(screen.queryByTestId('one-time-password')).toBeNull()
    expect(document.body.textContent).not.toMatch(/parola:|Tek kullanımlık|temporary|geçici parola/i)
  })

  it('an invitation for an address that already has an account shows the very same sentence (P12-M2)', async () => {
    const gateway = withColleague(createMemoryCloudGateway())
    const { user } = await open(gateway)
    await user.type(await screen.findByLabelText('E-posta'), 'berk@example.test')
    await user.type(screen.getByLabelText('Ad soyad'), 'Berk Demir')
    await user.click(screen.getByRole('button', { name: 'Kullanıcıyı ekle' }))
    expect(await screen.findByText('berk@example.test artık bu şirkete erişebiliyor.')).toBeInTheDocument()
    expect(screen.queryByTestId('one-time-password')).toBeNull()
    // No wording tells the administrator the address already had an account.
    expect(document.body.textContent).not.toMatch(/zaten bir hesap|already had an account|parolası değiştirilmedi/)
  })

  it('offers no way to reset or set a colleague\'s password (P12-B1)', async () => {
    await open(withColleague(createMemoryCloudGateway()))
    const row = await memberRow(COLLEAGUE)
    expect(within(row).queryByRole('button', { name: /parola/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /parola/i })).toBeNull()
  })

  it('reuses the request id when the same invitation is retried, and uses a new one after an edit', async () => {
    const gateway = createMemoryCloudGateway()
    const calls: string[] = []
    const provision = gateway.admin.provisionMember
    gateway.admin.provisionMember = async (input) => {
      calls.push(input.requestId)
      if (calls.length === 1) throw new CloudError('SERVER_UNAVAILABLE', 'lost response')
      return provision(input)
    }
    const { user } = await open(gateway)
    await user.type(await screen.findByLabelText('E-posta'), 'retry@example.test')
    await user.type(screen.getByLabelText('Ad soyad'), 'Retry')
    await user.click(screen.getByRole('button', { name: 'Kullanıcıyı ekle' }))
    await screen.findByText(/Sunucuya ulaşılamıyor/)
    await user.click(screen.getByRole('button', { name: 'Kullanıcıyı ekle' }))
    await screen.findByText('retry@example.test artık bu şirkete erişebiliyor.')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(calls[0])

    // A different invitation is a different request.
    await user.type(screen.getByLabelText('E-posta'), 'other@example.test')
    await user.type(screen.getByLabelText('Ad soyad'), 'Other')
    await user.click(screen.getByRole('button', { name: 'Kullanıcıyı ekle' }))
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2]).not.toBe(calls[0])
  })

  it('a refusal the screen did not expect is shown, with a way to reload authority from the server', async () => {
    const gateway = withColleague(createMemoryCloudGateway())
    gateway.admin.setMemberStatus = async () => { throw new CloudError('FORBIDDEN', 'demoted elsewhere') }
    const { user } = await open(gateway)
    const row = await memberRow(COLLEAGUE)
    await user.click(within(row).getByRole('button', { name: 'Erişimi kapat' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Onayla' }))
    expect(await screen.findByText('Bu işlem için yetkiniz yok.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yeniden yükle' })).toBeInTheDocument()
  })

  it('downloads a verified backup file and reports what it contains', async () => {
    const gateway = createMemoryCloudGateway()
    await gateway.catalog.createSupplier(TEST_ORGANIZATION_ID, { id: '40000000-0000-4000-8000-000000000001', displayName: 'Tedarikçi', externalRef: '0001' })
    const created: Blob[] = []
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => { created.push(blob); return 'blob:backup' }),
      revokeObjectURL: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const { user } = await open(gateway)
    await user.click(await screen.findByRole('button', { name: 'Şirket yedeğini indir' }))
    expect(await screen.findByText(/indirilmek üzere tarayıcıya verildi/)).toHaveTextContent('1 tedarikçi')
    expect(click).toHaveBeenCalledTimes(1)
    // jsdom's Blob has no `text()`; FileReader is the browser API it does implement.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(created[0])
    })
    expect(JSON.parse(text)).toMatchObject({ backupFormatVersion: 2, kind: 'ORGANIZATION_EXPORT', entityCounts: { suppliers: 1, members: 1 } })
  })

  it('a failed export shows the failure and starts no download', async () => {
    const gateway = createMemoryCloudGateway()
    gateway.catalog.listCustomers = async () => { throw new CloudError('SERVER_UNAVAILABLE', 'outage') }
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const { user } = await open(gateway)
    await user.click(await screen.findByRole('button', { name: 'Şirket yedeğini indir' }))
    expect(await screen.findByText('Yedek oluşturulamadı. Hiçbir dosya üretilmedi.')).toBeInTheDocument()
    expect(click).not.toHaveBeenCalled()
  })
})

describe('the company screen for an ADMIN', () => {
  it('cannot offer OWNER, and offers nothing on an OWNER\'s row', async () => {
    const gateway = withColleague(createMemoryCloudGateway({ organizations: [{ id: TEST_ORGANIZATION_ID, name: 'Test Company', role: 'ADMIN' }] }), 'OWNER')
    await open(gateway)
    const ownerRow = await memberRow(COLLEAGUE)
    expect(within(ownerRow).queryByRole('button')).toBeNull()
    expect(within(ownerRow).queryByRole('combobox')).toBeNull()
    const roleField = screen.getByLabelText('Rol', { selector: 'select' })
    expect(within(roleField).queryByRole('option', { name: 'Sahip' })).toBeNull()
  })
})

describe('the company screen for a MEMBER', () => {
  it('shows the company and says who can manage it, with no roster, invitation or backup', async () => {
    const gateway = createMemoryCloudGateway({ organizations: [{ id: TEST_ORGANIZATION_ID, name: 'Test Company', role: 'MEMBER' }] })
    await open(gateway)
    expect(await screen.findByText(/yalnızca şirket sahibi ve yöneticiler/)).toBeInTheDocument()
    expect(screen.getByTestId('organization-role').textContent).toBe('Üye')
    expect(screen.queryByRole('table', { name: 'Kullanıcılar' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Şirket yedeğini indir' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Kullanıcıyı ekle' })).toBeNull()
    expect(gateway.adminCalls).toEqual([])
  })

  it('renders in English too', async () => {
    const gateway = createMemoryCloudGateway({ organizations: [{ id: TEST_ORGANIZATION_ID, name: 'Test Company', role: 'MEMBER' }] })
    await open(gateway, 'en')
    expect(await screen.findByText(/Only the company owner and administrators/)).toBeInTheDocument()
    expect(screen.getByTestId('organization-role').textContent).toBe('Member')
  })
})
