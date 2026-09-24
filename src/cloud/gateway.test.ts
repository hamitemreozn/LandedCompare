/**
 * The gateway, driven through the REAL supabase-js 2.117 client over a stub
 * transport that behaves like PostgREST and GoTrue.
 *
 * Audit A found tests that asserted how the library was IMAGINED to behave —
 * a network failure thrown as `TypeError` — while postgrest-js returns it as a
 * value with `status: 0`. Driving the real client is what keeps these tests
 * honest about the library. The same properties are proved against the real
 * local stack in `security/`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudClient, CLOUD_SESSION_STORAGE_KEY } from './client'
import { isCloudError } from './errors'
import { createDataGateway, MAX_CATALOG_TRAVERSALS, type DataGateway } from './gateway'

const URL_BASE = 'https://stub.example.test'
const KEY = 'sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ORG = '11111111-1111-4111-8111-111111111111'
const USER = 'aaaaaaaa-0000-4000-8000-000000000001'

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.map.set(key, String(value)) }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>

function gatewayOver(handler: Handler, options: { pageSize?: number; storage?: Storage } = {}): {
  gateway: DataGateway
  storage: Storage
  requests: URL[]
} {
  const storage = options.storage ?? new MemoryStorage()
  const requests: URL[] = []
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requests.push(url)
    return handler(url, init)
  }) as typeof fetch
  const client = createCloudClient({ url: URL_BASE, publishableKey: KEY }, { storage, fetch: fetchStub })
  return { gateway: createDataGateway(client, { pageSize: options.pageSize, storage }), storage, requests }
}

/** A PostgREST products view capped at `maxRows`, honouring keyset, order, limit and count=exact. */
function postgrestProducts(ids: readonly string[], maxRows: number, visible = true): Handler {
  return (url) => {
    if (url.pathname === '/rest/v1/organizations') {
      return json(200, visible ? [{ id: ORG }] : [])
    }
    if (url.pathname !== '/rest/v1/products') return json(404, { code: 'PGRST205' })
    const after = url.searchParams.get('id')?.replace(/^gt\./, '')
    const limit = Number(url.searchParams.get('limit') ?? '1000')
    const remaining = [...ids].sort().filter((id) => (after ? id > after : true))
    const page = remaining.slice(0, Math.min(limit, maxRows))
    const rows = page.map((id) => ({
      id, organization_id: ORG, active: true,
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
      created_by: null, updated_by: null, version: 1,
      sku: `SKU-${id.slice(-4)}`, name: 'P', description: null, stock_unit: 'PIECE',
      default_purchase_unit: null, units_per_purchase_unit: '12345678901234567890.0047',
      manufacturer: null, manufacturer_ref: null, note: null,
    }))
    const range = page.length === 0 ? '*' : `0-${page.length - 1}`
    return json(200, rows, { 'content-range': `${range}/${remaining.length}` })
  }
}

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
})

describe('complete catalogue reads (Audit A, A-H1)', () => {
  it('returns every row in id order although the server caps each response', async () => {
    const all = ids(23)
    for (const pageSize of [5, 50]) {
      const { gateway } = gatewayOver(postgrestProducts(all, 7), { pageSize })
      const products = await gateway.catalog.listProducts(ORG)
      expect(products.map((product) => product.id)).toEqual([...all].sort())
      expect(products[0].unitsPerPurchaseUnit?.value).toBe('12345678901234567890.0047')
    }
  })

  it('refuses rather than returning a partial catalogue when the server reports rows it does not send', async () => {
    const { gateway } = gatewayOver((url) =>
      url.pathname === '/rest/v1/products' ? json(200, [], { 'content-range': '*/5' }) : json(200, [{ id: ORG }]),
    )
    await expect(gateway.catalog.listProducts(ORG)).rejects.toMatchObject({ code: 'UNEXPECTED' })
  })

  it('refuses when the server does not report a count at all', async () => {
    const { gateway } = gatewayOver((url) =>
      url.pathname === '/rest/v1/products' ? json(200, []) : json(200, [{ id: ORG }]),
    )
    await expect(gateway.catalog.listProducts(ORG)).rejects.toMatchObject({ code: 'UNEXPECTED' })
  })
})

/**
 * A products view whose contents change WHILE the gateway pages through it.
 * `afterFirstPage` runs once per traversal, after the traversal's first page
 * (no `id=gt.` filter) has been computed; the reconciliation count is the
 * `select=id&limit=1` request.
 */
