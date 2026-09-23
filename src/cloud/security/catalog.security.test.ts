/** Phase 11 catalogue proofs through real GoTrue + PostgREST sessions. */
import { beforeAll, describe, expect, it } from 'vitest'
import { rest, SEED, signIn } from './localStack'

const EXACT = '12345678901234567890.0047'
const PRODUCT_ID = 'c1000000-0000-4000-8000-000000000001'
const SUPPLIER_ID = 'c2000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = 'c3000000-0000-4000-8000-000000000001'
const STATUS_ID = 'c4000000-0000-4000-8000-000000000001'

let ownerADeviceA: string
let ownerADeviceB: string
let ownerB: string
let memberA: string

beforeAll(async () => {
  ;[ownerADeviceA, ownerADeviceB, ownerB, memberA] = await Promise.all([
    signIn(SEED.ownerA.email, SEED.password),
    signIn(SEED.ownerA.email, SEED.password),
    signIn(SEED.ownerB.email, SEED.password),
    signIn(SEED.memberA.email, SEED.password),
  ])
})

function createProduct(token: string, overrides: Record<string, unknown> = {}) {
  return rest('rpc/create_product', {
    token,
    method: 'POST',
    body: {
      p_id: PRODUCT_ID,
      p_organization_id: SEED.organizationA,
      p_sku: 'WIRE-EXACT-1',
      p_name: 'Exact wire product',
      p_description: '',
      p_stock_unit: 'PIECE',
      p_default_purchase_unit: 'BOX',
      p_units_per_purchase_unit: EXACT,
      p_manufacturer: '',
      p_manufacturer_ref: '',
      p_note: '',
      ...overrides,
    },
  })
}

describe('catalogue exactness, routes and tenant isolation', () => {
  it('round-trips the adversarial decimal as an exact JSON string over HTTP', async () => {
    const created = await createProduct(ownerADeviceA)
    expect(created.status).toBe(200)

    const response = await rest(`products?id=eq.${PRODUCT_ID}&select=units_per_purchase_unit`, {
      token: ownerADeviceA,
    })
    const value = (response.json as [{ units_per_purchase_unit: unknown }])[0].units_per_purchase_unit
    expect(value).toBe(EXACT)
    expect(typeof value).toBe('string')
    expect(response.text).toContain(`"units_per_purchase_unit":"${EXACT}"`)
    expect(response.text).not.toContain(`"units_per_purchase_unit":${EXACT}`)
  })

  it('has no canonical-table or writable-view bypass that can expose numeric JSON', async () => {
    const direct = await rest(`products?id=eq.${PRODUCT_ID}&select=units_per_purchase_unit`, {
      token: ownerADeviceA,
      headers: { 'Accept-Profile': 'app_data' },
    })
    expect(direct.status).toBe(406)
    expect((direct.json as { code?: string }).code).toBe('PGRST106')

    const patch = await rest(`products?id=eq.${PRODUCT_ID}`, {
      token: ownerADeviceA,
      method: 'PATCH',
      body: { units_per_purchase_unit: 1 },
    })
    expect(patch.status).toBeGreaterThanOrEqual(400)
  })

  it('hides every catalogue view and exact UUID lookup from another tenant', async () => {
    for (const path of [
      `products?id=eq.${PRODUCT_ID}&select=id`,
      `suppliers?id=eq.${SUPPLIER_ID}&select=id`,
      `customers?id=eq.${CUSTOMER_ID}&select=id`,
      `customer_statuses?id=eq.${STATUS_ID}&select=id`,
    ]) {
      const response = await rest(path, { token: ownerB })
      expect(response.status, path).toBe(200)
      expect(response.json, path).toEqual([])
    }
  })

  it('anon cannot read a catalogue view or call a catalogue mutation', async () => {
    const read = await rest('products?select=id')
    expect(read.status).toBeGreaterThanOrEqual(400)
    const write = await rest('rpc/create_product', { method: 'POST', body: {} })
    expect(write.status).toBeGreaterThanOrEqual(400)
  })
})

