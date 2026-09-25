/**
 * Accepting an invitation (Phase 12).
 *
 * A new person is invited by Auth, by e-mail, to their own address. Opening
 * the link verifies it at Auth and lands on the application with the person's
 * session in the URL FRAGMENT:
 *
 *   https://<app>/#access_token=…&refresh_token=…&expires_in=3600&token_type=bearer&type=invite
 *
 * The fragment never reaches a server. This module reads it ONCE, before the
 * boot sequence, and removes it from the address bar and the history entry
 * straight away, so the tokens are not left in the URL, a bookmark or a
 * screenshot. The session is then adopted through the gateway (after the
 * checks in `useApplicationBoot`), the boot reads the profile, and the
 * onboarding flag sends the person to "choose your password" — their own
 * password, which no administrator ever sees.
 *
 * Two link types are accepted, both e-mailed by Auth to the person's own
 * address: `invite` (a new account) and `recovery` (an operator-initiated
 * password recovery — the operator first raises the onboarding flag, so the
 * person is again asked to choose a password). Anything else in a token-shaped
 * fragment (an error from an expired link, a magic link, any other flow) is
 * removed and ignored, and the person meets the ordinary sign-in screen.
 *
 * ## Query-carried Auth material
 *
 * This product's links never carry credentials in the QUERY: admin-initiated
 * invitations use the implicit flow (PKCE is not supported for them), and
 * GoTrue returns both tokens and errors in the fragment — verified against the
 * local stack. Should a query ever carry Auth-shaped parameters (`code`,
 * `access_token`, `token_hash`, …) they are removed from the address and
 * ignored: fail closed, never accepted.
 *
 * ## Auth-shaped fragments
 *
 * A fragment is treated as Auth material — and removed from the address —
 * when it is not an application route (`#/…`) and carries any Auth-shaped key
 * (`access_token`, `refresh_token`, `provider_token`, `code`, `token_hash`,
 * `error_description`, …). Only ONE shape is ever adopted: exactly the keys
 * the implicit invite / recovery redirect produces, each once, with a
 * JWT-shaped access token and `token_type=bearer` when present. Anything else
 * — an OAuth provider token, a PKCE `code`, a `token_hash`, an error, a
 * partial or duplicated fragment — is scrubbed and ignored (fail closed). This
 * does not add support for any other sign-in flow.
 *
 * ## Whose link is this — an UNVERIFIED DISPLAY HINT ONLY
 *
 * The access token's `email` claim is decoded WITHOUT any signature check.
 * Anyone can write any claim into a token-shaped string, so the result is a
 * display hint and nothing more: it is shown to the person ("the link says it
 * is for …"). It must never decide whether confirmation is needed, whether a
 * session is adopted, which tenant or membership applies, or any other
 * security question. Whether a session already exists on this device, and
 * whose it is, comes from Auth; after adoption, the account's identity comes
 * from the verified session (`useApplicationBoot`).
 */

export type InvitationLinkType = 'invite' | 'recovery'

export interface InvitationTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly type: InvitationLinkType
  /**
   * The e-mail address written into the link's access token. UNVERIFIED
   * DISPLAY HINT ONLY: never compared, never used to skip a confirmation or to
   * authorise anything.
   */
  readonly unverifiedEmailHint?: string
}

interface LocationLike {
  readonly hash: string
  readonly pathname: string
  readonly search: string
}

interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string): void
}

const AUTH_PARAMETERS = [
  'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token',
  'code', 'token', 'token_hash', 'error', 'error_code', 'error_description',
  'expires_in', 'expires_at', 'token_type',
]

/**
 * The only keys the implicit invite / recovery redirect carries — observed
 * against the local Auth stack, including GoTrue's empty `sb` marker.
 */
const ADOPTABLE_KEYS = new Set(['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type', 'sb'])

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/

/**
 * True for a fragment carrying Auth material — tokens, a code, an error —
 * rather than an application route. Application routes start with `#/`.
 */
function isAuthFragment(hash: string): boolean {
  if (hash === '' || hash.startsWith('#/')) return false
  const parameters = new URLSearchParams(hash.replace(/^#/, ''))
  return AUTH_PARAMETERS.some((name) => parameters.has(name))
}

/** The query with every Auth-shaped parameter removed, or undefined when there were none. */
function scrubbedQuery(search: string): string | undefined {
  const parameters = new URLSearchParams(search)
  let changed = false
  for (const name of AUTH_PARAMETERS) {
    if (parameters.has(name)) {
      parameters.delete(name)
      changed = true
    }
  }
  if (!changed) return undefined
  const rest = parameters.toString()
  return rest === '' ? '' : `?${rest}`
}

/**
 * The UNVERIFIED payload of a JWT-shaped string, or an empty object. No
 * signature is checked: display hints only, never authority.
 */
function unverifiedClaims(token: string): { email?: unknown } {
  try {
    const payload = token.split('.')[1] ?? ''
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))
    const value = JSON.parse(json) as unknown
    return value !== null && typeof value === 'object' ? value as { email?: unknown } : {}
  } catch {
    return {}
  }
}

/**
 * Reads and REMOVES an Auth fragment (and any Auth-shaped query parameters).
 * Returns the tokens only for a well-formed `invite` or `recovery` fragment;
 * returns undefined — after still clearing the URL — otherwise. Returning
 * tokens authorises nothing: whether they may replace a session on this
 * device is decided in `useApplicationBoot`, from Auth's own answer.
 */
export function takeInvitationTokens(
  location: LocationLike = window.location,
  history: HistoryLike = window.history,
): InvitationTokens | undefined {
  const hash = location.hash
  const fromFragment = isAuthFragment(hash)
  const query = scrubbedQuery(location.search)
  if (!fromFragment && query === undefined) return undefined

  // Cleared first, whatever the URL turns out to hold.
  history.replaceState(null, '', `${location.pathname}${query ?? location.search}${fromFragment ? '#/dashboard' : hash}`)
  if (!fromFragment) return undefined

  const parameters = new URLSearchParams(hash.replace(/^#/, ''))
  const keys = [...parameters.keys()]
  // Exactly the implicit invite / recovery shape, each key once; anything
  // else is some other flow, an error, or tampering — never adopted.
  if (keys.some((key) => !ADOPTABLE_KEYS.has(key)) || new Set(keys).size !== keys.length) return undefined
  const accessToken = parameters.get('access_token') ?? ''
  const refreshToken = parameters.get('refresh_token') ?? ''
  const type = parameters.get('type')
  const tokenType = parameters.get('token_type')
  if (
    (type !== 'invite' && type !== 'recovery') ||
    !JWT_SHAPE.test(accessToken) ||
    refreshToken === '' ||
    (parameters.has('sb') && parameters.get('sb') !== '') ||
    (tokenType !== null && tokenType.toLowerCase() !== 'bearer')
  ) {
    return undefined
  }
  const claims = unverifiedClaims(accessToken)
  return {
    accessToken,
    refreshToken,
    type,
    ...(typeof claims.email === 'string' ? { unverifiedEmailHint: claims.email } : {}),
  }
}
