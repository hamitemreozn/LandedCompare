/**
 * The portable backup envelope: its shape, its version, its filename, and the
 * strict parser that reads one back.
 *
 * The file is a single UTF-8 JSON document, not a container format
 * (`docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §7). A custom extension would
 * advertise a container that does not exist and hide the contents from every
 * tool the user already owns; when attachments eventually justify a ZIP, that
 * is a `backupFormatVersion` bump and the extension becomes meaningful then.
 *
 * ## Two versions, never conflated
 *
 * - `backupFormatVersion` describes **the wrapper** — the manifest fields, the
 *   checksum scope, the container. This module owns it.
 * - `schemaVersion` describes **the payload** — the record shapes inside
 *   `data`. `src/persistence` owns it, and it is the number the migration
 *   chain moves.
 *
 * A reader can understand the wrapper and not the payload (an old build
 * reading a new file), or understand a payload whose wrapper changed. Keeping
 * the two numbers apart is what lets a future build read today's backup:
 * it recognises the envelope, sees an older `schemaVersion`, and runs the same
 * migration chain the database uses.
 */

import { APP_VERSION, SCHEMA_VERSION } from '../persistence/schema'
import {
  expectInstant,
  expectInteger,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectUuid,
} from '../persistence/validation'
import { PersistenceError } from '../persistence/errors'
import { canonicalize } from './canonicalJson'
import { CHECKSUM_ALGORITHM, isChecksumShape, sha256Hex, type DigestProvider } from './checksum'
import {
  BACKUP_STORE_NAMES,
  countEntities,
  isBusinessStoreName,
  type BackupData,
  type BusinessStoreName,
  type EntityCounts,
} from './businessData'
import { BackupError } from './errors'

/**
 * Rejects "the user picked the wrong JSON file" before any other rule runs.
 * Cheap, unambiguous, and it turns a confusing validation error into a clear
 * one.
 */
export const BACKUP_MAGIC = 'LandedCompareBackup'

/** The wrapper this build writes. */
export const BACKUP_FORMAT_VERSION = 1

/** The wrappers this build reads. A file outside this set is refused, never guessed at. */
export const SUPPORTED_BACKUP_FORMAT_VERSIONS: readonly number[] = [1]

/** The checksum's declared coverage, recorded in the file so it can widen later. */
export const INTEGRITY_SCOPE = 'data'

export interface BackupIntegrity {
  readonly algorithm: typeof CHECKSUM_ALGORITHM
  readonly scope: typeof INTEGRITY_SCOPE
  readonly value: string
}

/** Everything in the file except the payload itself. */
export interface BackupManifest {
  readonly magic: typeof BACKUP_MAGIC
  readonly backupFormatVersion: number
  readonly schemaVersion: number
  readonly appVersion: string
  readonly createdAt: string
  /** Provenance only: which installation wrote this file. Never restored. */
  readonly installId: string
  readonly entityCounts: EntityCounts
  readonly integrity: BackupIntegrity
}

export interface BackupEnvelope extends BackupManifest {
  readonly data: BackupData
}

const ENVELOPE_KEYS = [
  'magic',
  'backupFormatVersion',
  'schemaVersion',
  'appVersion',
  'createdAt',
  'installId',
  'entityCounts',
  'integrity',
  'data',
]

export interface BuildEnvelopeOptions {
  readonly data: BackupData
  readonly createdAt: string
  readonly installId: string
  readonly schemaVersion?: number
  readonly appVersion?: string
  readonly digestProvider?: DigestProvider
}

/**
 * Builds a complete, checksummed envelope.
 *
 * The checksum is computed over the canonical serialisation of `data` and
 * attached afterwards, so verification recomputes over exactly the bytes the
 * writer hashed. Nothing self-referential: the digest never covers the field
 * that holds it.
 */
export async function buildBackupEnvelope(options: BuildEnvelopeOptions): Promise<BackupEnvelope> {
  const canonicalData = canonicalize(options.data, 'data')
  const value = await sha256Hex(canonicalData, options.digestProvider)

  return {
    magic: BACKUP_MAGIC,
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: options.schemaVersion ?? SCHEMA_VERSION,
    appVersion: options.appVersion ?? APP_VERSION,
    createdAt: options.createdAt,
    installId: options.installId,
    entityCounts: countEntities(options.data),
    integrity: { algorithm: CHECKSUM_ALGORITHM, scope: INTEGRITY_SCOPE, value },
    data: options.data,
  }
}

