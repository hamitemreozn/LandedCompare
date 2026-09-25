/**
 * Producing an organisation backup: complete or nothing.
 */
import { describe, expect, it } from 'vitest'
import { CloudError, type DataGateway } from '../../cloud'
import { createMemoryCloudGateway, TEST_ORGANIZATION_ID, TEST_USER_ID } from '../../test/memoryCloud'
import { exportOrganizationBackup } from './exportOrganization'
import { parseCloudBackup } from './format'

const NOW = () => '2026-09-25T10:30:00.000Z'

async function seeded() {
  const gateway = createMemoryCloudGateway()
  const status = await gateway.catalog.createCustomerStatus(TEST_ORGANIZATION_ID, { id: '30000000-0000-4000-8000-000000000001', code: 'A++', sortOrder: 1 })
  await gateway.catalog.createCustomer(TEST_ORGANIZATION_ID, { id: '20000000-0000-4000-8000-000000000001', displayName: 'Müşteri', externalRef: '000120', customerStatusId: status.id })
  await gateway.catalog.createSupplier(TEST_ORGANIZATION_ID, { id: '40000000-0000-4000-8000-000000000001', displayName: 'Tedarikçi', externalRef: '320.01.001' })
  for (let n = 1; n <= 1001; n += 1) {
    await gateway.catalog.createProduct(TEST_ORGANIZATION_ID, {
      id: `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
      sku: `SKU-${n}`, name: `Product ${n}`, stockUnit: 'PIECE',
      ...(n === 7 ? { unitsPerPurchaseUnit: '12345678901234567890.0047' } : {}),
    })
  }
  return gateway
}

describe('exportOrganizationBackup', () => {
  it('reads every section completely and returns a file that verifies', async () => {
    const gateway = await seeded()
    const artifact = await exportOrganizationBackup(gateway, TEST_ORGANIZATION_ID, { now: NOW })

    expect(artifact.entityCounts).toEqual({ customerStatuses: 1, customers: 1, members: 1, products: 1001, suppliers: 1 })
    expect(artifact.filename).toBe('LandedCompare_OrganizationBackup_bbbbbbbb_2026-09-25_1030.json')
    expect(artifact.byteLength).toBe(new TextEncoder().encode(artifact.json).byteLength)
    const parsed = await parseCloudBackup(artifact.json)
    expect(parsed.manifest.source).toEqual({ organizationId: TEST_ORGANIZATION_ID, exportedBy: TEST_USER_ID })
    expect(parsed.data.organization.name).toBe('Test Company')
    expect(parsed.data.products.find((record) => record.sku === 'SKU-7')?.unitsPerPurchaseUnit).toEqual({ value: '12345678901234567890.0047' })
    expect(parsed.data.customers[0].externalRef).toBe('000120')
    expect(parsed.data.suppliers[0].externalRef).toBe('320.01.001')
    expect(parsed.data.members).toEqual([expect.objectContaining({ userId: TEST_USER_ID, role: 'OWNER', email: 'owner@example.test' })])
  })

  it('two exports of unchanged data carry the same data checksum', async () => {
    const gateway = await seeded()
    const first = await exportOrganizationBackup(gateway, TEST_ORGANIZATION_ID, { now: NOW })
    const second = await exportOrganizationBackup(gateway, TEST_ORGANIZATION_ID, { now: () => '2026-09-26T08:00:00.000Z' })
    expect(second.envelope.integrity.value).toBe(first.envelope.integrity.value)
    expect(second.json).not.toBe(first.json)
  })

  it('reads customers before customer statuses, so the file is referentially closed', async () => {
    const gateway = await seeded()
    const order: string[] = []
    const traced: DataGateway = {
      ...gateway,
      catalog: {
        ...gateway.catalog,
        listProducts: async (id) => { order.push('products'); return gateway.catalog.listProducts(id) },
        listSuppliers: async (id) => { order.push('suppliers'); return gateway.catalog.listSuppliers(id) },
        listCustomers: async (id) => { order.push('customers'); return gateway.catalog.listCustomers(id) },
        listCustomerStatuses: async (id) => { order.push('customerStatuses'); return gateway.catalog.listCustomerStatuses(id) },
      },
    }
    await exportOrganizationBackup(traced, TEST_ORGANIZATION_ID, { now: NOW })
    expect(order.indexOf('customers')).toBeLessThan(order.indexOf('customerStatuses'))
  })

  it('a section that fails to read produces no backup at all', async () => {
    const gateway = await seeded()
    const failing: DataGateway = {
      ...gateway,
      catalog: { ...gateway.catalog, listCustomers: async () => { throw new CloudError('SERVER_UNAVAILABLE', 'mid-export outage') } },
    }
    await expect(exportOrganizationBackup(failing, TEST_ORGANIZATION_ID, { now: NOW })).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' })
  })

  it('a MEMBER is refused on the members manifest, so a MEMBER gets no backup', async () => {
    const gateway = createMemoryCloudGateway({ organizations: [{ id: TEST_ORGANIZATION_ID, name: 'Test Company', role: 'MEMBER' }] })
    await expect(exportOrganizationBackup(gateway, TEST_ORGANIZATION_ID, { now: NOW })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('a membership lost during the export fails it', async () => {
    const gateway = await seeded()
    const losing: DataGateway = {
      ...gateway,
      admin: {
        ...gateway.admin,
        listMembers: async (id) => {
          const members = await gateway.admin.listMembers(id)
          gateway.organizations[0].status = 'DISABLED'
          return members
        },
      },
    }
    await expect(exportOrganizationBackup(losing, TEST_ORGANIZATION_ID, { now: NOW })).rejects.toMatchObject({ code: 'NO_MEMBERSHIP' })
  })

  it('a section the server returns malformed is refused by the read-back, not written', async () => {
    const gateway = await seeded()
    const malformed: DataGateway = {
      ...gateway,
      catalog: {
        ...gateway.catalog,
        listSuppliers: async (id) => (await gateway.catalog.listSuppliers(id)).map((record) => ({ ...record, displayName: '​' })),
      },
    }
    await expect(exportOrganizationBackup(malformed, TEST_ORGANIZATION_ID, { now: NOW })).rejects.toMatchObject({ code: 'BACKUP_RECORD_INVALID' })
  })
})
