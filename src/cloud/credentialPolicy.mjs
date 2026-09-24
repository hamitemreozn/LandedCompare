/**
 * The one definition of "a credential a client may carry".
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §19, threat 6.
 *
 * Plain JavaScript on purpose: the production build scanner
 * (`scripts/assert-no-secret-key.mjs`) and the hosted posture check
 * (`scripts/verify-hosted.mjs`) run in Node without a TypeScript step, and the
 * runtime configuration check (`src/cloud/config.ts`) runs in the bundle. All
 * three import THIS module, so the rule cannot drift between them.
 *
 * ## Why decoding is required
 *
 * A legacy Supabase key is a JWT. Its role claim lives in a base64url-encoded
 * payload, so the text `service_role` never appears in the key itself — a
 * substring search for it passes a real service-role key straight through.
 * The only reliable test is to decode the payload and read `role`.
 *
 * ## The policy
 *
 * | Credential | Kind | May a client carry it? |
 * | --- | --- | --- |
 * | `sb_publishable_…` | PUBLISHABLE | yes |
 * | legacy JWT with `role = "anon"` | LEGACY_ANON_JWT | only where a caller says so explicitly |
 * | `sb_secret_…` | SECRET | never |
 * | legacy JWT with any other role (`service_role`, `supabase_admin`, …) | PRIVILEGED_JWT | never |
 * | JWT-shaped text whose payload cannot be read | MALFORMED_JWT | never |
 * | anything else | UNRECOGNIZED | never as a key |
 *
 * Nothing here returns, logs or embeds a credential value. Results carry a
 * kind and, for a JWT, the decoded role name — which is not secret.
 */

const PUBLISHABLE_PREFIX = 'sb_publishable_'
const SECRET_PREFIX = 'sb_secret_'
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g
const SECRET_IN_TEXT = /sb_secret_[A-Za-z0-9_-]{8,}/g

function decodeBase64Url(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  return globalThis.Buffer.from(padded, 'base64').toString('utf8')
}

/** The `role` claim of a JWT-shaped string, or `undefined` when unreadable. */
export function jwtRole(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]))
    return payload !== null && typeof payload === 'object' && typeof payload.role === 'string'
      ? payload.role
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Classifies one credential value.
 *
 * @param {string} value
 * @returns {{ kind: 'PUBLISHABLE' | 'LEGACY_ANON_JWT' | 'SECRET' | 'PRIVILEGED_JWT' | 'MALFORMED_JWT' | 'UNRECOGNIZED', role?: string }}
 */
export function classifyCredential(value) {
  const text = String(value ?? '').trim()
  if (text.startsWith(SECRET_PREFIX)) return { kind: 'SECRET' }
  if (text.startsWith(PUBLISHABLE_PREFIX)) return { kind: 'PUBLISHABLE' }
  if (JWT_SHAPE.test(text)) {
    const role = jwtRole(text)
    if (role === undefined) return { kind: 'MALFORMED_JWT' }
    return role === 'anon' ? { kind: 'LEGACY_ANON_JWT', role } : { kind: 'PRIVILEGED_JWT', role }
  }
  return { kind: 'UNRECOGNIZED' }
}

/**
 * True when a client may carry this credential.
 *
 * @param {string} value
 * @param {{ allowLegacyAnon?: boolean }} [options]
 */
export function isClientCredential(value, options = {}) {
  const { kind } = classifyCredential(value)
  return kind === 'PUBLISHABLE' || (kind === 'LEGACY_ANON_JWT' && options.allowLegacyAnon === true)
}

/**
 * Every privileged credential embedded anywhere in a blob of text — a bundle
 * file, a configuration value.
 *
 * Returns kinds and roles only, never the matched text, so a caller can print
 * the result without moving a secret into a log.
 *
 * @param {string} text
 * @returns {{ kind: 'SECRET' | 'PRIVILEGED_JWT', role?: string }[]}
 */
export function findPrivilegedCredentials(text) {
  const hits = []
  const secrets = String(text).match(SECRET_IN_TEXT) ?? []
  for (let index = 0; index < secrets.length; index += 1) {
    hits.push({ kind: 'SECRET' })
  }
  for (const match of String(text).matchAll(JWT_IN_TEXT)) {
    const role = jwtRole(match[0])
    if (role !== undefined && role !== 'anon') {
      hits.push({ kind: 'PRIVILEGED_JWT', role })
    }
  }
  return hits
}
