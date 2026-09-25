/**
 * Maps the persistence, backup and startup layers' machine-readable codes to
 * translation keys — the same UI/i18n boundary `engineText.ts` draws for the
 * comparison engine, extended to the two layers Phase 9 put a screen in front
 * of.
 *
 * The rule those layers state and this module upholds: a `PersistenceError`'s
 * or `BackupError`'s `message` is developer-facing English and is **never
 * rendered**, and the originating `DOMException`'s text — which varies by
 * browser and by the browser's own locale — never reaches a user at all. What
 * reaches a user is a sentence written here, in Turkish and in English, that
 * says what happened and what to do about it.
 *
 * Only type-only imports, so nothing below this boundary gains a dependency on
 * i18n.
 */

import type { BootFailureReason, BootWarningCode } from '../app/bootstrap'
import type { BackupErrorCode } from '../backup/errors'
import type { ExternalBackupState } from '../backup/externalBackup'
import type { CloudErrorCode } from '../cloud/errors'
import type { PersistenceErrorCode } from '../persistence/errors'

/**
 * Persistence failures a user can actually meet through a Phase 9 screen.
 *
 * Every code in the union is mapped, including the ones a catalogue form
 * cannot currently produce: an unmapped code would fall through to a generic
 * message at exactly the moment a specific one mattered, and a `Record` over
 * the closed union makes adding a code a compile error rather than a silent
 * gap.
 */
export const PERSISTENCE_ERROR_TRANSLATION_KEY: Record<PersistenceErrorCode, string> = {
  ENVIRONMENT_UNSUPPORTED: 'dataError.environmentUnsupported',
  DATABASE_OPEN_FAILED: 'dataError.databaseOpenFailed',
  DATABASE_UPGRADE_BLOCKED: 'dataError.databaseUpgradeBlocked',
  SCHEMA_VERSION_TOO_NEW: 'dataError.schemaVersionTooNew',
  SCHEMA_METADATA_INVALID: 'dataError.schemaMetadataInvalid',
  MIGRATION_FAILED: 'dataError.migrationFailed',
  TRANSACTION_ABORTED: 'dataError.transactionAborted',
  QUOTA_EXCEEDED: 'dataError.quotaExceeded',
  RECORD_INVALID: 'dataError.recordInvalid',
  RECORD_NOT_FOUND: 'dataError.recordNotFound',
  REFERENCE_MISSING: 'dataError.referenceMissing',
  STALE_WRITE: 'dataError.staleWrite',
  APPEND_ONLY_VIOLATION: 'dataError.appendOnlyViolation',
  DUPLICATE_KEY: 'dataError.duplicateKey',
  DESTRUCTIVE_OPERATION_REFUSED: 'dataError.destructiveOperationRefused',
}

/**
 * The subset of backup codes a Phase 9 screen can surface.
 *
 * Phase 9 builds no restore wizard, so the restore-specific codes are not
 * mapped one by one — they cannot be reached from any screen that exists. The
 * three that can are the ones snapshot maintenance raises on startup.
 */
export const BACKUP_ERROR_TRANSLATION_KEY: Partial<Record<BackupErrorCode, string>> = {
  CRYPTO_UNAVAILABLE: 'dataError.cryptoUnavailable',
  SNAPSHOT_FAILED: 'dataError.snapshotFailed',
  SNAPSHOT_INVALID: 'dataError.snapshotInvalid',
}

/**
 * The cloud layer's codes, mapped by the same rule as everything above.
 *
 * This table is an EXTENSION and not a replacement, which is the point
 * [Cloud & Multi-User Architecture](../../docs/CLOUD_MULTIUSER_ARCHITECTURE.md)
 * §24 makes about the gateway: the four codes this shares with the persistence
 * layer — `STALE_WRITE`, `DUPLICATE_KEY`, `RECORD_NOT_FOUND`, `RECORD_INVALID`
 * — resolve to the SAME sentences they already resolve to. "Bu kayıt başka bir
 * yerde değiştirildi" was written for two tabs on one machine and is, if
 * anything, more true for two people on two machines, so the user-facing
 * contract for a concurrent edit does not change at all when the data moves to
 * a server.
 *
 * What is new is the six states that only exist once the data lives elsewhere,
 * and each one needs its own sentence because treating them alike is how a user
 * is told the wrong thing. `ORGANIZATION_LOCKED` in particular is the only one
 * of them in which READING STILL WORKS, and its wording has to carry that:
 * telling someone the system is down while they can still look things up is
 * both wrong and needlessly alarming.
 */
export const CLOUD_ERROR_TRANSLATION_KEY: Record<CloudErrorCode, string> = {
  OFFLINE: 'cloudError.offline',
  SERVER_UNAVAILABLE: 'cloudError.serverUnavailable',
  SESSION_EXPIRED: 'cloudError.sessionExpired',
  INVALID_CREDENTIALS: 'cloudError.invalidCredentials',
  FORBIDDEN: 'cloudError.forbidden',
  NO_MEMBERSHIP: 'cloudError.noMembership',
  ORGANIZATION_LOCKED: 'cloudError.organizationLocked',
  NOT_CONFIGURED: 'cloudError.notConfigured',
  PROVISIONING_IN_FLIGHT: 'cloudError.provisioningInFlight',
  STALE_WRITE: 'dataError.staleWrite',
  DUPLICATE_KEY: 'dataError.duplicateKey',
  RECORD_NOT_FOUND: 'dataError.recordNotFound',
  RECORD_INVALID: 'dataError.recordInvalid',
  UNEXPECTED: 'cloudError.unexpected',
}

export const BOOT_FAILURE_TRANSLATION_KEY: Record<BootFailureReason, string> = {
  PRE_MIGRATION_VERSION_UNKNOWN: 'boot.failure.preMigrationVersionUnknown',
  PRE_MIGRATION_SNAPSHOT_FAILED: 'boot.failure.preMigrationSnapshotFailed',
  DATABASE_OPEN_FAILED: 'boot.failure.databaseOpenFailed',
}

export const BOOT_WARNING_TRANSLATION_KEY: Record<BootWarningCode, string> = {
  SNAPSHOT_MAINTENANCE_FAILED: 'boot.warning.snapshotMaintenanceFailed',
  SNAPSHOT_STORAGE_OVER_CEILING: 'boot.warning.snapshotStorageOverCeiling',
  STORAGE_NOT_PERSISTED: 'boot.warning.storageNotPersisted',
}

/**
 * The external-backup state, as a sentence.
 *
 * The wording these keys resolve to is constrained by
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §10 and is not a matter of taste:
 * an internal snapshot is **not** a backup, and `lastExternalBackupAt` means
 * "a file was generated and handed to the browser", never "a file reached the
 * disk". A reassuring paraphrase of either would be a lie the user only
 * discovers when they need it to be true.
 */
export const EXTERNAL_BACKUP_STATE_TRANSLATION_KEY: Record<ExternalBackupState, string> = {
  NEVER: 'backupStatus.never',
  FRESH: 'backupStatus.fresh',
  STALE: 'backupStatus.stale',
}
