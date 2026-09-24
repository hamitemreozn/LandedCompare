/**
 * Audit A, A-M5 — the mutation invariants, per entity, over real HTTP.
 *
 * Audit A removed the version predicate from `update_supplier` and
 * `update_customer`, and granted UPDATE on `api.products`; every existing test
 * stayed green. These assertions are the ones that turn red for both:
 *
 * - a stale update and a stale lifecycle change are refused on EVERY
 *   catalogue entity, with the exact `STALE_WRITE` detail;
 * - `update_customer` refuses an inactive or foreign status;
 * - the read views are not a write path: a PATCH aimed at a genuinely
 *   updatable column (`name`), a POST and a DELETE are each refused by
 *   PRIVILEGE (403 / 42501) — not by an unrelated error on a computed column.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { freshOrganization, freshUser } from './fixtures'
import { rest, SEED, signIn } from './localStack'

let deviceA: string
let deviceB: string
let organizationId: string

function rpc(name: string, token: string, body: Record<string, unknown>) {
  return rest(`rpc/${name}`, { token, method: 'POST', body })
}

function refusal(response: { status: number; json: unknown }) {
  const body = response.json as { code?: string; details?: string } | null
  return { status: response.status, code: body?.code, details: body?.details }
}

beforeAll(async () => {
  const fresh = await freshOrganization('Integrity')
  organizationId = fresh.organizationId
  ;[deviceA, deviceB] = await Promise.all([
    signIn(fresh.owner.email, SEED.password),
    signIn(fresh.owner.email, SEED.password),
  ])
})

describe('stale writes are refused on every catalogue entity', () => {
  it('product: stale update and stale deactivation', async () => {
    const id = crypto.randomUUID()
    const base = {
      p_id: id, p_organization_id: organizationId, p_sku: `P-${id.slice(0, 8)}`, p_name: 'Product',
      p_description: '', p_stock_unit: 'PIECE', p_default_purchase_unit: '', p_units_per_purchase_unit: '',
      p_manufacturer: '', p_manufacturer_ref: '', p_note: '',
    }
    expect((await rpc('create_product', deviceA, base)).status).toBe(200)
    expect((await rpc('update_product', deviceA, { ...base, p_name: 'A wins', p_expected_version: 1 })).status).toBe(200)
    expect(refusal(await rpc('update_product', deviceB, { ...base, p_name: 'B stale', p_expected_version: 1 })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
    expect(refusal(await rpc('set_product_active', deviceB, { p_id: id, p_organization_id: organizationId, p_expected_version: 1, p_active: false })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
  })

  it('supplier: stale update and stale deactivation', async () => {
    const id = crypto.randomUUID()
    const base = { p_id: id, p_organization_id: organizationId, p_display_name: 'Supplier', p_external_ref: '0001', p_note: '' }
    expect((await rpc('create_supplier', deviceA, base)).status).toBe(200)
    expect((await rpc('update_supplier', deviceA, { ...base, p_display_name: 'A wins', p_expected_version: 1 })).status).toBe(200)
    expect(refusal(await rpc('update_supplier', deviceB, { ...base, p_display_name: 'B stale', p_expected_version: 1 })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
    expect(refusal(await rpc('set_supplier_active', deviceB, { p_id: id, p_organization_id: organizationId, p_expected_version: 1, p_active: false })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
    const stored = await rest(`suppliers?id=eq.${id}&select=display_name,version,active,external_ref`, { token: deviceB })
    expect(stored.json).toEqual([{ display_name: 'A wins', version: 2, active: true, external_ref: '0001' }])
  })

  it('customer: stale update and stale deactivation', async () => {
    const id = crypto.randomUUID()
    const base = { p_id: id, p_organization_id: organizationId, p_display_name: 'Customer', p_external_ref: '120-34-00-11-001', p_customer_status_id: null, p_note: '' }
    expect((await rpc('create_customer', deviceA, base)).status).toBe(200)
    expect((await rpc('update_customer', deviceA, { ...base, p_display_name: 'A wins', p_expected_version: 1 })).status).toBe(200)
    expect(refusal(await rpc('update_customer', deviceB, { ...base, p_display_name: 'B stale', p_expected_version: 1 })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
    expect(refusal(await rpc('set_customer_active', deviceB, { p_id: id, p_organization_id: organizationId, p_expected_version: 1, p_active: false })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
  })

  it('customer status: stale update and stale deactivation', async () => {
    const id = crypto.randomUUID()
    const base = { p_id: id, p_organization_id: organizationId, p_code: `ST-${id.slice(0, 6)}`, p_sort_order: 1 }
    expect((await rpc('create_customer_status', deviceA, base)).status).toBe(200)
    expect((await rpc('update_customer_status', deviceA, { ...base, p_sort_order: 2, p_expected_version: 1 })).status).toBe(200)
    expect(refusal(await rpc('update_customer_status', deviceB, { ...base, p_sort_order: 3, p_expected_version: 1 })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
    expect(refusal(await rpc('set_customer_status_active', deviceB, { p_id: id, p_organization_id: organizationId, p_expected_version: 1, p_active: false })))
      .toEqual({ status: 400, code: 'P0001', details: 'STALE_WRITE' })
  })

  it('omitting the expected version finds no function at all', async () => {
    const response = await rpc('update_supplier', deviceA, {
      p_id: crypto.randomUUID(), p_organization_id: organizationId, p_display_name: 'x', p_external_ref: '', p_note: '',
    })
    expect(refusal(response)).toMatchObject({ status: 404, code: 'PGRST202' })
  })
})

describe('update_customer cannot assign a status it may not assign', () => {
  it('refuses an inactive status and a foreign one, and changes nothing', async () => {
    const customerId = crypto.randomUUID()
    const statusId = crypto.randomUUID()
    expect((await rpc('create_customer_status', deviceA, { p_id: statusId, p_organization_id: organizationId, p_code: `OLD-${statusId.slice(0, 6)}`, p_sort_order: 9 })).status).toBe(200)
    expect((await rpc('set_customer_status_active', deviceA, { p_id: statusId, p_organization_id: organizationId, p_expected_version: 1, p_active: false })).status).toBe(200)
    expect((await rpc('create_customer', deviceA, { p_id: customerId, p_organization_id: organizationId, p_display_name: 'Graded', p_external_ref: '', p_customer_status_id: null, p_note: '' })).status).toBe(200)

    const other = await freshUser('ForeignStatus', 'OWNER')
    const otherToken = await signIn(other.email, SEED.password)
    const foreignStatus = crypto.randomUUID()
    expect((await rpc('create_customer_status', otherToken, { p_id: foreignStatus, p_organization_id: other.organizationId, p_code: `FOREIGN-${foreignStatus.slice(0, 6)}`, p_sort_order: 1 })).status).toBe(200)

    const update = (status: string) => rpc('update_customer', deviceA, {
      p_id: customerId, p_organization_id: organizationId, p_expected_version: 1,
      p_display_name: 'Graded', p_external_ref: '', p_customer_status_id: status, p_note: '',
    })
    expect(refusal(await update(statusId))).toEqual({ status: 400, code: 'P0001', details: 'RECORD_INVALID' })
    expect(refusal(await update(foreignStatus))).toEqual({ status: 400, code: 'P0001', details: 'RECORD_INVALID' })
    const stored = await rest(`customers?id=eq.${customerId}&select=customer_status_id,version`, { token: deviceA })
    expect(stored.json).toEqual([{ customer_status_id: null, version: 1 }])
  })
})

describe('the read views are not a write path', () => {
  it('refuses a PATCH of a genuinely updatable column, a POST and a DELETE — by privilege', async () => {
    const id = crypto.randomUUID()
    expect((await rpc('create_supplier', deviceA, { p_id: id, p_organization_id: organizationId, p_display_name: 'View target', p_external_ref: '', p_note: '' })).status).toBe(200)

    // `display_name` is a plain column of an auto-updatable view: if UPDATE
    // were ever granted on the view, this request would succeed and bypass
    // update_supplier's version check. The refusal must be the privilege.
    const patch = await rest(`suppliers?id=eq.${id}`, { token: deviceA, method: 'PATCH', body: { display_name: 'Bypassed the RPC' } })
    expect(refusal(patch)).toMatchObject({ status: 403, code: '42501' })
    const productPatch = await rest(`products?organization_id=eq.${organizationId}`, { token: deviceA, method: 'PATCH', body: { name: 'Bypassed the RPC' } })
    expect(refusal(productPatch)).toMatchObject({ status: 403, code: '42501' })

    const post = await rest('suppliers', { token: deviceA, method: 'POST', body: { id: crypto.randomUUID(), organization_id: organizationId, display_name: 'Inserted through the view' } })
    expect(refusal(post)).toMatchObject({ status: 403, code: '42501' })
    const remove = await rest(`suppliers?id=eq.${id}`, { token: deviceA, method: 'DELETE' })
    expect(refusal(remove)).toMatchObject({ status: 403, code: '42501' })

    const stored = await rest(`suppliers?id=eq.${id}&select=display_name,version`, { token: deviceA })
    expect(stored.json).toEqual([{ display_name: 'View target', version: 1 }])
  })
})
