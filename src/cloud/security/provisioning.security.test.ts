/**
 * The provisioning workflow, end to end, across the boundary no transaction
 * covers.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4 (failure cases
 * A–E); threat model 19 and 24.
 *
 * The pgTAP suite proves the database half: that four writes commit together,
 * that a retry converges, that the role checks hold. It cannot create an
 * `auth.users` row, so it cannot see the part that actually makes this hard —
 * an HTTP call to the Auth service sitting between two PostgreSQL writes.
 *
 * This file exercises the real Edge Function against the real Auth Admin API
 * and checks what is left behind afterwards, which is the only way to observe
 * the two properties that make the design safe:
 *
 *   - no path ever deletes an auth user it did not create in the same attempt;
 *   - the only thing ever left half-done is a `provisioning_attempts` row,
 *     which is inert.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { acceptInvitation, invitationLinkFor, invokeFunction, mailTo, SEED, signIn, sql } from './localStack'

let ownerA: string
let memberA: string
let ownerB: string

/** A fresh request_id per test, because reusing one is the thing under test. */
function requestId(suffix: string): string {
  return `7f000000-0000-4000-8000-0000000000${suffix}`
}

async function authUserCount(email: string): Promise<number> {
  return Number(await sql(`select count(*) from auth.users where email = '${email}'`))
}

beforeAll(async () => {
  ownerA = await signIn(SEED.ownerA.email, SEED.password)
  memberA = await signIn(SEED.memberA.email, SEED.password)
  ownerB = await signIn(SEED.ownerB.email, SEED.password)
})

describe('authorisation happens before the Auth Admin API is touched', () => {
  it('an unauthenticated caller is refused', async () => {
    const response = await invokeFunction('admin-provision-user', {
      body: {
        request_id: requestId('01'),
        organization_id: SEED.organizationA,
        email: 'nobody@example.test',
        display_name: 'Nobody',
        role: 'MEMBER',
      },
    })

    expect(response.status).toBe(401)
    expect(await authUserCount('nobody@example.test')).toBe(0)
  })

  it('a MEMBER is refused, and no account is created', async () => {
    const response = await invokeFunction('admin-provision-user', {
      token: memberA,
      body: {
        request_id: requestId('02'),
        organization_id: SEED.organizationA,
        email: 'member-invited@example.test',
        display_name: 'Member Invited',
        role: 'MEMBER',
      },
    })

    expect(response.status).toBe(403)
    expect((response.json as { code?: string }).code).toBe('FORBIDDEN')
    expect(await authUserCount('member-invited@example.test')).toBe(0)
  })

  it('threat 19: an OWNER cannot provision into an organisation that is not theirs', async () => {
    const response = await invokeFunction('admin-provision-user', {
      token: ownerA,
      body: {
        request_id: requestId('03'),
        organization_id: SEED.organizationB,
        email: 'smuggled@example.test',
        display_name: 'Smuggled',
        role: 'OWNER',
      },
    })

    expect(response.status).toBe(403)

    // The important assertion is not the status code — it is that the Auth
    // Admin API was never reached. An implementation that created the account
    // and then discovered it was not allowed to link it would leave an orphan
    // behind on every refused attempt.
    expect(await authUserCount('smuggled@example.test')).toBe(0)

    const attempts = await sql(
      `select count(*) from app_data.provisioning_attempts where request_id = '${requestId('03')}'`,
    )
    expect(attempts).toBe('0')
  })
})

