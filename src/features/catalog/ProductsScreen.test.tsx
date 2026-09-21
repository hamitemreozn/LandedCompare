import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { goTo, renderApp, type AppHarness } from '../../test/appHarness'
import { setLocale } from '../../i18n'
import { listProductRecords, openDatabase, type ProductRecord } from '../../persistence'

let harness: AppHarness

afterEach(async () => {
  await harness?.destroy()
  await setLocale('tr')
})

const PRODUCTS = 'Ürünler'

/** Navigates to the catalogue and waits for the first read to settle. */
async function openProducts(): Promise<void> {
  harness = await renderApp()
  await goTo(harness, PRODUCTS, PRODUCTS)
  await waitFor(() => {
    expect(screen.queryByText('Yükleniyor')).not.toBeInTheDocument()
  })
}

/** The one "New product" button: in the header, or in the empty state. */
async function clickNewProduct(): Promise<void> {
  await harness.user.click(await screen.findByRole('button', { name: 'Yeni Ürün' }))
}

const CONVERSION_LABEL = '1 satın alma biriminde kaç stok birimi var?'

interface ProductFields {
  readonly sku: string
  readonly name: string
  /** A value from the dropdown. `Diğer…` values go through `typeCustomUnit`. */
  readonly stockUnit?: string
  readonly purchaseUnit?: string
  readonly packFactor?: string
}

/** Fills the product form. Only the three required fields unless told otherwise. */
async function fillProduct(fields: ProductFields): Promise<void> {
  await harness.user.clear(screen.getByLabelText('Stok Kodu (SKU)'))
  await harness.user.type(screen.getByLabelText('Stok Kodu (SKU)'), fields.sku)
  await harness.user.clear(screen.getByLabelText('Ürün Adı'))
  await harness.user.type(screen.getByLabelText('Ürün Adı'), fields.name)
  await harness.user.selectOptions(
    screen.getByLabelText('Stok Birimi'),
    fields.stockUnit ?? 'Adet',
  )
  if (fields.purchaseUnit !== undefined) {
    await harness.user.selectOptions(
      screen.getByLabelText('Varsayılan Satın Alma Birimi'),
      fields.purchaseUnit,
    )
  }
  if (fields.packFactor !== undefined) {
    const factor = screen.getByLabelText(CONVERSION_LABEL)
    await harness.user.clear(factor)
    await harness.user.type(factor, fields.packFactor)
  }
}

async function createProductThroughUI(fields: ProductFields): Promise<void> {
  await clickNewProduct()
  await fillProduct(fields)
  await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
}

function row(name: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(name) })
}

/** Reads the products straight out of the database the harness is using. */
async function storedProducts(): Promise<ProductRecord[]> {
  const database = await openDatabase({ name: harness.databaseName })
  try {
    return await listProductRecords(database)
  } finally {
    database.close()
  }
}

/** Picks "Diğer…" on a unit dropdown and types a unit that is not on the list. */
async function typeCustomUnit(unitLabel: string, unit: string): Promise<void> {
  const select = screen.getByLabelText(unitLabel)
  await harness.user.selectOptions(
    select,
    within(select).getByRole('option', { name: 'Diğer…' }),
  )
  await harness.user.type(await screen.findByLabelText('Diğer birim'), unit)
}

