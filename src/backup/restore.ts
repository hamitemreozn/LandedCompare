/**
 * Restore — the only operation in this application that can destroy
 * everything, designed accordingly.
 *
 * ## Two calls, never one
 *
 * The API is split on purpose:
 *
 * ```text
 *   prepareRestore()   read-only.  Parses, validates, migrates in memory,
 *                      and reports what would happen. Writes nothing, ever.
 *   applyRestore()     destructive. Takes a plan that already proved itself.
 * ```
 *
 * Collapsing them into one `restoreFromFile(file)` would mean the moment a
 * user picked a file, the outcome was decided — no summary, no confirmation,
 * no chance to notice that the backup is three weeks old and holds a third of
 * the current records. The confirmation itself belongs to Phase 9; what this
 * module guarantees is that there is something to confirm *before* anything
 * is written.
 *
 * ## The ordered flow
 *
 * ```text
 *  1  size check            before the file is read into memory
 *  2  read as text
 *  3  depth check           on the raw text, before JSON.parse allocates
 *  4  JSON.parse            prototype-polluting keys reject the whole file
 *  5  envelope check        magic, then shape, then backupFormatVersion
 *  6  schema version check  newer → refuse. older → a migration must exist
 *  7  integrity check       SHA-256 recomputed over canonical(data as written)
 *  8  count check           entityCounts vs the records actually present
 *  9  migrate in memory     the payload, never the working database
 * 10  structural validation every record, through the runtime validators
 * 11  preview               incoming counts and what currently exists
 *     ── everything above is read-only; a failure here is a no-op ──
 * 12  PRE_RESTORE snapshot  its own transaction, COMMITTED before step 13
 * 13  restore transaction   one readwrite transaction: clear, then repopulate
 * 14  verify IN THAT SAME   count and re-validate the written state; a failure
 *     transaction           ABORTS it, so a refused restore is a no-op too
 * 15  confirm after commit  a fresh read, defence in depth, different code
 * ```
 *
 * ### The line that divides every failure in this module
 *
 * Steps 1–14 are no-ops when they fail: the working database is still exactly
 * what it was, and a caller may say so. Step 15 is on the other side of the
 * commit, where that sentence is no longer true — so **every** way it can fail
 * reports `RESTORE_COMMITTED_BUT_UNVERIFIABLE` with
 * `workingDatabaseReplaced: true` and the pre-restore snapshot id, whether the
 * read disagreed or could not be performed at all. Telling those two failure
 * classes apart is the one thing a caller cannot be asked to guess.
 *
 * ### Why 7 and 8 come before 9
 *
 * The canonical flow lists the schema decision before the integrity check.
 * This implementation *decides* about the version at step 6 but *applies* the
 * migration at step 9, after the checksum — because the checksum covers the
 * payload **as written to the file**, and hashing a payload the reader has
 * already transformed would verify the reader's own work rather than the
 * file's integrity. Same for `entityCounts`, which describes the file.
 * Validation at step 10 then runs on the migrated payload, which is the shape
 * that is actually about to be written.
 *
 * ### Why 12 is separate from 13
 *
 * A pre-restore snapshot inside the transaction that replaces the data is not
 * a safety net; it rolls back with everything else exactly when it is needed.
 * So it is its own transaction and `createSnapshot()` resolves on *commit*.
 * If it fails, the restore does not start — there is no option to skip it and
 * none is offered.
 *
 * The restore transaction spans the business stores and **not** `snapshots`
 * or `meta`, so it cannot delete the escape hatch it just created, and it
 * cannot overwrite this installation's identity with the one from the file.
 *
 * ### Why 13 is one transaction
 *
 * Replace-all means clear-then-repopulate, and those two halves must be
 * indivisible. `clear()` in one transaction followed by writes in another
 * leaves a window — a crash, a closed laptop, a failed write — in which the
 * database is empty and the backup has not landed. IndexedDB gives multi-store
 * atomicity as long as every store is named when the transaction opens, so
 * there is no excuse for taking it: either the whole restore lands or the
 * database is exactly as it was (Data Model, I20).
 *
 * ### Why 14 is inside 13
 *
 * Because "failed restore = no-op" has to mean what it says. `Database.write`
 * resolves on the transaction's `complete` event, so a verification step
 * placed after it inspects a database that has *already* replaced the user's
 * data — and a failure there reports "the restore failed" over a working
 * database that is now neither the old one nor a valid new one. The
 * pre-restore snapshot would make that recoverable, which is a strictly weaker
 * promise than never having entered the state.
 *
 * So verification runs inside the transaction, against its own uncommitted
 * writes, and a failure aborts it. Step 15 still exists as a durability
 * confirmation on a fresh connection, but it cannot be the first place a bad
 * restore is discovered, and its failure carries a different code precisely
 * because by then the no-op guarantee no longer applies.
 *
 * Merge is not offered. Replace-all is the documented pilot behaviour
 * (Product Scope, Open Decision 10).
 */