function changingProducts(state: { ids: string[]; visible: boolean }, afterFirstPage: (traversal: number) => void) {
  let traversals = 0
  const handler: Handler = (url) => {
    if (url.pathname === '/rest/v1/organizations') return json(200, state.visible ? [{ id: ORG }] : [])
    const reconciliation = url.searchParams.get('select') === 'id'
    const after = url.searchParams.get('id')?.replace(/^gt\./, '')
    const visible = state.visible ? [...state.ids].sort() : []
    const remaining = visible.filter((id) => (after ? id > after : true))
    const limit = Number(url.searchParams.get('limit') ?? '1000')
    const page = remaining.slice(0, Math.min(limit, 7))
    const response = json(
      200,
      page.map(productRow),
      { 'content-range': `${page.length === 0 ? '*' : `0-${page.length - 1}`}/${remaining.length}` },
    )
    if (!reconciliation && !after) {
      traversals += 1
      afterFirstPage(traversals)
    }
    return response
  }
  return { handler, traversals: () => traversals }
}

function productRow(id: string) {
  return {
    id, organization_id: ORG, active: true,
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    created_by: null, updated_by: null, version: 1,
    sku: `SKU-${id.slice(-4)}`, name: 'P', description: null, stock_unit: 'PIECE',
    default_purchase_unit: null, units_per_purchase_unit: null,
    manufacturer: null, manufacturer_ref: null, note: null,
  }
}

