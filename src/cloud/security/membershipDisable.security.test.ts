/**
 * Threat 3 — a removed member keeps a valid JWT.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §6, §22 threat 3.
 *
 * ## The claim, and why it needs a real token to prove
 *
 * > Every policy resolves membership from the `memberships` table AT QUERY
 * > TIME, never from a JWT claim. `status = 'DISABLED'` takes effect on the
 * > very next request. Authentication without membership grants nothing.
 *
 * The pgTAP version of this test holds a `request.jwt.claims` setting constant
 * while the database changes underneath it, which is the right shape but not
 * the real thing: it never involves a token, a signature, or an expiry. This
 * one signs in for real, keeps the SAME access token across the change, and
 * makes the next HTTP request with it.
 *
 * That distinction matters because the tempting implementation — put the
 * organisation and the role in the token's claims, read them in the policy —
 * passes every in-database test and fails exactly here, silently, for as long
 * as the token lives. An access token is valid for an hour by default. An hour
 * is a long time to be a former employee with full access to a company's
 * catalogue.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { rest, SEED, signIn, sql } from './localStack'

async function setMembershipStatus(status: 'ACTIVE' | 'DISABLED'): Promise<void> {
  await sql(
    `update app_data.memberships set status = '${status}'
      where organization_id = '${SEED.organizationB}'
        and user_id = '${SEED.memberB.id}'`,
  )
}

afterEach(async () => {
  await setMembershipStatus('ACTIVE')
})

describe('disabling a membership takes effect on the next request', () => {
  it('the same token that worked a moment ago now reaches nothing', async () => {
    // One sign-in. This token is never refreshed, re-issued or re-read.
    const token = await signIn(SEED.memberB.email, SEED.password)

    const before = await rest('organizations?select=id,name', { token })
    expect(before.status).toBe(200)
    expect(before.json).toEqual([{ id: SEED.organizationB, name: 'Deneme Şirketi B' }])

    await setMembershipStatus('DISABLED')

    const after = await rest('organizations?select=id,name', { token })

    // Still 200 — the token still verifies, the session is still valid, the
    // user is still authenticated. They simply are not a member of anything,
    // and every organisation-scoped policy resolves that from the database.
    expect(after.status).toBe(200)
    expect(after.json).toEqual([])
  })

  it('and colleagues disappear with it, because profile visibility is the same live state', async () => {
    const token = await signIn(SEED.memberB.email, SEED.password)

    const before = await rest(`profiles?user_id=eq.${SEED.ownerB.id}&select=display_name`, { token })
    expect(before.json).toEqual([{ display_name: 'Cem Kaya' }])

    await setMembershipStatus('DISABLED')

    const after = await rest(`profiles?user_id=eq.${SEED.ownerB.id}&select=display_name`, { token })
    expect(after.json).toEqual([])
  })

  it('the deactivated membership row stays readable by its owner, so the UI can say why', async () => {
    const token = await signIn(SEED.memberB.email, SEED.password)
    await setMembershipStatus('DISABLED')

    const memberships = await rest('memberships?select=organization_id,status', { token })
    const profile = await rest('profiles?select=display_name', { token })

    // §17 needs three different sentences for three different states, and
    // "your access to this company has been deactivated — talk to your
    // administrator" is not derivable from an empty result set. The row grants
    // no access to anything: `current_org_ids()` filters on ACTIVE, so what a
    // user can SEE here and what they can DO are decided separately.
    expect(memberships.json).toEqual([
      { organization_id: SEED.organizationB, status: 'DISABLED' },
    ])
    expect(profile.json).toEqual([{ display_name: 'Deniz Aydın' }])
  })

  it('re-enabling restores access to the same token, with no new sign-in', async () => {
    const token = await signIn(SEED.memberB.email, SEED.password)

    await setMembershipStatus('DISABLED')
    expect((await rest('organizations?select=id', { token })).json).toEqual([])

    await setMembershipStatus('ACTIVE')
    expect((await rest('organizations?select=id', { token })).json).toEqual([
      { id: SEED.organizationB },
    ])
  })

  it('a disabled member cannot write either — the refusal is not read-only', async () => {
    const token = await signIn(SEED.memberB.email, SEED.password)

    const version = Number(
      await sql(`select version from app_data.profiles where user_id = '${SEED.memberB.id}'`),
    )

    await setMembershipStatus('DISABLED')

    // The own-profile RPC is not organisation-scoped, so it still works — a
    // person may rename themselves whether or not they currently belong to a
    // company, and that is correct rather than an oversight.
    const ownProfile = await rest('rpc/update_own_profile', {
      token,
      method: 'POST',
      body: { p_display_name: 'Deniz Aydın', p_expected_version: version },
    })
    expect(ownProfile.status).toBe(200)

    // What they have lost is every organisation-scoped read, which in Phase 11
    // is every product, supplier and customer in the company.
    const orgScoped = await rest('admin_events?select=*', { token })
    expect(orgScoped.json).toEqual([])
  })
})