describe('typed mutations and shared authoritative state', () => {
  it('a second independent session reads the first session’s committed record', async () => {
    const response = await rest(`products?id=eq.${PRODUCT_ID}&select=id,sku,version`, {
      token: ownerADeviceB,
    })
    expect(response.json).toEqual([{ id: PRODUCT_ID, sku: 'WIRE-EXACT-1', version: 1 }])
  })

  it('requires expected_version and refuses a stale write from the second session', async () => {
    const updated = await rest('rpc/update_product', {
      token: ownerADeviceA,
      method: 'POST',
      body: {
        p_id: PRODUCT_ID, p_organization_id: SEED.organizationA, p_expected_version: 1,
        p_sku: 'WIRE-EXACT-1', p_name: 'Updated by device A', p_description: '',
        p_stock_unit: 'PIECE', p_default_purchase_unit: 'BOX', p_units_per_purchase_unit: EXACT,
        p_manufacturer: '', p_manufacturer_ref: '', p_note: '',
      },
    })
    expect(updated.status).toBe(200)
    expect((updated.json as [{ version: number }])[0].version).toBe(2)

    const stale = await rest('rpc/update_product', {
      token: ownerADeviceB,
      method: 'POST',
      body: {
        p_id: PRODUCT_ID, p_organization_id: SEED.organizationA, p_expected_version: 1,
        p_sku: 'WIRE-EXACT-1', p_name: 'Stale device B', p_description: '',
        p_stock_unit: 'PIECE', p_default_purchase_unit: 'BOX', p_units_per_purchase_unit: EXACT,
        p_manufacturer: '', p_manufacturer_ref: '', p_note: '',
      },
    })
    expect(stale.status).toBeGreaterThanOrEqual(400)
    expect((stale.json as { details?: string }).details).toBe('STALE_WRITE')

    const omitted = await rest('rpc/update_product', {
      token: ownerADeviceB,
      method: 'POST',
      body: { p_id: PRODUCT_ID, p_organization_id: SEED.organizationA },
    })
    expect(omitted.status).toBeGreaterThanOrEqual(400)
  })

  it('deactivation requires the current version and preserves the row', async () => {
    const stale = await rest('rpc/set_product_active', {
      token: ownerADeviceB,
      method: 'POST',
      body: { p_id: PRODUCT_ID, p_organization_id: SEED.organizationA, p_expected_version: 1, p_active: false },
    })
    expect((stale.json as { details?: string }).details).toBe('STALE_WRITE')

    const current = await rest('rpc/set_product_active', {
      token: ownerADeviceA,
      method: 'POST',
      body: { p_id: PRODUCT_ID, p_organization_id: SEED.organizationA, p_expected_version: 2, p_active: false },
    })
    expect(current.status).toBe(200)
    expect(current.json).toEqual(expect.arrayContaining([expect.objectContaining({ id: PRODUCT_ID, active: false, version: 3 })]))
  })

  it('denies a typed create that names another organization', async () => {
    const response = await createProduct(ownerADeviceA, {
      p_id: 'c1000000-0000-4000-8000-000000000099',
      p_organization_id: SEED.organizationB,
      p_sku: 'FOREIGN-1',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect((response.json as { details?: string }).details).toBe('FORBIDDEN')
  })

  it('uses the same locale-independent Turkish-character SKU fold as the client', async () => {
    const first = await createProduct(ownerADeviceA, {
      p_id: 'c1000000-0000-4000-8000-000000000010',
      p_sku: 'İST-1',
      p_units_per_purchase_unit: '1',
    })
    expect(first.status).toBe(200)
    const duplicate = await createProduct(ownerADeviceA, {
      p_id: 'c1000000-0000-4000-8000-000000000011',
      p_sku: 'i̇st-1',
      p_units_per_purchase_unit: '1',
    })
    expect(duplicate.status).toBe(409)
  })
})

describe('parties and configurable customer statuses', () => {
  it('starts each organization with no customer status rows', async () => {
    const response = await rest('customer_statuses?select=code,sort_order&order=sort_order.asc', {
      token: ownerADeviceA,
    })
    expect(response.status).toBe(200)
    expect(response.json).toEqual([])
  })

  it('allows C, A, A+ and A++ as ordinary user-created examples', async () => {
    const examples = [
      ['c4000000-0000-4000-8000-000000000010', 'C', 10],
      ['c4000000-0000-4000-8000-000000000011', 'A', 20],
      ['c4000000-0000-4000-8000-000000000012', 'A+', 30],
      ['c4000000-0000-4000-8000-000000000013', 'A++', 40],
    ] as const
    for (const [id, code, sortOrder] of examples) {
      const response = await rest('rpc/create_customer_status', {
        token: ownerADeviceA,
        method: 'POST',
        body: { p_id: id, p_organization_id: SEED.organizationA, p_code: code, p_sort_order: sortOrder },
      })
      expect(response.status, code).toBe(200)
    }
    const rows = await rest('customer_statuses?select=code,sort_order&order=sort_order.asc', {
      token: ownerADeviceB,
    })
    expect(rows.json).toEqual([
      { code: 'C', sort_order: 10 },
      { code: 'A', sort_order: 20 },
      { code: 'A+', sort_order: 30 },
      { code: 'A++', sort_order: 40 },
    ])
  })

  it('stores customer and supplier external system codes as opaque strings', async () => {
    const supplier = await rest('rpc/create_supplier', {
      token: ownerADeviceA,
      method: 'POST',
      body: { p_id: SUPPLIER_ID, p_organization_id: SEED.organizationA, p_display_name: 'Opaque Supplier', p_external_ref: '320-34-00-11-001', p_note: '' },
    })
    expect((supplier.json as [{ external_ref: string }])[0].external_ref).toBe('320-34-00-11-001')

    const status = await rest('rpc/create_customer_status', {
      token: ownerADeviceA,
      method: 'POST',
      body: { p_id: STATUS_ID, p_organization_id: SEED.organizationA, p_code: 'PREFERRED', p_sort_order: 50 },
    })
    expect(status.status).toBe(200)

    const customer = await rest('rpc/create_customer', {
      token: ownerADeviceA,
      method: 'POST',
      body: { p_id: CUSTOMER_ID, p_organization_id: SEED.organizationA, p_display_name: 'Opaque Customer', p_external_ref: '120-34-00-11-001', p_customer_status_id: STATUS_ID, p_note: '' },
    })
    expect(customer.json).toEqual(expect.arrayContaining([expect.objectContaining({ external_ref: '120-34-00-11-001', customer_status_id: STATUS_ID })]))
  })

  it('keeps an inactive status on an existing customer but refuses a new assignment', async () => {
    const deactivated = await rest('rpc/set_customer_status_active', {
      token: ownerADeviceA,
      method: 'POST',
      body: { p_id: STATUS_ID, p_organization_id: SEED.organizationA, p_expected_version: 1, p_active: false },
    })
    expect(deactivated.status).toBe(200)
    const existing = await rest(`customers?id=eq.${CUSTOMER_ID}&select=customer_status_id`, { token: ownerADeviceB })
    expect(existing.json).toEqual([{ customer_status_id: STATUS_ID }])

    const refused = await rest('rpc/create_customer', {
      token: ownerADeviceB,
      method: 'POST',
      body: { p_id: 'c3000000-0000-4000-8000-000000000002', p_organization_id: SEED.organizationA, p_display_name: 'Refused', p_external_ref: '', p_customer_status_id: STATUS_ID, p_note: '' },
    })
    expect((refused.json as { details?: string }).details).toBe('RECORD_INVALID')
  })

  it('rejects a customer status belonging to another organization', async () => {
    const otherStatus = await rest('rpc/create_customer_status', {
      token: ownerB,
      method: 'POST',
      body: { p_id: 'c4000000-0000-4000-8000-000000000099', p_organization_id: SEED.organizationB, p_code: 'OTHER', p_sort_order: 1 },
    })
    expect(otherStatus.status).toBe(200)
    const refused = await rest('rpc/create_customer', {
      token: ownerADeviceA,
      method: 'POST',
      body: { p_id: 'c3000000-0000-4000-8000-000000000099', p_organization_id: SEED.organizationA, p_display_name: 'Cross tenant', p_external_ref: '', p_customer_status_id: 'c4000000-0000-4000-8000-000000000099', p_note: '' },
    })
    expect((refused.json as { details?: string }).details).toBe('RECORD_INVALID')
  })
})

describe('one-time legacy catalogue import', () => {
  const requestId = 'c5000000-0000-4000-8000-000000000001'
  const payload = {
    p_request_id: requestId,
    p_organization_id: SEED.organizationB,
    p_payload_checksum: 'sha256-test-catalog',
    p_products: [],
    p_suppliers: [{ id: 'c2000000-0000-4000-8000-000000000099', displayName: 'Imported', externalRef: '000-OPAQUE', active: true, createdAt: '2026-09-22T12:00:00.000Z', updatedAt: '2026-09-22T12:00:00.000Z' }],
    p_customers: [],
  }

  it('requires OWNER, assigns the authenticated target tenant and is idempotent by request id', async () => {
    const forbidden = await rest('rpc/import_catalog', { token: memberA, method: 'POST', body: { ...payload, p_organization_id: SEED.organizationA } })
    expect(forbidden.status).toBeGreaterThanOrEqual(400)
    expect((forbidden.json as { details?: string }).details).toBe('FORBIDDEN')

    const imported = await rest('rpc/import_catalog', { token: ownerB, method: 'POST', body: payload })
    expect(imported.status).toBe(200)
    expect(imported.json).toEqual({ products: 0, suppliers: 1, customers: 0 })
    const retry = await rest('rpc/import_catalog', { token: ownerB, method: 'POST', body: payload })
    expect(retry.json).toEqual(imported.json)

    const rows = await rest('suppliers?external_ref=eq.000-OPAQUE&select=organization_id,external_ref', { token: ownerB })
    expect(rows.json).toEqual([{ organization_id: SEED.organizationB, external_ref: '000-OPAQUE' }])
  })
})