const MIDDLE = (index: number) => `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const BEHIND = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const AHEAD = 'ffffffff-0000-4000-8000-000000000001'

describe('reads that reconcile against concurrent change (source review, R-1/R-2)', () => {
  it('a membership withdrawn between pages is NO_MEMBERSHIP, never a shorter list', async () => {
    const state = { ids: Array.from({ length: 20 }, (_, index) => MIDDLE(index)), visible: true }
    const live = changingProducts(state, () => { state.visible = false })
    const { gateway } = gatewayOver(live.handler, { pageSize: 5 })
    await expect(gateway.catalog.listProducts(ORG)).rejects.toMatchObject({ code: 'NO_MEMBERSHIP' })
  })

  it('a row committed behind the cursor is found by reading again', async () => {
    const state = { ids: Array.from({ length: 20 }, (_, index) => MIDDLE(index)), visible: true }
    const live = changingProducts(state, (traversal) => { if (traversal === 1) state.ids.push(BEHIND(1)) })
    const { gateway } = gatewayOver(live.handler, { pageSize: 5 })
    const products = await gateway.catalog.listProducts(ORG)
    expect(products.map((product) => product.id)).toEqual([...state.ids].sort())
    expect(products.map((product) => product.id)).toContain(BEHIND(1))
    expect(live.traversals()).toBe(2)
  })

  it('a row committed ahead of the cursor is read once, in the same traversal', async () => {
    const state = { ids: Array.from({ length: 20 }, (_, index) => MIDDLE(index)), visible: true }
    const live = changingProducts(state, (traversal) => { if (traversal === 1) state.ids.push(AHEAD) })
    const { gateway } = gatewayOver(live.handler, { pageSize: 5 })
    const ids = (await gateway.catalog.listProducts(ORG)).map((product) => product.id)
    expect(ids).toHaveLength(21)
    expect(new Set(ids).size).toBe(21)
    expect(ids.at(-1)).toBe(AHEAD)
    expect(live.traversals()).toBe(1)
  })

  it('writes that never pause make the read fail explicitly after a bounded number of traversals', async () => {
    const state = { ids: Array.from({ length: 20 }, (_, index) => MIDDLE(index)), visible: true }
    const live = changingProducts(state, (traversal) => { state.ids.push(BEHIND(traversal)) })
    const { gateway } = gatewayOver(live.handler, { pageSize: 5 })
    await expect(gateway.catalog.listProducts(ORG)).rejects.toMatchObject({ code: 'UNEXPECTED' })
    expect(live.traversals()).toBe(MAX_CATALOG_TRAVERSALS)
  })
})

describe('empty catalogue vs lost membership (Audit A, A-M2)', () => {
  it('an empty list is a real empty catalogue only while the organisation is still visible', async () => {
    await expect(gatewayOver(postgrestProducts([], 7, true)).gateway.catalog.listProducts(ORG)).resolves.toEqual([])
    await expect(gatewayOver(postgrestProducts([], 7, false)).gateway.catalog.listProducts(ORG)).rejects.toMatchObject({
      code: 'NO_MEMBERSHIP',
    })
  })

  it('a refused mutation is re-examined against live membership', async () => {
    const forbidden: Handler = (url) =>
      url.pathname === '/rest/v1/organizations'
        ? json(200, [])
        : json(403, { code: '42501', details: 'FORBIDDEN', message: 'not an active member of this organization' })
    await expect(
      gatewayOver(forbidden).gateway.catalog.createProduct(ORG, { id: USER, sku: 'X', name: 'X', stockUnit: 'PIECE' }),
    ).rejects.toMatchObject({ code: 'NO_MEMBERSHIP' })
  })
})

describe('error mapping reflects what postgrest-js actually does (Audit A, A-L1)', () => {
  // postgrest-js retries a GET with back-off before it gives up, exactly as it
  // will in the browser; the clock is advanced so the test does not wait.
  async function codeOf(handler: Handler): Promise<string> {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const pending = gatewayOver(handler).gateway.catalog.readProduct(ORG, USER).then(
      () => 'OK',
      (cause: unknown) => (isCloudError(cause) ? cause.code : String(cause)),
    )
    await vi.advanceTimersByTimeAsync(120_000)
    const code = await pending
    vi.useRealTimers()
    return code
  }

  it('a network failure is SERVER_UNAVAILABLE online and OFFLINE offline', async () => {
    const down: Handler = () => { throw new TypeError('Failed to fetch') }
    expect(await codeOf(down)).toBe('SERVER_UNAVAILABLE')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    expect(await codeOf(down)).toBe('OFFLINE')
  })

  it('a gateway 5xx and PostgREST connection codes are SERVER_UNAVAILABLE', async () => {
    expect(await codeOf(() => new Response('<html>Bad Gateway</html>', { status: 502 }))).toBe('SERVER_UNAVAILABLE')
    expect(await codeOf(() => json(503, { code: 'PGRST002', message: 'schema cache' }))).toBe('SERVER_UNAVAILABLE')
    expect(await codeOf(() => json(503, { code: 'PGRST000', message: 'no database' }))).toBe('SERVER_UNAVAILABLE')
  })

  it('database refusals keep their own codes', async () => {
    expect(await codeOf(() => json(500, { code: '55006', message: 'locked' }))).toBe('ORGANIZATION_LOCKED')
    expect(await codeOf(() => json(400, { code: 'P0001', details: 'STALE_WRITE', message: 'stale' }))).toBe('STALE_WRITE')
    expect(await codeOf(() => json(400, { code: '22003', message: 'out of range' }))).toBe('RECORD_INVALID')
    expect(await codeOf(() => json(401, { code: 'PGRST303', message: 'JWT expired' }))).toBe('SESSION_EXPIRED')
  })
})

describe('authentication failures', () => {
  it('wrong credentials are INVALID_CREDENTIALS, not "your session expired"', async () => {
    const { gateway } = gatewayOver(() => json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }))
    await expect(gateway.signInWithPassword('a@example.test', 'wrong')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  it('a sign-in that cannot reach the server is a transport failure', async () => {
    const { gateway } = gatewayOver(() => { throw new TypeError('Failed to fetch') })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    await expect(gateway.signInWithPassword('a@example.test', 'secret-1')).rejects.toMatchObject({ code: 'OFFLINE' })
  })
})

describe('sign-out on a device that is offline with an expired token (Audit A, A-M3)', () => {
  function expiredSession(storage: Storage): void {
    const now = Math.floor(Date.now() / 1000)
    storage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify({
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now - 60,
      user: { id: USER, aud: 'authenticated', role: 'authenticated', email: 'a@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-09-01T00:00:00Z' },
    }))
  }

  it('removes every local credential, and the session does not come back when the network does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const storage = new MemoryStorage()
    expiredSession(storage)
    let online = false
    const handler: Handler = (url) => {
      if (!online) throw new TypeError('Failed to fetch')
      if (url.pathname === '/auth/v1/token') {
        // Were the refresh token still on the device, this is where the
        // previous user would silently come back.
        return json(200, { access_token: 'renewed', refresh_token: 'renewed', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: USER } })
      }
      return json(204, {})
    }
    const { gateway } = gatewayOver(handler, { storage })

    // auth-js retries the refresh with back-off for up to 30 seconds.
    const signedOut = gateway.signOut()
    await vi.advanceTimersByTimeAsync(120_000)
    await signedOut
    expect(storage.getItem(CLOUD_SESSION_STORAGE_KEY)).toBeNull()

    online = true
    const afterReconnect = gatewayOver(handler, { storage }).gateway
    await expect(afterReconnect.currentUserId()).resolves.toBeNull()
  })

  it('an offline refresh is a transport problem, not an expired session — and the session is kept', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const storage = new MemoryStorage()
    expiredSession(storage)
    const { gateway } = gatewayOver(() => { throw new TypeError('Failed to fetch') }, { storage })
    const pending = gateway.currentUserId().then(() => 'OK', (cause) => (isCloudError(cause) ? cause.code : String(cause)))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await pending).toBe('SERVER_UNAVAILABLE')
    expect(storage.getItem(CLOUD_SESSION_STORAGE_KEY)).not.toBeNull()
  })
})
