/**
 * Resolving the server credential from the platform, instead of managing one.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §19.
 *
 * ---------------------------------------------------------------------------
 * Why this replaced a hand-managed secret
 *
 * The first Phase 10 implementation required an operator to run
 * `supabase secrets set LANDEDCOMPARE_SECRET_KEY=sb_secret_…` before the Edge
 * Functions would work. Measured against the pinned CLI's runtime, that secret
 * **duplicated a credential the platform already injects**:
 *
 *   SUPABASE_SECRET_KEYS       {"default":"sb_secret_…"}   ← current
 *   SUPABASE_SERVICE_ROLE_KEY  eyJ…                        ← legacy, deprecated
 *   SUPABASE_URL               the project URL
 *
 * A duplicated secret is not a neutral extra step. It is a second copy of the
 * most dangerous credential in the system, which has to be created, transported
 * and rotated by a human — and which will silently diverge from the real one
 * the first time the project's keys are rotated and nobody remembers that a
 * copy exists. Removing it removes a whole class of operational mistake, and it
 * removes a step from a runbook that is run by one person, rarely, under
 * pressure.
 *
 * ---------------------------------------------------------------------------
 * Why this is a resolver and not `Deno.env.get('SUPABASE_SECRET_KEYS')`
 *
 * `SUPABASE_SECRET_KEYS` is **plural**, and it is plural because Supabase
 * supports having more than one secret key active at a time — which is what
 * makes key rotation possible without downtime. Its observed shape in the
 * pinned runtime is a JSON object keyed by name (`{"default": "sb_secret_…"}`),
 * but "observed shape of a platform-managed envelope" is exactly the kind of
 * thing that acquires a second form later.
 *
 * So this accepts every reasonable shape, prefers the current key over the
 * deprecated one, and **fails closed with a named reason** if it finds nothing
 * usable — rather than returning an empty string that would surface three calls
 * later as an unexplained 401 from the Auth Admin API.
 *
 * It takes a plain environment record rather than reading `Deno.env` itself,
 * which is what lets the whole thing be unit-tested from the application's
 * vitest suite (`src/cloud/serverSecretKey.test.ts`) without a Deno runtime and
 * without a real credential anywhere near a test fixture.
 */

/** A bare secret key, in the current key format. */
const SECRET_KEY_PREFIX = 'sb_secret_'

export type SecretKeySource =
  /** `SUPABASE_SECRET_KEYS`, the current platform-managed envelope. */
  | 'SUPABASE_SECRET_KEYS'
  /** `SUPABASE_SERVICE_ROLE_KEY`, the legacy key. Deprecated by Supabase. */
  | 'SUPABASE_SERVICE_ROLE_KEY'

export interface ResolvedSecretKey {
  readonly key: string
  /** Which variable it came from. Reported, logged — never the key itself. */
  readonly source: SecretKeySource
}

export class ServerCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerCredentialError'
  }
}

/**
 * Pulls the first usable `sb_secret_…` value out of whatever shape the
 * envelope happens to be in.
 *
 * Handles, in order of how likely each is to be what the platform sends:
 * a JSON object of named keys, a JSON array of keys, a JSON array of
 * `{ name, key }`-ish records, and a bare unwrapped string.
 */
function extractSecretKey(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }

  if (trimmed.startsWith(SECRET_KEY_PREFIX)) {
    return trimmed
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>)
      : [parsed]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith(SECRET_KEY_PREFIX)) {
      return candidate
    }
    // A record like { name: 'default', key: 'sb_secret_…' } — the shape this
    // envelope would most plausibly grow into if it ever carried metadata.
    if (candidate !== null && typeof candidate === 'object') {
      for (const value of Object.values(candidate as Record<string, unknown>)) {
        if (typeof value === 'string' && value.startsWith(SECRET_KEY_PREFIX)) {
          return value
        }
      }
    }
  }

  return null
}

/**
 * The server credential, or a refusal that says which variable was missing.
 *
 * Never returns a partially-configured result and never falls back to the
 * publishable key: an Edge Function running with anon privileges would fail on
 * its first Auth Admin call with a message about permissions, and somebody
 * would spend an afternoon looking at RLS policies.
 */
export function resolveServerSecretKey(
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedSecretKey {
  const envelope = environment.SUPABASE_SECRET_KEYS ?? ''
  const fromEnvelope = extractSecretKey(envelope)
  if (fromEnvelope !== null) {
    return { key: fromEnvelope, source: 'SUPABASE_SECRET_KEYS' }
  }

  // The legacy service-role JWT. Supabase is deprecating the legacy key pair by
  // the end of 2026, so this is a fallback rather than a peer — but a project
  // that has not yet been migrated to the new keys must still work, and a
  // function that refused to start on one would be choosing purity over the
  // pilot running.
  const legacy = (environment.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (legacy !== '') {
    return { key: legacy, source: 'SUPABASE_SERVICE_ROLE_KEY' }
  }

  throw new ServerCredentialError(
    'no server credential is available: neither SUPABASE_SECRET_KEYS nor SUPABASE_SERVICE_ROLE_KEY was injected',
  )
}
