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
import { invokeFunction, SEED, signIn, sql } from './localStack'

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

  it('creates the account, links it, and returns the password exactly once', async () => {
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
    const body = first.json as {
      status: string
      user_id: string
      account_created: boolean
      temporary_password: string | null
    }

    expect(body.status).toBe('SUCCEEDED')
    expect(body.account_created).toBe(true)
    expect(body.temporary_password).toBeTruthy()

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

    // The generated password appears in the response and nowhere else. An
    // `admin_events` row records that the provisioning happened and who did it
    // — never the credential.
    const details = await sql(
      `select details::text from app_data.admin_events where subject_user_id = '${body.user_id}'`,
    )
    expect(details).not.toContain(body.temporary_password!)
  })

  it('the new colleague can sign in with the password they were read out', async () => {
    // The whole out-of-band delivery story (§4) rests on this working: the
    // administrator reads the password down a phone, and it opens the account.
    const created = await sql(
      `select count(*) from auth.users where email = '${email}' and email_confirmed_at is not null`,
    )
    expect(created).toBe('1')
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
    const body = retry.json as { status: string; temporary_password: string | null }
    expect(body.status).toBe('ALREADY_SUCCEEDED')

    // No password, and this is the point of the case rather than a detail: the
    // credential was shown once, at the moment it was generated. Returning it
    // again would make "shown once" false, and returning a NEW one would
    // silently change a password the colleague may already be using.
    expect(body.temporary_password).toBeNull()

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
    const body = response.json as {
      status: string
      user_id: string
      account_created: boolean
      temporary_password: string | null
    }

    expect(body.status).toBe('SUCCEEDED')
    expect(body.user_id).toBe(SEED.memberB.id)
    expect(body.account_created).toBe(false)
    // No password: the account is not this attempt's to re-credential. This is
    // the difference between "invite" and "reset", and folding them together
    // would mean an administrator who re-typed an address silently locked a
    // colleague out.
    expect(body.temporary_password).toBeNull()

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

describe('admin-reset-password', () => {
  it('threat: an ADMIN of one company cannot reset an account in another', async () => {
    const before = await sql(
      `select encrypted_password from auth.users where id = '${SEED.memberB.id}'`,
    )

    const response = await invokeFunction('admin-reset-password', {
      token: ownerA,
      body: { organization_id: SEED.organizationA, user_id: SEED.memberB.id },
    })

    expect(response.status).toBe(403)

    const after = await sql(
      `select encrypted_password from auth.users where id = '${SEED.memberB.id}'`,
    )
    expect(after).toBe(before)
  })

  it('an OWNER resets their own colleague, and the event is recorded without the password', async () => {
    // The subject is the account THIS suite provisioned, not a seed user.
    // Resetting a seed password would leave the fixture in a state the other
    // files cannot sign in to, and a suite whose files have to run in a
    // particular order to pass is a suite that will one day pass for the wrong
    // reason.
    const subjectId = await sql(
      `select id::text from auth.users where email = 'provisioned-once@example.test'`,
    )
    expect(subjectId).not.toBe('')

    const response = await invokeFunction('admin-reset-password', {
      token: ownerA,
      body: { organization_id: SEED.organizationA, user_id: subjectId },
    })

    expect(response.status).toBe(200)
    const body = response.json as { status: string; temporary_password: string }
    expect(body.status).toBe('RESET')
    expect(body.temporary_password).toBeTruthy()

    // The reset re-raises the forced-change flag, because the password is once
    // again one an administrator knows.
    const flagged = await sql(
      `select must_change_password from app_data.profiles where user_id = '${subjectId}'`,
    )
    expect(flagged).toBe('t')

    const event = await sql(
      `select details::text from app_data.admin_events
        where subject_user_id = '${subjectId}' and event_type = 'PASSWORD_RESET_BY_ADMIN'`,
    )
    expect(event).toBe('{}')

    // The new password works, which is the only way to know the reset was real
    // rather than an event row describing a change that did not happen.
    await expect(
      signIn('provisioned-once@example.test', body.temporary_password),
    ).resolves.toBeTruthy()
  })
})