describe('the empty catalog', () => {
  it('explains itself instead of showing a blank table', async () => {
    await openProducts()

    expect(await screen.findByText('Henüz ürün eklenmemiş')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // The empty state carries the action, so there is no dead end.
    expect(screen.getAllByRole('button', { name: 'Yeni Ürün' }).length).toBeGreaterThan(0)
  })
})

describe('creating a product', () => {
  it('writes it, returns to the list, and shows it there', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'ANK-100', name: 'Çelik Cıvata M8' })

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getByText('ANK-100')).toBeInTheDocument()
    expect(screen.getByText('Çelik Cıvata M8')).toBeInTheDocument()
  })

  it('refuses to submit without the required fields, without touching the database', async () => {
    await openProducts()
    await clickNewProduct()
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    expect(screen.getAllByText('Bu alan zorunludur.')).toHaveLength(3)
    // Still on the form, and the SKU field is marked invalid rather than just
    // coloured.
    expect(screen.getByLabelText('Stok Kodu (SKU)')).toHaveAttribute('aria-invalid', 'true')
  })

  it('rejects a duplicate SKU visibly, whatever its casing', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'ANK-100', name: 'İlk ürün' })
    await waitFor(() => expect(screen.getByText('ANK-100')).toBeInTheDocument())

    await createProductThroughUI({ sku: 'ank-100', name: 'İkinci ürün' })

    expect(await screen.findByText('Bu stok kodu başka bir üründe kullanılıyor.')).toBeInTheDocument()
    // The form stayed open with the user's input intact.
    expect(screen.getByLabelText('Ürün Adı')).toHaveValue('İkinci ürün')
  })

  it('rejects a pack factor that is not a positive number', async () => {
    await openProducts()
    await clickNewProduct()
    await fillProduct({ sku: 'PF-1', name: 'Paket', packFactor: '0' })
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    expect(screen.getByText('Sıfırdan büyük bir değer girin.')).toBeInTheDocument()
  })

  it('stores a decimal pack factor exactly, and reopens it in the local form', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'PF-2', name: 'Paket', packFactor: '12,5' })
    await waitFor(() => expect(screen.getByText('PF-2')).toBeInTheDocument())

    // Canonical storage is dot-separated, whatever was typed.
    expect((await storedProducts())[0]!.unitsPerPurchaseUnit).toEqual({ value: '12.5' })

    // Reopened in a Turkish interface, it reads back the Turkish way.
    await harness.user.click(within(row('PF-2')).getByRole('button', { name: 'Düzenle' }))
    expect(screen.getByLabelText(CONVERSION_LABEL)).toHaveValue('12,5')
  })
})

describe('editing a product', () => {
  it('loads the stored record and saves the change', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'EDT-1', name: 'Eski ad' })
    await waitFor(() => expect(screen.getByText('EDT-1')).toBeInTheDocument())

    await harness.user.click(within(row('EDT-1')).getByRole('button', { name: 'Düzenle' }))
    expect(screen.getByLabelText('Ürün Adı')).toHaveValue('Eski ad')

    await harness.user.clear(screen.getByLabelText('Ürün Adı'))
    await harness.user.type(screen.getByLabelText('Ürün Adı'), 'Yeni ad')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    await waitFor(() => expect(screen.getByText('Yeni ad')).toBeInTheDocument())
    expect(screen.queryByText('Eski ad')).not.toBeInTheDocument()
    // One record, edited — not a second one created.
    expect(screen.getAllByText('EDT-1')).toHaveLength(1)
  })

  it('keeps a product able to save its own unchanged SKU', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'SELF-1', name: 'Kendi kodu' })
    await waitFor(() => expect(screen.getByText('SELF-1')).toBeInTheDocument())

    await harness.user.click(within(row('SELF-1')).getByRole('button', { name: 'Düzenle' }))
    await harness.user.clear(screen.getByLabelText('Ürün Adı'))
    await harness.user.type(screen.getByLabelText('Ürün Adı'), 'Güncellendi')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    await waitFor(() => expect(screen.getByText('Güncellendi')).toBeInTheDocument())
    expect(screen.queryByText('Bu stok kodu başka bir üründe kullanılıyor.')).not.toBeInTheDocument()
  })
})

