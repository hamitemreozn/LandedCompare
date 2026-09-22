/**
 * B4, B5, B8, B9 — the proofs that cannot be written in pgTAP.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7 "Part 2 —
 * behavioural, and two of these need HTTP"; threat model 9b, 21 and 21b.
 *
 * ## Why this file exists at all
 *
 * > pgTAP runs INSIDE the database and therefore cannot see PostgREST's
 * > exposed-schema configuration at all.
 *
 * That sentence is the reason the catalogue suite, complete as it is, leaves
 * the single most important control in this architecture unproven. `app_data`
 * having no HTTP route is what makes the exact-decimal contract an invariant
 * rather than a convention, and what makes the stale-write predicate impossible
 * to drop from a crafted request. It is a property of a PostgREST setting —
 * `db-schemas` on the `authenticator` role — which a dashboard edit can change
 * out from under the repository, and which no in-database assertion can see.
 *
 * So these are real requests, sent the way an attacker would send them, and the
 * assertions are about what comes back.
 */

import { describe, expect, it } from 'vitest'
import { rest, SEED, signIn } from './localStack'

describe('route isolation — the exposed-schema list is the security boundary', () => {
  it('B5: a canonical table in app_data has no route under its own name', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    // `counters` is a real table in `app_data` with real rows in it. Asking for
    // it by name reaches `api.counters`, which does not exist — the request
    // never gets as far as a privilege check, let alone a policy.
    const response = await rest('counters?select=*', { token })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect((response.json as { code?: string }).code).toBe('PGRST205')
  })

  it('B5: naming the schema explicitly is refused, and the refusal names the whole allow-list', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    const response = await rest('organizations?select=*', {
      token,
      headers: { 'Accept-Profile': 'app_data' },
    })

    expect(response.status).toBe(406)
    const body = response.json as { code?: string; hint?: string }
    expect(body.code).toBe('PGRST106')
    // The hint is the exposed-schema list itself. Asserting on it turns this
    // test into a guard on the CONFIGURATION rather than on one table: adding
    // `public` or `app_data` to `[api] schemas` fails here immediately.
    expect(body.hint).toBe('Only the following schemas are exposed: api')
  })

  it('B5: app_private is refused by the same mechanism', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    const response = await rest('managed_table?select=*', {
      token,
      headers: { 'Accept-Profile': 'app_private' },
    })

    expect(response.status).toBe(406)
    expect((response.json as { code?: string }).code).toBe('PGRST106')
  })

  it('B4: the RLS helper is EXECUTEable and simultaneously uncallable', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    // B3 — the helper works. If the EXECUTE grant were missing this would be
    // `permission denied for function app_private.current_org_ids`, because a
    // policy expression runs with the rights of the user running the query.
    const throughPolicy = await rest('organizations?select=id', { token })
    expect(throughPolicy.status).toBe(200)
    expect((throughPolicy.json as unknown[]).length).toBe(1)

    // B4 — and it has no route. This is the pair that makes "a privilege is not
    // a route" an observed state rather than a claim: the same function, in the
    // same request, executable and unreachable.
    const asRpc = await rest('rpc/current_org_ids', { token, method: 'POST', body: {} })
    expect(asRpc.status).toBeGreaterThanOrEqual(400)
    expect((asRpc.json as { code?: string }).code).toBe('PGRST202')
  })

  it('B4: neither do the trigger helpers or the operator bootstrap', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    for (const fn of ['stamp_row', 'assert_write_allowed', 'bootstrap_organization', 'has_org_role']) {
      const response = await rest(`rpc/${fn}`, { token, method: 'POST', body: {} })
      expect(response.status, `rpc/${fn} must not be routable`).toBeGreaterThanOrEqual(400)
    }
  })

  it('B9: a crafted PATCH against a canonical table cannot reach it', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    // This is threat 9b in its exact form: a modified client dropping the
    // version predicate from an update. There is no privilege question to lose,
    // because there is no route to consult one.
    const patch = await rest(`counters?organization_id=eq.${SEED.organizationA}`, {
      token,
      method: 'PATCH',
      body: { next_value: 9999 },
    })
    expect(patch.status).toBeGreaterThanOrEqual(400)

    const patchViaSchema = await rest(`counters?organization_id=eq.${SEED.organizationA}`, {
      token,
      method: 'PATCH',
      body: { next_value: 9999 },
      headers: { 'Content-Profile': 'app_data' },
    })
    expect(patchViaSchema.status).toBeGreaterThanOrEqual(400)
  })

  it('B9: and neither can an INSERT or a DELETE', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    const insert = await rest('counters', {
      token,
      method: 'POST',
      body: { organization_id: SEED.organizationA, key: 'SMUGGLED', next_value: 1 },
      headers: { 'Content-Profile': 'app_data' },
    })
    expect(insert.status).toBeGreaterThanOrEqual(400)

    const remove = await rest(`organizations?id=eq.${SEED.organizationA}`, {
      token,
      method: 'DELETE',
      headers: { 'Content-Profile': 'app_data' },
    })
    expect(remove.status).toBeGreaterThanOrEqual(400)
  })

  it('an api VIEW is read-only: a write aimed at the exposed surface is refused too', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    // `api.organizations` IS routable — it is the read surface. Only `select`
    // is granted on it, so a write arrives at a privilege check and fails
    // there. Both halves matter: the view must be readable and must not be a
    // second write path beside the RPCs.
    const read = await rest('organizations?select=name', { token })
    expect(read.status).toBe(200)

    const write = await rest(`organizations?id=eq.${SEED.organizationA}`, {
      token,
      method: 'PATCH',
      body: { name: 'Renamed By A Client' },
    })
    expect(write.status).toBeGreaterThanOrEqual(400)
  })

  it('B8: anon reaches nothing — not a view, not an RPC, not the schema', async () => {
    for (const path of ['organizations?select=*', 'profiles?select=*', 'memberships?select=*']) {
      const response = await rest(path)
      expect(response.status, `anon must not read ${path}`).toBeGreaterThanOrEqual(400)
      // `permission denied for schema api` — the refusal happens before any
      // object is consulted, because `anon` holds no USAGE at all.
      expect(response.text).toContain('permission denied for schema api')
    }

    const rpc = await rest('rpc/update_own_profile', {
      method: 'POST',
      body: { p_display_name: 'anon', p_expected_version: 1 },
    })
    expect(rpc.status).toBeGreaterThanOrEqual(400)
  })

  it('B8: and the provisioning RPCs are refused even to a signed-in OWNER', async () => {
    const token = await signIn(SEED.ownerA.email, SEED.password)

    // These are in `api`, so they HAVE a route — but EXECUTE is granted to
    // `service_role` alone. The refusal is a privilege, which is the strongest
    // form it can take: the function is never entered, so nothing depends on it
    // checking who called it.
    const response = await rest('rpc/begin_provisioning', {
      token,
      method: 'POST',
      body: {
        p_request_id: '99999999-9999-4999-8999-999999999999',
        p_organization_id: SEED.organizationA,
        p_email: 'self-invited@example.test',
        p_requested_role: 'OWNER',
        p_actor_user_id: SEED.ownerA.id,
      },
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.text).not.toContain('CLAIMED')
  })
})

describe('public sign-up is closed, and signing in still works', () => {
  it('threat 17: POST /auth/v1/signup is refused', async () => {
    const { apiUrl, publishableKey } = await import('./localStack').then((m) => m.localStack())

    const response = await fetch(`${apiUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'intruder@example.test', password: 'LandedLocal!1' }),
    })

    expect(response.status).toBe(422)
    expect(((await response.json()) as { error_code?: string }).error_code).toBe('signup_disabled')
  })

  it('…while the password grant that the product actually uses is unaffected', async () => {
    // Both halves are asserted because the obvious way to disable sign-up —
    // `[auth.email] enable_signup = false` — turns off the e-mail provider
    // ENTIRELY in GoTrue and breaks sign-IN, for a product whose only
    // authentication method is e-mail and password. A test for the first
    // property alone would call that configuration a success.
    const token = await signIn(SEED.memberA.email, SEED.password)
    expect(token.split('.')).toHaveLength(3)
  })
})
