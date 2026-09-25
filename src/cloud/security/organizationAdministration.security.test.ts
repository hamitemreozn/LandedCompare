/**
 * Phase 12 — organisation administration and the A-L6 lifecycle, over real
 * HTTP against the local stack: PostgREST, GoTrue and the Edge Functions.
 *
 * Every authority decision asserted here is the SERVER's. The requests are
 * sent with real access tokens, raw, so nothing a well-behaved client would
 * refuse to send is left untried — a MEMBER calling the admin RPC directly,
 * an OWNER of another company naming this one, a stale version.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { addFreshUser, freshOrganization, signedInGateway, type FreshUser } from './fixtures'
import { invokeFunction, rest, SEED, signIn, sql } from './localStack'

interface Member {
  userId: string
  email: string | null
  role: string
  status: string
  version: number
}

let org: { organizationId: string; owner: FreshUser; members: FreshUser[] }
let other: { organizationId: string; owner: FreshUser; members: FreshUser[] }
let ownerToken: string
let adminToken: string
let memberToken: string
let otherOwnerToken: string

async function members(token: string, organizationId: string) {
  return rest('rpc/list_organization_members', { token, method: 'POST', body: { p_organization_id: organizationId } })
}

async function memberRow(organizationId: string, userId: string): Promise<Member> {
  const listed = await members(ownerToken, organizationId)
  return (listed.json as Member[]).find((entry) => entry.userId === userId)!
}

beforeAll(async () => {
  org = await freshOrganization('P12Admin', ['ADMIN', 'MEMBER', 'MEMBER'])
  other = await freshOrganization('P12Other')
  ownerToken = await signIn(org.owner.email, SEED.password)
  adminToken = await signIn(org.members[0].email, SEED.password)
  memberToken = await signIn(org.members[1].email, SEED.password)
  otherOwnerToken = await signIn(other.owner.email, SEED.password)
})

describe('who may read the roster', () => {
  it('an OWNER and an ADMIN read every member of their company, with e-mail', async () => {
    for (const token of [ownerToken, adminToken]) {
      const response = await members(token, org.organizationId)
      expect(response.status).toBe(200)
      const emails = (response.json as Member[]).map((entry) => entry.email).sort()
      expect(emails).toEqual([org.owner.email, ...org.members.map((entry) => entry.email)].sort())
    }
  })

  it('a MEMBER is refused by the database, not by a hidden button', async () => {
    const response = await members(memberToken, org.organizationId)
    expect(response.status).toBe(403)
    expect(response.json).toMatchObject({ code: '42501', details: 'FORBIDDEN' })
  })

  it('an OWNER of another company is refused, and learns nothing about this one', async () => {
    const response = await members(otherOwnerToken, org.organizationId)
    expect(response.status).toBe(403)
    expect(response.text).not.toContain(org.owner.email)
  })

  it('an anonymous caller has no route at all', async () => {
    const response = await rest('rpc/list_organization_members', { method: 'POST', body: { p_organization_id: org.organizationId } })
    expect(response.status).toBe(401)
  })
})

describe('changing role and status, as the server decides', () => {
  it('a MEMBER cannot promote themselves or disable a colleague', async () => {
    const self = await rest('rpc/set_member_role', {
      token: memberToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: org.members[1].userId, p_expected_version: 1, p_role: 'OWNER' },
    })
    expect(self.status).toBe(403)
    const colleague = await rest('rpc/set_member_status', {
      token: memberToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: org.members[2].userId, p_expected_version: 1, p_status: 'DISABLED' },
    })
    expect(colleague.status).toBe(403)
    expect(await sql(`select role || ':' || status from app_data.memberships where user_id = '${org.members[1].userId}'`)).toBe('MEMBER:ACTIVE')
  })

  it('an ADMIN cannot touch the OWNER, cannot grant OWNER, and cannot change themselves', async () => {
    const owner = await rest('rpc/set_member_status', {
      token: adminToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: org.owner.userId, p_expected_version: 1, p_status: 'DISABLED' },
    })
    const grant = await rest('rpc/set_member_role', {
      token: adminToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: org.members[2].userId, p_expected_version: 1, p_role: 'OWNER' },
    })
    const self = await rest('rpc/set_member_role', {
      token: adminToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: org.members[0].userId, p_expected_version: 1, p_role: 'MEMBER' },
    })
    expect([owner.status, grant.status, self.status]).toEqual([403, 403, 403])
  })

  it('an OWNER of another company cannot disable a member here', async () => {
    const response = await rest('rpc/set_member_status', {
      token: otherOwnerToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: org.members[2].userId, p_expected_version: 1, p_status: 'DISABLED' },
    })
    expect(response.status).toBe(403)
  })

  it('an ADMIN promotes a MEMBER; the same request with the old version is a STALE_WRITE', async () => {
    const before = await memberRow(org.organizationId, org.members[2].userId)
    const body = { p_organization_id: org.organizationId, p_user_id: org.members[2].userId, p_expected_version: before.version, p_role: 'ADMIN' }
    const first = await rest('rpc/set_member_role', { token: adminToken, method: 'POST', body })
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ role: 'ADMIN', version: before.version + 1 })
    const stale = await rest('rpc/set_member_role', { token: adminToken, method: 'POST', body: { ...body, p_role: 'MEMBER' } })
    expect(stale.status).toBe(400)
    expect(stale.json).toMatchObject({ details: 'STALE_WRITE' })
    expect(await sql(`select count(*) from app_data.admin_events where organization_id = '${org.organizationId}' and event_type = 'MEMBER_ROLE_CHANGED' and subject_user_id = '${org.members[2].userId}'`)).toBe('1')
  })

  it('no route writes the memberships table directly', async () => {
    const patch = await rest(`memberships?user_id=eq.${org.members[1].userId}`, { token: memberToken, method: 'PATCH', body: { role: 'OWNER' } })
    expect(patch.status).toBeGreaterThanOrEqual(400)
    expect(await sql(`select role from app_data.memberships where user_id = '${org.members[1].userId}'`)).toBe('MEMBER')
  })

  it('the real gateway reaches the same surface and parses its answers', async () => {
    const { gateway } = await signedInGateway(org.owner.email)
    const listed = await gateway.admin.listMembers(org.organizationId)
    expect(listed.map((entry) => entry.userId)).toContain(org.members[1].userId)
    const target = listed.find((entry) => entry.userId === org.members[1].userId)!
    await expect(gateway.admin.setMemberRole(org.organizationId, target.userId, target.version + 5, 'ADMIN')).rejects.toMatchObject({ code: 'STALE_WRITE' })
    const { gateway: memberGateway } = await signedInGateway(org.members[1].email)
    await expect(memberGateway.admin.listMembers(org.organizationId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('A-L6 — disabling is organisation-scoped; the Auth identity is not the organisation\'s to delete', () => {
  let shared: FreshUser

  beforeAll(async () => {
    shared = await addFreshUser(org.organizationId, 'P12Shared', 'MEMBER')
    await sql(
      `select set_config('app.actor_user_id', '${other.owner.userId}', false); ` +
        `insert into app_data.memberships (organization_id, user_id, role, status) values ('${other.organizationId}', '${shared.userId}', 'MEMBER', 'ACTIVE');`,
    )
  })

  it('the SAME access token loses this company on the next request, and keeps the other one', async () => {
    const token = await signIn(shared.email, SEED.password)
    const before = await rest('organizations?select=id', { token })
    expect((before.json as { id: string }[]).map((row) => row.id).sort()).toEqual([org.organizationId, other.organizationId].sort())

    const row = await memberRow(org.organizationId, shared.userId)
    const disable = await rest('rpc/set_member_status', {
      token: ownerToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: shared.userId, p_expected_version: row.version, p_status: 'DISABLED' },
    })
    expect(disable.status).toBe(200)

    const after = await rest('organizations?select=id', { token })
    expect((after.json as { id: string }[]).map((entry) => entry.id)).toEqual([other.organizationId])
    const products = await rest(`products?select=id&organization_id=eq.${org.organizationId}`, { token })
    expect(products.json).toEqual([])
  })

  it('the identity, its profile, its password and its other membership are untouched', async () => {
    expect(await sql(`select count(*) from auth.users where id = '${shared.userId}'`)).toBe('1')
    expect(await sql(`select count(*) from app_data.profiles where user_id = '${shared.userId}'`)).toBe('1')
    expect(await sql(`select status from app_data.memberships where user_id = '${shared.userId}' and organization_id = '${other.organizationId}'`)).toBe('ACTIVE')
    expect(await sql(`select status from app_data.memberships where user_id = '${shared.userId}' and organization_id = '${org.organizationId}'`)).toBe('DISABLED')
    await expect(signIn(shared.email, SEED.password)).resolves.toMatch(/^ey/)
  })

  it('re-inviting the disabled address re-enables it, links the existing account and returns NO password', async () => {
    const response = await invokeFunction('admin-provision-user', {
      token: ownerToken,
      body: { request_id: crypto.randomUUID(), organization_id: org.organizationId, email: shared.email, display_name: 'P12Shared User', role: 'MEMBER' },
    })
    expect(response.status).toBe(200)
    expect(Object.keys(response.json as object).sort()).toEqual(['request_id', 'status'])
    expect((response.json as { status: string }).status).toBe('SUCCEEDED')
    expect(await sql(`select status from app_data.memberships where user_id = '${shared.userId}' and organization_id = '${org.organizationId}'`)).toBe('ACTIVE')
    await expect(signIn(shared.email, SEED.password)).resolves.toMatch(/^ey/)
  })

  it('an OWNER re-inviting their OWN address with a lesser role is refused, and keeps OWNER', async () => {
    const response = await invokeFunction('admin-provision-user', {
      token: ownerToken,
      body: { request_id: crypto.randomUUID(), organization_id: org.organizationId, email: org.owner.email, display_name: 'Owner', role: 'MEMBER' },
    })
    expect(response.status).toBe(403)
    expect(await sql(`select role from app_data.memberships where user_id = '${org.owner.userId}' and organization_id = '${org.organizationId}'`)).toBe('OWNER')
    expect(await sql(`select count(*) from auth.users where id = '${org.owner.userId}'`)).toBe('1')
  })

  it('a provisioning refused at the link step deletes nothing', async () => {
    // The owner's own address as MEMBER again — refused at complete_provisioning,
    // after the Auth user was RESOLVED (it exists). Compensation must not touch it.
    await invokeFunction('admin-provision-user', {
      token: ownerToken,
      body: { request_id: crypto.randomUUID(), organization_id: org.organizationId, email: org.owner.email, display_name: 'Owner', role: 'ADMIN' },
    })
    expect(await sql(`select count(*) from auth.users where id = '${org.owner.userId}'`)).toBe('1')
  })

  it('the operator functions have no route for any caller — not even the secret key', async () => {
    for (const fn of ['purge_orphaned_auth_identity', 'orphaned_auth_identities', 'organization_members', 'change_member_status']) {
      const plain = await rest(`rpc/${fn}`, { token: ownerToken, method: 'POST', body: { p_user_id: shared.userId } })
      expect(plain.status).toBe(404)
      const profiled = await rest(`rpc/${fn}`, {
        token: ownerToken, method: 'POST', body: { p_user_id: shared.userId }, headers: { 'Content-Profile': 'app_private' },
      })
      expect(profiled.status).toBeGreaterThanOrEqual(400)
    }
    expect(await sql(`select count(*) from auth.users where id = '${shared.userId}'`)).toBe('1')
  })
})