describe('the happy path, and the retry that must not duplicate it', () => {
  const email = 'provisioned-once@example.test'
  const id = requestId('10')
  // The local mailbox outlives `db reset`, so invitations are counted from
  // what was already there when this file started.
  const invitationCount = async () => (await mailTo(email)).filter((message) => /invited/i.test(message.Subject)).length
  let invitationsBefore = 0

  it('invites the address, links the account, and returns no credential', async () => {
    invitationsBefore = await invitationCount()
    const first = await invokeFunction('admin-provision-user', {
      token: ownerA,
      body: {
        request_id: id,
        organization_id: SEED.organizationA,
        email,
        display_name: 'Provisioned Once',
        role: 'MEMBER',
      },
    })

    expect(first.status).toBe(200)
    // Phase 12: `{ status, request_id }` and nothing else — no password, no
    // user id, no "created" flag. The person is invited by Auth, by e-mail.
    expect(first.json).toEqual({ status: 'SUCCEEDED', request_id: id })
    const body = { user_id: await sql(`select id::text from auth.users where email = '${email}'`) }

    // The four writes, verified through a connection the Data API does not
    // offer — because "did these commit together" is not a question a client
    // can ask, and pretending it were would make the test about the view.
    const linked = await sql(`
      select
        (select count(*) from app_data.profiles where user_id = '${body.user_id}'),
        (select count(*) from app_data.memberships
          where user_id = '${body.user_id}' and organization_id = '${SEED.organizationA}'
            and role = 'MEMBER' and status = 'ACTIVE'),
        (select count(*) from app_data.admin_events
          where subject_user_id = '${body.user_id}' and event_type = 'MEMBER_PROVISIONED'),
        (select status from app_data.provisioning_attempts where request_id = '${id}')
    `)
    expect(linked).toBe('1|1|1|SUCCEEDED')

    // The invitation went to the person, and only to the person.
    await invitationLinkFor(email)
    expect(await invitationCount()).toBe(invitationsBefore + 1)
    for (const message of await mailTo(email)) {
      expect(message.To.map((to) => to.Address)).toEqual([email])
    }
  })

  it('the new colleague accepts the invitation and signs in with the password they chose', async () => {
    // The account is not usable by anyone until its owner accepts: it has no
    // confirmed address and no password anybody knows.
    expect(await sql(`select email_confirmed_at is null from auth.users where email = '${email}'`)).toBe('t')
    await acceptInvitation(await invitationLinkFor(email), 'colleague-chose-this-1')
    await expect(signIn(email, 'colleague-chose-this-1')).resolves.toMatch(/^ey/)
  })

  it('case B: the same request_id returns the stored outcome and no password', async () => {
    const retry = await invokeFunction('admin-provision-user', {
      token: ownerA,
      body: {
        request_id: id,
        organization_id: SEED.organizationA,
        email,
        display_name: 'Provisioned Once',
        role: 'MEMBER',
      },
    })

    expect(retry.status).toBe(200)
    // The stored outcome, in the same shape — and no second invitation.
    expect(retry.json).toEqual({ status: 'ALREADY_SUCCEEDED', request_id: id })
    expect(await invitationCount()).toBe(invitationsBefore + 1)

    expect(await authUserCount(email)).toBe(1)
    const events = await sql(
      `select count(*) from app_data.admin_events
        where details->>'request_id' = '${id}'`,
    )
    expect(events).toBe('1')
  })
})

describe('case C — the address already has an account', () => {
  it('links the existing account instead of re-credentialling it', async () => {
    const before = await sql(
      `select encrypted_password from auth.users where id = '${SEED.memberB.id}'`,
    )

    // Owner B invites a colleague who already exists — their own member B —
    // into organisation B, where that member already is. A new request_id,
    // because the old outcome belongs to the old attempt.
    const response = await invokeFunction('admin-provision-user', {
      token: ownerB,
      body: {
        request_id: requestId('20'),
        organization_id: SEED.organizationB,
        email: SEED.memberB.email,
        display_name: 'Deniz Aydın',
        role: 'ADMIN',
      },
    })

    expect(response.status).toBe(200)
    // The same answer a new address gets: nothing says the account existed,
    // and nothing that could open it comes back.
    expect(response.json).toEqual({ status: 'SUCCEEDED', request_id: requestId('20') })

    const after = await sql(
      `select encrypted_password from auth.users where id = '${SEED.memberB.id}'`,
    )
    expect(after).toBe(before)

    // Case D at the same time: the role was applied to the existing membership
    // rather than producing a second one.
    const membership = await sql(
      `select role, status from app_data.memberships
        where user_id = '${SEED.memberB.id}' and organization_id = '${SEED.organizationB}'`,
    )
    expect(membership).toBe('ADMIN|ACTIVE')

    // Put the fixture back, so the file order of this suite does not decide
    // what the next one sees.
    await sql(
      `update app_data.memberships set role = 'MEMBER'
        where user_id = '${SEED.memberB.id}' and organization_id = '${SEED.organizationB}'`,
    )
  })
})