describe('deactivating a product', () => {
  it('asks first, and says plainly that it is not a deletion', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'DEA-1', name: 'Pasife alınacak' })
    await waitFor(() => expect(screen.getByText('DEA-1')).toBeInTheDocument())

    await harness.user.click(within(row('DEA-1')).getByRole('button', { name: 'Pasife Al' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Pasife alınacak/)).toBeInTheDocument()
    expect(
      within(dialog).getByText('Bu bir silme işlemi değildir. Ana veri kayıtları silinmez.'),
    ).toBeInTheDocument()
  })

  it('removes it from the default active view but keeps the record', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'DEA-2', name: 'Pasif ürün' })
    await waitFor(() => expect(screen.getByText('DEA-2')).toBeInTheDocument())

    await harness.user.click(within(row('DEA-2')).getByRole('button', { name: 'Pasife Al' }))
    await harness.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Pasife Al' }),
    )

    // The default filter is "active", so it leaves the visible list…
    await waitFor(() => expect(screen.queryByText('DEA-2')).not.toBeInTheDocument())
    // …and is still there under "all", carrying an inactive status in words.
    await harness.user.click(screen.getByRole('button', { name: 'Tümü' }))
    await waitFor(() => expect(screen.getByText('DEA-2')).toBeInTheDocument())
    expect(within(row('DEA-2')).getByText('Pasif')).toBeInTheDocument()
  })

  it('can be undone, because deactivation is a lifecycle state', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'DEA-3', name: 'Geri alınacak' })
    await waitFor(() => expect(screen.getByText('DEA-3')).toBeInTheDocument())

    await harness.user.click(within(row('DEA-3')).getByRole('button', { name: 'Pasife Al' }))
    await harness.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Pasife Al' }),
    )
    await waitFor(() => expect(screen.queryByText('DEA-3')).not.toBeInTheDocument())

    await harness.user.click(screen.getByRole('button', { name: 'Pasif' }))
    await waitFor(() => expect(screen.getByText('DEA-3')).toBeInTheDocument())
    await harness.user.click(within(row('DEA-3')).getByRole('button', { name: 'Aktife Al' }))
    await harness.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Aktife Al' }),
    )

    await harness.user.click(screen.getByRole('button', { name: 'Aktif' }))
    await waitFor(() => expect(screen.getByText('DEA-3')).toBeInTheDocument())
  })

  it('offers no delete control at all', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'NODEL-1', name: 'Silinemez' })
    await waitFor(() => expect(screen.getByText('NODEL-1')).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: 'Sil' })).not.toBeInTheDocument()
  })
})

describe('searching and filtering', () => {
  it('matches case-insensitively across Turkish casing', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'IST-1', name: 'İSTANBUL Bağlantı' })
    await waitFor(() => expect(screen.getByText('IST-1')).toBeInTheDocument())
    await createProductThroughUI({ sku: 'ANK-1', name: 'Ankara Bağlantı' })
    await waitFor(() => expect(screen.getByText('ANK-1')).toBeInTheDocument())

    await harness.user.type(screen.getByLabelText('Ara'), 'istanbul')

    await waitFor(() => expect(screen.queryByText('ANK-1')).not.toBeInTheDocument())
    expect(screen.getByText('IST-1')).toBeInTheDocument()
  })

  it('matches on the SKU as well as the name', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'ZXQ-991', name: 'Bir ürün' })
    await waitFor(() => expect(screen.getByText('ZXQ-991')).toBeInTheDocument())
    await createProductThroughUI({ sku: 'AAA-100', name: 'Başka ürün' })
    await waitFor(() => expect(screen.getByText('AAA-100')).toBeInTheDocument())

    await harness.user.type(screen.getByLabelText('Ara'), 'zxq')
    await waitFor(() => expect(screen.queryByText('AAA-100')).not.toBeInTheDocument())
    expect(screen.getByText('ZXQ-991')).toBeInTheDocument()
  })

  it('says so when a search matches nothing, rather than showing an empty table', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'ONLY-1', name: 'Tek ürün' })
    await waitFor(() => expect(screen.getByText('ONLY-1')).toBeInTheDocument())

    await harness.user.type(screen.getByLabelText('Ara'), 'bulunamayacak')
    expect(await screen.findByText('Eşleşen kayıt yok')).toBeInTheDocument()
    // Not the "no products yet" state: the catalogue is not empty.
    expect(screen.queryByText('Henüz ürün eklenmemiş')).not.toBeInTheDocument()
  })

  it('sorts by name using the Turkish alphabet, not code points', async () => {
    await openProducts()
    for (const [sku, name] of [
      ['S-1', 'Zeytin'],
      ['S-2', 'Çelik'],
      ['S-3', 'Demir'],
    ] as const) {
      await createProductThroughUI({ sku, name })
      await waitFor(() => expect(screen.getByText(sku)).toBeInTheDocument())
    }

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((tableRow) => within(tableRow).getByText(/Zeytin|Çelik|Demir/).textContent)

    // Ç sorts between C and D in Turkish. Under code-unit comparison it would
    // be last, after Z.
    expect(names).toEqual(['Çelik', 'Demir', 'Zeytin'])
  })
})