/**
 * The file's bytes.
 *
 * Canonical rather than `JSON.stringify`, so two exports of the same data
 * produce byte-identical files apart from the manifest fields that must
 * legitimately differ (`createdAt`). That is what makes a backup diffable and
 * a round-trip property testable.
 */
export function serialiseBackupEnvelope(envelope: BackupEnvelope): string {
  return canonicalize(envelope, 'backup')
}

const FILENAME_INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):/

/**
 * `LandedCompare_Backup_2026-09-19_1832.json`
 *
 * Derived by slicing the ISO instant, never by formatting a `Date`: a
 * localized date string would change with the user's locale and produce
 * `19.09.2026` on the pilot machine and `9/19/2026` on a developer's, which is
 * neither sortable nor safe in a filename. The stamp is therefore **UTC**, and
 * the characters are limited to letters, digits, `_`, `-` and the extension.
 *
 * The filename is a convenience for the human filing the file. A restore reads
 * `createdAt` from inside the envelope and never trusts the name.
 */
export function backupFilename(createdAt: string, prefix = 'LandedCompare_Backup'): string {
  const match = FILENAME_INSTANT.exec(createdAt)
  if (match === null) {
    throw new BackupError(
      'BACKUP_ENVELOPE_INVALID',
      'A backup filename needs an ISO-8601 UTC instant',
      { details: { createdAt } },
    )
  }
  const [, date, hours, minutes] = match
  return `${prefix}_${date}_${hours}${minutes}.json`
}

function envelopeFailure(reason: string, details: Record<string, string | number> = {}): BackupError {
  return new BackupError('BACKUP_ENVELOPE_INVALID', `Backup envelope is invalid: ${reason}`, {
    details: { reason, ...details },
  })
}

/** Re-raises a Phase 7 structural failure as an envelope failure, keeping the path. */
function readField<T>(read: () => T, reason: string): T {
  try {
    return read()
  } catch (cause) {
    if (cause instanceof PersistenceError) {
      const path = cause.details.path
      throw new BackupError('BACKUP_ENVELOPE_INVALID', `Backup envelope is invalid: ${reason}`, {
        details: { reason, ...(typeof path === 'string' ? { path } : {}) },
        cause,
      })
    }
    throw cause
  }
}

function parseEntityCounts(value: unknown): EntityCounts {
  const record = readField(() => expectObject(value, 'entityCounts'), 'entityCounts must be an object')
  for (const store of Object.keys(record)) {
    if (!isBusinessStoreName(store)) {
      throw envelopeFailure('entityCounts names a store this build does not know', { store })
    }
  }
  const counts: Record<string, number> = {}
  for (const store of BACKUP_STORE_NAMES) {
    const count = readField(
      () => expectInteger(record[store], `entityCounts.${store}`),
      'entityCounts must list every store as an integer',
    )
    if (count < 0) {
      throw envelopeFailure('entityCounts must not be negative', { store, count })
    }
    counts[store] = count
  }
  return counts as EntityCounts
}

function parseIntegrity(value: unknown): BackupIntegrity {
  const record = readField(() => expectObject(value, 'integrity'), 'integrity must be an object')
  readField(
    () => expectNoUnknownKeys(record, ['algorithm', 'scope', 'value'], 'integrity'),
    'integrity carries an unknown field',
  )
  if (record.algorithm !== CHECKSUM_ALGORITHM) {
    throw envelopeFailure('integrity.algorithm must be SHA-256', {
      algorithm: typeof record.algorithm === 'string' ? record.algorithm : typeof record.algorithm,
    })
  }
  if (record.scope !== INTEGRITY_SCOPE) {
    throw envelopeFailure('integrity.scope must be "data"', {
      scope: typeof record.scope === 'string' ? record.scope : typeof record.scope,
    })
  }
  if (!isChecksumShape(record.value)) {
    throw envelopeFailure('integrity.value must be 64 lowercase hex characters')
  }
  return { algorithm: CHECKSUM_ALGORITHM, scope: INTEGRITY_SCOPE, value: record.value }
}

function parseRawData(value: unknown): Record<string, readonly unknown[]> {
  const record = readField(() => expectObject(value, 'data'), 'data must be an object')
  const data: Record<string, readonly unknown[]> = {}
  for (const store of Object.keys(record)) {
    if (!isBusinessStoreName(store)) {
      throw envelopeFailure('data names a store this build does not know', { store })
    }
  }
  for (const store of BACKUP_STORE_NAMES) {
    const records = record[store]
    if (!Array.isArray(records)) {
      throw envelopeFailure('data must contain an array for every store', { store })
    }
    data[store] = records
  }
  return data
}

