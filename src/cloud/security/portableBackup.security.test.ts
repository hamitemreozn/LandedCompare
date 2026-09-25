/**
 * Phase 12 — the portable organisation backup, produced by the REAL gateway
 * from the REAL local stack, where PostgREST's `max_rows` is 1000.
 *
 *   - more than 1000 rows in a section: every one of them is in the file;
 *   - the file equals the database, row for row, by id;
 *   - the hostile-precision decimal and opaque external codes arrive exact;
 *   - a MEMBER gets no backup — refused by the server on the members manifest;
 *   - a failure in the middle of the export produces no file;
 *   - the file carries no credential: not the session's tokens, not a hash.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { exportOrganizationBackup } from '../../backup/cloud/exportOrganization'
import { parseCloudBackup } from '../../backup/cloud/format'
import { CLOUD_SESSION_STORAGE_KEY } from '../client'
import { freshOrganization, seedRows, signedInGateway, type FreshUser } from './fixtures'
import { SEED, rest, signIn, sql } from './localStack'

const HOSTILE = '12345678901234567890.0047'

let org: { organizationId: string; owner: FreshUser; members: FreshUser[] }

beforeAll(async () => {
  org = await freshOrganization('P12Backup', ['ADMIN', 'MEMBER'])
  await seedRows('products', org.organizationId, 1001)
  await seedRows('customers', org.organizationId, 3)
  const token = await signIn(org.owner.email, SEED.password)
  const created = await rest('rpc/create_product', {
    token, method: 'POST',
    body: {
      p_id: crypto.randomUUID(), p_organization_id: org.organizationId, p_sku: 'HOSTILE-1', p_name: 'Hostile precision',
      p_description: '', p_stock_unit: 'PIECE', p_default_purchase_unit: 'BOX', p_units_per_purchase_unit: HOSTILE,
      p_manufacturer: '', p_manufacturer_ref: '', p_note: '',
    },
  })
  expect(created.status).toBe(200)
  await rest('rpc/create_customer_status', { token, method: 'POST', body: { p_id: '5a000000-0000-4000-8000-000000000001', p_organization_id: org.organizationId, p_code: 'A++', p_sort_order: 1 } })
  await rest('rpc/create_supplier', { token, method: 'POST', body: { p_id: crypto.randomUUID(), p_organization_id: org.organizationId, p_display_name: 'Opaque', p_external_ref: '000120.01-A', p_note: '' } })
  await rest('rpc/create_customer', {
    token, method: 'POST',
    body: { p_id: crypto.randomUUID(), p_organization_id: org.organizationId, p_display_name: 'Graded', p_external_ref: '0001', p_customer_status_id: '5a000000-0000-4000-8000-000000000001', p_note: '' },
  })
})

describe('the portable backup, against the real stack', () => {
  it('holds every row of a section larger than max_rows, and equals the database by id', async () => {
    const { gateway } = await signedInGateway(org.owner.email, { pageSize: 400 })
    const artifact = await exportOrganizationBackup(gateway, org.organizationId)
    const parsed = await parseCloudBackup(artifact.json)

    expect(parsed.data.products).toHaveLength(1002)
    const databaseIds = (await sql(`select string_agg(id::text, ',' order by id) from app_data.products where organization_id = '${org.organizationId}'`)).split(',')
    expect(parsed.data.products.map((record) => record.id)).toEqual(databaseIds)
    expect(parsed.manifest.entityCounts).toEqual({ customerStatuses: 1, customers: 4, members: 3, products: 1002, suppliers: 1 })
  })

  it('carries the hostile-precision decimal and the opaque codes exactly', async () => {
    const { gateway } = await signedInGateway(org.owner.email)
    const artifact = await exportOrganizationBackup(gateway, org.organizationId)
    expect(artifact.json).toContain(`"unitsPerPurchaseUnit":{"value":"${HOSTILE}"}`)
    const parsed = await parseCloudBackup(artifact.json)
    expect(parsed.data.suppliers[0].externalRef).toBe('000120.01-A')
    expect(parsed.data.customers.find((record) => record.displayName === 'Graded')).toMatchObject({
      externalRef: '0001', customerStatusId: '5a000000-0000-4000-8000-000000000001',
    })
  })

  it('an ADMIN may export; the members manifest names every member with e-mail, and nothing secret', async () => {
    const { gateway, storage } = await signedInGateway(org.members[0].email)
    const artifact = await exportOrganizationBackup(gateway, org.organizationId)
    const parsed = await parseCloudBackup(artifact.json)
    expect(parsed.data.members.map((member) => member.email).sort()).toEqual([org.owner.email, ...org.members.map((m) => m.email)].sort())

    const session = JSON.parse(storage.getItem(CLOUD_SESSION_STORAGE_KEY)!) as { access_token: string; refresh_token: string }
    expect(artifact.json).not.toContain(session.access_token)
    expect(artifact.json).not.toContain(session.refresh_token)
    const lowered = artifact.json.toLowerCase()
    for (const forbidden of ['password', 'token', 'sb_secret_', 'sb_publishable_', 'service_role', '$2a$', '$2b$']) {
      expect(lowered).not.toContain(forbidden)
    }
  })

  it('a MEMBER gets no backup: the server refuses the members manifest', async () => {
    const { gateway } = await signedInGateway(org.members[1].email)
    await expect(exportOrganizationBackup(gateway, org.organizationId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('a failure in the middle of a section produces no file at all', async () => {
    const handle = await signedInGateway(org.owner.email, { pageSize: 300 })
    let productPages = 0
    handle.afterResponse = (url) => {
      if (url.pathname.endsWith('/products') && url.searchParams.has('limit')) {
        productPages += 1
        if (productPages === 2) handle.offline = true
      }
    }
    await expect(exportOrganizationBackup(handle.gateway, org.organizationId)).rejects.toMatchObject({
      code: expect.stringMatching(/^(OFFLINE|SERVER_UNAVAILABLE)$/),
    })
  })

  it('a membership withdrawn during the export fails it rather than shortening it', async () => {
    const member = org.members[0]
    const handle = await signedInGateway(member.email, { pageSize: 300 })
    let withdrawn = false
    handle.afterResponse = async (url) => {
      if (!withdrawn && url.pathname.endsWith('/products') && url.searchParams.has('limit')) {
        withdrawn = true
        await sql(`update app_data.memberships set status = 'DISABLED' where user_id = '${member.userId}' and organization_id = '${org.organizationId}';`)
      }
    }
    try {
      await expect(exportOrganizationBackup(handle.gateway, org.organizationId)).rejects.toMatchObject({ code: 'NO_MEMBERSHIP' })
    } finally {
      await sql(`update app_data.memberships set status = 'ACTIVE' where user_id = '${member.userId}' and organization_id = '${org.organizationId}';`)
    }
  })
})
