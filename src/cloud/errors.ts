/**
 * The cloud error vocabulary, and the translation of PostgREST/PostgreSQL
 * failures into it.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §17 and §24.
 *
 * The rule this module exists to uphold is the one `src/persistence/errors.ts`
 * already upholds for IndexedDB: **no raw server message ever reaches a
 * screen.** A `DOMException`'s text varies by browser and by the browser's own
 * locale; a PostgreSQL error's text varies by server locale and names schemas,
 * columns and constraints that mean nothing to a warehouse clerk and quite a
 * lot to an attacker. What reaches a user is a sentence written in
 * `src/i18n/resources`, chosen by the code below.
 *
 * The existing codes — `STALE_WRITE`, `DUPLICATE_KEY`, `RECORD_NOT_FOUND`,
 * `RECORD_INVALID` — are reused rather than renamed, because the sentences they
 * already resolve to are correct against a server too. "Bu kayıt başka bir
 * yerde değiştirildi" was written for two tabs on one machine and is, if
 * anything, more true for two people on two machines.
 */

/**
 * Failures that only exist once the data lives somewhere else.
 *
 * Each one needs its own sentence because treating them alike is how a user is
 * told the wrong thing: "no internet" and "the server is down" have different
 * remedies, and "your account is not attached to a company" is not a fault at
 * all.
 */
export type CloudErrorCode =
  /** The device has no network at all. */
  | 'OFFLINE'
  /**
   * The network is up and the server is not answering — a refused connection, a
   * timeout, or a platform 5xx. A Free-plan project paused for inactivity
   * presents exactly like this, and only an OWNER or ADMIN is shown the extra
   * panel explaining what to do about it.
   */
  | 'SERVER_UNAVAILABLE'
  /** No session, or a refresh the server refused. The remedy is the sign-in screen. */
  | 'SESSION_EXPIRED'
  /**
   * A sign-in attempt the Auth service refused. Wrong address, wrong password
   * and a disabled account are deliberately ONE code, so the form is not an
   * oracle for which addresses have accounts — but it is not "your session
   * expired", which is a different sentence for a different situation.
   */
  | 'INVALID_CREDENTIALS'
  /** Authenticated, but not permitted to do this. */
  | 'FORBIDDEN'
  /**
   * Authenticated with no ACTIVE membership anywhere. Distinct from FORBIDDEN
   * because the user has done nothing wrong and the remedy is an administrator,
   * not a different button.
   */
  | 'NO_MEMBERSHIP'
  /**
   * A write was refused because the organisation is write-locked for a restore
   * (§16). The ONLY state in which reading still works, and the wording has to
   * carry that — telling someone the system is down while they can still look
   * things up is both wrong and needlessly alarming.
   */
  | 'ORGANIZATION_LOCKED'
  /** The build was never configured with a project URL and publishable key. */
  | 'NOT_CONFIGURED'
  /** A concurrent edit; the existing code, the existing sentence. */
  | 'STALE_WRITE'
  | 'DUPLICATE_KEY'
  | 'RECORD_NOT_FOUND'
  | 'RECORD_INVALID'
  /** Anything unclassified. Never a raw message. */
  | 'UNEXPECTED'

export interface CloudErrorDetails {
  /** Already-safe context. Never a server message, never a constraint name. */
  readonly [key: string]: string | number | boolean
}

export class CloudError extends Error {
  readonly code: CloudErrorCode
  readonly details?: CloudErrorDetails

  constructor(code: CloudErrorCode, message: string, details?: CloudErrorDetails) {
    super(message)
    this.name = 'CloudError'
    this.code = code
    this.details = details
  }
}

export function isCloudError(value: unknown): value is CloudError {
  return value instanceof CloudError
}

/** The shape `@supabase/supabase-js` reports for a PostgREST failure. */
export interface PostgrestFailure {
  readonly code?: string | null
  readonly details?: string | null
  readonly hint?: string | null
  readonly message: string
}

/**
 * What the transport knew about the failed request.
 *
 * `postgrest-js` (2.117) does NOT throw on a network failure: it RETURNS an
 * error value with `status: 0` and a message such as `TypeError: Failed to
 * fetch`. So the HTTP status travels with the error, and a status of 0 is how
 * "the request never got an answer" is recognised. Audit A A-L1 found the
 * earlier mapper waiting for a thrown `TypeError` that never came, which made
 * OFFLINE and SERVER_UNAVAILABLE unreachable from every Data API call.
 */
export interface PostgrestContext {
  /** The HTTP status postgrest-js reported; 0 when no response arrived. */
  readonly status?: number
  /** The browser's connectivity signal, used only to choose between two sentences. */
  readonly online?: boolean
}

/**
 * PostgreSQL SQLSTATE codes this system raises on purpose.
 *
 * `55006` is `object_in_use`, which §16's write gate chose deliberately over a
 * generic `raise exception`: it is a standard class that means "come back
 * later", which is exactly what a held restore lock means.
 */
const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501'
const SQLSTATE_OBJECT_IN_USE = '55006'
const SQLSTATE_UNIQUE_VIOLATION = '23505'
const SQLSTATE_CHECK_VIOLATION = '23514'
const SQLSTATE_NOT_NULL_VIOLATION = '23502'
const SQLSTATE_FOREIGN_KEY_VIOLATION = '23503'
const SQLSTATE_RAISE_EXCEPTION = 'P0001'

