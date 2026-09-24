/**
 * Audit A, A-H1 — no catalogue list is ever a silently truncated one.
 *
 * PostgREST caps every response at `max_rows` (1000, locally and hosted). The
 * production gateway reads in keyset pages with an exact count per page; these
 * tests put 1001 and 1500 rows behind the REAL PostgREST and require every one
 * of them back, in a stable order — with page sizes below AND above the
 * server's cap, because correctness must not depend on the cap's value.
 *
 * The second half changes the database BETWEEN two pages of a real read
 * (source review, R-1/R-2): a membership withdrawn, a row committed behind
 * the cursor, one committed ahead of it, and writes that never stop.
 */
import { describe, expect, it } from 'vitest'
import { MAX_CATALOG_TRAVERSALS } from '../gateway'
import { countRows, freshOrganization, seedRows, signedInGateway } from './fixtures'
import { rest, SEED, signIn, sql } from './localStack'

describe('the server cap is real, and the gateway is not fooled by it', () => {
  it('PostgREST itself returns at most 1000 rows for 1500 — the hazard being defended against', async () => {
    const { organizationId, owner } = await freshOrganization('CapEvidence')
    await seedRows('products', organizationId, 1500)
    const token = await signIn(owner.email, SEED.password)
    const raw = await rest(`products?organization_id=eq.${organizationId}&select=id`, { token })
    expect(raw.status).toBe(200)
    expect((raw.json as unknown[]).length).toBe(1000)
  })

  for (const count of [1001, 1500]) {
    it(`reads all ${count} products, suppliers, customers and statuses, in id order`, async () => {
      const { organizationId, owner: user } = await freshOrganization(`Complete${count}`)
      const owner = await signedInGateway(user.email)
      for (const table of ['products', 'suppliers', 'customers', 'customer_statuses'] as const) {
        await seedRows(table, organizationId, count)
      }

      const [products, suppliers, customers, statuses] = await Promise.all([
        owner.gateway.catalog.listProducts(organizationId),
        owner.gateway.catalog.listSuppliers(organizationId),
        owner.gateway.catalog.listCustomers(organizationId),
        owner.gateway.catalog.listCustomerStatuses(organizationId),
      ])

      expect(products).toHaveLength(await countRows('products', organizationId))
      expect(products).toHaveLength(count)
      expect(suppliers).toHaveLength(count)
      expect(customers).toHaveLength(count)
      expect(statuses).toHaveLength(count)
      expect(new Set(products.map((row) => row.id)).size).toBe(count)
      const ids = products.map((row) => row.id)
      expect(ids).toEqual([...ids].sort())
      // Statuses come back in the stable display order: sort_order, code, id.
      for (let index = 1; index < statuses.length; index += 1) {
        expect(statuses[index - 1].sortOrder).toBeLessThanOrEqual(statuses[index].sortOrder)
      }
    })
  }

  it('is complete whether the page is smaller or larger than the server cap', async () => {
    const { organizationId, owner } = await freshOrganization('PageSizes')
    await seedRows('products', organizationId, 1500)
    for (const pageSize of [333, 1000, 1200, 5000]) {
      const handle = await signedInGateway(owner.email, { pageSize })
      expect(await handle.gateway.catalog.listProducts(organizationId), `pageSize ${pageSize}`).toHaveLength(1500)
    }
  })
})

/** The first page of a traversal: a full-column select with no keyset filter. */
function isFirstPage(url: URL): boolean {
  return url.pathname === '/rest/v1/products' && url.searchParams.get('select') !== 'id' && !url.searchParams.has('id')
}

function isPage(url: URL): boolean {
  return url.pathname === '/rest/v1/products' && url.searchParams.get('select') !== 'id'
}

function lowId(): string {
  return `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`
}

async function insertProduct(organizationId: string, id: string, sku: string): Promise<void> {
  await sql(`insert into app_data.products (id, organization_id, sku, name, stock_unit) values ('${id}', '${organizationId}', '${sku}', 'Concurrent ${sku}', 'PIECE');`)
}

describe('a read that the database changes under — real PostgREST (source review, R-1/R-2)', () => {
  it('B: a membership disabled after page 1 fails as NO_MEMBERSHIP, never as a shorter list', async () => {
    const { organizationId, owner } = await freshOrganization('MidReadRevoked')
    await seedRows('products', organizationId, 1200)
    const handle = await signedInGateway(owner.email, { pageSize: 500 })
    let pages = 0
    handle.afterResponse = async (url) => {
      if (!isPage(url)) return
      pages += 1
      if (pages === 1) await sql(`update app_data.memberships set status = 'DISABLED' where user_id = '${owner.userId}';`)
    }

    await expect(handle.gateway.catalog.listProducts(organizationId)).rejects.toMatchObject({ code: 'NO_MEMBERSHIP' })
    // Page 2 really was read — and really came back empty with count 0.
    expect(pages).toBe(2)
  })

  it('C: a row committed behind the cursor is in the result, found by a second traversal', async () => {
    const { organizationId, owner } = await freshOrganization('BehindCursor')
    await seedRows('products', organizationId, 1200)
    const handle = await signedInGateway(owner.email, { pageSize: 500 })
    const behind = lowId()
    let traversals = 0
    handle.afterResponse = async (url) => {
      if (!isFirstPage(url)) return
      traversals += 1
      if (traversals === 1) await insertProduct(organizationId, behind, 'BEHIND')
    }

    const ids = (await handle.gateway.catalog.listProducts(organizationId)).map((product) => product.id)
    expect(ids).toContain(behind)
    expect(ids).toHaveLength(1201)
    expect(new Set(ids).size).toBe(1201)
    expect(ids).toHaveLength(await countRows('products', organizationId))
    expect(traversals).toBe(2)
  })

  it('D: a row committed ahead of the cursor is read once, with no second traversal', async () => {
    const { organizationId, owner } = await freshOrganization('AheadOfCursor')
    await seedRows('products', organizationId, 1200)
    const handle = await signedInGateway(owner.email, { pageSize: 500 })
    const ahead = `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`
    let traversals = 0
    handle.afterResponse = async (url) => {
      if (!isFirstPage(url)) return
      traversals += 1
      if (traversals === 1) await insertProduct(organizationId, ahead, 'AHEAD')
    }

    const ids = (await handle.gateway.catalog.listProducts(organizationId)).map((product) => product.id)
    expect(ids).toHaveLength(1201)
    expect(new Set(ids).size).toBe(1201)
    expect(ids.at(-1)).toBe(ahead)
    expect(traversals).toBe(1)
  })

  it('E: writes that never pause end in an explicit failure after a bounded number of traversals', async () => {
    const { organizationId, owner } = await freshOrganization('NeverStill')
    await seedRows('products', organizationId, 1200)
    const handle = await signedInGateway(owner.email, { pageSize: 500 })
    let traversals = 0
    handle.afterResponse = async (url) => {
      if (!isFirstPage(url)) return
      traversals += 1
      await insertProduct(organizationId, lowId(), `BEHIND-${traversals}`)
    }

    await expect(handle.gateway.catalog.listProducts(organizationId)).rejects.toMatchObject({ code: 'UNEXPECTED' })
    expect(traversals).toBe(MAX_CATALOG_TRAVERSALS)
    expect(await countRows('products', organizationId)).toBe(1200 + MAX_CATALOG_TRAVERSALS)
  })
})
