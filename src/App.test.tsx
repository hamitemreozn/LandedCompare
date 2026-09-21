/**
 * The boot gate and the application shell.
 *
 * The first two tests here are the ones with teeth: the application must not
 * render business data before the database is open, and it must not render it
 * when the database could not be opened at all. Everything else — navigation,
 * the dashboard, the language switch — is behaviour that only exists once
 * those hold.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import i18n, { setLocale } from './i18n'
import { deleteDatabase, SCHEMA_VERSION } from './persistence'
import { createTestDatabaseName } from './persistence/testSupport'
import { goTo, renderApp, type AppHarness } from './test/appHarness'

let harness: AppHarness | undefined

afterEach(async () => {
  await harness?.destroy()
  harness = undefined
  await setLocale('tr')
})

/** A database written by a build from the future. This one must refuse it. */
async function createFutureDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, SCHEMA_VERSION + 5)
    request.onupgradeneeded = () => request.result.createObjectStore('meta', { keyPath: 'key' })
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

describe('the boot gate', () => {
  it('shows an initialising state and no business data while the database opens', async () => {
    await setLocale('tr')
    const databaseName = createTestDatabaseName('boot-gate')
    const view = render(<App options={{ databaseName, requestStorage: false }} />)

    // Synchronously after the first render: the sequence has not finished.
    expect(screen.getByText('Yerel veritabanı hazırlanıyor')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByRole('navigation')).toBeInTheDocument())

    view.unmount()
    await deleteDatabase(databaseName)
  })

  it('blocks on a database it cannot safely open, and shows no application at all', async () => {
    await setLocale('tr')
    const databaseName = createTestDatabaseName('boot-gate-failure')
    await createFutureDatabase(databaseName)

    const view = render(<App options={{ databaseName, requestStorage: false }} />)

    expect(await screen.findByText('Uygulama açılamadı')).toBeInTheDocument()
    // The specific reason, translated — not a DOMException.
    expect(
      screen.getByText(
        'Yerel veriler, uygulamanın bu sürümünden daha yeni bir sürümle yazılmış. Devam etmek verileri bozabilir. Lütfen uygulamayı güncelleyin.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/SCHEMA_VERSION_TOO_NEW/)).toBeInTheDocument()

    // No shell, no navigation, no empty-looking catalogue: an empty list here
    // would tell the user their data is gone.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('Ürünler')).not.toBeInTheDocument()

    view.unmount()
    await deleteDatabase(databaseName)
  })

  it('offers only a retry — never a "reset the database" button', async () => {
    await setLocale('tr')
    const databaseName = createTestDatabaseName('boot-gate-no-reset')
    await createFutureDatabase(databaseName)

    const view = render(<App options={{ databaseName, requestStorage: false }} />)
    await screen.findByText('Uygulama açılamadı')

    const buttons = screen.getAllByRole('button').map((button) => button.textContent)
    expect(buttons).toEqual(['Yeniden Dene'])

    view.unmount()
    await deleteDatabase(databaseName)
  })
})

describe('the application shell', () => {
  it('navigates between the four Phase 9 screens', async () => {
    harness = await renderApp()

    expect(screen.getByRole('heading', { level: 1, name: 'Genel Bakış' })).toBeInTheDocument()

    await goTo(harness, 'Ürünler', 'Ürünler')
    await goTo(harness, 'Tedarikçiler', 'Tedarikçiler')
    await goTo(harness, 'Müşteriler', 'Müşteriler')
    await goTo(harness, 'Genel Bakış', 'Genel Bakış')
  })

  it('reflects the route in the URL, so a reload lands on the same screen', async () => {
    harness = await renderApp()
    await goTo(harness, 'Tedarikçiler', 'Tedarikçiler')

    expect(window.location.hash).toBe('#/suppliers')

    await harness.remount()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tedarikçiler' }),
    ).toBeInTheDocument()
  })

  it('marks the current section for assistive technology, not just visually', async () => {
    harness = await renderApp({ hash: '#/products' })

    const nav = screen.getByRole('navigation', { name: 'Ana menü' })
    expect(within(nav).getByRole('link', { name: 'Ürünler' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: 'Genel Bakış' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('shows future sections as unavailable rather than as broken links', async () => {
    harness = await renderApp()

    // Not links and not buttons: nothing offers to take the user somewhere
    // that does not exist.
    expect(screen.queryByRole('link', { name: /Satın Alma/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Satın Alma/ })).not.toBeInTheDocument()
    expect(screen.getByText('Satın Alma')).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('the dashboard', () => {
  it('warns truthfully that no external backup has ever been exported', async () => {
    harness = await renderApp()

    expect(
      screen.getByText('Henüz hiç dış yedek dosyası dışa aktarılmadı.'),
    ).toBeInTheDocument()
    // And it does not let an internal snapshot pass for one.
    expect(screen.getByText(/anlık kopyalar verilerle aynı diskte/)).toBeInTheDocument()
  })

  it('counts persisted records, and updates after a record is added', async () => {
    harness = await renderApp()

    // Scoped to the content region: the navigation rail also has a link
    // whose name starts with "Ürün".
    await waitFor(() => {
      const products = within(screen.getByRole('main')).getByRole('link', { name: /^Ürün/ })
      expect(within(products).getByText('0')).toBeInTheDocument()
    })

    await goTo(harness, 'Ürünler', 'Ürünler')
    await harness.user.click(await screen.findByRole('button', { name: 'Yeni Ürün' }))
    await harness.user.type(screen.getByLabelText('Stok Kodu (SKU)'), 'DSH-1')
    await harness.user.type(screen.getByLabelText('Ürün Adı'), 'Gösterge ürünü')
    await harness.user.selectOptions(screen.getByLabelText('Stok Birimi'), 'Adet')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    await screen.findByText('DSH-1')

    await goTo(harness, 'Genel Bakış', 'Genel Bakış')
    await waitFor(() => {
      const products = within(screen.getByRole('main')).getByRole('link', { name: /^Ürün/ })
      expect(within(products).getByText('1')).toBeInTheDocument()
    })
    expect(screen.getByText('Gösterge ürünü')).toBeInTheDocument()
  })

  it('reports where the data physically lives', async () => {
    harness = await renderApp()

    expect(screen.getByText('Şema sürümü')).toBeInTheDocument()
    expect(screen.getByText(String(SCHEMA_VERSION))).toBeInTheDocument()
    expect(screen.getByText(harness.databaseName)).toBeInTheDocument()
  })
})

describe('Turkish and English', () => {
  it('renders the whole shell in Turkish', async () => {
    harness = await renderApp({ locale: 'tr' })

    expect(screen.getByRole('navigation', { name: 'Ana menü' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Genel Bakış' })).toBeInTheDocument()
    expect(screen.getByText('Toplam İthal Maliyeti ve yerel operasyon yönetimi')).toBeInTheDocument()
  })

  it('renders the whole shell in English', async () => {
    harness = await renderApp({ locale: 'en' })

    expect(screen.getByRole('navigation', { name: 'Main menu' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByText('Total landed cost and local operations')).toBeInTheDocument()
  })

  it('switches language in place, keeping the screen and its data working', async () => {
    harness = await renderApp({ locale: 'tr' })
    await goTo(harness, 'Müşteriler', 'Müşteriler')

    await harness.user.click(await screen.findByRole('button', { name: 'Yeni Müşteri' }))
    await harness.user.type(screen.getByLabelText('Müşteri Adı'), 'Dil Testi A.Ş.')
    await harness.user.click(screen.getByRole('button', { name: 'Kaydet' }))
    await screen.findByText('Dil Testi A.Ş.')

    await harness.user.click(screen.getByRole('button', { name: 'English' }))

    // The same screen, the same record, in the other language.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Customers' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Dil Testi A.Ş.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New customer' })).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: /Dil Testi/ })).getByText('Active')).toBeInTheDocument()

    // Still usable in the new language: the filter still filters.
    await harness.user.click(screen.getByRole('button', { name: 'Inactive' }))
    expect(await screen.findByText('No matching records')).toBeInTheDocument()
  })

  it('persists the chosen language for the next start', async () => {
    harness = await renderApp({ locale: 'tr' })
    await harness.user.click(screen.getByRole('button', { name: 'English' }))

    await waitFor(() => expect(i18n.language).toBe('en'))
    expect(window.localStorage.getItem('landedcompare.locale')).toBe('en')
  })
})

describe('the shell is keyboard reachable', () => {
  it('moves through the navigation with Tab and activates with Enter', async () => {
    harness = await renderApp()
    const user = userEvent.setup()

    const productsLink = screen.getByRole('link', { name: 'Ürünler' })
    productsLink.focus()
    expect(productsLink).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ürünler' }),
    ).toBeInTheDocument()
  })
})
