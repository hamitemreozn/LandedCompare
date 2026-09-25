/**
 * Phase 12 — AN ORGANISATION ADMINISTRATOR NEVER LEARNS A USABLE GLOBAL
 * CREDENTIAL FOR A PROVISIONED USER. Real GoTrue, PostgREST, Edge runtime and
 * the local mail capture; no React, no navigation.
 *
 * The exact cross-tenant scenario:
 *
 *   1. X's OWNER provisions a NEW address U.
 *   2. Auth e-mails U an invitation.
 *   3. Nothing X receives carries a password, token, OTP or invitation link.
 *   4. Before U accepts, Y's OWNER provisions the same address (links the
 *      same, still unaccepted, global identity).
 *   5. X's OWNER and ADMIN try every credential route they can reach — the
 *      removed reset function and RPCs, re-provisioning under every role, the
 *      Auth recovery / OTP / invite / admin endpoints with their own tokens.
 *   6. No string X ever received signs in as U.
 *   7. U accepts the invitation from U's own mailbox and chooses a password.
 *   8. U signs in normally with it.
 *   9. U's access is exactly U's memberships: X and Y.
 *  10. At no point did an administrator hold U's credential.
 *
 * An EXISTING, already set-up account is covered as well: linking it changes
 * nothing about its credential and sends it nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { addFreshUser, freshOrganization, type FreshUser } from './fixtures'
import {
  acceptInvitation,
  auth,
  invitationLinkFor,
  invokeFunction,
  mailTo,
  rest,
  SEED,
  signIn,
  sql,
  type RawResponse,
} from './localStack'

type Org = { organizationId: string; owner: FreshUser; members: FreshUser[] }

let x: Org
let y: Org
let xOwner: string
let xAdmin: string
let yOwner: string

/** Every string leaf of a JSON value — each is a candidate credential to try. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/**
 * Tries every string as every kind of credential: a password for U, a link
 * that might sign someone in (followed without redirects; a session would
 * appear in the Location fragment), and a bearer token (is it U's session?).
 */
async function expectNoneAuthenticates(email: string, userId: string, candidates: readonly string[]): Promise<void> {
  for (const candidate of candidates) {
    await expect(signIn(email, candidate), `password: ${candidate.slice(0, 24)}`).rejects.toThrow()
    if (/^https?:\/\//.test(candidate)) {
      const followed = await fetch(candidate, { redirect: 'manual' })
      expect(followed.headers.get('location') ?? '', `link: ${candidate.slice(0, 40)}`).not.toMatch(/access_token=/)
    }
    const asBearer = await auth('user', { token: candidate, method: 'GET' })
    expect((asBearer.json as { id?: string } | null)?.id, `bearer: ${candidate.slice(0, 24)}`).not.toBe(userId)
  }
}

function provision(token: string, organizationId: string, email: string, role: string, displayName = 'Invited Person') {
  return invokeFunction('admin-provision-user', {
    token, body: { request_id: crypto.randomUUID(), organization_id: organizationId, email, display_name: displayName, role },
  })
}

beforeAll(async () => {
  x = await freshOrganization('CBX', ['ADMIN'])
  y = await freshOrganization('CBY')
  xOwner = await signIn(x.owner.email, SEED.password)
  xAdmin = await signIn(x.members[0].email, SEED.password)
  yOwner = await signIn(y.owner.email, SEED.password)
})