describe('the stock unit is asked as a question, not as a field name', () => {
  it('offers the units a warehouse counts in, rather than an empty text box', async () => {
    await openProducts()
    await clickNewProduct()

    const select = screen.getByLabelText('Stok Birimi')
    expect(select.tagName).toBe('SELECT')
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(
      expect.arrayContaining(['Adet', 'Kutu', 'Paket', 'Koli', 'Set', 'Metre', 'Kilogram', 'Litre']),
    )
    // The labels are Turkish; the values behind them are not.
    const values = within(select)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
    expect(values).toEqual(expect.arrayContaining(['PIECE', 'BOX', 'CARTON', 'METER']))
    // …and a way out of the list, so the field is still free text underneath.
    expect(options).toContain('Diğer…')
  })

  it('explains what it is asking, in warehouse terms and with examples', async () => {
    await openProducts()
    await clickNewProduct()

    expect(
      screen.getByText(/Depoda ürünü hangi birimle saydığınızı seçin/),
    ).toBeInTheDocument()
    expect(screen.getByText(/37 Adet, 12 Kutu, 250 Metre/)).toBeInTheDocument()
  })

  it('stores a locale-independent code and shows the translated label', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'UNI-1', name: 'Birim testi', stockUnit: 'Koli' })
    await screen.findByText('UNI-1')

    expect(within(row('UNI-1')).getByText('Koli')).toBeInTheDocument()
    // What is persisted is the code, not the Turkish word on screen.
    expect((await storedProducts())[0]!.stockUnit).toBe('CARTON')
  })

  it('persists the same value whichever language picked it', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'UNI-TR', name: 'Türkçe seçim', stockUnit: 'Adet' })
    await screen.findByText('UNI-TR')
    const fromTurkish = (await storedProducts())[0]!.stockUnit

    // The same product master, the same list, the other language.
    await harness.user.click(screen.getByRole('button', { name: 'English' }))
    await screen.findByRole('heading', { level: 1, name: 'Products' })
    await harness.user.click(await screen.findByRole('button', { name: 'New product' }))
    await harness.user.type(screen.getByLabelText('SKU'), 'UNI-EN')
    await harness.user.type(screen.getByLabelText('Product name'), 'English choice')
    await harness.user.selectOptions(screen.getByLabelText('Stock unit'), 'Piece')
    await harness.user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('UNI-EN')

    const stored = await storedProducts()
    const fromEnglish = stored.find((product) => product.sku === 'UNI-EN')!.stockUnit

    expect(fromTurkish).toBe('PIECE')
    expect(fromEnglish).toBe('PIECE')
    expect(fromEnglish).toBe(fromTurkish)
  })

  it('switching language changes the label and never the stored value', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'UNI-2', name: 'Dil testi', stockUnit: 'Kutu' })
    await screen.findByText('UNI-2')
    const before = (await storedProducts())[0]!

    await harness.user.click(screen.getByRole('button', { name: 'English' }))
    await screen.findByRole('heading', { level: 1, name: 'Products' })

    // The row now reads "Box"…
    expect(within(row('UNI-2')).getByText('Box')).toBeInTheDocument()
    // …and the record is byte-for-byte the one that was written.
    expect(await storedProducts()).toEqual([before])
  })

  it('accepts a unit that is not on the list, through "Diğer…", and never translates it', async () => {
    await openProducts()
    await clickNewProduct()

    await harness.user.type(screen.getByLabelText('Stok Kodu (SKU)'), 'ROL-1')
    await harness.user.type(screen.getByLabelText('Ürün Adı'), 'Rulo ürün')
    await typeCustomUnit('Stok Birimi', 'Rulo')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    await screen.findByText('ROL-1')
    expect(within(row('ROL-1')).getByText('Rulo')).toBeInTheDocument()
    // A company's own unit is stored verbatim: one field, no code table.
    expect((await storedProducts())[0]!.stockUnit).toBe('Rulo')

    // And it survives the language switch unchanged, in the list and in store.
    await harness.user.click(screen.getByRole('button', { name: 'English' }))
    await screen.findByRole('heading', { level: 1, name: 'Products' })
    expect(within(row('ROL-1')).getByText('Rulo')).toBeInTheDocument()
    expect((await storedProducts())[0]!.stockUnit).toBe('Rulo')
  })

  it('shows a stored unit it does not recognise as itself, not as an error', async () => {
    await openProducts()
    await clickNewProduct()
    await harness.user.type(screen.getByLabelText('Stok Kodu (SKU)'), 'ROL-2')
    await harness.user.type(screen.getByLabelText('Ürün Adı'), 'Rulo ürün')
    await typeCustomUnit('Stok Birimi', 'Rulo')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    await screen.findByText('ROL-2')

    await harness.user.click(within(row('ROL-2')).getByRole('button', { name: 'Düzenle' }))
    // Reopened: the dropdown carries the stored value as its own option and has
    // it selected. Nothing was rewritten to the nearest known unit.
    expect(screen.getByLabelText('Stok Birimi')).toHaveValue('Rulo')
  })
})

