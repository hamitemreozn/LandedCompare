/**
 * Hosted configuration verification, over real HTTP, without creating anything.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7 and §20;
 * docs/DEPLOYMENT.md.
 *
 * ## Why this is a script and not a checklist
 *
 * The exposed-schema list and the sign-up switch are declared in
 * `supabase/config.toml` and pushed with `supabase config push`. They are also
 * **dashboard values that can drift from the repository** — PostgREST reads the
 * list from `pgrst.db_schemas` on the `authenticator` role, which a dashboard
 * edit changes out from under the migrations. §20 is explicit that Phase 10
 * "asserts it over HTTP rather than trusting it".
 *
 * A checklist item that says "confirm Exposed schemas is api" is trusting it.
 * It is read by a person who already believes the answer, at the end of a
 * deployment, when they want to be finished. This asks the server.
 *
 * ## Every check here is unauthenticated, on purpose
 *
 * Not one of them needs a user account, a password, or a row of business data —
 * which is what makes it safe to run against a brand-new production project
 * before anybody exists on it. The authenticated half of the suite
 * (`npm run test:security`) proves tenant isolation against the local stack
 * with synthetic tenants, and that half must never be pointed at production.
 *
 * ## Usage
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
 *   node scripts/verify-hosted.mjs
 *
 * The publishable key is not a secret (§19) — it is a project identifier that
 * grants exactly what `anon` is granted, which is nothing. No secret key, no
 * database password and no access token is read, accepted or printed.
 */

import process from 'node:process'

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? ''

if (url === '' || key === '') {
  console.error('usage: SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… node scripts/verify-hosted.mjs')
  process.exit(2)
}

if (key.includes('sb_secret_') || key.includes('service_role')) {
  // Refusing is the whole point: a secret key here would make every check below
  // pass while proving nothing, because service_role bypasses the posture the
  // checks exist to confirm.
  console.error('refused: SUPABASE_PUBLISHABLE_KEY looks like a secret key. Use the publishable key.')
  process.exit(2)
}

const results = []

function record(name, ok, detail, why) {
  results.push({ name, ok, detail, why })
}

async function request(path, init = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { apikey: key, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: response.status, text, json }
}

// ── 1. The exposed-schema list, asked of the server ────────────────────────
//
// The hint PostgREST returns IS the allow-list, so this single assertion covers
// the whole configuration rather than one table: adding `public` or `app_data`
// to `[api] schemas` fails here immediately.
{
  const r = await request('/rest/v1/organizations?select=*', {
    headers: { 'Accept-Profile': 'app_data' },
  })
  const hint = r.json?.hint ?? ''
  record(
    'app_data is not an exposed schema',
    r.json?.code === 'PGRST106' && hint === 'Only the following schemas are exposed: api',
    `status ${r.status}, code ${r.json?.code ?? '—'}, hint ${JSON.stringify(hint)}`,
    'the canonical tables must have no HTTP route; this is what makes the exact-decimal and stale-write guarantees server properties',
  )
}

{
  const r = await request('/rest/v1/managed_table?select=*', {
    headers: { 'Accept-Profile': 'app_private' },
  })
  record(
    'app_private is not an exposed schema',
    r.json?.code === 'PGRST106',
    `status ${r.status}, code ${r.json?.code ?? '—'}`,
    'security helpers hold EXECUTE and must remain uncallable',
  )
}

{
  const r = await request('/rest/v1/organizations?select=*', {
    headers: { 'Accept-Profile': 'public' },
  })
  record(
    'public is not an exposed schema',
    r.json?.code === 'PGRST106',
    `status ${r.status}, code ${r.json?.code ?? '—'}`,
    'public is exposed by Supabase default and must be removed from the list',
  )
}

// ── 2. anon reaches nothing ────────────────────────────────────────────────
//
// The refusal must happen at the SCHEMA, before any object is consulted —
// `anon` holds no USAGE at all, so there is no per-object question to get wrong.
for (const view of ['organizations', 'profiles', 'memberships', 'admin_events']) {
  const r = await request(`/rest/v1/${view}?select=*`)
  record(
    `anon cannot read api.${view}`,
    r.status >= 400 && r.text.includes('permission denied for schema api'),
    `status ${r.status}`,
    'there is no unauthenticated operation in this product',
  )
}