/**
 * Data exceptions (class 22) a caller's parameters can produce: a value out of
 * range for its type, text that is not an integer, a numeric too large to
 * represent. They are refusals of the input, so they read as RECORD_INVALID.
 */
const SQLSTATE_INVALID_INPUT = new Set(['22001', '22003', '22007', '22008', '22023', '22P02'])

/**
 * PostgREST's own "the database is not answering" family: PGRST000 (could not
 * connect), PGRST001 (connection error), PGRST002 (schema cache not ready) and
 * PGRST003 (timed out acquiring a connection). None of them is the caller's
 * fault and every one of them clears when the server recovers.
 */
const POSTGREST_UNAVAILABLE = new Set(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'])

function unavailable(online: boolean): CloudError {
  return online
    ? new CloudError('SERVER_UNAVAILABLE', 'the server could not be reached')
    : new CloudError('OFFLINE', 'the device has no network connection')
}

/**
 * Maps a PostgREST failure onto the error vocabulary.
 *
 * The RPCs raise with a `detail` naming the code — `STALE_WRITE`,
 * `RECORD_INVALID`, `FORBIDDEN` — rather than relying on the message text,
 * because message text is the thing that gets reworded and a client that
 * pattern-matches on English prose breaks the first time somebody improves a
 * sentence.
 */
export function cloudErrorFromPostgrest(
  failure: PostgrestFailure,
  context: PostgrestContext = {},
): CloudError {
  const detail = (failure.details ?? '').trim()
  const code = failure.code ?? ''
  const status = context.status
  const online = context.online ?? true

  // No HTTP response at all: the network or the server's front door.
  if (status === 0) {
    return unavailable(online)
  }

  if (code === SQLSTATE_RAISE_EXCEPTION) {
    switch (detail) {
      case 'STALE_WRITE':
        return new CloudError('STALE_WRITE', 'the record changed since it was read')
      case 'RECORD_INVALID':
        return new CloudError('RECORD_INVALID', 'the record was refused by a server-side rule')
      case 'RECORD_NOT_FOUND':
        return new CloudError('RECORD_NOT_FOUND', 'the record does not exist')
      case 'DUPLICATE_KEY':
        return new CloudError('DUPLICATE_KEY', 'the value is already used by another record')
      case 'FORBIDDEN':
        return new CloudError('FORBIDDEN', 'the caller is not permitted to do this')
      default:
        return new CloudError('UNEXPECTED', 'the server refused the operation')
    }
  }

  switch (code) {
    case SQLSTATE_OBJECT_IN_USE:
      return new CloudError('ORGANIZATION_LOCKED', 'the organisation is locked for maintenance')
    case SQLSTATE_INSUFFICIENT_PRIVILEGE:
      return new CloudError('FORBIDDEN', 'the caller is not permitted to do this')
    case SQLSTATE_UNIQUE_VIOLATION:
      return new CloudError('DUPLICATE_KEY', 'the value is already used by another record')
    case SQLSTATE_CHECK_VIOLATION:
    case SQLSTATE_NOT_NULL_VIOLATION:
      return new CloudError('RECORD_INVALID', 'the record was refused by a database constraint')
    case SQLSTATE_FOREIGN_KEY_VIOLATION:
      return new CloudError('RECORD_NOT_FOUND', 'a referenced record does not exist')
    default:
      break
  }

  if (SQLSTATE_INVALID_INPUT.has(code)) {
    return new CloudError('RECORD_INVALID', 'a value was refused by its database type')
  }

  // PostgREST's own codes. `PGRST301`/`PGRST303` are an invalid or expired
  // JWT; the rest of the PGRST3xx family is authentication. `PGRST106` and
  // `PGRST202`/`PGRST205` mean a route does not exist — which, if it ever
  // happens in production, is a deployment fault rather than a user-facing
  // condition, so it is reported as a server problem rather than as a puzzling
  // permission message.
  if (code.startsWith('PGRST3')) {
    return new CloudError('SESSION_EXPIRED', 'the session is no longer valid')
  }
  if (code === 'PGRST106' || code === 'PGRST202' || code === 'PGRST205') {
    return new CloudError('SERVER_UNAVAILABLE', 'the expected API surface is not present on this server')
  }
  if (POSTGREST_UNAVAILABLE.has(code)) {
    return unavailable(true)
  }

  // A gateway failure (a paused project, a proxy that lost its upstream) or a
  // 5xx without a database code: the server side is not answering properly.
  if (status === 502 || status === 503 || status === 504 || (status !== undefined && status >= 500 && code === '')) {
    return unavailable(true)
  }

  return new CloudError('UNEXPECTED', 'the request failed')
}

/**
 * Classifies a THROWN value from a network call.
 *
 * The distinction between OFFLINE and SERVER_UNAVAILABLE cannot be made from
 * the exception alone — a `TypeError: Failed to fetch` means both — so the
 * browser's own connectivity signal is consulted. `navigator.onLine` is a weak
 * signal (it reports the network interface, not reachability) and is used only
 * to choose between two honest messages, never to decide whether to attempt a
 * request.
 */
export function cloudErrorFromTransport(cause: unknown, online = true): CloudError {
  if (isCloudError(cause)) {
    return cause
  }
  return unavailable(online)
}
