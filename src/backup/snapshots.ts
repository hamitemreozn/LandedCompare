/**
 * Recovery layer 1 — internal snapshots.
 *
 * A snapshot is a complete, timestamped copy of every business store, written
 * into the `snapshots` store *inside the same database*
 * (`docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §6).
 *
 * ## What they are for
 *
 * Undo at the database level: a bad bulk edit, a mistaken import, a migration
 * that turned out to be logically wrong, a restore the user regrets. They are
 * fast, they need no user action, and they cannot be forgotten.
 *
 * ## What they are emphatically not
 *
 * **They are not disaster recovery, and nothing in this module may be
 * presented as if they were.** A snapshot shares a disk, a browser profile and
 * an origin with the data it protects. A failed drive, a reinstalled operating
 * system, a wiped profile, or one click on "clear browsing data" destroys the
 * working database and every snapshot in it in the same instant. Only a file
 * that has left the origin is disaster recovery, which is what
 * `externalBackup.ts` produces.
 *
 * The API keeps the two words apart on purpose: nothing here is called a
 * backup, and nothing in `externalBackup.ts` is called a snapshot.
 *
 * ## Coherence
 *
 * A snapshot that caught the database mid-write would be worse than no
 * snapshot, because it would look restorable. So every store is read **and**
 * the snapshot is written inside **one** `readwrite` transaction. Reading
 * store A, returning to the event loop, then reading store B could capture a
 * state that never existed — a project referencing a supplier that had not
 * been saved when the projects were read. Building the record is pure
 * synchronous work, so the transaction never has to wait on anything that is
 * not an IndexedDB request.
 */

import type { Database } from '../persistence/database'
import type { TransactionScope } from '../persistence/idb'
import { PersistenceError } from '../persistence/errors'
import {
  expectEnum,
  expectInstant,
  expectInteger,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectUuid,
} from '../persistence/validation'
import type { StoreName } from '../persistence/schema'
import { canonicalize } from './canonicalJson'
import {
  BACKUP_STORE_NAMES,
  countEntities,
  readBusinessData,
  totalRecords,
  validateBackupData,
  type BackupData,
  type EntityCounts,
} from './businessData'
import { BackupError } from './errors'
import { utf8ByteLength } from './limits'

/**
 * The five reasons a snapshot exists. Closed on purpose: retention is defined
 * per kind, so an unrecognised kind would be a snapshot no policy governs.
 */
export const SNAPSHOT_KINDS = [
  'MANUAL',
  'DAILY',
  'PRE_MIGRATION',
  'PRE_IMPORT',
  'PRE_RESTORE',
] as const
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number]

export interface SnapshotRecord {
  readonly id: string
  readonly kind: SnapshotKind
  readonly createdAt: string
  readonly schemaVersion: number
  readonly appVersion: string
  readonly entityCounts: EntityCounts
  /** Canonical byte length of `payload`. The input to the quota ceiling. */
  readonly sizeBytes: number
  readonly payload: BackupData
}

/** A snapshot without its payload — what a list screen and the pruner need. */
export interface SnapshotSummary {
  readonly id: string
  readonly kind: SnapshotKind
  readonly createdAt: string
  readonly schemaVersion: number
  readonly appVersion: string
  readonly entityCounts: EntityCounts
  readonly sizeBytes: number
  readonly totalRecords: number
}

const SNAPSHOT_KEYS = [
  'id',
  'kind',
  'createdAt',
  'schemaVersion',
  'appVersion',
  'entityCounts',
  'sizeBytes',
  'payload',
]

const SNAPSHOT_STORES: readonly StoreName[] = [...BACKUP_STORE_NAMES, 'snapshots']

function snapshotFailure(reason: string, details: Record<string, string | number> = {}): BackupError {
  return new BackupError('SNAPSHOT_INVALID', `Stored snapshot is invalid: ${reason}`, {
    details: { reason, ...details },
  })
}

function readSnapshotField<T>(read: () => T, reason: string): T {
  try {
    return read()
  } catch (cause) {
    if (cause instanceof PersistenceError) {
      throw snapshotFailure(reason, {})
    }
    throw cause
  }
}

function parseEntityCountsField(value: unknown): EntityCounts {
  const record = readSnapshotField(
    () => expectObject(value, 'snapshot.entityCounts'),
    'entityCounts must be an object',
  )
  const counts: Record<string, number> = {}
  for (const store of BACKUP_STORE_NAMES) {
    counts[store] = readSnapshotField(
      () => expectInteger(record[store], `snapshot.entityCounts.${store}`),
      'entityCounts must list every store as an integer',
    )
  }
  return counts as EntityCounts
}

