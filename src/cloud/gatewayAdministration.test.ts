/**
 * The administration half of the gateway, driven through the REAL
 * supabase-js client over a stub transport — the same technique as
 * `gateway.test.ts`, so the tests are honest about how the library reports
 * PostgREST and Edge Function failures. The real server is exercised in
 * `security/organizationAdministration.security.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createCloudClient } from './client'
import { createDataGateway } from './gateway'

const URL_BASE = 'https://stub.example.test'
const KEY = 'sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ORG = '11111111-1111-4111-8111-111111111111'
const USER = 'aaaaaaaa-0000-4000-8000-000000000001'
const AT = '2026-09-25T10:00:00.000Z'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function gatewayOver(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const requests: { url: URL; body: string | undefined }[] = []
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    return handler(url, init)
  }) as typeof fetch
  const storage = new Map<string, string>()
  const memoryStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } as unknown as Storage
  const client = createCloudClient({ url: URL_BASE, publishableKey: KEY }, { storage: memoryStorage, fetch: fetchStub })
  return { gateway: createDataGateway(client, { storage: memoryStorage }), requests }
}

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, displayName: 'Ayşe', email: 'a@example.test', role: 'OWNER', status: 'ACTIVE', version: 1, createdAt: AT, updatedAt: AT, ...extra,
})

describe('listing members', () => {
  it('calls the typed RPC and returns members sorted by user id', async () => {
    const { gateway, requests } = gatewayOver(() => json(200, [member('bbbbbbbb-0000-4000-8000-000000000001'), member(USER)]))
    const members = await gateway.admin.listMembers(ORG)
    expect(members.map((entry) => entry.userId)).toEqual([USER, 'bbbbbbbb-0000-4000-8000-000000000001'])
    expect(requests[0].url.pathname).toBe('/rest/v1/rpc/list_organization_members')
    expect(JSON.parse(requests[0].body!)).toEqual({ p_organization_id: ORG })
  })

  it('refuses a malformed member instead of rendering it', async () => {
    const { gateway } = gatewayOver(() => json(200, [member(USER, { role: 'ROOT' })]))
    await expect(gateway.admin.listMembers(ORG)).rejects.toMatchObject({ code: 'UNEXPECTED' })
  })

  it('refuses the same member listed twice', async () => {
    const { gateway } = gatewayOver(() => json(200, [member(USER), member(USER)]))
    await expect(gateway.admin.listMembers(ORG)).rejects.toMatchObject({ code: 'UNEXPECTED' })
  })

  it('a FORBIDDEN from a caller who is still a member stays FORBIDDEN (a role question)', async () => {
    const { gateway } = gatewayOver((url) => url.pathname === '/rest/v1/organizations'
      ? json(200, [{ id: ORG }])
      : json(403, { code: '42501', details: 'FORBIDDEN', message: 'no' }))
    await expect(gateway.admin.listMembers(ORG)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('a FORBIDDEN from a caller who can no longer see the organisation is NO_MEMBERSHIP', async () => {
    const { gateway } = gatewayOver((url) => url.pathname === '/rest/v1/organizations'
      ? json(200, [])
      : json(403, { code: '42501', details: 'FORBIDDEN', message: 'no' }))
    await expect(gateway.admin.listMembers(ORG)).rejects.toMatchObject({ code: 'NO_MEMBERSHIP' })
  })
})

describe('changing a membership', () => {
  it('sends the version it read and maps a stale one to STALE_WRITE', async () => {
    const { gateway, requests } = gatewayOver(() => json(400, { code: 'P0001', details: 'STALE_WRITE', message: 'stale' }))
    await expect(gateway.admin.setMemberStatus(ORG, USER, 4, 'DISABLED')).rejects.toMatchObject({ code: 'STALE_WRITE' })
    expect(requests[0].url.pathname).toBe('/rest/v1/rpc/set_member_status')
    expect(JSON.parse(requests[0].body!)).toEqual({ p_organization_id: ORG, p_user_id: USER, p_expected_version: 4, p_status: 'DISABLED' })
  })

  it('returns the server projection after a role change', async () => {
    const { gateway } = gatewayOver(() => json(200, member(USER, { role: 'ADMIN', version: 2 })))
    await expect(gateway.admin.setMemberRole(ORG, USER, 1, 'ADMIN')).resolves.toMatchObject({ role: 'ADMIN', version: 2 })
  })
})

describe('the Edge Functions', () => {
  const input = { requestId: '7f000000-0000-4000-8000-000000000001', organizationId: ORG, email: 'new@example.test', displayName: 'New', role: 'MEMBER' as const }

  it('passes on only the status — never a password, token, link, user id or "created" flag, whatever a server sends', async () => {
    const ok = gatewayOver(() => json(200, { status: 'SUCCEEDED', request_id: input.requestId }))
    await expect(ok.gateway.admin.provisionMember(input)).resolves.toEqual({ status: 'SUCCEEDED' })
    expect(ok.requests[0].url.pathname).toBe('/functions/v1/admin-provision-user')
    expect(JSON.parse(ok.requests[0].body!)).toEqual({
      request_id: input.requestId, organization_id: ORG, email: 'new@example.test', display_name: 'New', role: 'MEMBER',
    })

    // A server that sent the old fields, or worse, still reaches the screen as `{ status }` only.
    const hostile = gatewayOver(() => json(200, {
      status: 'SUCCEEDED', user_id: USER, account_created: true, temporary_password: 'Abc7!',
      action_link: 'http://x/verify?token=t', access_token: 'ey.x.y',
    }))
    const result = await hostile.gateway.admin.provisionMember(input)
    expect(result).toEqual({ status: 'SUCCEEDED' })
    expect(JSON.stringify(result)).not.toMatch(/Abc7|token|verify|account_created|user_id/)
  })

  it('offers no password reset of any kind (P12-B1)', () => {
    const { gateway } = gatewayOver(() => json(500, {}))
    expect(Object.keys(gateway.admin).sort()).toEqual([
      'clearProvisioningAttempt', 'listInFlightProvisioningAttempts', 'listMembers', 'provisionMember', 'setMemberRole', 'setMemberStatus',
    ])
  })

  it('maps the function\'s refusals to the application vocabulary', async () => {
    const cases: [number, unknown, string][] = [
      [409, { code: 'PROVISIONING_IN_FLIGHT' }, 'PROVISIONING_IN_FLIGHT'],
      [400, { code: 'RECORD_INVALID' }, 'RECORD_INVALID'],
      [401, { code: 'UNAUTHENTICATED' }, 'SESSION_EXPIRED'],
      [409, { code: 'DUPLICATE_KEY' }, 'DUPLICATE_KEY'],
      [502, { code: 'SERVER_UNAVAILABLE' }, 'SERVER_UNAVAILABLE'],
    ]
    for (const [status, body, expected] of cases) {
      const { gateway } = gatewayOver(() => json(status, body))
      await expect(gateway.admin.provisionMember(input)).rejects.toMatchObject({ code: expected })
    }
  })

  it('a 403 from a caller still in the organisation is FORBIDDEN', async () => {
    const { gateway } = gatewayOver((url) => url.pathname === '/rest/v1/organizations' ? json(200, [{ id: ORG }]) : json(403, { code: 'FORBIDDEN' }))
    await expect(gateway.admin.provisionMember(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('a function that cannot be reached is a transport failure, never a verdict', async () => {
    const { gateway } = gatewayOver((url) => {
      if (url.pathname.startsWith('/functions/')) throw new TypeError('Failed to fetch')
      return json(200, [{ id: ORG }])
    })
    await expect(gateway.admin.provisionMember(input)).rejects.toMatchObject({ code: expect.stringMatching(/^(OFFLINE|SERVER_UNAVAILABLE)$/) })
  })
})