describe('case E — a stuck attempt is refused rather than raced', () => {
  it('an IN_FLIGHT attempt makes the same request_id return BUSY', async () => {
    const id = requestId('30')

    // The state an Edge Function leaves behind when it is killed between
    // creating the auth user and linking it. It is written directly because
    // killing a container mid-request is not something a test can arrange
    // reliably, and the STATE is what the next call has to reason about.
    await sql(`
      insert into app_data.provisioning_attempts
        (request_id, organization_id, email, requested_role, status, actor_user_id)
      values ('${id}', '${SEED.organizationA}', 'stuck@example.test', 'MEMBER',
              'IN_FLIGHT', '${SEED.ownerA.id}')
    `)

    const response = await invokeFunction('admin-provision-user', {
      token: ownerA,
      body: {
        request_id: id,
        organization_id: SEED.organizationA,
        email: 'stuck@example.test',
        display_name: 'Stuck',
        role: 'MEMBER',
      },
    })

    expect(response.status).toBe(409)
    expect((response.json as { code?: string }).code).toBe('PROVISIONING_IN_FLIGHT')

    // Nothing was created. "The other attempt is probably dead by now" is a
    // guess, and acting on it is precisely how a duplicate account appears.
    expect(await authUserCount('stuck@example.test')).toBe(0)
  })

  it('a NEW request_id converges on the correct final state', async () => {
    // §4 case E: the stale attempt stays visible to an OWNER and is cleared
    // explicitly, never by a timeout. Meanwhile the operation itself can
    // proceed under a fresh id, which resolves the now-existing (or still
    // absent) account through case C and links it.
    const response = await invokeFunction('admin-provision-user', {
      token: ownerA,
      body: {
        request_id: requestId('31'),
        organization_id: SEED.organizationA,
        email: 'stuck@example.test',
        display_name: 'Stuck Resolved',
        role: 'MEMBER',
      },
    })

    expect(response.status).toBe(200)
    expect((response.json as { status: string }).status).toBe('SUCCEEDED')
    expect(await authUserCount('stuck@example.test')).toBe(1)

    // And the stale row is still there, still IN_FLIGHT, still visible to the
    // OWNER through `api.provisioning_attempts`. An inert half-done record is
    // the worst outcome this workflow can produce.
    const stale = await sql(
      `select status from app_data.provisioning_attempts where request_id = '${requestId('30')}'`,
    )
    expect(stale).toBe('IN_FLIGHT')
  })
})

describe('admin-reset-password is gone (Phase 12, P12-B1)', () => {
  // An Auth identity is global. The Phase 10 reset let an administrator of ONE
  // organisation replace — and receive — the password of an account that may
  // also open another. The function and both RPCs behind it were removed; the
  // cross-organisation regression is in `security/credentialBoundary.security.test.ts`.
  it('no administrator can replace an existing account\'s password through it', async () => {
    const before = await sql(`select encrypted_password from auth.users where id = '${SEED.memberA.id}'`)
    const response = await invokeFunction('admin-reset-password', {
      token: ownerA,
      body: { organization_id: SEED.organizationA, user_id: SEED.memberA.id },
    })
    expect(response.status).not.toBe(200)
    expect(response.text).not.toMatch(/password|token/i)
    expect(await sql(`select encrypted_password from auth.users where id = '${SEED.memberA.id}'`)).toBe(before)
  })

  it('the RPCs it depended on no longer exist, for any caller', async () => {
    expect(await sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname in ('begin_password_reset', 'complete_password_reset')`)).toBe('0')
  })
})