import type { Database } from '../persistence/database'
import { PersistenceError, isPersistenceError } from '../persistence/errors'
import type { TransactionScope } from '../persistence/idb'
import type { StoreName } from '../persistence/schema'
import {
  assertJsonDepthWithin,
  assertTextWithinSizeLimit,
  assertWithinSizeLimit,
  parseUntrustedJson,
} from './canonicalJson'
import type { DigestProvider } from './checksum'
import {
  BACKUP_STORE_NAMES,
  countEntities,
  emptyBackupData,
  totalRecords,
  validateBackupData,
  type BackupData,
  type BusinessStoreName,
  type EntityCounts,
} from './businessData'
import {
  parseBackupEnvelope,
  verifyBackupChecksum,
  verifyEntityCounts,
  type BackupManifest,
} from './envelope'
import { BackupError, isBackupError } from './errors'
import { MAX_BACKUP_BYTES, MAX_JSON_DEPTH } from './limits'
import { migrateBackupPayload, type PayloadMigration } from './payloadMigrations'
import { createSnapshot, readSnapshot, type SnapshotSummary } from './snapshots'

/**
 * Stores a restore never touches.
 *
 * `snapshots` because the restore must not delete the pre-restore snapshot it
 * depends on; `meta` because `installId`, `createdAt` and
 * `lastExternalBackupAt` describe *this* installation and this disk. Restoring
 * another machine's `lastExternalBackupAt` would silence the staleness warning
 * on a database that has never been exported from here.
 */
export const PRESERVED_STORE_NAMES: readonly StoreName[] = ['meta', 'snapshots']

export type RestoreSourceKind = 'FILE' | 'SNAPSHOT'

export interface RestorePreview {
  readonly source: RestoreSourceKind
  /** When the backup or snapshot was taken. Read from inside, never from a filename. */
  readonly createdAt: string
  readonly appVersion: string
  readonly installId?: string
  readonly backupFormatVersion?: number
  /** The version the payload declared. */
  readonly backupSchemaVersion: number
  /** The version it will be written at — this build's. */
  readonly targetSchemaVersion: number
  /** Payload migration steps applied in memory. Empty when the versions matched. */
  readonly migrationsApplied: readonly number[]
  /** Recomputed from the payload, not copied from the manifest. */
  readonly incoming: EntityCounts
  /** What the working database holds right now — i.e. what is about to go. */
  readonly current: EntityCounts
  readonly totalIncomingRecords: number
  readonly totalCurrentRecords: number
  /** Stores a restore leaves alone, so a UI can say so rather than imply otherwise. */
  readonly preservedStores: readonly string[]
}

export interface RestorePlan {
  readonly manifest?: BackupManifest
  /** Validated, migrated records, ready to be written. Nothing else is written. */
  readonly data: BackupData
  readonly preview: RestorePreview
}

export interface PrepareRestoreOptions {
  readonly maxBytes?: number
  readonly maxDepth?: number
  readonly digestProvider?: DigestProvider
  readonly migrations?: readonly PayloadMigration[]
  readonly targetSchemaVersion?: number
}

