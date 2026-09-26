import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { goTo, renderApp, type AppHarness } from '../../test/appHarness'
import { setLocale } from '../../i18n'
import { TEST_ORGANIZATION_ID } from '../../test/memoryCloud'

let harness: AppHarness

afterEach(async () => {
  await harness?.destroy()
  await setLocale('tr')
})

const SUPPLIERS = 'Tedarikçiler'
const CUSTOMERS = 'Müşteriler'

async function open(section: string): Promise<void> {
  harness = await renderApp()
  await goTo(harness, section, section)
  await waitFor(() => expect(screen.queryByText('Yükleniyor')).not.toBeInTheDocument())
}

async function createParty(
  newLabel: string,
  nameLabel: string,
  fields: { name: string; externalRef?: string; note?: string },
): Promise<void> {
  await harness.user.click(await screen.findByRole('button', { name: newLabel }))
  await harness.user.type(screen.getByLabelText(nameLabel), fields.name)
  if (fields.externalRef !== undefined) {
    await harness.user.type(screen.getByLabelText(/Dış Sistem Kodu/), fields.externalRef)
  }
  if (fields.note !== undefined) {
    await harness.user.type(screen.getByLabelText(/^Not/), fields.note)
  }
  await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
}

const newSupplier = (fields: { name: string; externalRef?: string; note?: string }) =>
  createParty('Yeni Tedarikçi', 'Tedarikçi Adı', fields)

const newCustomer = (fields: { name: string; externalRef?: string; note?: string }) =>
  createParty('Yeni Müşteri', 'Müşteri Adı', fields)

function row(name: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(name) })
}

describe('suppliers', () => {
  it('starts empty and says so', async () => {
    await open(SUPPLIERS)
    expect(await screen.findByText('Henüz tedarikçi eklenmemiş')).toBeInTheDocument()
  })

  it('creates a supplier and shows it in the list', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Şanlı Çelik A.Ş.', note: 'İzmir' })

    expect(await screen.findByText('Şanlı Çelik A.Ş.')).toBeInTheDocument()
    expect(screen.getByText('İzmir')).toBeInTheDocument()
  })

  it('keeps an external system code opaque and displays it exactly', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Kodlu Tedarikçi', externalRef: '320-34-00-11-001' })
    expect(await screen.findByText('320-34-00-11-001')).toBeInTheDocument()
  })

  it('requires a name', async () => {
    await open(SUPPLIERS)
    await harness.user.click(await screen.findByRole('button', { name: 'Yeni Tedarikçi' }))
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    expect(screen.getByText('Bu alan zorunludur.')).toBeInTheDocument()
    expect(screen.getByLabelText('Tedarikçi Adı')).toHaveAttribute('aria-invalid', 'true')
  })

  it('edits a supplier without creating a second one', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Eski Tedarikçi' })
    await screen.findByText('Eski Tedarikçi')

    await harness.user.click(within(row('Eski Tedarikçi')).getByRole('button', { name: 'Düzenle' }))
    await harness.user.clear(screen.getByLabelText('Tedarikçi Adı'))
    await harness.user.type(screen.getByLabelText('Tedarikçi Adı'), 'Yeni Tedarikçi Adı')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    expect(await screen.findByText('Yeni Tedarikçi Adı')).toBeInTheDocument()
    expect(screen.queryByText('Eski Tedarikçi')).not.toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2) // header + one record
  })

  it('deactivates rather than deletes, and the record is still findable', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Pasif Tedarikçi' })
    await screen.findByText('Pasif Tedarikçi')

    await harness.user.click(
      within(row('Pasif Tedarikçi')).getByRole('button', { name: 'Pasife Al' }),
    )
    await harness.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Pasife Al' }),
    )

    await waitFor(() => expect(screen.queryByText('Pasif Tedarikçi')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Sil' })).not.toBeInTheDocument()

    await harness.user.click(screen.getByRole('button', { name: 'Pasif' }))
    expect(await screen.findByText('Pasif Tedarikçi')).toBeInTheDocument()
  })

  it('searches by name and by note', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Ankara Metal', note: 'demir' })
    await screen.findByText('Ankara Metal')
    await newSupplier({ name: 'İzmir Plastik', note: 'polimer' })
    await screen.findByText('İzmir Plastik')

    await harness.user.type(screen.getByLabelText('Ara'), 'polimer')
    await waitFor(() => expect(screen.queryByText('Ankara Metal')).not.toBeInTheDocument())
    expect(screen.getByText('İzmir Plastik')).toBeInTheDocument()
  })

  it('survives a remount, because it was actually written', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Kalıcı Tedarikçi' })
    await screen.findByText('Kalıcı Tedarikçi')

    await harness.remount()
    await goTo(harness, SUPPLIERS, SUPPLIERS)

    expect(await screen.findByText('Kalıcı Tedarikçi')).toBeInTheDocument()
  })
})