/**
 * The envelope as it arrived, structurally checked but not yet trusted.
 *
 * This proves the *wrapper*: that the file is a LandedCompare backup, that
 * every manifest field is present and well formed, that no unknown top-level
 * key is smuggled through, and that `data` holds an array for every store and
 * for no store this build has never heard of. It deliberately does **not**
 * check the checksum, the counts, the schema version or a single record —
 * those are separate, ordered steps in `restore.ts`, and collapsing them here
 * would make it impossible to say which one a given file failed.
 */
export interface ParsedEnvelope {
  readonly manifest: BackupManifest
  /** Untouched, unvalidated store contents. The checksum is computed over this. */
  readonly rawData: Record<string, readonly unknown[]>
}

export function parseBackupEnvelope(value: unknown): ParsedEnvelope {
  const record = readField(() => expectObject(value, 'backup'), 'expected a JSON object')

  if (record.magic !== BACKUP_MAGIC) {
    throw new BackupError(
      'BACKUP_NOT_RECOGNISED',
      'This file is not a LandedCompare backup',
      { details: { expected: BACKUP_MAGIC } },
    )
  }

  readField(
    () => expectNoUnknownKeys(record, ENVELOPE_KEYS, 'backup'),
    'the envelope carries a field this build does not know',
  )

  const backupFormatVersion = readField(
    () => expectInteger(record.backupFormatVersion, 'backup.backupFormatVersion'),
    'backupFormatVersion must be an integer',
  )
  if (!SUPPORTED_BACKUP_FORMAT_VERSIONS.includes(backupFormatVersion)) {
    throw new BackupError(
      'BACKUP_FORMAT_UNSUPPORTED',
      `This build does not read backup format version ${backupFormatVersion}`,
      {
        details: {
          backupFormatVersion,
          supported: SUPPORTED_BACKUP_FORMAT_VERSIONS.join(','),
        },
      },
    )
  }

  const schemaVersion = readField(
    () => expectInteger(record.schemaVersion, 'backup.schemaVersion'),
    'schemaVersion must be an integer',
  )
  if (schemaVersion < 1) {
    throw envelopeFailure('schemaVersion must be at least 1', { schemaVersion })
  }

  const manifest: BackupManifest = {
    magic: BACKUP_MAGIC,
    backupFormatVersion,
    schemaVersion,
    appVersion: readField(
      () => expectNonEmptyString(record.appVersion, 'backup.appVersion'),
      'appVersion must be a non-empty string',
    ),
    createdAt: readField(
      () => expectInstant(record.createdAt, 'backup.createdAt'),
      'createdAt must be an ISO-8601 UTC instant',
    ),
    installId: readField(
      () => expectUuid(record.installId, 'backup.installId'),
      'installId must be a UUID',
    ),
    entityCounts: parseEntityCounts(record.entityCounts),
    integrity: parseIntegrity(record.integrity),
  }

  return { manifest, rawData: parseRawData(record.data) }
}

/**
 * Recomputes the digest over the payload as it arrived and compares.
 *
 * The comparison is a plain string equality: there is no secret here, so
 * constant-time comparison would protect nothing.
 */
export async function verifyBackupChecksum(
  rawData: Record<string, readonly unknown[]>,
  integrity: BackupIntegrity,
  digestProvider?: DigestProvider,
): Promise<void> {
  const actual = await sha256Hex(canonicalize(rawData, 'data'), digestProvider)
  if (actual !== integrity.value) {
    throw new BackupError(
      'BACKUP_CHECKSUM_MISMATCH',
      'The backup file failed its integrity check; it is corrupt, truncated or edited',
      { details: { expected: integrity.value, actual, algorithm: integrity.algorithm } },
    )
  }
}

/**
 * Compares the manifest's counts against the payload actually present.
 *
 * The manifest is outside the checksum's scope, so this is not a redundant
 * check — it is the one that catches a file whose header and body disagree,
 * which is what a truncation or a hand-edit looks like.
 */
export function verifyEntityCounts(
  declared: EntityCounts,
  rawData: Record<string, readonly unknown[]>,
): void {
  for (const store of BACKUP_STORE_NAMES) {
    const actual = rawData[store]?.length ?? 0
    if (declared[store] !== actual) {
      throw new BackupError(
        'BACKUP_COUNT_MISMATCH',
        `The backup declares ${declared[store]} records for "${store}" but carries ${actual}`,
        { details: { store, declared: declared[store], actual } },
      )
    }
  }
}

export type { BusinessStoreName }