/**
 * Validates a snapshot's **metadata**, not its payload.
 *
 * The payload is re-proven record by record only when it is about to be used
 * (`prepareRestoreFromSnapshot`), because validating every record of every
 * snapshot just to draw a list would read the whole history to render a menu.
 * Until then the metadata is what is trusted, and it is checked strictly.
 */
export function parseSnapshotMetadata(value: unknown): SnapshotSummary {
  const record = readSnapshotField(() => expectObject(value, 'snapshot'), 'expected an object')
  readSnapshotField(
    () => expectNoUnknownKeys(record, SNAPSHOT_KEYS, 'snapshot'),
    'unknown field',
  )
  const entityCounts = parseEntityCountsField(record.entityCounts)
  const sizeBytes = readSnapshotField(
    () => expectInteger(record.sizeBytes, 'snapshot.sizeBytes'),
    'sizeBytes must be an integer',
  )
  if (sizeBytes < 0) {
    throw snapshotFailure('sizeBytes must not be negative', { sizeBytes })
  }
  return {
    id: readSnapshotField(() => expectUuid(record.id, 'snapshot.id'), 'id must be a UUID'),
    kind: readSnapshotField(
      () => expectEnum(record.kind, 'snapshot.kind', SNAPSHOT_KINDS),
      'kind must be a known snapshot kind',
    ),
    createdAt: readSnapshotField(
      () => expectInstant(record.createdAt, 'snapshot.createdAt'),
      'createdAt must be an ISO-8601 UTC instant',
    ),
    schemaVersion: readSnapshotField(
      () => expectInteger(record.schemaVersion, 'snapshot.schemaVersion'),
      'schemaVersion must be an integer',
    ),
    appVersion: readSnapshotField(
      () => expectNonEmptyString(record.appVersion, 'snapshot.appVersion'),
      'appVersion must be a non-empty string',
    ),
    entityCounts,
    sizeBytes,
    totalRecords: totalRecords(entityCounts),
  }
}

/** Metadata plus the payload, proven record by record through the runtime validators. */
export function parseSnapshotRecord(value: unknown): SnapshotRecord {
  const summary = parseSnapshotMetadata(value)
  const record = value as Record<string, unknown>
  const payload = readSnapshotField(
    () => expectObject(record.payload, 'snapshot.payload'),
    'payload must be an object',
  )
  const data = validateBackupData(payload as Record<string, readonly unknown[]>)
  return {
    id: summary.id,
    kind: summary.kind,
    createdAt: summary.createdAt,
    schemaVersion: summary.schemaVersion,
    appVersion: summary.appVersion,
    entityCounts: summary.entityCounts,
    sizeBytes: summary.sizeBytes,
    payload: data,
  }
}

export interface CreateSnapshotOptions {
  readonly kind: SnapshotKind
  /** Injected so a test controls the timestamp instead of waiting for one. */
  readonly now?: () => string
  readonly generateId?: () => string
}

/**
 * Builds the snapshot record inside an open transaction and writes it.
 *
 * Exposed separately from `createSnapshot` so a caller that is already inside
 * a transaction over the right stores can join it rather than opening a
 * second one.
 */
export async function writeSnapshot(
  scope: TransactionScope,
  options: {
    kind: SnapshotKind
    id: string
    createdAt: string
    schemaVersion: number
    appVersion: string
  },
): Promise<SnapshotSummary> {
  const payload = await readBusinessData(scope)
  // Pure synchronous work: no `await` of anything that is not an IndexedDB
  // request, so the transaction is still active when `add` is issued below.
  const entityCounts = countEntities(payload)
  const sizeBytes = utf8ByteLength(canonicalize(payload, 'payload'))

  const record: SnapshotRecord = {
    id: options.id,
    kind: options.kind,
    createdAt: options.createdAt,
    schemaVersion: options.schemaVersion,
    appVersion: options.appVersion,
    entityCounts,
    sizeBytes,
    payload,
  }
  await scope.add('snapshots', record)

  return {
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt,
    schemaVersion: record.schemaVersion,
    appVersion: record.appVersion,
    entityCounts,
    sizeBytes,
    totalRecords: totalRecords(entityCounts),
  }
}