describe('customers', () => {
  it('starts empty and says it is not a CRM', async () => {
    await open(CUSTOMERS)
    expect(await screen.findByText('Henüz müşteri eklenmemiş')).toBeInTheDocument()
  })

  it('creates a customer with an external reference', async () => {
    await open(CUSTOMERS)
    await newCustomer({ name: 'Doğuş Makine', externalRef: 'LOGO-4411' })

    expect(await screen.findByText('Doğuş Makine')).toBeInTheDocument()
    expect(screen.getByText('LOGO-4411')).toBeInTheDocument()
  })

  it('lets two customers share an external reference, because it is not an identifier', async () => {
    await open(CUSTOMERS)
    await newCustomer({ name: 'Birinci', externalRef: 'LOGO-1' })
    await screen.findByText('Birinci')
    await newCustomer({ name: 'İkinci', externalRef: 'LOGO-1' })

    expect(await screen.findByText('İkinci')).toBeInTheDocument()
    expect(screen.getAllByText('LOGO-1')).toHaveLength(2)
  })

  it('edits, deactivates and filters like the other masters', async () => {
    await open(CUSTOMERS)
    await newCustomer({ name: 'Çağrı Ticaret' })
    await screen.findByText('Çağrı Ticaret')

    await harness.user.click(within(row('Çağrı Ticaret')).getByRole('button', { name: 'Düzenle' }))
    await harness.user.clear(screen.getByLabelText('Müşteri Adı'))
    await harness.user.type(screen.getByLabelText('Müşteri Adı'), 'Çağrı Ticaret Ltd.')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    expect(await screen.findByText('Çağrı Ticaret Ltd.')).toBeInTheDocument()

    await harness.user.click(
      within(row('Çağrı Ticaret Ltd.')).getByRole('button', { name: 'Pasife Al' }),
    )
    await harness.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Pasife Al' }),
    )
    await waitFor(() => expect(screen.queryByText('Çağrı Ticaret Ltd.')).not.toBeInTheDocument())

    await harness.user.click(screen.getByRole('button', { name: 'Tümü' }))
    expect(await screen.findByText('Çağrı Ticaret Ltd.')).toBeInTheDocument()
    expect(within(row('Çağrı Ticaret Ltd.')).getByText('Pasif')).toBeInTheDocument()
  })

  it('searches by the external reference too', async () => {
    await open(CUSTOMERS)
    await newCustomer({ name: 'Alfa', externalRef: 'MUS-7788' })
    await screen.findByText('Alfa')
    await newCustomer({ name: 'Beta', externalRef: 'MUS-1122' })
    await screen.findByText('Beta')

    await harness.user.type(screen.getByLabelText('Ara'), '7788')
    await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument())
    expect(screen.getByText('Alfa')).toBeInTheDocument()
  })

  it('survives a remount', async () => {
    await open(CUSTOMERS)
    await newCustomer({ name: 'Kalıcı Müşteri' })
    await screen.findByText('Kalıcı Müşteri')

    await harness.remount()
    await goTo(harness, CUSTOMERS, CUSTOMERS)
    expect(await screen.findByText('Kalıcı Müşteri')).toBeInTheDocument()
  })
})

