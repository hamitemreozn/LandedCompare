/**
 * The `meta` store: one record, describing the database itself.
 *
 * `schemaVersion` is duplicated here on purpose. The IndexedDB version is only
 * readable from an open connection, and Phase 8 needs the application-level
 * version to travel with an exported payload that has no connection at all.
 * `assertSchemaVersionConsistency` (in `database.ts`) is what keeps the two
 * from disagreeing.
 */

import {
  expectInstant,
  expectInteger,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectUuid,
  invalidRecord,
  optional,
} from '../validation'

export const META_KEY = 'meta'

export interface MetaRecord {
  readonly key: typeof META_KEY
  readonly schemaVersion: number
  /** Informational; never branched on. */
  readonly appVersion: string
  /** Identifies this installation across exports. Not a user identity. */
  readonly installId: string
  readonly createdAt: string
  /**
   * Stamped by Phase 8 on every successful external export, and the input to
   * the backup-freshness warning. Absent until the first export — which is
   * itself the state the warning is loudest about.
   */
  readonly lastExternalBackupAt?: string
}

const KNOWN_KEYS = [
  'key',
  'schemaVersion',
  'appVersion',
  'installId',
  'createdAt',
  'lastExternalBackupAt',
]

export function parseMetaRecord(value: unknown): MetaRecord {
  const record = expectObject(value, 'meta')
  expectNoUnknownKeys(record, KNOWN_KEYS, 'meta')

  const key = expectNonEmptyString(record.key, 'meta.key')
  if (key !== META_KEY) {
    throw invalidRecord('meta.key', `expected "${META_KEY}"`)
  }

  return {
    key: META_KEY,
    schemaVersion: expectInteger(record.schemaVersion, 'meta.schemaVersion'),
    appVersion: expectNonEmptyString(record.appVersion, 'meta.appVersion'),
    installId: expectUuid(record.installId, 'meta.installId'),
    createdAt: expectInstant(record.createdAt, 'meta.createdAt'),
    lastExternalBackupAt: optional(
      record.lastExternalBackupAt,
      'meta.lastExternalBackupAt',
      expectInstant,
    ),
  }
}
