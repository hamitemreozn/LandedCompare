/**
 * The backup module's public surface.
 *
 * Three layers, and the difference between them is the point:
 *
 * ```text
 *   WORKING DATA
 *   └── IndexedDB                  ← src/persistence. Everything reads/writes here.
 *
 *   RECOVERY
 *   ├── internal snapshots         ← undo. Dies with the disk, the profile, the origin.
 *   └── external backup files      ← disaster recovery. The only real one.
 * ```
 *
 * **A snapshot is not a backup.** Snapshots share a disk and a browser origin
 * with the data they protect, so everything that destroys the working database
 * destroys them in the same instant. Only a file that has left the origin
 * survives a dead drive or a wiped profile. The two words are kept apart
 * throughout this module, and any UI built on it must keep them apart too —
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §10 makes that a product
 * requirement, not a preference.
 *
 * This module is plain TypeScript: no React, no i18n, and exactly one
 * DOM-aware function (`downloadBackup`), kept in its own file so the backup
 * path is testable without a browser. Failures are machine-readable
 * `BackupError` codes; the Turkish and English wording belongs to `src/i18n`
 * and to the Phase 9 Settings screen.
 */

export { BackupError, isBackupError, type BackupErrorCode, type BackupErrorDetails } from './errors'

export {
  MAX_BACKUP_BYTES,
  MAX_JSON_DEPTH,
  MAX_RECORDS_PER_STORE,
  MAX_TOTAL_RECORDS,
  utf8ByteLength,
} from './limits'

export {
  canonicalize,
  assertJsonDepthWithin,
  assertTextWithinSizeLimit,
  assertWithinSizeLimit,
  parseUntrustedJson,
  FORBIDDEN_KEYS,
} from './canonicalJson'

export {
  CHECKSUM_ALGORITHM,
  sha256Hex,
  isChecksumShape,
  type DigestProvider,
} from './checksum'

export {
  BACKUP_STORE_NAMES,
  VALIDATED_STORE_NAMES,
  countEntities,
  emptyBackupData,
  isBusinessStoreName,
  readBusinessData,
  totalRecords,
  validateBackupData,
  type BackupData,
  type BusinessStoreName,
  type EntityCounts,
} from './businessData'

export {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  INTEGRITY_SCOPE,
  SUPPORTED_BACKUP_FORMAT_VERSIONS,
  backupFilename,
  buildBackupEnvelope,
  parseBackupEnvelope,
  serialiseBackupEnvelope,
  verifyBackupChecksum,
  verifyEntityCounts,
  type BackupEnvelope,
  type BackupIntegrity,
  type BackupManifest,
  type ParsedEnvelope,
} from './envelope'

export {
  PAYLOAD_MIGRATIONS,
  assertPayloadMigrationChain,
  migrateBackupPayload,
  type MigratedPayload,
  type PayloadMigration,
} from './payloadMigrations'

export {
  SNAPSHOT_KINDS,
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  parseSnapshotMetadata,
  parseSnapshotRecord,
  readSnapshot,
  writeSnapshot,
  type SnapshotKind,
  type SnapshotRecord,
  type SnapshotSummary,
} from './snapshots'

export {
  ensurePreMigrationSnapshot,
  type EnsurePreMigrationSnapshotOptions,
  type PreMigrationOutcome,
  type PreMigrationSnapshotResult,
} from './preMigration'

export {
  DEFAULT_RETENTION_POLICY,
  planRetention,
  type RetentionPlan,
  type RetentionPlanOptions,
  type RetentionPolicy,
} from './retention'

export {
  applyRetention,
  ensureDailySnapshot,
  runSnapshotMaintenance,
  utcDay,
  type DailySnapshotResult,
  type RetentionResult,
  type SnapshotMaintenanceResult,
} from './maintenance'

export {
  EXTERNAL_BACKUP_STALE_AFTER_DAYS,
  createBackup,
  describeOrigin,
  exportBackup,
  externalBackupStatus,
  isExternalBackupStale,
  markExternalBackupCompleted,
  type BackupArtifact,
  type CreateBackupOptions,
  type ExportBackupOptions,
  type ExportBackupResult,
  type ExternalBackupState,
  type ExternalBackupStatus,
  type OriginInfo,
} from './externalBackup'

export { downloadBackup, toBackupBlob, type DownloadOptions } from './download'

export {
  PRESERVED_STORE_NAMES,
  applyRestore,
  prepareRestore,
  prepareRestoreFromSnapshot,
  type ApplyRestoreOptions,
  type PrepareRestoreOptions,
  type RestorePlan,
  type RestorePreview,
  type RestoreResult,
  type RestoreSourceKind,
} from './restore'