/** A `Blob`/`File` without depending on the DOM's `File` type. */
interface BlobLike {
  readonly size: number
  text(): Promise<string>
}

function isBlobLike(value: unknown): value is BlobLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobLike).size === 'number' &&
    typeof (value as BlobLike).text === 'function'
  )
}

/**
 * Step 1–2. The size gate comes first, and for a `Blob` it is checked against
 * `size` *before* `text()` is called — reading a hostile two-gigabyte file
 * into a string to discover it is too big would be the failure the limit
 * exists to prevent.
 */
async function readSource(
  source: string | BlobLike,
  maxBytes: number,
): Promise<string> {
  if (isBlobLike(source)) {
    assertWithinSizeLimit(source.size, maxBytes)
    return source.text()
  }
  assertTextWithinSizeLimit(source, maxBytes)
  return source
}

async function readCurrentCounts(database: Database): Promise<EntityCounts> {
  return database.read(BACKUP_STORE_NAMES, async (scope) => {
    const counts: Record<string, number> = {}
    for (const store of BACKUP_STORE_NAMES) {
      counts[store] = await scope.count(store)
    }
    return counts as EntityCounts
  })
}

/**
 * Steps 1–11. **Reads the database; writes nothing.**
 *
 * Every rejection here leaves the working database byte-for-byte as it was,
 * because nothing has been opened in `readwrite` mode at any point.
 */
export async function prepareRestore(
  database: Database,
  source: string | BlobLike,
  options: PrepareRestoreOptions = {},
): Promise<RestorePlan> {
  const maxBytes = options.maxBytes ?? MAX_BACKUP_BYTES
  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH
  const target = options.targetSchemaVersion ?? database.schemaVersion

  const text = await readSource(source, maxBytes)
  assertTextWithinSizeLimit(text, maxBytes)
  assertJsonDepthWithin(text, maxDepth)

  const parsed = parseUntrustedJson(text)
  const { manifest, rawData } = parseBackupEnvelope(parsed)

  // Step 6 decides; step 9 applies. A payload from the future is refused here
  // rather than being carried through checks it would pass by accident.
  if (manifest.schemaVersion > target) {
    throw new BackupError(
      'BACKUP_SCHEMA_TOO_NEW',
      'The backup was written by a newer version of this application and cannot be read',
      { details: { backupSchemaVersion: manifest.schemaVersion, supportedSchemaVersion: target } },
    )
  }

  await verifyBackupChecksum(rawData, manifest.integrity, options.digestProvider)
  verifyEntityCounts(manifest.entityCounts, rawData)

  // The payload is migrated as a plain value, in memory. The working database
  // is not a scratchpad: if a step throws, nothing anywhere has changed.
  const preMigration = validateShape(rawData)
  const migrated = migrateBackupPayload(preMigration, manifest.schemaVersion, {
    migrations: options.migrations,
    targetVersion: target,
  })

  const data = validateBackupData(migrated.data)
  const incoming = countEntities(data)
  const current = await readCurrentCounts(database)

  return {
    manifest,
    data,
    preview: {
      source: 'FILE',
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      installId: manifest.installId,
      backupFormatVersion: manifest.backupFormatVersion,
      backupSchemaVersion: manifest.schemaVersion,
      targetSchemaVersion: target,
      migrationsApplied: migrated.applied,
      incoming,
      current,
      totalIncomingRecords: totalRecords(incoming),
      totalCurrentRecords: totalRecords(current),
      preservedStores: [...PRESERVED_STORE_NAMES],
    },
  }
}

/**
 * Shapes the raw payload into a `BackupData` without validating records.
 *
 * A migration step receives the payload keyed by store with array values, so
 * this fills in stores the file happened to omit — `parseBackupEnvelope` has
 * already rejected unknown store names and non-array values, so there is
 * nothing left to trust here.
 */
