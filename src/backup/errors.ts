/**
 * Structured backup, snapshot and restore failures.
 *
 * A deliberate second error type rather than new members on
 * `PersistenceErrorCode`. The two layers fail for different reasons and the
 * distinction is worth keeping visible:
 *
 * - a `PersistenceError` means *the local database* refused or broke —
 *   a transaction aborted, a stored record was invalid, the origin is out of
 *   quota;
 * - a `BackupError` means *a file, a payload or a restore precondition* was
 *   rejected. Most of those come from untrusted input that never touched the
 *   database and never will.
 *
 * Keeping the union closed in this module also means Phase 8 adds nothing to
 * Phase 7's public surface. Failures raised by the persistence layer during a
 * backup or a restore propagate as `PersistenceError` unchanged — this class
 * does not swallow them.
 *
 * As in `src/persistence/errors.ts`, `message` is developer-facing English and
 * is never rendered. The UI translates `code` and `details`.
 */

export type BackupErrorCode =
  /** `crypto.subtle` is unavailable, so no checksum can be produced or verified. */
  | 'CRYPTO_UNAVAILABLE'
  /** A value cannot be serialised deterministically (function, class instance, cycle, `undefined`). */
  | 'CANONICALIZATION_FAILED'
  /** The file or payload is larger than the pilot limit. Checked before parsing. */
  | 'BACKUP_TOO_LARGE'
  /** JSON nesting is deeper than the pilot limit. Checked before parsing. */
  | 'BACKUP_TOO_DEEP'
  /** `JSON.parse` failed. */
  | 'BACKUP_MALFORMED_JSON'
  /** A `__proto__` / `constructor` / `prototype` key was present in the file. */
  | 'BACKUP_FORBIDDEN_KEY'
  /** The envelope is missing, misshapen, or carries unknown top-level keys. */
  | 'BACKUP_ENVELOPE_INVALID'
  /** `magic` is absent or wrong — this is not a LandedCompare backup. */
  | 'BACKUP_NOT_RECOGNISED'
  /** `backupFormatVersion` is not one this build reads. */
  | 'BACKUP_FORMAT_UNSUPPORTED'
  /** The payload declares a `schemaVersion` newer than this build supports. Never guessed at. */
  | 'BACKUP_SCHEMA_TOO_NEW'
  /** The payload declares an older `schemaVersion` with no migration path to the current one. */
  | 'BACKUP_SCHEMA_UNSUPPORTED'
  /** A payload migration step threw. The working database was not touched. */
  | 'BACKUP_MIGRATION_FAILED'
  /** The recomputed SHA-256 does not match `integrity.value`. */
  | 'BACKUP_CHECKSUM_MISMATCH'
  /** `entityCounts` disagrees with the records actually present in `data`. */
  | 'BACKUP_COUNT_MISMATCH'
  /** A record inside the payload failed the same validators the application uses at runtime. */
  | 'BACKUP_RECORD_INVALID'
  /** The payload carries records for a store this build cannot validate. */
  | 'BACKUP_STORE_UNSUPPORTED'
  /** A snapshot record read back from the database is not a valid snapshot. */
  | 'SNAPSHOT_INVALID'
  /** The pre-restore snapshot could not be created, so the restore did not start. */
  | 'SNAPSHOT_FAILED'
  /** A restore was asked for in a state that forbids it. Nothing was written. */
  | 'RESTORE_PRECONDITION_FAILED'
  /**
   * The restored state did not satisfy its invariants, so the restore
   * transaction was **aborted**. The working database is unchanged — this is a
   * no-op failure like every other validation failure, and is raised from
   * inside the transaction precisely so that stays true.
   */
  | 'RESTORE_VERIFICATION_FAILED'
  /**
   * The restore committed and verified inside its transaction, and then could
   * not be confirmed afterwards.
   *
   * **This one is not a no-op**, and the code is separate so it can never be
   * mistaken for one: the replacement did land, the working database is now
   * the restored data, and the pre-restore snapshot named in `details` is the
   * way back.
   *
   * It covers the whole post-commit phase, not one comparison. Either the
   * fresh read succeeded and disagreed (`details.reason` is `COUNT_MISMATCH`),
   * or the read could not be performed at all — a connection closed by
   * `versionchange`, a transaction that would not open, a failure inside the
   * confirmation itself (`CONFIRMATION_UNREADABLE`). The two are worth telling
   * apart, but neither is allowed to be reported as a failure that left the
   * old data in place, because by then it did not.
   *
   * `details` always carries `workingDatabaseReplaced: true` and
   * `preRestoreSnapshotId`. When the underlying cause was a
   * `PersistenceError`, its code travels as `persistenceCode`; the originating
   * `DOMException` stays in `cause` and its text is never surfaced.
   */
  | 'RESTORE_COMMITTED_BUT_UNVERIFIABLE'

/** Already-safe, machine-readable context. No raw `DOMException` text. */
export type BackupErrorDetails = Readonly<Record<string, string | number | boolean>>

export class BackupError extends Error {
  readonly code: BackupErrorCode
  readonly details: BackupErrorDetails

  constructor(
    code: BackupErrorCode,
    message: string,
    options: { details?: BackupErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BackupError'
    this.code = code
    this.details = options.details ?? {}
  }
}

export function isBackupError(value: unknown): value is BackupError {
  return value instanceof BackupError
}
