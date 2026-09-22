/**
 * Where the client learns which Supabase project it talks to — and the one
 * check that makes "no security-by-hidden-key architecture" a property of the
 * build rather than a paragraph in a document.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §19.
 *
 * ## What may be in a bundle, and what may never be
 *
 * | Value | In the React/Tauri bundle? |
 * | --- | --- |
 * | project URL | yes |
 * | publishable key (`sb_publishable_…`) | yes — it is a project identifier |
 * | secret key (`sb_secret_…`) | **never** |
 * | database password, management access token | **never** |
 *
 * A publishable key is not a secret and is not treated as one. It grants
 * exactly what the `anon` and `authenticated` roles are granted, and `anon` is
 * granted nothing on any business object in any schema. Extracting it from a
 * bundle, a network trace, or a decompiled desktop binary gives an attacker the
 * capabilities of a logged-out visitor.
 *
 * A secret key bypasses every row-level policy in the system. It exists in one
 * place — Edge Function secrets — and `assertNoSecretKeyInBundle` in
 * `scripts/assert-no-secret-key.mjs` fails the production build if one ever
 * reaches the output.
 */

/** The prefixes a client bundle must never contain. */
export const FORBIDDEN_KEY_PREFIXES = ['sb_secret_'] as const

/**
 * The legacy `service_role` JWT marker. Supabase is deprecating the legacy
 * anon/service_role key pair by the end of 2026 in favour of
 * publishable/secret, so new work uses the new names — but a legacy secret in a
 * bundle is exactly as catastrophic as a new one, and the build check looks for
 * both.
 */
export const FORBIDDEN_KEY_MARKERS = ['service_role'] as const

export interface CloudConfig {
  readonly url: string
  readonly publishableKey: string
}

export type CloudConfigProblem =
  /** No `VITE_SUPABASE_URL` was provided at build time. */
  | 'URL_MISSING'
  /** The URL is not a parseable absolute HTTPS (or local HTTP) URL. */
  | 'URL_INVALID'
  /** No `VITE_SUPABASE_PUBLISHABLE_KEY` was provided at build time. */
  | 'KEY_MISSING'
  /**
   * A secret key was provided where a publishable one belongs. This is the
   * single most dangerous configuration mistake available, and it fails loudly
   * rather than working perfectly and silently handing every visitor
   * unrestricted database access.
   */
  | 'KEY_IS_SECRET'

export class CloudConfigError extends Error {
  readonly problem: CloudConfigProblem

  constructor(problem: CloudConfigProblem, message: string) {
    super(message)
    this.name = 'CloudConfigError'
    this.problem = problem
  }
}

/** Environment values, as a plain record, so this module is testable without Vite. */
export interface CloudEnvironment {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
}

/**
 * Validates configuration and refuses anything that would be unsafe or broken.
 *
 * Throws rather than returning a partial result: a client constructed from a
 * missing URL produces network errors that look like an unavailable server
 * (§17), and telling an administrator "the server is down" when the truth is
 * "this build was never configured" sends them to restart a project that was
 * never the problem.
 */
export function readCloudConfig(environment: CloudEnvironment): CloudConfig {
  const url = (environment.VITE_SUPABASE_URL ?? '').trim()
  const publishableKey = (environment.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim()

  if (url === '') {
    throw new CloudConfigError('URL_MISSING', 'VITE_SUPABASE_URL is not set')
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new CloudConfigError('URL_INVALID', 'VITE_SUPABASE_URL is not a valid URL')
  }

  // `http` is permitted only for the local development stack, which listens on
  // a loopback address and is never exposed publicly. Anything else must be
  // HTTPS: a session token travelling in clear text is a stolen session, which
  // is the one threat row-level security cannot mitigate (threat 15).
  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new CloudConfigError('URL_INVALID', 'VITE_SUPABASE_URL must use https outside local development')
  }

  if (publishableKey === '') {
    throw new CloudConfigError('KEY_MISSING', 'VITE_SUPABASE_PUBLISHABLE_KEY is not set')
  }

  if (containsForbiddenKeyMaterial(publishableKey)) {
    throw new CloudConfigError(
      'KEY_IS_SECRET',
      'VITE_SUPABASE_PUBLISHABLE_KEY looks like a secret key; a secret key must never reach a client bundle',
    )
  }

  return { url, publishableKey }
}

/**
 * True if the text contains a marker that must never appear in client-side
 * material. Shared by this module and the build-time bundle scan, so the rule
 * is stated once and applied in both places.
 */
export function containsForbiddenKeyMaterial(text: string): boolean {
  return (
    FORBIDDEN_KEY_PREFIXES.some((prefix) => text.includes(prefix)) ||
    FORBIDDEN_KEY_MARKERS.some((marker) => text.includes(marker))
  )
}