function validateShape(rawData: Record<string, readonly unknown[]>): BackupData {
  const data: Record<string, readonly unknown[]> = {}
  for (const store of BACKUP_STORE_NAMES) {
    data[store] = rawData[store] ?? []
  }
  return data as BackupData
}

/**
 * Builds a restore plan from an internal snapshot.
 *
 * Same destination, same guarantees, different source — and the same
 * validators: a snapshot's payload was written by this application, but it has
 * been sitting in a database a user can open in devtools, so it is re-proven
 * record by record like any other input. There is no cheaper path that skips
 * validation, because "we wrote it ourselves" is exactly the assumption that
 * lets corrupt data back in.
 */
export async function prepareRestoreFromSnapshot(
  database: Database,
  snapshotId: string,
  options: { targetSchemaVersion?: number; migrations?: readonly PayloadMigration[] } = {},
): Promise<RestorePlan> {
  const target = options.targetSchemaVersion ?? database.schemaVersion
  const snapshot = await readSnapshot(database, snapshotId)

  if (snapshot.schemaVersion > target) {
    throw new BackupError(
      'BACKUP_SCHEMA_TOO_NEW',
      'The snapshot was written at a newer schema version than this build supports',
      { details: { snapshotId, snapshotSchemaVersion: snapshot.schemaVersion, supportedSchemaVersion: target } },
    )
  }

  const migrated = migrateBackupPayload(snapshot.payload, snapshot.schemaVersion, {
    migrations: options.migrations,
    targetVersion: target,
  })
  const data = validateBackupData(migrated.data)
  const incoming = countEntities(data)
  const current = await readCurrentCounts(database)

  return {
    data,
    preview: {
      source: 'SNAPSHOT',
      createdAt: snapshot.createdAt,
      appVersion: snapshot.appVersion,
      backupSchemaVersion: snapshot.schemaVersion,
      targetSchemaVersion: target,
      migrationsApplied: migrated.applied,
      incoming,
      current,
      totalIncomingRecords: totalRecords(incoming),
      totalCurrentRecords: totalRecords(current),
      preservedStores: [...PRESERVED_STORE_NAMES],
    },
  }
}

export interface ApplyRestoreOptions {
  readonly now?: () => string
  readonly generateId?: () => string
  /**
   * Records re-read and re-validated per store **inside the restore
   * transaction**, on top of the count check that always runs for every store.
   *
   * Re-parsing every record of a large payload would double the cost of a
   * restore to re-prove something that was already proven before the write, so
   * the default samples the ends of each store — where a truncated or
   * misordered write would show first — and a test can raise it.
   */
  readonly verifySampleSize?: number
  readonly targetSchemaVersion?: number
}

export interface RestoreResult {
  /** Always present on success: a restore cannot happen without one. */
  readonly preRestoreSnapshot: SnapshotSummary
  readonly restored: EntityCounts
  readonly totalRestoredRecords: number
  readonly verified: true
  readonly preview: RestorePreview
}

/** Issues a batch of writes and reports the first failure, leaving none unhandled. */
async function settleAll(promises: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(promises)
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
}

/** Writes issued per turn. Large enough to be fast, small enough not to queue a payload's worth of requests at once. */
const WRITE_BATCH_SIZE = 250

async function replaceAll(scope: TransactionScope, data: BackupData): Promise<void> {
  for (const store of BACKUP_STORE_NAMES) {
    await scope.clear(store)
  }
  for (const store of BACKUP_STORE_NAMES) {
    const records = data[store]
    for (let index = 0; index < records.length; index += WRITE_BATCH_SIZE) {
      const batch = records.slice(index, index + WRITE_BATCH_SIZE)
      // `add`, not `put`: the store was just cleared, so a key collision means
      // the payload carries a duplicate — which aborts the whole transaction
      // instead of quietly overwriting a record.
      await settleAll(batch.map((record) => scope.add(store, record)))
    }
  }
}

function sampleOf(records: readonly unknown[], size: number): readonly unknown[] {
  if (size <= 0 || records.length === 0) {
    return []
  }
  if (records.length <= size) {
    return records
  }
  const half = Math.max(1, Math.floor(size / 2))
  return [...records.slice(0, half), ...records.slice(-half)]
}

