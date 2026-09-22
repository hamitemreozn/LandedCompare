/**
 * B1, B2, B6/B7 — two tenants, two sessions, and hostile requests between them.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7 "Part 2"; threat
 * model 1, 2, 18 and 20.
 *
 * The pgTAP suite proves the same isolation from inside the database, with
 * `set role` and a claims setting. This proves it from outside, with two real
 * access tokens issued by GoTrue, through the only surface a client has. The
 * difference is not redundancy: a `security_invoker` option missing from a view
 * is invisible to a `set role` test that queries the table, and the
 * catalogue assertion that would catch it is a different kind of evidence from
 * a request that comes back with somebody else's company in it.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { rest, SEED, signIn, sql } from './localStack'

let ownerA: string
let memberA: string
let ownerB: string

beforeAll(async () => {
  ownerA = await signIn(SEED.ownerA.email, SEED.password)
  memberA = await signIn(SEED.memberA.email, SEED.password)
  ownerB = await signIn(SEED.ownerB.email, SEED.password)
})

describe('B1/B2 — a tenant sees its own data and cannot see the other', () => {
  it('each organisation reads itself, and only itself', async () => {
    const a = await rest('organizations?select=id,name', { token: ownerA })
    const b = await rest('organizations?select=id,name', { token: ownerB })

    expect(a.json).toEqual([{ id: SEED.organizationA, name: 'Deneme Şirketi A' }])
    expect(b.json).toEqual([{ id: SEED.organizationB, name: 'Deneme Şirketi B' }])
  })

  it('threat 2: filtering explicitly for the other tenant returns nothing, not an error', async () => {
    const response = await rest(`organizations?id=eq.${SEED.organizationB}&select=*`, {
      token: ownerA,
    })

    // 200 with an empty array, identical to what a nonexistent uuid returns.
    // That identity is the control: a 403 here would confirm the row exists,
    // which turns the API into an enumeration oracle for other companies.
    expect(response.status).toBe(200)
    expect(response.json).toEqual([])

    const nonexistent = await rest(
      'organizations?id=eq.00000000-0000-4000-8000-000000000000&select=*',
      { token: ownerA },
    )
    expect(nonexistent.status).toBe(response.status)
    expect(nonexistent.json).toEqual(response.json)
  })

  it('threat 18: profiles are scoped to shared ACTIVE membership', async () => {
    const namesFor = async (token: string): Promise<string[]> => {
      const response = await rest('profiles?select=display_name&order=display_name', { token })
      return (response.json as { display_name: string }[]).map((row) => row.display_name)
    }

    const a = await namesFor(ownerA)
    const b = await namesFor(ownerB)

    // Containment and exclusion rather than an exact list. The provisioning
    // suite adds colleagues to organisation A, so an exact-equality assertion
    // here would pass or fail depending on which file the runner happened to
    // execute first — and a suite whose result depends on file order is a suite
    // that will one day be green for the wrong reason.
    expect(a).toEqual(expect.arrayContaining(['Ayşe Yılmaz', 'Berk Demir']))
    expect(b).toEqual(expect.arrayContaining(['Cem Kaya', 'Deniz Aydın']))

    // The property under test, stated as the thing that must NOT be true.
    expect(a).not.toEqual(expect.arrayContaining(['Cem Kaya']))
    expect(a).not.toEqual(expect.arrayContaining(['Deniz Aydın']))
    expect(b).not.toEqual(expect.arrayContaining(['Ayşe Yılmaz']))
    expect(b).not.toEqual(expect.arrayContaining(['Berk Demir']))
  })

  it('asking for a colleague of the other tenant by exact user id returns nothing', async () => {
    const response = await rest(`profiles?user_id=eq.${SEED.ownerB.id}&select=display_name`, {
      token: ownerA,
    })
    expect(response.json).toEqual([])
  })

  it('a MEMBER is confined by role as well as by tenant', async () => {
    const events = await rest('admin_events?select=*', { token: memberA })
    const attempts = await rest('provisioning_attempts?select=*', { token: memberA })

    expect(events.status).toBe(200)
    expect(events.json).toEqual([])
    expect(attempts.json).toEqual([])
  })
})

describe('threat 1 — a client-supplied organization_id cannot reach another tenant', () => {
  it('the only client write path refuses to name a subject at all', async () => {
    // `api.update_own_profile(p_display_name, p_expected_version)` has no
    // parameter for a user id or an organisation id. The attack has nowhere to
    // put its payload — which is what "typed, per-entity, small" buys over a
    // generic `mutate(table, id, payload)`.
    const response = await rest('rpc/update_own_profile', {
      token: ownerA,
      method: 'POST',
      body: {
        p_display_name: 'Renamed by A',
        p_expected_version: 1,
        // Ignored by PostgREST: an argument that does not exist in the
        // signature is not a silently-accepted extra, it changes which
        // overload is resolved — and there is no overload taking it.
        p_user_id: SEED.ownerB.id,
        p_organization_id: SEED.organizationB,
      },
    })

    expect(response.status).toBeGreaterThanOrEqual(400)

    const untouched = await sql(
      `select display_name from app_data.profiles where user_id = '${SEED.ownerB.id}'`,
    )
    expect(untouched).toBe('Cem Kaya')
  })

  it('the version predicate is required and enforced — threat 9 and 9b', async () => {
    const before = await rest(`profiles?user_id=eq.${SEED.ownerA.id}&select=version`, {
      token: ownerA,
    })
    const version = (before.json as [{ version: number }])[0].version

    const ok = await rest('rpc/update_own_profile', {
      token: ownerA,
      method: 'POST',
      body: { p_display_name: 'Ayşe Yılmaz', p_expected_version: version },
    })
    expect(ok.status).toBe(200)

    // The same expected version a second time. Zero rows matched, which the RPC
    // raises on — so the client receives a refusal rather than a success that
    // quietly overwrote somebody else's edit.
    const stale = await rest('rpc/update_own_profile', {
      token: ownerA,
      method: 'POST',
      body: { p_display_name: 'Ayşe Yılmaz', p_expected_version: version },
    })
    expect(stale.status).toBeGreaterThanOrEqual(400)
    expect((stale.json as { details?: string }).details).toBe('STALE_WRITE')

    // And there is no overload without the argument, so a client cannot simply
    // omit the clause it does not like.
    const omitted = await rest('rpc/update_own_profile', {
      token: ownerA,
      method: 'POST',
      body: { p_display_name: 'Ayşe Yılmaz' },
    })
    expect(omitted.status).toBeGreaterThanOrEqual(400)
    expect((omitted.json as { code?: string }).code).toBe('PGRST202')
  })
})

describe('B6/B7 — the wire format of an api projection', () => {
  it('timestamps arrive in the exact instant format the existing validator accepts', async () => {
    const response = await rest(`organizations?id=eq.${SEED.organizationA}&select=created_at`, {
      token: ownerA,
    })

    const createdAt = (response.json as [{ created_at: string }])[0].created_at

    // PostgreSQL would return `2026-09-22T20:12:07.123456+00:00`, which
    // `expectInstant` rejects — it wants milliseconds and a literal Z. The
    // normalisation happens in the view, in one place, for the same reason
    // decimals will be cast there in Phase 11.
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(createdAt).toISOString()).toBe(createdAt)
  })

  it('B7: no api projection returns a JSON number for anything but an integer counter', async () => {
    // Phase 10 has no financial column, so the hostile-precision fixture of §7
    // belongs to Phase 11, where the first `numeric` appears. What is asserted
    // NOW is the shape of the surface that fixture will land on: the only
    // JSON numbers crossing this boundary are `version` counters, which are
    // `integer` and exactly representable in float64.
    //
    // The catalogue assertion P15 is the other half — it fails the build the
    // day an api view or RPC exposes a `numeric` without casting it to text —
    // and together they mean the decimal contract cannot be broken quietly
    // between now and the phase that proves it with a value.
    const response = await rest(`organizations?id=eq.${SEED.organizationA}&select=*`, {
      token: ownerA,
    })

    const row = (response.json as Record<string, unknown>[])[0]
    for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'number') {
        expect(column, `${column} is serialised as a JSON number`).toBe('version')
        expect(Number.isInteger(value)).toBe(true)
      }
    }

    // And the raw body, not the parsed object — because by the time
    // `JSON.parse` has run, a destroyed decimal already looks like a plausible
    // number. This is the assertion technique Phase 11's fixture uses.
    expect(response.text).not.toMatch(/"[a-z_]*amount[a-z_]*":\s*[0-9]/)
  })
})