/**
 * Takes a snapshot of the whole working database.
 *
 * Resolves only once the transaction has **committed** — `Database.write`
 * settles on the transaction's `complete` event, never on the individual
 * request. That is what makes the ordering rule in `restore.ts` enforceable:
 * "the pre-restore snapshot is committed before the restore transaction
 * opens" is a promise that can actually be awaited.
 */
export function createSnapshot(
  database: Database,
  options: CreateSnapshotOptions,
): Promise<SnapshotSummary> {
  const now = options.now ?? (() => new Date().toISOString())
  const generateId = options.generateId ?? (() => crypto.randomUUID())
  const createdAt = now()
  const id = generateId()

  return database.write(SNAPSHOT_STORES, (scope) =>
    writeSnapshot(scope, {
      kind: options.kind,
      id,
      createdAt,
      schemaVersion: database.schemaVersion,
      appVersion: database.meta.appVersion,
    }),
  )
}

/**
 * Every snapshot's metadata, newest first, without loading a single payload.
 *
 * Walks the `createdAt` index with a cursor for the reason spelled out on
 * `forEachFromIndex`: the alternative reads every byte of every snapshot into
 * memory to answer a question about their sizes.
 */
export async function listSnapshots(database: Database): Promise<SnapshotSummary[]> {
  // Two steps on purpose. Inside the cursor each record is *projected* —
  // every field except `payload`, copied by name — and validation happens
  // after the transaction has closed. Two reasons: a rejection keeps its own
  // `BackupError` code instead of being flattened into `TRANSACTION_ABORTED`
  // by the transaction boundary, and dropping `payload` at the projection
  // means the walk never retains more than one snapshot's data at a time.
  // Copying every other key verbatim is what keeps `expectNoUnknownKeys`
  // meaningful.
  const projected = await database.read(['snapshots'], async (scope) => {
    const rows: unknown[] = []
    await scope.forEachFromIndex('snapshots', 'createdAt', (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        rows.push(value)
        return
      }
      const record = value as Record<string, unknown>
      const metadata: Record<string, unknown> = {}
      for (const key of Object.keys(record)) {
        if (key !== 'payload') {
          metadata[key] = record[key]
        }
      }
      rows.push(metadata)
    })
    return rows
  })

  return projected.map(parseSnapshotMetadata).reverse()
}

export async function readSnapshot(database: Database, id: string): Promise<SnapshotRecord> {
  const stored = await database.read(['snapshots'], (scope) => scope.get<unknown>('snapshots', id))
  if (stored === undefined) {
    throw new BackupError('SNAPSHOT_INVALID', `No snapshot with id "${id}"`, {
      details: { snapshotId: id },
    })
  }
  return parseSnapshotRecord(stored)
}

/**
 * Removes one snapshot.
 *
 * The canonical policy makes `MANUAL` snapshots user-deletable; every other
 * kind is managed by retention. `allowKinds` is how a UI expresses that
 * without this module having to know which button was pressed.
 */
export async function deleteSnapshot(
  database: Database,
  id: string,
  options: { allowKinds?: readonly SnapshotKind[] } = {},
): Promise<void> {
  const allowed = options.allowKinds

  // The refusal is raised *after* the transaction rather than inside it.
  // `runInTransaction` re-types anything thrown in a callback through
  // `toPersistenceError`, which would flatten a `BackupError` into a generic
  // `TRANSACTION_ABORTED` and lose the reason. Returning the verdict and
  // throwing outside keeps the code the caller needs — and the transaction
  // that committed did nothing, because the delete was never issued.
  const refusedKind = await database.write(['snapshots'], async (scope) => {
    if (allowed !== undefined) {
      const stored = await scope.get<Record<string, unknown>>('snapshots', id)
      if (stored === undefined) {
        return undefined
      }
      // Only `kind` is needed to answer "may this be deleted?", and reading it
      // raw avoids validating a whole record — a snapshot too corrupt to parse
      // is still a snapshot a user may want to remove.
      const kind = stored.kind
      if (typeof kind !== 'string' || !allowed.includes(kind as SnapshotKind)) {
        return typeof kind === 'string' ? kind : 'UNKNOWN'
      }
    }
    await scope.delete('snapshots', id)
    return undefined
  })

  if (refusedKind !== undefined) {
    throw new BackupError(
      'RESTORE_PRECONDITION_FAILED',
      `Refusing to delete a ${refusedKind} snapshot`,
      { details: { snapshotId: id, kind: refusedKind } },
    )
  }
}