function keyPathOf(store: BusinessStoreName): string {
  return store === 'settings' || store === 'counters' ? 'key' : 'id'
}

/**
 * Step 14, **inside the restore transaction**.
 *
 * ## Why this is not a post-commit check
 *
 * `Database.write` resolves on the transaction's `complete` event, so anything
 * verified after it has already been committed — and a verification failure
 * discovered there would mean the old data was gone, replaced by a payload the
 * application had just declared unacceptable. That is not "failed restore =
 * no-op"; it is a destructive restore with an apologetic error message. A
 * pre-restore snapshot makes such a state *recoverable*, which is a different
 * and much weaker promise than *never entered*.
 *
 * So the read-back happens here, in the same `readwrite` transaction that did
 * the clearing and the writing. IndexedDB lets a transaction read its own
 * uncommitted writes, so this checks exactly the state that is about to be
 * committed, and returning a failure lets the caller abort — leaving the
 * previous working database untouched.
 *
 * ## Why it returns instead of throwing
 *
 * `runInTransaction` re-types whatever a callback throws through
 * `toPersistenceError`, which would flatten a `BackupError` into a generic
 * `TRANSACTION_ABORTED` and lose the reason the restore was refused. Returning
 * the failure keeps the control flow explicit: the caller records it, throws
 * it to abort the transaction, and re-raises the original afterwards.
 *
 * Everything here is an IndexedDB request or synchronous validation — no
 * `await` of anything else — so the transaction stays alive throughout.
 */
async function verifyWithinTransaction(
  scope: TransactionScope,
  data: BackupData,
  expected: EntityCounts,
  sampleSize: number,
  snapshotId: string,
): Promise<BackupError | undefined> {
  for (const store of BACKUP_STORE_NAMES) {
    const actual = await scope.count(store)
    if (actual !== expected[store]) {
      return new BackupError(
        'RESTORE_VERIFICATION_FAILED',
        `The restored "${store}" holds ${actual} records instead of ${expected[store]}; the restore was aborted`,
        {
          details: {
            store,
            expected: expected[store],
            actual,
            preRestoreSnapshotId: snapshotId,
          },
        },
      )
    }
  }

  // Re-prove a bounded sample through the runtime validators, so a restore is
  // never reported as successful on records that cannot be read back as the
  // records they were meant to be.
  const sampled: Record<string, readonly unknown[]> = { ...emptyBackupData() }
  for (const store of BACKUP_STORE_NAMES) {
    const keyPath = keyPathOf(store)
    const read: unknown[] = []
    for (const record of sampleOf(data[store], sampleSize)) {
      const key = (record as Record<string, unknown>)[keyPath]
      const stored = await scope.get<unknown>(store, key as IDBValidKey)
      if (stored === undefined) {
        return new BackupError(
          'RESTORE_VERIFICATION_FAILED',
          `A record written into "${store}" could not be read back; the restore was aborted`,
          { details: { store, preRestoreSnapshotId: snapshotId } },
        )
      }
      read.push(stored)
    }
    sampled[store] = read
  }

  try {
    validateBackupData(sampled as BackupData)
  } catch (cause) {
    return new BackupError(
      'RESTORE_VERIFICATION_FAILED',
      'A restored record failed validation when read back; the restore was aborted',
      { details: { preRestoreSnapshotId: snapshotId }, cause },
    )
  }

  return undefined
}