describe('the cross-tenant credential boundary', () => {
  it('X provisions U, Y links U before U accepts; X never holds anything that opens U; U alone sets U\'s password', async () => {
    const email = `cb-${crypto.randomUUID().slice(0, 8)}@example.test`
    const xReceived: RawResponse[] = []

    // 1–3. X provisions a new address.
    const first = await provision(xOwner, x.organizationId, email, 'MEMBER')
    xReceived.push(first)
    expect(first.status).toBe(200)
    expect(Object.keys(first.json as object).sort()).toEqual(['request_id', 'status'])
    const link = await invitationLinkFor(email)
    const inviteToken = new URL(link).searchParams.get('token')!
    expect(inviteToken.length).toBeGreaterThan(10)
    expect(first.text).not.toContain(inviteToken)
    for (const message of await mailTo(email)) {
      expect(message.To.map((to) => to.Address)).toEqual([email])
    }
    const userId = await sql(`select id::text from auth.users where email = '${email}'`)
    expect(await sql(`select email_confirmed_at is null from auth.users where id = '${userId}'`)).toBe('t')

    // 4. Y links the same, still unaccepted, identity.
    const linkedByY = await provision(yOwner, y.organizationId, email, 'MEMBER', 'Named By Y')
    expect(linkedByY.status).toBe(200)
    expect(Object.keys(linkedByY.json as object).sort()).toEqual(['request_id', 'status'])
    expect(await sql(`select status from app_data.memberships where organization_id = '${y.organizationId}' and user_id = '${userId}'`)).toBe('ACTIVE')

    // 5. Every credential route X's administrators can reach.
    for (const token of [xOwner, xAdmin]) {
      xReceived.push(await invokeFunction('admin-reset-password', { token, body: { organization_id: x.organizationId, user_id: userId } }))
      for (const fn of ['begin_password_reset', 'complete_password_reset']) {
        xReceived.push(await rest(`rpc/${fn}`, {
          token, method: 'POST', body: { p_organization_id: x.organizationId, p_actor_user_id: x.owner.userId, p_subject_user_id: userId },
        }))
      }
      xReceived.push(await auth('recover', { token, body: { email } }))
      xReceived.push(await auth('otp', { token, body: { email, create_user: false } }))
      xReceived.push(await auth('invite', { token, body: { email } }))
      xReceived.push(await auth('admin/generate_link', { token, body: { type: 'invite', email } }))
      xReceived.push(await auth('admin/generate_link', { token, body: { type: 'recovery', email } }))
      xReceived.push(await auth(`admin/users/${userId}`, { token, method: 'PUT', body: { password: 'x-chosen-password-1' } }))
    }
    for (const [token, role] of [[xOwner, 'OWNER'], [xOwner, 'ADMIN'], [xAdmin, 'ADMIN'], [xAdmin, 'MEMBER']] as const) {
      const response = await provision(token, x.organizationId, email, role)
      expect(Object.keys(response.json as object).sort()).toEqual(['request_id', 'status'])
      xReceived.push(response)
    }

    // No invitation, recovery or OTP material in anything X received.
    const allMail = await mailTo(email)
    for (const response of xReceived) {
      expect(response.text).not.toMatch(/"(temporary_password|password|access_token|refresh_token|action_link|email_otp|hashed_token)"\s*:\s*"/)
      expect(response.text).not.toContain(inviteToken)
    }

    // 6. Nothing X received authenticates as U, used ANY way: as a password,
    //    as a link to follow, or as a bearer token — and neither does the
    //    password X tried to set through the admin endpoint.
    const candidates = [...new Set([...xReceived.flatMap((response) => strings(response.json)), 'x-chosen-password-1'])]
      .filter((value) => value.length >= 6)
      .slice(0, 40)
    await expectNoneAuthenticates(email, userId, candidates)

    // 7–8. U accepts the invitation from U's own mailbox and signs in.
    expect(allMail.length).toBeGreaterThan(0)
    await acceptInvitation(await invitationLinkFor(email), 'u-own-password-1')
    const uToken = await signIn(email, 'u-own-password-1')

    // 9. U's access is U's memberships.
    const visible = await rest('organizations?select=id', { token: uToken })
    expect((visible.json as { id: string }[]).map((row) => row.id).sort()).toEqual([x.organizationId, y.organizationId].sort())

    // 10. Still nothing X received opens the account.
    await expectNoneAuthenticates(email, userId, candidates)
    // And X renamed nobody: the global profile keeps the first name it was given.
    expect(await sql(`select display_name from app_data.profiles where user_id = '${userId}'`)).toBe('Invited Person')
  }, 90_000)

  it('an EXISTING, set-up account is linked with the same answer; its credential is untouched and it is sent nothing', async () => {
    const existing = await addFreshUser(y.organizationId, 'CBexisting', 'MEMBER')
    const hashBefore = await sql(`select encrypted_password from auth.users where id = '${existing.userId}'`)
    const mailBefore = (await mailTo(existing.email)).length

    const response = await provision(xAdmin, x.organizationId, existing.email, 'MEMBER')
    expect(response.status).toBe(200)
    expect(Object.keys(response.json as object).sort()).toEqual(['request_id', 'status'])

    expect(await sql(`select encrypted_password from auth.users where id = '${existing.userId}'`)).toBe(hashBefore)
    expect((await mailTo(existing.email)).length).toBe(mailBefore)
    await expect(signIn(existing.email, SEED.password)).resolves.toMatch(/^ey/)
    expect(await sql(`select status from app_data.memberships where organization_id = '${x.organizationId}' and user_id = '${existing.userId}'`)).toBe('ACTIVE')
  })

  it('the answers for a new address and an existing account have the same shape, and the audit row says nothing about which it was', async () => {
    const fresh = await provision(xOwner, x.organizationId, `cb-shape-${crypto.randomUUID().slice(0, 8)}@example.test`, 'MEMBER')
    const existing = await addFreshUser(y.organizationId, 'CBshape', 'MEMBER')
    const linked = await provision(xOwner, x.organizationId, existing.email, 'MEMBER')
    const shape = (response: RawResponse) => Object.fromEntries(Object.entries(response.json as Record<string, unknown>).map(([key, value]) => [key, typeof value]))
    expect([fresh.status, linked.status]).toEqual([200, 200])
    expect(shape(fresh)).toEqual(shape(linked))
    expect((fresh.json as { status: string }).status).toBe((linked.json as { status: string }).status)

    const events = await rest(`admin_events?select=details&organization_id=eq.${x.organizationId}&event_type=eq.MEMBER_PROVISIONED`, { token: xOwner })
    expect(events.status).toBe(200)
    for (const event of events.json as { details: Record<string, unknown> }[]) {
      expect(Object.keys(event.details).sort()).toEqual(['email', 'request_id', 'role'])
    }
    const attempts = await rest(`provisioning_attempts?organization_id=eq.${x.organizationId}`, { token: xOwner })
    for (const row of attempts.json as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('created_here')
    }
  })

  it('a colleague cannot read another member\'s onboarding state or profile age', async () => {
    const email = `cb-colleague-${crypto.randomUUID().slice(0, 8)}@example.test`
    await provision(xOwner, x.organizationId, email, 'MEMBER')
    const userId = await sql(`select id::text from auth.users where email = '${email}'`)
    expect(await sql(`select must_change_password from app_data.profiles where user_id = '${userId}'`)).toBe('t')
    const seen = await rest(`profiles?select=user_id,display_name,must_change_password,version,created_at,updated_at&user_id=eq.${userId}`, { token: xAdmin })
    expect(seen.json).toEqual([{ user_id: userId, display_name: 'Invited Person', must_change_password: false, version: 0, created_at: null, updated_at: null }])
  })
})

describe('retries and idempotency', () => {
  it('the same request id returns the same shape and sends no second invitation', async () => {
    const email = `cb-retry-${crypto.randomUUID().slice(0, 8)}@example.test`
    const requestId = crypto.randomUUID()
    const call = () => invokeFunction('admin-provision-user', {
      token: xOwner, body: { request_id: requestId, organization_id: x.organizationId, email, display_name: 'Retry', role: 'MEMBER' },
    })
    const first = await call()
    await invitationLinkFor(email)
    const mails = (await mailTo(email)).length
    const second = await call()
    expect([first.status, second.status]).toEqual([200, 200])
    expect(Object.keys(second.json as object).sort()).toEqual(['request_id', 'status'])
    expect((second.json as { status: string }).status).toBe('ALREADY_SUCCEEDED')
    expect((await mailTo(email)).length).toBe(mails)
    expect(await sql(`select count(*) from auth.users where email = '${email}'`)).toBe('1')
  })
})