describe('the purchase-unit conversion reads itself back', () => {
  it('shows nothing until all three parts of the sentence are real', async () => {
    await openProducts()
    await clickNewProduct()

    expect(screen.queryByText(/^1 .+ = .+$/)).not.toBeInTheDocument()

    await harness.user.selectOptions(screen.getByLabelText('Stok Birimi'), 'Adet')
    await harness.user.type(screen.getByLabelText(CONVERSION_LABEL), '50')
    // Still no purchase unit, so still no sentence.
    expect(screen.queryByText(/^1 .+ = .+$/)).not.toBeInTheDocument()
  })

  it('reads "1 Kutu = 50 Adet" once the units and the factor are chosen', async () => {
    await openProducts()
    await clickNewProduct()

    await harness.user.selectOptions(screen.getByLabelText('Stok Birimi'), 'Adet')
    await harness.user.selectOptions(
      screen.getByLabelText('Varsayılan Satın Alma Birimi'),
      'Kutu',
    )
    await harness.user.type(screen.getByLabelText(CONVERSION_LABEL), '50')

    expect(await screen.findByText('1 Kutu = 50 Adet')).toBeInTheDocument()
  })

  it('does not change what the conversion means: the exact decimal is stored', async () => {
    await openProducts()
    await createProductThroughUI({
      sku: 'CNV-1',
      name: 'Dönüşüm',
      stockUnit: 'Adet',
      purchaseUnit: 'Paket',
      packFactor: '12.5',
    })
    await screen.findByText('CNV-1')

    // Still a Quantity snapshot, still character-exact — the wording changed,
    // the semantics did not.
    expect((await storedProducts())[0]!.unitsPerPurchaseUnit).toEqual({ value: '12.5' })
  })

  it('accepts the Turkish decimal comma and stores the canonical dot form', async () => {
    await openProducts()
    await createProductThroughUI({
      sku: 'CNV-2',
      name: 'Virgül',
      stockUnit: 'Adet',
      purchaseUnit: 'Kutu',
      packFactor: '12,5',
    })
    await screen.findByText('CNV-2')

    expect((await storedProducts())[0]!.unitsPerPurchaseUnit).toEqual({ value: '12.5' })
  })

  it('reads a comma decimal back in the example while the user types it', async () => {
    await openProducts()
    await clickNewProduct()

    await harness.user.selectOptions(screen.getByLabelText('Stok Birimi'), 'Adet')
    await harness.user.selectOptions(
      screen.getByLabelText('Varsayılan Satın Alma Birimi'),
      'Kutu',
    )
    await harness.user.type(screen.getByLabelText(CONVERSION_LABEL), '12,5')

    expect(await screen.findByText('1 Kutu = 12,5 Adet')).toBeInTheDocument()
  })

  it('re-expresses a half-typed factor when the language changes under the form', async () => {
    await openProducts()
    await clickNewProduct()
    await harness.user.type(screen.getByLabelText(CONVERSION_LABEL), '1,5')

    await harness.user.click(screen.getByRole('button', { name: 'English' }))

    // The same quantity, written the way the new language writes it — not a
    // Turkish decimal left sitting in an English form, where "1,5" would be
    // read against English conventions on the next save.
    expect(
      await screen.findByLabelText('How many stock units are in 1 purchase unit?'),
    ).toHaveValue('1.5')
  })

  it('refuses the one input that could mean two magnitudes, rather than guessing', async () => {
    await openProducts()
    await clickNewProduct()
    // In Turkish "1.500" is either one thousand five hundred or one and a half.
    // A thousand-fold difference is not something to decide on the user's behalf.
    await fillProduct({ sku: 'CNV-4', name: 'Belirsiz', packFactor: '1.500' })
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))

    expect(
      screen.getByText(
        '“1.500” belirsiz: buradaki ayıracın binlik mi ondalık mı olduğu anlaşılmıyor. Binlik ayracı kullanmayın. Örnek: 1500 ya da 1,5',
      ),
    ).toBeInTheDocument()
    // Nothing was guessed at and nothing was written.
    expect(await storedProducts()).toHaveLength(0)
    // …and the read-back sentence stays away while the value is unreadable.
    expect(screen.queryByText(/^1 .+ = .+$/)).not.toBeInTheDocument()
  })

  it('is not presented as mandatory', async () => {
    await openProducts()
    await clickNewProduct()

    expect(screen.getByLabelText(CONVERSION_LABEL)).not.toHaveAttribute('aria-required')
    // A product with no purchase unit and no factor saves cleanly.
    await fillProduct({ sku: 'CNV-3', name: 'Faktörsüz' })
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    await screen.findByText('CNV-3')
    expect((await storedProducts())[0]!.unitsPerPurchaseUnit).toBeUndefined()
  })
})

