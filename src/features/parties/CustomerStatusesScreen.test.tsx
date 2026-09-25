/**
 * Two small UI-polish points on the customer statuses screen:
 *   - the sort-order field explains itself (it is a list position, not a
 *     customer-value ranking) under its renamed label;
 *   - the record-count footer sits in the same `card__body` wrapper the other
 *     master-data screens use, instead of being flush against the card edge.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { goTo, renderApp, type AppHarness } from '../../test/appHarness'
import { createMemoryCloudGateway } from '../../test/memoryCloud'

let harness: AppHarness | undefined

afterEach(async () => {
  await harness?.destroy()
  harness = undefined
})

describe('customer statuses screen', () => {
  it('labels the sort-order field "Liste sırası" and explains it is not a value score', async () => {
    harness = await renderApp({ gateway: createMemoryCloudGateway() })
    await goTo(harness, 'Müşteri Durumları', 'Müşteri Durumları')
    await harness.user.click(screen.getByRole('button', { name: 'Yeni Müşteri Durumu' }))

    const field = await screen.findByLabelText('Liste sırası')
    expect(field).toBeInTheDocument()
    expect(screen.getByText('Küçük sayılar listede önce görünür; bu bir müşteri değeri puanı değildir.')).toBeInTheDocument()
  })

  it('places the record-count footer in the same card__body wrapper Products/Suppliers/Customers use', async () => {
    const gateway = createMemoryCloudGateway()
    await gateway.catalog.createCustomerStatus(gateway.organizations[0].id, { id: crypto.randomUUID(), code: 'VIP', sortOrder: 1 })
    harness = await renderApp({ gateway })
    await goTo(harness, 'Müşteri Durumları', 'Müşteri Durumları')

    const count = await screen.findByText('1 / 1 kayıt gösteriliyor')
    expect(count.closest('.card__body')).not.toBeNull()
    await waitFor(() => expect(count.closest('.card__body')?.parentElement?.className).toContain('card'))
  })
})
