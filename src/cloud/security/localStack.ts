/**
 * Talking to the local Supabase stack the way a client does.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7 and §20.
 *
 * ## Raw `fetch`, deliberately, and not `supabase-js`
 *
 * The behavioural suite has to be able to send requests a correct client would
 * never send: a schema header naming `app_data`, a `PATCH` against a canonical
 * table, an RPC path for a private helper. A client library is built to stop
 * you doing those things, which makes it the wrong instrument for proving they
 * are impossible — "the library would not let me" is not the same claim as
 * "there is no route".
 *
 * It also lets the assertions read the RAW RESPONSE BODY. For the exact-decimal
 * contract that distinction is the entire point: a test that parses JSON and
 * compares numerically passes while the data is being destroyed, because
 * `JSON.parse` has already turned the number into a float64 by the time the
 * comparison runs.
 *
 * ## Credentials in this file are not secrets
 *
 * The local stack's keys are identical on every machine that runs
 * `supabase start`, are published in Supabase's own documentation, and open a
 * database that listens on 127.0.0.1 and holds four synthetic users. They are
 * read from `supabase status` rather than hard-coded only so that a CLI version
 * that changes them does not silently break the suite.
 */

import { inject } from 'vitest'

export interface LocalStack {
  readonly apiUrl: string
  readonly publishableKey: string
  readonly secretKey: string
}

export function localStack(): LocalStack {
  const resolved = inject('localStack')
  if (!resolved?.apiUrl) {
    throw new Error(
      'the local Supabase stack was not resolved; run `npm run test:security`, which resets and inspects it first',
    )
  }
  return resolved
}

export interface RawResponse {
  readonly status: number
  /** The body exactly as it arrived, before any parsing. */
  readonly text: string
  readonly json: unknown
}

async function send(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<RawResponse> {
  const response = await fetch(url, init)
  const text = await response.text()
  let json: unknown = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, text, json }
}

/**
 * Signs in with e-mail and password and returns the access token.
 *
 * This is the real GoTrue endpoint with a real password grant, so the token it
 * returns is a real access token with a real expiry — which matters for the
 * membership-disable proof, where the whole point is that the SAME token keeps
 * verifying while the authorisation behind it is withdrawn.
 */
export async function signIn(email: string, password: string): Promise<string> {
  const { apiUrl, publishableKey } = localStack()
  const response = await send(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  const token = (response.json as { access_token?: string } | null)?.access_token
  if (response.status !== 200 || !token) {
    throw new Error(`sign-in failed for ${email}: ${response.status} ${response.text.slice(0, 200)}`)
  }
  return token
}

export interface RestOptions {
  /** A user access token. Omitted means an unauthenticated (`anon`) request. */
  readonly token?: string
  readonly method?: string
  readonly body?: unknown
  /** Extra headers — this is how a hostile `Accept-Profile` gets sent. */
  readonly headers?: Record<string, string>
}

/** A request against the PostgREST Data API. */
export function rest(path: string, options: RestOptions = {}): Promise<RawResponse> {
  const { apiUrl, publishableKey } = localStack()
  const headers: Record<string, string> = {
    apikey: publishableKey,
    'Content-Type': 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...options.headers,
  }
  return send(`${apiUrl}/rest/v1/${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

/** A request against an Edge Function. */
export function invokeFunction(
  name: string,
  options: { token?: string; body?: unknown } = {},
): Promise<RawResponse> {
  const { apiUrl, publishableKey } = localStack()
  return send(`${apiUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(options.body ?? {}),
  })
}

/**
 * Runs SQL as the database owner, to arrange or inspect state the Data API
 * deliberately cannot reach.
 *
 * Used only for FIXTURES and for reading what a test's HTTP request actually
 * wrote — never to prove a behaviour. A security assertion made through this
 * function would be asserting about a connection no client has.
 */
export async function sql(statement: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run('docker', [
    'exec',
    'supabase_db_LandedCompare',
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-t',
    '-A',
    '-c',
    statement,
  ])
  return stdout.trim()
}

/** The synthetic users `supabase/seed.sql` creates. */
export const SEED = {
  password: 'LandedLocal!1',
  organizationA: '11111111-1111-4111-8111-111111111111',
  organizationB: '22222222-2222-4222-8222-222222222222',
  ownerA: { email: 'owner-a@example.test', id: 'aaaaaaaa-0000-4000-8000-000000000001' },
  memberA: { email: 'member-a@example.test', id: 'aaaaaaaa-0000-4000-8000-000000000002' },
  ownerB: { email: 'owner-b@example.test', id: 'bbbbbbbb-0000-4000-8000-000000000001' },
  memberB: { email: 'member-b@example.test', id: 'bbbbbbbb-0000-4000-8000-000000000002' },
} as const