describe('the form says which fields are required, once', () => {
  it('marks the three required controls and states the rule in one sentence', async () => {
    await openProducts()
    await clickNewProduct()

    expect(screen.getByLabelText('Stok Kodu (SKU)')).toHaveAttribute('aria-required', 'true')
    expect(screen.getByLabelText('Ürün Adı')).toHaveAttribute('aria-required', 'true')
    expect(screen.getByLabelText('Stok Birimi')).toHaveAttribute('aria-required', 'true')
    expect(screen.getByLabelText('Üretici')).not.toHaveAttribute('aria-required')

    expect(
      screen.getByText('* işaretli alanlar zorunludur. Diğer alanları boş bırakabilirsiniz.'),
    ).toBeInTheDocument()
    // And the old per-label noise is gone.
    expect(screen.queryByText(/isteğe bağlı/)).not.toBeInTheDocument()
  })

  it('groups the fields under headings a business user can read', async () => {
    await openProducts()
    await clickNewProduct()

    expect(screen.getByRole('group', { name: 'Ürün Bilgileri' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Satın Alma / Paketleme' })).toBeInTheDocument()
  })

  it('distinguishes the product description from the internal note', async () => {
    await openProducts()
    await clickNewProduct()

    expect(screen.getByLabelText('Ürün Açıklaması')).toBeInTheDocument()
    expect(screen.getByText('Ürünü tanımlayan genel veya teknik bilgi.')).toBeInTheDocument()
    expect(screen.getByLabelText('İç Not')).toBeInTheDocument()
    expect(
      screen.getByText('Yalnızca şirket içinde kullanılacak operasyonel not.'),
    ).toBeInTheDocument()
  })
})

describe('a new product is active, and is not asked about it', () => {
  it('shows no Active checkbox while creating', async () => {
    await openProducts()
    await clickNewProduct()

    expect(screen.queryByLabelText('Aktif')).not.toBeInTheDocument()
  })

  it('stores active: true without the user choosing it', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'ACT-1', name: 'Varsayılan aktif' })
    await screen.findByText('ACT-1')

    expect((await storedProducts())[0]!.active).toBe(true)
    // Visible under the default "active" filter, with the word, not just a colour.
    expect(within(row('ACT-1')).getByText('Aktif')).toBeInTheDocument()
  })

  it('offers the Active control again when editing an existing product', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'ACT-2', name: 'Düzenlenecek' })
    await screen.findByText('ACT-2')

    await harness.user.click(within(row('ACT-2')).getByRole('button', { name: 'Düzenle' }))
    expect(screen.getByLabelText('Aktif')).toBeChecked()
  })
})