// Phase 11 catalogue views must be present in PostgREST's schema cache while
// remaining unreadable to anon. A missing view produces a route/cache error;
// an existing protected view reaches PostgreSQL and is refused at schema api.
for (const view of ['products', 'suppliers', 'customers', 'customer_statuses']) {
  const r = await request(`/rest/v1/${view}?select=*`)
  record(
    `api.${view} exists but anon cannot read it`,
    r.status >= 400 && r.text.includes('permission denied for schema api'),
    `status ${r.status}`,
    'the Phase 11 catalogue projection must be deployed without creating an unauthenticated read path',
  )
}

{
  const r = await request('/rest/v1/rpc/current_org_ids', { method: 'POST', body: '{}' })
  record(
    'the RLS helper has no RPC route',
    r.status >= 400,
    `status ${r.status}, code ${r.json?.code ?? '—'}`,
    'a database privilege is not an HTTP route, and this is the pair that proves it',
  )
}

{
  const r = await request('/rest/v1/rpc/begin_provisioning', { method: 'POST', body: '{}' })
  record(
    'provisioning RPCs are not callable by anon',
    r.status >= 400,
    `status ${r.status}`,
    'EXECUTE is granted to service_role alone',
  )
}

// ── 3. A canonical table has no write path ─────────────────────────────────
{
  const r = await request('/rest/v1/counters?key=eq.PURCHASE_ORDER', {
    method: 'PATCH',
    body: JSON.stringify({ next_value: 9999 }),
    headers: { 'Content-Profile': 'app_data' },
  })
  record(
    'a crafted PATCH against a canonical table is refused',
    r.status >= 400,
    `status ${r.status}`,
    'threat 9b: a modified client dropping the version predicate has no route to drop it from',
  )
}

for (const method of ['POST', 'PATCH']) {
  const r = await request('/rest/v1/products?id=eq.00000000-0000-4000-8000-000000000000', {
    method,
    body: JSON.stringify({ name: 'posture-check-only' }),
    headers: { 'Content-Profile': 'app_data' },
  })
  record(
    `a crafted ${method} against canonical catalogue products is refused`,
    r.status === 406 && r.json?.code === 'PGRST106',
    `status ${r.status}, code ${r.json?.code ?? '—'}`,
    'canonical catalogue writes must have no direct REST bypass around typed RPCs and expected_version',
  )
}

// ── 4. Public sign-up is closed, and sign-in is not ────────────────────────
//
// Both halves. `[auth.email] enable_signup = false` closes the e-mail provider
// ENTIRELY and breaks sign-in, so a deployment that checked only the first
// would call a completely unusable project a success.
{
  // The password is ONE CHARACTER, and that is the safety mechanism rather than
  // carelessness.
  //
  // GoTrue evaluates `DISABLE_SIGNUP` BEFORE it validates password strength —
  // measured, not assumed. So on a correctly configured project this still
  // returns `signup_disabled`, and on a MISCONFIGURED one the password policy
  // (minimum 8) rejects it before any row is written. The check therefore
  // cannot create an account in either outcome, which is what makes it safe to
  // point at production.
  //
  // An earlier version of this script used a valid password, and running it
  // against a deliberately broken local configuration created a real auth row —
  // which is how this was found.
  const r = await request('/auth/v1/signup', {
    method: 'POST',
    body: JSON.stringify({ email: `verify-${Date.now()}@example.invalid`, password: 'x' }),
  })
  record(
    'public sign-up is disabled',
    r.status === 422 && r.json?.error_code === 'signup_disabled',
    `status ${r.status}, error_code ${r.json?.error_code ?? '—'}`,
    'accounts exist only because an administrator created one; anything other than signup_disabled means registration is open',
  )
}

{
  // A deliberately wrong credential. The provider must answer
  // `invalid_credentials`; `email_provider_disabled` would mean e-mail login is
  // switched off and nobody can use the product at all.
  const r = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({
      email: 'nobody@example.invalid',
      password: 'NotARealPassword!1',
    }),
  })
  record(
    'the password grant is still enabled',
    r.json?.error_code === 'invalid_credentials',
    `status ${r.status}, error_code ${r.json?.error_code ?? '—'}`,
    'e-mail and password is the only authentication method this product has',
  )
}

// ── Report ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)

console.log('')
console.log(`Hosted verification — ${url}`)
console.log('')
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  console.log(`        ${r.detail}`)
  if (!r.ok) {
    console.log(`        why it matters: ${r.why}`)
  }
}
console.log('')
console.log(`${results.length - failed.length}/${results.length} checks passed.`)
console.log('')

if (failed.length > 0) {
  console.error('HOSTED CONFIGURATION IS NOT CORRECT. Do not put data in this project yet.')
  process.exit(1)
}