/**
 * Why a post-commit failure cannot be reported as an ordinary one.
 *
 * Every other failure in this module is a no-op: the plan was rejected, the
 * snapshot could not be taken, the transaction aborted — and in all of those
 * the working database is still the database the user had. A caller can say
 * "nothing happened, try again".
 *
 * Once the replace-all transaction has **committed**, that sentence becomes a
 * lie. The old data is gone, the payload is in, and the only route back is the
 * pre-restore snapshot. So from the commit onward there is exactly one failure
 * code, it always carries `workingDatabaseReplaced: true`, and it always names
 * the snapshot — regardless of *why* confirmation could not be completed.
 *
 * `reason` distinguishes the two ways that happens without weakening the
 * verdict:
 *
 * - `COUNT_MISMATCH` — the read succeeded and disagreed.
 * - `CONFIRMATION_UNREADABLE` — the read itself could not be performed. A
 *   connection closed by `versionchange` (another tab upgrading the schema)
 *   does exactly this: the transaction cannot even be opened. Reporting that
 *   as `TRANSACTION_ABORTED` would name the *confirmation's* transaction while
 *   implying the *restore's* had rolled back, which is precisely backwards.
 *
 * `details` stays machine-readable, as `BackupErrorDetails` requires: codes and
 * counts only. The underlying `DOMException` travels in `cause` for a
 * developer and is never turned into user-facing text.
 */
function committedButUnverifiable(
  reason: 'COUNT_MISMATCH' | 'CONFIRMATION_UNREADABLE',
  message: string,
  snapshotId: string,
  extra: Readonly<Record<string, string | number | boolean>> = {},
  cause?: unknown,
): BackupError {
  return new BackupError('RESTORE_COMMITTED_BUT_UNVERIFIABLE', message, {
    details: {
      // The two facts a caller must have to do anything useful, first.
      workingDatabaseReplaced: true,
      preRestoreSnapshotId: snapshotId,
      reason,
      ...extra,
      ...(isPersistenceError(cause) ? { persistenceCode: cause.code } : {}),
    },
    cause,
  })
}

/**
 * Step 15. A durability confirmation on a **fresh** transaction, after commit.
 *
 * Defence in depth, and deliberately *not* the first place a bad restore could
 * be caught — `verifyWithinTransaction` has already proven the same counts
 * against the same data while the transaction could still be aborted. What
 * this adds is the difference between "the transaction reported complete" and
 * "a new connection can read it".
 *
 * ## The whole phase is wrapped, not just the comparison
 *
 * The counts are the *subject* of this check, but they are not the only thing
 * that can go wrong in it. The read needs a connection, a transaction and a
 * `count` on every store, and each of those can fail on its own — most
 * plausibly because `connection.onversionchange` closed the handle when
 * another tab started an upgrade, which makes `database.transaction()` throw
 * outright.
 *
 * If that escaped uncaught it would surface as a `PersistenceError`
 * (`TRANSACTION_ABORTED`) with no `workingDatabaseReplaced` and no snapshot
 * id — indistinguishable from the pre-commit abort that leaves the old data in
 * place. A caller would tell the user nothing had happened while their
 * database had already been replaced. So every path out of this function past
 * the commit carries the same verdict.
 */
async function confirmAfterCommit(
  database: Database,
  expected: EntityCounts,
  snapshotId: string,
): Promise<void> {
  let actual: EntityCounts
  try {
    actual = await database.read(BACKUP_STORE_NAMES, async (scope) => {
      const counts: Record<string, number> = {}
      for (const store of BACKUP_STORE_NAMES) {
        counts[store] = await scope.count(store)
      }
      return counts as EntityCounts
    })
  } catch (cause) {
    throw committedButUnverifiable(
      'CONFIRMATION_UNREADABLE',
      'The restore committed, but the database could not be read back to confirm it',
      snapshotId,
      {},
      cause,
    )
  }

  for (const store of BACKUP_STORE_NAMES) {
    if (actual[store] !== expected[store]) {
      throw committedButUnverifiable(
        'COUNT_MISMATCH',
        `The restore committed, but "${store}" reads back ${actual[store]} records instead of ${expected[store]}`,
        snapshotId,
        { store, expected: expected[store], actual: actual[store] },
      )
    }
  }
}

/**
 * Steps 12–15. The destructive half.
 *
 * Takes a plan that has already proven itself. It does not re-parse a file, it
 * does not re-derive what to write, and there is no option to skip the
 * pre-restore snapshot — a "force" flag would exist for exactly one purpose,
 * which is to be used on the day it matters most.
 */