describe('the same form in English', () => {
  it('asks the same questions, in the other language', async () => {
    harness = await renderApp({ locale: 'en' })
    await goTo(harness, 'Products', 'Products')
    await harness.user.click(await screen.findByRole('button', { name: 'New product' }))

    expect(screen.getByRole('group', { name: 'Product details' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Purchasing / packaging' })).toBeInTheDocument()
    expect(
      screen.getByText('Fields marked * are required. You can leave the rest empty.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Product description')).toBeInTheDocument()
    expect(screen.getByLabelText('Internal note')).toBeInTheDocument()
    expect(screen.getByLabelText('How many stock units are in 1 purchase unit?')).toBeInTheDocument()
    expect(screen.queryByLabelText('Active')).not.toBeInTheDocument()

    const select = screen.getByLabelText('Stock unit')
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(expect.arrayContaining(['Piece', 'Box', 'Carton', 'Meter', 'Other…']))
  })

  it('reads the conversion back in English', async () => {
    harness = await renderApp({ locale: 'en' })
    await goTo(harness, 'Products', 'Products')
    await harness.user.click(await screen.findByRole('button', { name: 'New product' }))

    await harness.user.selectOptions(screen.getByLabelText('Stock unit'), 'Piece')
    await harness.user.selectOptions(screen.getByLabelText('Default purchase unit'), 'Box')
    await harness.user.type(
      screen.getByLabelText('How many stock units are in 1 purchase unit?'),
      '10',
    )

    expect(await screen.findByText('1 Box = 10 Piece')).toBeInTheDocument()
  })

  it('states the stock rule in business language, not in schema language', async () => {
    harness = await renderApp({ locale: 'en' })
    await goTo(harness, 'Products', 'Products')
    await harness.user.click(await screen.findByRole('button', { name: 'New product' }))

    expect(
      screen.getByText(
        'Stock quantity is never typed onto a product record. Once warehouse receipts and dispatches begin, stock is calculated automatically.',
      ),
    ).toBeInTheDocument()
  })
})

describe('persistence', () => {
  it('survives an unmount, a closed connection and a fresh boot', async () => {
    await openProducts()
    await createProductThroughUI({ sku: 'PER-1', name: 'Kalıcı ürün' })
    await waitFor(() => expect(screen.getByText('PER-1')).toBeInTheDocument())

    await harness.remount()
    await goTo(harness, PRODUCTS, PRODUCTS)

    expect(await screen.findByText('PER-1')).toBeInTheDocument()
    expect(screen.getByText('Kalıcı ürün')).toBeInTheDocument()
  })

  it('stores no stock quantity on the product, now or ever', async () => {
    await openProducts()
    await clickNewProduct()

    // Data Model I1: physical stock is Σ(IN) − Σ(OUT) over the ledger. A field
    // here would be a second answer that nothing keeps in step.
    expect(screen.queryByLabelText(/Stok Miktarı|Stock Quantity/)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Stok miktarı ürün kartına elle yazılmaz. Depo giriş ve çıkışları başladığında stok otomatik hesaplanacaktır.',
      ),
    ).toBeInTheDocument()
  })
})
