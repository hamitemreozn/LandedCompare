/**
 * Structured persistence failures.
 *
 * Every failure this layer produces is a `PersistenceError` carrying a
 * machine-readable `code` plus a small, already-safe `details` record. The
 * `message` is developer-facing English; it is **not** a user-facing string and
 * must never be rendered directly. The UI translates `code` (and, where useful,
 * `details`) through `src/i18n` — see `engineText.ts` for the equivalent rule
 * the engine already follows.
 *
 * The originating `DOMException` is kept in `cause` for debugging only. Its
 * message text varies by browser and locale and is deliberately not part of
 * `details`.
 */

export type PersistenceErrorCode =
  /** `indexedDB` is not available in this environment at all. */
  | 'ENVIRONMENT_UNSUPPORTED'
  /** `indexedDB.open()` failed for a reason that is not one of the cases below. */
  | 'DATABASE_OPEN_FAILED'
  /** Another tab holds an open connection and refuses to let the upgrade proceed. */
  | 'DATABASE_UPGRADE_BLOCKED'
  /** The stored database is newer than this build understands. Never opened. */
  | 'SCHEMA_VERSION_TOO_NEW'
  /** The `meta` record is missing, unreadable, or disagrees with the database version. */
  | 'SCHEMA_METADATA_INVALID'
  /** A numbered migration threw; the upgrade transaction was aborted. */
  | 'MIGRATION_FAILED'
  /** The transaction aborted, so none of its writes landed. */
  | 'TRANSACTION_ABORTED'
  /** The browser refused the write because the origin is out of storage. */
  | 'QUOTA_EXCEEDED'
  /** A stored record did not match the shape this build expects. */
  | 'RECORD_INVALID'
  /** A record the operation requires does not exist. */
  | 'RECORD_NOT_FOUND'
  /** A referenced record (e.g. a `supplierId`) does not exist. */
  | 'REFERENCE_MISSING'
  /** Another tab wrote this aggregate first; the save was refused, not merged. */
  | 'STALE_WRITE'
  /** An attempt to rewrite or remove an append-only record. */
  | 'APPEND_ONLY_VIOLATION'
  /** A key that must be unique already exists. */
  | 'DUPLICATE_KEY'
  /** A destructive operation was refused because it was not explicitly confirmed. */
  | 'DESTRUCTIVE_OPERATION_REFUSED'

/** Already-safe, machine-readable context. No raw `DOMException` text. */
export type PersistenceErrorDetails = Readonly<Record<string, string | number | boolean>>

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode
  readonly details: PersistenceErrorDetails

  constructor(
    code: PersistenceErrorCode,
    message: string,
    options: { details?: PersistenceErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PersistenceError'
    this.code = code
    this.details = options.details ?? {}
  }
}

export function isPersistenceError(value: unknown): value is PersistenceError {
  return value instanceof PersistenceError
}

/**
 * Reads a `DOMException`-like name without assuming `DOMException` exists as a
 * constructor (it does in browsers and in jsdom, but a wrapper may pass a plain
 * object through, and a test double should not have to fabricate one).
 */
function errorName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const name = (value as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

/**
 * Maps a raw IndexedDB failure onto a persistence code.
 *
 * Quota exhaustion is separated deliberately: it is a realistic pilot failure
 * with its own remedy ("export a backup, remove old snapshots") and must not
 * disappear into a generic save failure. See
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §2, "Storage durability".
 */
export function classifyRequestFailure(cause: unknown): PersistenceErrorCode {
  switch (errorName(cause)) {
    case 'QuotaExceededError':
      return 'QUOTA_EXCEEDED'
    case 'ConstraintError':
      return 'DUPLICATE_KEY'
    case 'VersionError':
      return 'SCHEMA_VERSION_TOO_NEW'
    case 'AbortError':
      return 'TRANSACTION_ABORTED'
    default:
      return 'TRANSACTION_ABORTED'
  }
}

/**
 * Wraps a raw IndexedDB failure, preserving an already-typed
 * `PersistenceError` (a validation failure raised inside a transaction must
 * keep its own code rather than being flattened into `TRANSACTION_ABORTED`).
 */
export function toPersistenceError(cause: unknown, context: PersistenceErrorDetails = {}): PersistenceError {
  if (isPersistenceError(cause)) {
    return cause
  }
  const code = classifyRequestFailure(cause)
  return new PersistenceError(code, `IndexedDB operation failed (${code})`, { details: context, cause })
}