export async function applyRestore(
  database: Database,
  plan: RestorePlan,
  options: ApplyRestoreOptions = {},
): Promise<RestoreResult> {
  const target = options.targetSchemaVersion ?? database.schemaVersion
  if (plan.preview.targetSchemaVersion !== target) {
    throw new BackupError(
      'RESTORE_PRECONDITION_FAILED',
      'This restore plan was prepared for a different schema version',
      {
        details: {
          planTargetVersion: plan.preview.targetSchemaVersion,
          databaseSchemaVersion: target,
        },
      },
    )
  }

  // Step 12. Committed before anything is cleared. A failure here ends the
  // restore: the database is untouched and stays that way.
  let preRestoreSnapshot: SnapshotSummary
  try {
    preRestoreSnapshot = await createSnapshot(database, {
      kind: 'PRE_RESTORE',
      now: options.now,
      generateId: options.generateId,
    })
  } catch (cause) {
    throw new BackupError(
      'SNAPSHOT_FAILED',
      'The pre-restore snapshot could not be created, so the restore was not started',
      {
        details: isPersistenceError(cause) ? { persistenceCode: cause.code } : {},
        cause,
      },
    )
  }

  const restored = countEntities(plan.data)
  const sampleSize = options.verifySampleSize ?? 2

  // Steps 13–14. One transaction over the business stores — and only those, so
  // the snapshot written above and this installation's `meta` both survive.
  //
  // Clearing, writing **and verifying** all happen in here. Verification that
  // ran after this resolved would be verifying data that had already replaced
  // the user's; running it inside is what keeps a refused restore a genuine
  // no-op.
  //
  // The failure is carried out in a holder rather than thrown directly,
  // because the transaction boundary re-types anything a callback throws and
  // would erase the reason.
  const verification: { failure?: BackupError } = {}
  try {
    await database.write(BACKUP_STORE_NAMES, async (scope) => {
      await replaceAll(scope, plan.data)
      const failure = await verifyWithinTransaction(
        scope,
        plan.data,
        restored,
        sampleSize,
        preRestoreSnapshot.id,
      )
      if (failure !== undefined) {
        verification.failure = failure
        // Aborts the transaction: the clear and every write roll back
        // together, and the database the user had is still the database the
        // user has.
        throw failure
      }
    })
  } catch (cause) {
    if (verification.failure !== undefined) {
      throw verification.failure
    }
    throw new BackupError(
      'RESTORE_PRECONDITION_FAILED',
      'The restore transaction failed and was rolled back; the database is unchanged',
      {
        details: {
          preRestoreSnapshotId: preRestoreSnapshot.id,
          ...(cause instanceof PersistenceError ? { persistenceCode: cause.code } : {}),
        },
        cause,
      },
    )
  }

  // ── The commit has happened. Past this line "the restore failed" can only
  //    ever mean "…and the working database is already the restored data". ──
  //
  // Step 15 is a durability confirmation, not the first line of defence — see
  // `confirmAfterCommit` for why its failure code differs. The call is wrapped
  // as well as its body so that *nothing* reachable after the commit can
  // escape as a code that implies a no-op: a defect in the confirmation logic
  // itself must still be reported as a replaced database, because that is what
  // it would be.
  try {
    await confirmAfterCommit(database, restored, preRestoreSnapshot.id)
  } catch (cause) {
    if (isBackupError(cause) && cause.code === 'RESTORE_COMMITTED_BUT_UNVERIFIABLE') {
      throw cause
    }
    throw committedButUnverifiable(
      'CONFIRMATION_UNREADABLE',
      'The restore committed, but confirming it did not complete',
      preRestoreSnapshot.id,
      {},
      cause,
    )
  }

  return {
    preRestoreSnapshot,
    restored,
    totalRestoredRecords: totalRecords(restored),
    verified: true,
    preview: plan.preview,
  }
}

export type { BusinessStoreName }
