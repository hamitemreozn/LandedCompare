/**
 * Phase 12 security corrections, proved against the real local stack.
 *
 *   P12-H1  an OWNER invitation claimed by an OWNER who is demoted to ADMIN
 *           before it completes does not grant OWNER
 *   P12-H2  a failed provisioning never deletes the global identity it
 *           created — even after another organisation linked it meanwhile
 *   P12-M1  a second organisation's invitation does not rename the person
 *   P12-M3  foreign vs non-existent targets answer identically; a stale
 *           version is refused; two OWNERs demoting each other at the same
 *           moment cannot leave the company without an OWNER
 *
 * Interleavings are forced, not hoped for. Where a step has to happen INSIDE
 * another request, a test-only trigger holds that request with `pg_sleep`
 * while the test acts; the trigger is created and dropped by the test itself
 * (`public.lc_test_*`, never a migration). Where a workflow has to be held
 * BETWEEN its two database steps, the steps are driven as the Edge Function
 * drives them — `service_role` RPCs over PostgREST.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { addFreshUser, freshOrganization, freshUser, type FreshUser } from './fixtures'
import { invokeFunction, mailTo, rest, SEED, serviceRpc, signIn, sql } from './localStack'

type Org = { organizationId: string; owner: FreshUser; members: FreshUser[] }

const hooks: string[] = []

/** Installs a BEFORE trigger that runs `body` (plpgsql) for rows matching `when`. Dropped after the test. */
async function hook(table: string, when: string, body: string, events = 'insert', timing: 'before' | 'after' = 'before'): Promise<void> {
  const name = `lc_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  hooks.push(name)
  await sql(
    `create function public.${name}() returns trigger language plpgsql as $h$ begin if ${when} then ${body} end if; return new; end $h$; ` +
      `create trigger ${name} ${timing} ${events} on app_data.${table} for each row execute function public.${name}();`,
  )
}

afterEach(async () => {
  while (hooks.length > 0) {
    const name = hooks.pop()!
    await sql(`drop function if exists public.${name}() cascade;`)
  }
})

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('condition not reached in time')
}

async function version(organizationId: string, userId: string): Promise<number> {
  return Number(await sql(`select version from app_data.memberships where organization_id = '${organizationId}' and user_id = '${userId}'`))
}

describe('P12-H1 — a stale OWNER grant', () => {
  it('OWNER claims an OWNER invitation → is demoted to ADMIN → the completion is refused and grants nothing', async () => {
    const org: Org = await freshOrganization('H1', ['OWNER'])
    const invited = await freshUser('H1invited')
    const requestId = crypto.randomUUID()

    const claim = await serviceRpc('begin_provisioning', {
      p_request_id: requestId, p_organization_id: org.organizationId, p_email: invited.email,
      p_requested_role: 'OWNER', p_actor_user_id: org.owner.userId,
    })
    expect(claim.status).toBe(200)
    expect(claim.json).toMatchObject({ status: 'CLAIMED' })

    // The pause: the actor loses OWNER while the workflow is between its steps.
    await sql(`update app_data.memberships set role = 'ADMIN' where organization_id = '${org.organizationId}' and user_id = '${org.owner.userId}';`)

    const complete = await serviceRpc('complete_provisioning', {
      p_request_id: requestId, p_user_id: invited.userId, p_display_name: 'Would Be Owner', p_created_here: false,
    })
    expect(complete.status).toBe(403)
    expect(complete.json).toMatchObject({ code: '42501', details: 'FORBIDDEN' })
    expect(await sql(`select count(*) from app_data.memberships where organization_id = '${org.organizationId}' and user_id = '${invited.userId}'`)).toBe('0')
    expect(await sql(`select count(*) from app_data.memberships where organization_id = '${org.organizationId}' and role = 'OWNER' and status = 'ACTIVE'`)).toBe('1')
    expect(await sql(`select count(*) from app_data.admin_events where details ->> 'request_id' = '${requestId}'`)).toBe('0')
  })

  it('the same demotion during a real Edge Function run fails the invitation safely', async () => {
    const org: Org = await freshOrganization('H1edge', ['OWNER'])
    const ownerToken = await signIn(org.owner.email, SEED.password)
    const email = `h1-edge-${crypto.randomUUID().slice(0, 8)}@example.test`
    // Held for four seconds inside begin_provisioning's attempt insert — AFTER
    // it has checked that the actor is an OWNER, BEFORE the Auth user is
    // created and complete_provisioning runs.
    await hook('provisioning_attempts', `new.email = '${email}'`, 'perform pg_sleep(4);')
    const run = invokeFunction('admin-provision-user', {
      token: ownerToken,
      body: { request_id: crypto.randomUUID(), organization_id: org.organizationId, email, display_name: 'Edge Owner', role: 'OWNER' },
    })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await sql(`update app_data.memberships set role = 'ADMIN' where organization_id = '${org.organizationId}' and user_id = '${org.owner.userId}';`)

    const response = await run
    expect(response.status).toBe(403)
    expect(await sql(`select count(*) from app_data.memberships m join auth.users u on u.id = m.user_id where m.organization_id = '${org.organizationId}' and u.email = '${email}'`)).toBe('0')
    expect(await sql(`select status from app_data.provisioning_attempts where organization_id = '${org.organizationId}' and email = '${email}'`)).toBe('FAILED')
  }, 30_000)
})

describe('P12-H2 — compensation never deletes a shared identity', () => {
  it('A creates U → A\'s link step fails → B links U meanwhile → U, and B\'s membership, survive', async () => {
    const a: Org = await freshOrganization('H2A')
    const b: Org = await freshOrganization('H2B')
    const tokenA = await signIn(a.owner.email, SEED.password)
    const tokenB = await signIn(b.owner.email, SEED.password)
    const email = `h2-${crypto.randomUUID().slice(0, 8)}@example.test`
    const marker = `H2 hold ${crypto.randomUUID().slice(0, 8)}`

    // A's link step is held for six seconds inside its profile insert, then
    // fails — the window in which the old compensation raced another company.
    await hook('profiles', `new.display_name = '${marker}'`, `perform pg_sleep(6); raise exception 'injected link failure';`)
    const runA = invokeFunction('admin-provision-user', {
      token: tokenA,
      body: { request_id: crypto.randomUUID(), organization_id: a.organizationId, email, display_name: marker, role: 'MEMBER' },
    })

    // A has created U in Auth and is now stuck linking it.
    await waitUntil(async () => (await sql(`select count(*) from auth.users where email = '${email}'`)) === '1')
    const userId = await sql(`select id::text from auth.users where email = '${email}'`)

    // B finds U by its address and links it (§4 case C) while A is held.
    const runB = await invokeFunction('admin-provision-user', {
      token: tokenB,
      body: { request_id: crypto.randomUUID(), organization_id: b.organizationId, email, display_name: 'Linked By B', role: 'MEMBER' },
    })
    expect(runB.status).toBe(200)

    const responseA = await runA
    expect(responseA.status).toBeGreaterThanOrEqual(400)

    expect(await sql(`select count(*) from auth.users where id = '${userId}'`)).toBe('1')
    expect(await sql(`select status from app_data.memberships where organization_id = '${b.organizationId}' and user_id = '${userId}'`)).toBe('ACTIVE')
    expect(await sql(`select display_name from app_data.profiles where user_id = '${userId}'`)).toBe('Linked By B')
    expect(await sql(`select count(*) from app_data.memberships where organization_id = '${a.organizationId}' and user_id = '${userId}'`)).toBe('0')
    expect(await sql(`select status || ':' || failure_reason from app_data.provisioning_attempts where organization_id = '${a.organizationId}' and email = '${email}'`))
      .toBe('FAILED:LINK_FAILED')
  }, 60_000)

  it('the same interleaving where B\'s link leaves no audit trail: the outcome does not rest on incidental guards', async () => {
    // Why this variant exists. When B links U through `admin-provision-user`,
    // U is referenced by a SUCCEEDED `provisioning_attempts` row and by an
    // append-only `admin_events` row; deleting U would null those references,
    // which the check constraint and the append-only trigger refuse — so an
    // Auth delete of a provisioned-and-linked identity already fails as a
    // whole. That protection is incidental. Here B's membership is written the
    // way a fixture writes one — no attempt, no event — which is exactly the
    // shape a future link path could have. The identity and B's membership
    // must survive A's failure all the same.
    const a: Org = await freshOrganization('H2bareA')
    const b: Org = await freshOrganization('H2bareB')
    const tokenA = await signIn(a.owner.email, SEED.password)
    const email = `h2-bare-${crypto.randomUUID().slice(0, 8)}@example.test`
    const marker = `H2 bare ${crypto.randomUUID().slice(0, 8)}`
    await hook('profiles', `new.display_name = '${marker}'`, `perform pg_sleep(4); raise exception 'injected link failure';`)
    const runA = invokeFunction('admin-provision-user', {
      token: tokenA,
      body: { request_id: crypto.randomUUID(), organization_id: a.organizationId, email, display_name: marker, role: 'MEMBER' },
    })
    await waitUntil(async () => (await sql(`select count(*) from auth.users where email = '${email}'`)) === '1')
    const userId = await sql(`select id::text from auth.users where email = '${email}'`)
    await sql(
      `select set_config('app.actor_user_id', '${b.owner.userId}', false); ` +
        `insert into app_data.profiles (user_id, display_name, must_change_password) values ('${userId}', 'Bare Link', false); ` +
        `insert into app_data.memberships (organization_id, user_id, role, status) values ('${b.organizationId}', '${userId}', 'MEMBER', 'ACTIVE');`,
    )

    expect((await runA).status).toBeGreaterThanOrEqual(400)
    expect(await sql(`select count(*) from auth.users where id = '${userId}'`)).toBe('1')
    expect(await sql(`select status from app_data.memberships where organization_id = '${b.organizationId}' and user_id = '${userId}'`)).toBe('ACTIVE')
  }, 60_000)

  it('a failed provisioning leaves an identifiable orphan that only the operator purge removes, after its own live checks', async () => {
    const a: Org = await freshOrganization('H2orphan')
    const tokenA = await signIn(a.owner.email, SEED.password)
    const email = `h2-orphan-${crypto.randomUUID().slice(0, 8)}@example.test`
    const marker = `H2 fail ${crypto.randomUUID().slice(0, 8)}`
    await hook('profiles', `new.display_name = '${marker}'`, `raise exception 'injected link failure';`)

    const response = await invokeFunction('admin-provision-user', {
      token: tokenA,
      body: { request_id: crypto.randomUUID(), organization_id: a.organizationId, email, display_name: marker, role: 'MEMBER' },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    const userId = await sql(`select id::text from auth.users where email = '${email}'`)
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await sql(`select eligible_for_purge from app_private.orphaned_auth_identities() where user_id = '${userId}'`)).toBe('t')
    expect(await sql(`select app_private.purge_orphaned_auth_identity('${userId}')`)).toBe('PURGED')
    expect(await sql(`select count(*) from auth.users where id = '${userId}'`)).toBe('0')
  })
})

describe('P12-M1 — a second organisation does not rename the person', () => {
  it('X invites U (already in Y) under another name; the global profile is untouched', async () => {
    const x: Org = await freshOrganization('M1X')
    const y: Org = await freshOrganization('M1Y')
    const u = await addFreshUser(y.organizationId, 'M1U', 'MEMBER')
    const before = await sql(`select display_name || '|' || must_change_password || '|' || version from app_data.profiles where user_id = '${u.userId}'`)

    const response = await invokeFunction('admin-provision-user', {
      token: await signIn(x.owner.email, SEED.password),
      body: { request_id: crypto.randomUUID(), organization_id: x.organizationId, email: u.email, display_name: 'Renamed By X', role: 'MEMBER' },
    })
    expect(response.status).toBe(200)
    expect(await sql(`select display_name || '|' || must_change_password || '|' || version from app_data.profiles where user_id = '${u.userId}'`)).toBe(before)

    // And that is what Y sees.
    const yToken = await signIn(y.owner.email, SEED.password)
    const seen = await rest(`profiles?select=display_name&user_id=eq.${u.userId}`, { token: yToken })
    expect(seen.json).toEqual([{ display_name: u.displayName }])
  })
})

describe('P12-M3 — responses, versions and the last OWNER', () => {
  let org: Org
  let other: Org
  let ownerToken: string
  let otherOwnerToken: string

  beforeAll(async () => {
    org = await freshOrganization('M3', ['MEMBER'])
    other = await freshOrganization('M3other', ['MEMBER'])
    ownerToken = await signIn(org.owner.email, SEED.password)
    otherOwnerToken = await signIn(other.owner.email, SEED.password)
  })

  it('another company\'s OWNER gets the same answer for a real member here as for a user that does not exist', async () => {
    const call = (userId: string) => rest('rpc/set_member_status', {
      token: otherOwnerToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: userId, p_expected_version: 1, p_status: 'DISABLED' },
    })
    const real = await call(org.members[0].userId)
    const ghost = await call(crypto.randomUUID())
    expect(real.status).toBe(ghost.status)
    expect(real.json).toEqual(ghost.json)

    const listReal = await rest('rpc/list_organization_members', { token: otherOwnerToken, method: 'POST', body: { p_organization_id: org.organizationId } })
    const listGhost = await rest('rpc/list_organization_members', { token: otherOwnerToken, method: 'POST', body: { p_organization_id: crypto.randomUUID() } })
    expect(listReal.status).toBe(listGhost.status)
    expect(listReal.json).toEqual(listGhost.json)
  })

  it('an OWNER naming another company\'s member gets the same answer as for a user that does not exist', async () => {
    const call = (userId: string) => rest('rpc/set_member_role', {
      token: ownerToken, method: 'POST',
      body: { p_organization_id: org.organizationId, p_user_id: userId, p_expected_version: 1, p_role: 'ADMIN' },
    })
    const foreign = await call(other.members[0].userId)
    const ghost = await call(crypto.randomUUID())
    expect(foreign.status).toBe(400)
    expect(foreign.json).toMatchObject({ details: 'RECORD_NOT_FOUND' })
    expect(foreign.status).toBe(ghost.status)
    expect(foreign.json).toEqual(ghost.json)
    expect(await sql(`select role from app_data.memberships where user_id = '${other.members[0].userId}'`)).toBe('MEMBER')
  })

  it('a stale expected_version is refused for status as for role, and changes nothing', async () => {
    const target = org.members[0].userId
    const current = await version(org.organizationId, target)
    for (const [fn, field, value] of [['set_member_status', 'p_status', 'DISABLED'], ['set_member_role', 'p_role', 'ADMIN']] as const) {
      const response = await rest(`rpc/${fn}`, {
        token: ownerToken, method: 'POST',
        body: { p_organization_id: org.organizationId, p_user_id: target, p_expected_version: current + 10, [field]: value },
      })
      expect(response.status).toBe(400)
      expect(response.json).toMatchObject({ details: 'STALE_WRITE' })
    }
    expect(await sql(`select role || ':' || status || ':' || version from app_data.memberships where organization_id = '${org.organizationId}' and user_id = '${target}'`))
      .toBe(`MEMBER:ACTIVE:${current}`)
  })

  it('two OWNERs demoting each other at the same moment: exactly one wins, the company keeps an OWNER', async () => {
    const company: Org = await freshOrganization('M3race', ['OWNER'])
    const [first, second] = [company.owner, company.members[0]]
    const tokens = [await signIn(first.email, SEED.password), await signIn(second.email, SEED.password)]
    // Every membership update in this company is held for 1.5 s, so both
    // requests are guaranteed to be in flight together.
    await hook('memberships', `new.organization_id = '${company.organizationId}'`, 'perform pg_sleep(1.5);', 'update')

    const demote = async (token: string, subject: FreshUser) => rest('rpc/set_member_role', {
      token, method: 'POST',
      body: { p_organization_id: company.organizationId, p_user_id: subject.userId, p_expected_version: await version(company.organizationId, subject.userId), p_role: 'MEMBER' },
    })
    const results = await Promise.all([demote(tokens[0], second), demote(tokens[1], first)])

    expect(results.map((result) => result.status).sort()).toEqual([200, 403])
    expect(await sql(`select count(*) from app_data.memberships where organization_id = '${company.organizationId}' and role = 'OWNER' and status = 'ACTIVE'`)).toBe('1')
  }, 30_000)

  it('two OWNERs disabling each other at the same moment: the company keeps an OWNER', async () => {
    const company: Org = await freshOrganization('M3raceStatus', ['OWNER'])
    const [first, second] = [company.owner, company.members[0]]
    const tokens = [await signIn(first.email, SEED.password), await signIn(second.email, SEED.password)]
    await hook('memberships', `new.organization_id = '${company.organizationId}'`, 'perform pg_sleep(1.5);', 'update')

    const disable = async (token: string, subject: FreshUser) => rest('rpc/set_member_status', {
      token, method: 'POST',
      body: { p_organization_id: company.organizationId, p_user_id: subject.userId, p_expected_version: await version(company.organizationId, subject.userId), p_status: 'DISABLED' },
    })
    const results = await Promise.all([disable(tokens[0], second), disable(tokens[1], first)])

    expect(results.map((result) => result.status).sort()).toEqual([200, 403])
    expect(await sql(`select count(*) from app_data.memberships where organization_id = '${company.organizationId}' and role = 'OWNER' and status = 'ACTIVE'`)).toBe('1')
  }, 30_000)
})

describe('invitation failure — safe, idempotent, and silent about the account', () => {
  it('the invitation itself fails: no account, no membership, one safe error, the attempt FAILED — and a retry fails the same way', async () => {
    const org: Org = await freshOrganization('INVfail')
    const token = await signIn(org.owner.email, SEED.password)
    // Accepted by the application's address check, refused by Auth's mailer:
    // GoTrue reports "Error sending invite email" and keeps no account.
    const email = `inv..fail-${crypto.randomUUID().slice(0, 6)}@example.test`
    const requestId = crypto.randomUUID()
    const call = () => invokeFunction('admin-provision-user', {
      token, body: { request_id: requestId, organization_id: org.organizationId, email, display_name: 'Never Invited', role: 'MEMBER' },
    })

    const first = await call()
    expect(first.status).toBe(502)
    expect(first.json).toEqual({ code: 'SERVER_UNAVAILABLE', message: 'the invitation could not be sent' })
    expect(await sql(`select count(*) from auth.users where email = '${email}'`)).toBe('0')
    expect(await sql(`select count(*) from app_data.memberships m join auth.users u on u.id = m.user_id where u.email = '${email}'`)).toBe('0')
    expect(await sql(`select status || ':' || failure_reason from app_data.provisioning_attempts where request_id = '${requestId}'`)).toBe('FAILED:INVITATION_FAILED')

    const retry = await call()
    expect(retry.status).toBe(502)
    expect(await sql(`select count(*) from app_data.provisioning_attempts where request_id = '${requestId}'`)).toBe('1')
    expect(await sql(`select count(*) from auth.users where email = '${email}'`)).toBe('0')
  })

  it('a failed link records the same reason whether the account was just invited or already existed', async () => {
    const org: Org = await freshOrganization('INVreason')
    const token = await signIn(org.owner.email, SEED.password)
    const marker = `INV reason ${crypto.randomUUID().slice(0, 8)}`
    await hook('memberships', `new.organization_id = '${org.organizationId}'`, `raise exception 'injected link failure';`)

    const fresh = `inv-new-${crypto.randomUUID().slice(0, 8)}@example.test`
    const existing = await addFreshUser((await freshOrganization('INVreasonOther')).organizationId, 'INVexisting', 'MEMBER')
    const responses = []
    for (const email of [fresh, existing.email]) {
      responses.push(await invokeFunction('admin-provision-user', {
        token, body: { request_id: crypto.randomUUID(), organization_id: org.organizationId, email, display_name: marker, role: 'MEMBER' },
      }))
    }
    expect(responses.map((response) => response.status)).toEqual([500, 500])
    expect(responses[0].json).toEqual(responses[1].json)

    const visible = await rest(`provisioning_attempts?select=email,status,failure_reason&organization_id=eq.${org.organizationId}&order=email`, { token })
    expect((visible.json as { failure_reason: string }[]).map((row) => row.failure_reason)).toEqual(['LINK_FAILED', 'LINK_FAILED'])
    // The account the invitation created stays — an operator-purgeable orphan.
    expect(await sql(`select eligible_for_purge from app_private.orphaned_auth_identities() where email = '${fresh}'`)).toBe('t')
    expect((await mailTo(fresh)).length).toBe(1)
  })
})

describe('operator purge vs. a concurrent link — every ordering', () => {
  /** An orphan: an Auth identity with no profile, no membership, no attempt. */
  async function orphan(): Promise<{ userId: string; email: string }> {
    const userId = crypto.randomUUID()
    const email = `orphan-${userId.slice(0, 8)}@example.test`
    await sql(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change_token_new, email_change) ` +
        `values ('00000000-0000-0000-0000-000000000000', '${userId}', 'authenticated', 'authenticated', '${email}', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', '', '', '', '');`,
    )
    expect(await sql(`select eligible_for_purge from app_private.orphaned_auth_identities() where user_id = '${userId}'`)).toBe('t')
    return { userId, email }
  }

  it('link first: the link holds the identity; the purge waits, then sees the membership and refuses', async () => {
    const org: Org = await freshOrganization('PLlink')
    const u = await orphan()
    const requestId = crypto.randomUUID()
    expect((await serviceRpc('begin_provisioning', {
      p_request_id: requestId, p_organization_id: org.organizationId, p_email: u.email, p_requested_role: 'MEMBER', p_actor_user_id: org.owner.userId,
    })).json).toMatchObject({ status: 'CLAIMED' })

    // Held AFTER the membership row is written — its foreign key already holds
    // a key-share lock on the identity — for four seconds, uncommitted.
    await hook('memberships', `new.user_id = '${u.userId}'`, 'perform pg_sleep(4);', 'insert', 'after')
    const link = serviceRpc('complete_provisioning', { p_request_id: requestId, p_user_id: u.userId, p_display_name: 'Linked', p_created_here: false })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const purge = sql(`select app_private.purge_orphaned_auth_identity('${u.userId}');`).then(() => 'PURGED', (error: Error) => error.message)

    const [linked, purged] = await Promise.all([link, purge])
    expect(linked.status).toBe(200)
    expect(purged).toMatch(/still has a membership/)
    expect(await sql(`select count(*) from auth.users where id = '${u.userId}'`)).toBe('1')
    expect(await sql(`select status from app_data.memberships where organization_id = '${org.organizationId}' and user_id = '${u.userId}'`)).toBe('ACTIVE')
  }, 30_000)

  it('link in flight: an IN_FLIGHT attempt for the address makes the purge refuse before any lock is contested', async () => {
    const org: Org = await freshOrganization('PLflight')
    const u = await orphan()
    await serviceRpc('begin_provisioning', {
      p_request_id: crypto.randomUUID(), p_organization_id: org.organizationId, p_email: u.email, p_requested_role: 'MEMBER', p_actor_user_id: org.owner.userId,
    })
    await expect(sql(`select app_private.purge_orphaned_auth_identity('${u.userId}');`)).rejects.toThrow(/in-flight provisioning attempt/)
    expect(await sql(`select count(*) from auth.users where id = '${u.userId}'`)).toBe('1')
  })

  it('purge first: the purge holds the deleted identity; the link waits, then cannot commit against it', async () => {
    const org: Org = await freshOrganization('PLpurge')
    const u = await orphan()
    // The purge commits only after four seconds; until then its DELETE holds
    // the identity row.
    const purge = sql(`begin; select app_private.purge_orphaned_auth_identity('${u.userId}'); select pg_sleep(4); commit;`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const requestId = crypto.randomUUID()
    expect((await serviceRpc('begin_provisioning', {
      p_request_id: requestId, p_organization_id: org.organizationId, p_email: u.email, p_requested_role: 'MEMBER', p_actor_user_id: org.owner.userId,
    })).json).toMatchObject({ status: 'CLAIMED' })
    const link = await serviceRpc('complete_provisioning', { p_request_id: requestId, p_user_id: u.userId, p_display_name: 'Too Late', p_created_here: false })
    await purge

    expect(link.status).toBeGreaterThanOrEqual(400)
    expect(await sql(`select count(*) from auth.users where id = '${u.userId}'`)).toBe('0')
    expect(await sql(`select count(*) from app_data.memberships where user_id = '${u.userId}'`)).toBe('0')
    expect(await sql(`select count(*) from app_data.profiles where user_id = '${u.userId}'`)).toBe('0')
  }, 30_000)

  it('no committed membership, anywhere, references a deleted identity', async () => {
    expect(await sql(`select count(*) from app_data.memberships m where not exists (select 1 from auth.users u where u.id = m.user_id)`)).toBe('0')
  })
})