describe('a new party is active, and is not asked about it', () => {
  it('shows no Active checkbox while creating a supplier, and stores active: true', async () => {
    await open(SUPPLIERS)
    await harness.user.click(await screen.findByRole('button', { name: 'Yeni Tedarikçi' }))

    expect(screen.queryByLabelText('Aktif')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Tedarikçi Adı')).toHaveAttribute('aria-required', 'true')
    expect(screen.queryByText(/isteğe bağlı/)).not.toBeInTheDocument()

    await harness.user.type(screen.getByLabelText('Tedarikçi Adı'), 'Varsayılan Aktif A.Ş.')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    await screen.findByText('Varsayılan Aktif A.Ş.')

    expect((await harness.gateway.catalog.listSuppliers(TEST_ORGANIZATION_ID))[0]!.active).toBe(true)
  })

  it('explains that lifecycle changes are made from the list when editing', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Düzenlenecek Tedarikçi' })
    await screen.findByText('Düzenlenecek Tedarikçi')

    await harness.user.click(
      within(row('Düzenlenecek Tedarikçi')).getByRole('button', { name: 'Düzenle' }),
    )
    expect(screen.getByText('Aktif/pasif durumunu kaydettikten sonra listeden değiştirin.')).toBeInTheDocument()
  })

  it('applies the same rule to a new customer', async () => {
    await open(CUSTOMERS)
    await harness.user.click(await screen.findByRole('button', { name: 'Yeni Müşteri' }))

    expect(screen.queryByLabelText('Aktif')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Müşteri Adı')).toHaveAttribute('aria-required', 'true')
    expect(screen.getByLabelText(/Dış Sistem Kodu/)).not.toHaveAttribute('aria-required')
  })
})

describe('a concurrent edit from a second tab', () => {
  /**
   * The scenario `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §5 exists for: this
   * tab loaded the record, something else changed it, and this tab then tried
   * to save the copy it had. The second connection below *is* the second tab —
   * a separate `openDatabase()` against the same database, writing through the
   * same typed store.
   */
  it('refuses the save, explains it, and does not overwrite the newer record', async () => {
    await open(SUPPLIERS)
    await newSupplier({ name: 'Ortak Tedarikçi' })
    await screen.findByText('Ortak Tedarikçi')

    // This tab opens the record for editing and holds its `updatedAt`.
    await harness.user.click(within(row('Ortak Tedarikçi')).getByRole('button', { name: 'Düzenle' }))
    await harness.user.clear(screen.getByLabelText('Tedarikçi Adı'))
    await harness.user.type(screen.getByLabelText('Tedarikçi Adı'), 'Bu sekmenin değişikliği')

    // The other tab saves first.
    const [stored] = await harness.gateway.catalog.listSuppliers(TEST_ORGANIZATION_ID)
    await harness.gateway.catalog.updateSupplier(TEST_ORGANIZATION_ID, stored!.version, {
      id: stored!.id,
      displayName: 'Diğer sekmenin değişikliği',
      externalRef: stored!.externalRef,
      note: stored!.note,
    })

    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    // A sentence, not a DOMException, and the machine-readable code beside it.
    expect(
      await screen.findByText(
        'Bu kayıt siz düzenlerken başka bir yerde değiştirildi. Daha yeni kaydın üzerine yazılmaması için kayıt işlemi durduruldu. Kaydı yeniden yükleyip değişikliğinizi tekrar uygulayın.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/STALE_WRITE/)).toBeInTheDocument()

    // The newer record is intact in the database — nothing was merged.
    const after = await harness.gateway.catalog.listSuppliers(TEST_ORGANIZATION_ID)
    expect(after[0]!.displayName).toBe('Diğer sekmenin değişikliği')

    // The reload action replaces the stale baseline with the stored one.
    await harness.user.click(screen.getByRole('button', { name: 'Kaydı Yeniden Yükle' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Tedarikçi Adı')).toHaveValue('Diğer sekmenin değişikliği'),
    )
  })
})

describe('customer statuses', () => {
  it('assigns a configurable status and keeps displaying it after deactivation', async () => {
    harness = await renderApp()
    await goTo(harness, 'Müşteri Durumları', 'Müşteri Durumları')
    await harness.user.click(await screen.findByRole('button', { name: 'Yeni Müşteri Durumu' }))
    await harness.user.type(screen.getByLabelText('Durum Kodu'), 'A++')
    await harness.user.clear(screen.getByLabelText('Liste sırası'))
    await harness.user.type(screen.getByLabelText('Liste sırası'), '10')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    expect(await screen.findByRole('cell', { name: 'A++' })).toBeInTheDocument()

    await goTo(harness, CUSTOMERS, CUSTOMERS)
    await harness.user.click(await screen.findByRole('button', { name: 'Yeni Müşteri' }))
    await harness.user.type(screen.getByLabelText('Müşteri Adı'), 'Durumlu Müşteri')
    const statusSelect = screen.getByLabelText('Müşteri Durumu')
    await harness.user.click(statusSelect)
    await harness.user.click(await screen.findByRole('option', { name: 'A++' }))
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    expect(await screen.findByText('Durumlu Müşteri')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'A++' })).toBeInTheDocument()

    await goTo(harness, 'Müşteri Durumları', 'Müşteri Durumları')
    const statusRow = () => screen.getByRole('row', { name: /A\+\+/ })
    await harness.user.click(within(statusRow()).getByRole('button', { name: 'Pasife Al' }))
    const dialog = await screen.findByRole('dialog')
    await harness.user.click(within(dialog).getByRole('button', { name: 'Pasife Al' }))
    await harness.user.click(screen.getByRole('button', { name: 'Pasif' }))
    await waitFor(() => expect(within(statusRow()).getByText('Pasif')).toBeInTheDocument())

    await goTo(harness, CUSTOMERS, CUSTOMERS)
    expect(await screen.findByText('A++ (Pasif)')).toBeInTheDocument()
    await harness.user.click(screen.getByRole('button', { name: 'Yeni Müşteri' }))
    expect(within(screen.getByLabelText('Müşteri Durumu')).queryByRole('option', { name: /A\+\+/ })).not.toBeInTheDocument()
  })
})
