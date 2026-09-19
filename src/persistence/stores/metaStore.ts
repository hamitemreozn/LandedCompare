import type { Database } from '../database'
import type { TransactionScope } from '../idb'
import { PersistenceError } from '../errors'
import { META_KEY, parseMetaRecord, type MetaRecord } from '../records/meta'

/**
 * Reads the database's own metadata.
 *
 * `openDatabase` already validated this record and exposes it as
 * `database.meta`; this function exists for the case where it must be re-read
 * inside a transaction the caller controls — which is what Phase 8 needs when
 * it stamps `lastExternalBackupAt` alongside an export.
 */
export async function readMetaRecord(scope: TransactionScope): Promise<MetaRecord> {
  const stored = await scope.get<unknown>('meta', META_KEY)
  if (stored === undefined) {
    throw new PersistenceError('SCHEMA_METADATA_INVALID', 'The database has no meta record')
  }
  return parseMetaRecord(stored)
}

export function readMeta(database: Database): Promise<MetaRecord> {
  return database.read(['meta'], readMetaRecord)
}
