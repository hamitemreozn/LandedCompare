/**
 * The restore itself: the destructive half.
 *
 * Four guarantees are on trial here, and each has a test that would fail if
 * the implementation merely *looked* correct:
 *
 * 1. **A preview writes nothing.** Proven by comparing every store before and
 *    after.
 * 2. **The pre-restore snapshot is committed before the restore starts.**
 *    Proven by making the snapshot fail and checking the data never moved.
 * 3. **The restore is atomic.** Proven by failing a write partway through and
 *    requiring the *old* data — not an empty database, not a half-restored
 *    one — to be intact.
 * 4. **Success means the transaction committed and the data reads back.**
 *    Proven by silently dropping writes and requiring the restore to fail
 *    anyway.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../persistence/database'
import type { TransactionScope } from '../persistence/idb'
import { SCHEMA_VERSION, type StoreName } from '../persistence/schema'
import { readMeta } from '../persistence/stores/metaStore'
import { openTestDatabase, testUuid, type TestDatabase } from '../persistence/testSupport'
import { emptyBackupData, type BackupData } from './businessData'
import { BackupError } from './errors'
import { createBackup, markExternalBackupCompleted } from './externalBackup'
import { applyRestore, prepareRestore, prepareRestoreFromSnapshot, PRESERVED_STORE_NAMES } from './restore'
import { createSnapshot, listSnapshots, readSnapshot } from './snapshots'
import {
  movementRecord,
  projectRecord,
  readAllStores,
  seedDatabase,
  standardSeed,
  supplierRecord,
} from './testSupport'

let fixture: TestDatabase
let database: Database

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
})

afterEach(async () => {
  await fixture.destroy()
})

const clock = (instant: string) => () => instant

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (cause) {
    return cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
  }
  return 'did-not-throw'
}

async function errorOf(run: () => Promise<unknown>): Promise<BackupError> {
  try {
    await run()
  } catch (cause) {
    if (cause instanceof BackupError) {
      return cause
    }
    throw cause
  }
  throw new Error('expected a BackupError')
}

/** A backup file taken from a second, independently seeded database. */
async function backupFileFrom(seed: Parameters<typeof seedDatabase>[1]): Promise<string> {
  const other = await openTestDatabase()
  try {
    await seedDatabase(other.database, seed)
    const artifact = await createBackup(other.database, { now: clock('2026-09-19T18:32:11.482Z') })
    return artifact.json
  } finally {
    await other.destroy()
  }
}

/**
 * Wraps a `Database` so writes to the *business* stores misbehave, while the
 * snapshot transaction is left alone — the two must be separable, which is
 * itself part of what these tests assert.
 *
 * The three faults model three genuinely different failures:
 *
 * - `throw` — the write fails outright, as a quota error or a rejected key
 *   would.
 * - `skip` — the write silently does not happen, and every `add()` still
 *   resolves. This is the one that a "did the requests succeed?" check cannot
 *   see.
 * - `corrupt` — the write happens, with the right key but the wrong contents,
 *   so counts match and only re-validation catches it.
 *
 * All three are injected *inside the real transaction*, so what rolls back is
 * rolled back by IndexedDB rather than by the test.
 */
function withFaultyBusinessWrites(
  base: Database,
  fault: (scope: TransactionScope, addCount: number) => 'throw' | 'skip' | 'corrupt' | 'ok',
): Database {
  return {
    ...base,
    write: <T>(stores: readonly StoreName[], work: (scope: TransactionScope) => Promise<T> | T) => {
      if (stores.includes('snapshots')) {
        return base.write(stores, work)
      }
      return base.write(stores, (scope) => {
        let adds = 0
        const wrapped: TransactionScope = {
          ...scope,
          add: async (store, value) => {
            adds += 1
            const verdict = fault(scope, adds)
            if (verdict === 'throw') {
              throw new Error('simulated write failure')
            }
            if (verdict === 'skip') {
              return
            }
            if (verdict === 'corrupt') {
              await scope.add(store, { ...(value as object), unexpectedField: 'corruption' })
              return
            }
            await scope.add(store, value)
          },
        }
        return work(wrapped)
      })
    },
  }
}

/** Wraps a `Database` so creating any snapshot fails. */
function withFailingSnapshots(base: Database): Database {
  return {
    ...base,
    write: <T>(stores: readonly StoreName[], work: (scope: TransactionScope) => Promise<T> | T) => {
      if (stores.includes('snapshots')) {
        return Promise.reject(new Error('simulated snapshot failure'))
      }
      return base.write(stores, work)
    },
  }
}

describe('prepareRestore — the preview', () => {
  it('reports what the file holds and what is about to be replaced', async () => {
    await seedDatabase(database, standardSeed())
    const suppliers = [supplierRecord(31), supplierRecord(32), supplierRecord(33)]
    const file = await backupFileFrom({
      suppliers,
      projects: [projectRecord(40, [suppliers[0]!.id])],
      inventoryMovements: [movementRecord(50), movementRecord(51), movementRecord(52)],
    })

    const plan = await prepareRestore(database, file)

    expect(plan.preview.source).toBe('FILE')
    expect(plan.preview.createdAt).toBe('2026-09-19T18:32:11.482Z')
    expect(plan.preview.backupSchemaVersion).toBe(SCHEMA_VERSION)
    expect(plan.preview.targetSchemaVersion).toBe(SCHEMA_VERSION)
    expect(plan.preview.incoming.suppliers).toBe(3)
    expect(plan.preview.incoming.projects).toBe(1)
    expect(plan.preview.incoming.inventoryMovements).toBe(3)
    expect(plan.preview.current.suppliers).toBe(2)
    expect(plan.preview.current.inventoryMovements).toBe(2)
    expect(plan.preview.totalIncomingRecords).toBe(7)
    expect(plan.preview.totalCurrentRecords).toBe(8)
    expect(plan.preview.preservedStores).toEqual([...PRESERVED_STORE_NAMES])
  })

  it('recomputes the counts from the payload rather than trusting the manifest', async () => {
    const file = await backupFileFrom({ suppliers: [supplierRecord(31), supplierRecord(32)] })
    const plan = await prepareRestore(database, file)
    expect(plan.preview.incoming.suppliers).toBe(plan.data.suppliers.length)
  })

  it('mutates nothing, including the snapshot store', async () => {
    await seedDatabase(database, standardSeed())
    await createSnapshot(database, { kind: 'MANUAL' })
    const before = await readAllStores(database)
    const snapshotsBefore = await listSnapshots(database)
    const metaBefore = await readMeta(database)

    await prepareRestore(database, await backupFileFrom({ suppliers: [supplierRecord(31)] }))

    expect(await readAllStores(database)).toEqual(before)
    expect(await listSnapshots(database)).toEqual(snapshotsBefore)
    expect(await readMeta(database)).toEqual(metaBefore)
  })

  it('accepts a Blob as well as a string', async () => {
    const file = await backupFileFrom({ suppliers: [supplierRecord(31)] })
    const blob = { size: new TextEncoder().encode(file).byteLength, text: async () => file }
    const plan = await prepareRestore(database, blob)
    expect(plan.preview.incoming.suppliers).toBe(1)
  })
})

describe('applyRestore — the happy path', () => {
  it('replaces everything and verifies the result', async () => {
    await seedDatabase(database, standardSeed())
    const suppliers = [supplierRecord(31), supplierRecord(32), supplierRecord(33)]
    const file = await backupFileFrom({
      suppliers,
      projects: [projectRecord(40, [suppliers[0]!.id])],
      inventoryMovements: [movementRecord(50)],
      settings: [{ key: 'locale', value: 'en' }],
      counters: [{ key: 'PO', nextValue: 42 }],
    })

    const plan = await prepareRestore(database, file)
    const result = await applyRestore(database, plan, { now: clock('2026-09-20T09:00:00.000Z') })

    expect(result.verified).toBe(true)
    expect(result.restored.suppliers).toBe(3)
    expect(result.totalRestoredRecords).toBe(7)

    const after = await readAllStores(database)
    expect(after.suppliers).toHaveLength(3)
    expect(after.projects).toHaveLength(1)
    expect(after.inventoryMovements).toHaveLength(1)
    expect((after.counters[0] as { nextValue: number }).nextValue).toBe(42)
    // The seeded records are gone — this is replace-all, not merge.
    expect(after.suppliers.map((record) => (record as { id: string }).id)).not.toContain(testUuid(1))
  })

  it('keeps decimal strings character-exact through a full restore', async () => {
    const file = await backupFileFrom({
      inventoryMovements: [
        movementRecord(50, { quantity: { value: '0.000001' } }),
        movementRecord(51, { quantity: { value: '99999999.999999' } }),
      ],
    })
    await applyRestore(database, await prepareRestore(database, file))

    const after = await readAllStores(database)
    const values = (after.inventoryMovements as { quantity: { value: string } }[])
      .map((record) => record.quantity.value)
      .sort()
    expect(values).toEqual(['0.000001', '99999999.999999'])
  })

  it('restores an empty backup, which is a legitimate state', async () => {
    await seedDatabase(database, standardSeed())
    const file = await backupFileFrom({})

    const result = await applyRestore(database, await prepareRestore(database, file))

    expect(result.totalRestoredRecords).toBe(0)
    expect(await readAllStores(database)).toEqual(emptyBackupData())
  })

  it('is deterministic when repeated', async () => {
    await seedDatabase(database, standardSeed())
    const file = await backupFileFrom({
      suppliers: [supplierRecord(31), supplierRecord(32)],
      inventoryMovements: [movementRecord(50)],
    })

    await applyRestore(database, await prepareRestore(database, file))
    const first = await readAllStores(database)
    await applyRestore(database, await prepareRestore(database, file))
    const second = await readAllStores(database)

    expect(second).toEqual(first)
  })
})

describe('applyRestore — the pre-restore snapshot', () => {
  it('commits a PRE_RESTORE snapshot of the OLD data before replacing it', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)
    const file = await backupFileFrom({ suppliers: [supplierRecord(31)] })

    const result = await applyRestore(database, await prepareRestore(database, file), {
      now: clock('2026-09-20T09:00:00.000Z'),
    })

    expect(result.preRestoreSnapshot.kind).toBe('PRE_RESTORE')
    const snapshot = await readSnapshot(database, result.preRestoreSnapshot.id)
    // The snapshot holds what the database looked like *before* the restore.
    expect(snapshot.payload).toEqual(before)
  })

  it('survives the restore transaction, because that transaction never touches snapshots', async () => {
    await seedDatabase(database, standardSeed())
    const existing = await createSnapshot(database, { kind: 'MANUAL' })
    const file = await backupFileFrom({ suppliers: [supplierRecord(31)] })

    const result = await applyRestore(database, await prepareRestore(database, file))

    const snapshots = await listSnapshots(database)
    const ids = snapshots.map((entry) => entry.id)
    expect(ids).toContain(result.preRestoreSnapshot.id)
    expect(ids).toContain(existing.id)
  })

  it('refuses to restore at all when the snapshot cannot be taken', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)
    const file = await backupFileFrom({ suppliers: [supplierRecord(31)] })
    const plan = await prepareRestore(database, file)

    const faulty = withFailingSnapshots(database)
    expect(await codeOf(() => applyRestore(faulty, plan))).toBe('SNAPSHOT_FAILED')

    // Not one record moved.
    expect(await readAllStores(database)).toEqual(before)
  })

  it('can itself be restored, which is the whole point of taking it', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)
    const file = await backupFileFrom({ suppliers: [supplierRecord(31)] })

    const result = await applyRestore(database, await prepareRestore(database, file))
    expect(await readAllStores(database)).not.toEqual(before)

    const undo = await prepareRestoreFromSnapshot(database, result.preRestoreSnapshot.id)
    expect(undo.preview.source).toBe('SNAPSHOT')
    await applyRestore(database, undo)

    expect(await readAllStores(database)).toEqual(before)
  })
})

describe('applyRestore — atomicity', () => {
  it('leaves the old database completely intact when a write fails partway', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)
    const file = await backupFileFrom({
      suppliers: [supplierRecord(31), supplierRecord(32), supplierRecord(33)],
      inventoryMovements: [movementRecord(50), movementRecord(51)],
    })
    const plan = await prepareRestore(database, file)

    // Fails on the third write, i.e. after `clear()` has run on every store
    // and some records have already landed. Without one transaction this is
    // the moment the database would be left empty or half-restored.
    const faulty = withFaultyBusinessWrites(database, (_, adds) => (adds === 3 ? 'throw' : 'ok'))
    expect(await codeOf(() => applyRestore(faulty, plan))).toBe('RESTORE_PRECONDITION_FAILED')

    expect(await readAllStores(database)).toEqual(before)
  })

  it('leaves the old database intact when IndexedDB itself rejects a record', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)

    // A hand-built plan carrying a record with no `id`, so the store's keyPath
    // cannot be satisfied and the request fails at the IndexedDB level — a
    // real failure, not an injected one.
    const data = { ...emptyBackupData(), suppliers: [{ displayName: 'no id here' }] } as BackupData
    const plan = {
      data,
      preview: {
        source: 'FILE' as const,
        createdAt: '2026-09-19T18:32:11.482Z',
        appVersion: '0.8.0',
        backupSchemaVersion: SCHEMA_VERSION,
        targetSchemaVersion: SCHEMA_VERSION,
        migrationsApplied: [],
        incoming: { ...emptyBackupData(), suppliers: [] } as never,
        current: { ...emptyBackupData(), suppliers: [] } as never,
        totalIncomingRecords: 1,
        totalCurrentRecords: 0,
        preservedStores: [...PRESERVED_STORE_NAMES],
      },
    }

    expect(await codeOf(() => applyRestore(database, plan))).toBe('RESTORE_PRECONDITION_FAILED')
    expect(await readAllStores(database)).toEqual(before)
  })

  it('names the pre-restore snapshot in the failure, so recovery is possible', async () => {
    await seedDatabase(database, standardSeed())
    const plan = await prepareRestore(database, await backupFileFrom({ suppliers: [supplierRecord(31)] }))
    const faulty = withFaultyBusinessWrites(database, (_, adds) => (adds === 1 ? 'throw' : 'ok'))

    const error = await errorOf(() => applyRestore(faulty, plan))
    expect(typeof error.details.preRestoreSnapshotId).toBe('string')
    await expect(readSnapshot(database, error.details.preRestoreSnapshotId as string)).resolves.toBeTruthy()
  })
})

describe('applyRestore — verification', () => {
  it('fails when the data does not read back, even though every write "succeeded"', async () => {
    await seedDatabase(database, standardSeed())
    const file = await backupFileFrom({
      suppliers: [supplierRecord(31), supplierRecord(32), supplierRecord(33)],
    })
    const plan = await prepareRestore(database, file)

    // Writes are silently dropped rather than failing: every `add()` resolves
    // and nothing throws. Only reading the data back catches it — which is the
    // difference between "requests were issued" and "the restore worked".
    const faulty = withFaultyBusinessWrites(database, (_, adds) => (adds > 1 ? 'skip' : 'ok'))
    const error = await errorOf(() => applyRestore(faulty, plan))

    expect(error.code).toBe('RESTORE_VERIFICATION_FAILED')
    expect(error.details.store).toBe('suppliers')
    expect(error.details.expected).toBe(3)
    expect(error.details.actual).toBe(1)
    expect(typeof error.details.preRestoreSnapshotId).toBe('string')
  })

  /**
   * The contract test. A verification failure must be a **no-op**, not a
   * recoverable accident.
   *
   * The failure is injected between the writes and the commit: records are
   * silently dropped, so by the time verification runs the transaction has
   * already cleared every store and written a partial payload. If verification
   * lived after `Database.write` resolved — i.e. after the commit — the
   * database at this point would be that partial payload, and the pre-restore
   * snapshot would be the only way back. Running it inside the transaction
   * turns the same discovery into an abort.
   *
   * This uses real IndexedDB transaction semantics: `fake-indexeddb` performs
   * an actual abort and rolls the cleared stores back. Nothing here is a
   * boolean stand-in for atomicity.
   */
  it('leaves the working database EXACTLY as it was when verification fails', async () => {
    await seedDatabase(database, standardSeed())
    const beforeA = await readAllStores(database)
    expect(beforeA.suppliers).toHaveLength(2)
    expect(beforeA.projects).toHaveLength(1)
    expect(beforeA.inventoryMovements).toHaveLength(2)

    const payloadB = {
      suppliers: [supplierRecord(31), supplierRecord(32), supplierRecord(33)],
      inventoryMovements: [movementRecord(50), movementRecord(51)],
    }
    const plan = await prepareRestore(database, await backupFileFrom(payloadB))

    // Everything after the first write is dropped: the transaction clears all
    // stores, writes one record, and is then asked to verify.
    const faulty = withFaultyBusinessWrites(database, (_, adds) => (adds > 1 ? 'skip' : 'ok'))
    const error = await errorOf(() => applyRestore(faulty, plan))
    expect(error.code).toBe('RESTORE_VERIFICATION_FAILED')

    const afterA = await readAllStores(database)

    // Not B.
    expect(afterA.suppliers.map((record) => (record as { id: string }).id)).not.toContain(
      payloadB.suppliers[0]!.id,
    )
    // Not empty.
    expect(afterA.suppliers.length).toBeGreaterThan(0)
    // Not partially restored — the single record that did get written is gone
    // too, because `clear()` and that write rolled back together.
    expect(afterA.suppliers).toHaveLength(2)
    expect(afterA.projects).toHaveLength(1)
    expect(afterA.inventoryMovements).toHaveLength(2)
    // Exactly A, record for record.
    expect(afterA).toEqual(beforeA)

    // And the extra safety layer is still there on top of the no-op.
    const snapshotId = error.details.preRestoreSnapshotId as string
    const snapshot = await readSnapshot(database, snapshotId)
    expect(snapshot.kind).toBe('PRE_RESTORE')
    expect(snapshot.payload).toEqual(beforeA)
  })

  it('leaves the database untouched when a sampled record fails re-validation', async () => {
    await seedDatabase(database, standardSeed())
    const beforeA = await readAllStores(database)
    const plan = await prepareRestore(
      database,
      await backupFileFrom({ suppliers: [supplierRecord(31), supplierRecord(32)] }),
    )

    // The record written is not the record the plan says was written, so the
    // count is right and only re-validation can catch it.
    const faulty = withFaultyBusinessWrites(database, () => 'corrupt')
    const error = await errorOf(() => applyRestore(faulty, plan, { verifySampleSize: 100 }))

    expect(error.code).toBe('RESTORE_VERIFICATION_FAILED')
    expect(await readAllStores(database)).toEqual(beforeA)
  })

  it('re-validates restored records, not just their number', async () => {
    const file = await backupFileFrom({ suppliers: [supplierRecord(31), supplierRecord(32)] })
    const plan = await prepareRestore(database, file)
    const result = await applyRestore(database, plan, { verifySampleSize: 100 })
    expect(result.verified).toBe(true)
  })

  it('refuses a plan prepared for a different schema version', async () => {
    const plan = await prepareRestore(database, await backupFileFrom({ suppliers: [supplierRecord(31)] }))
    const shifted = { ...plan, preview: { ...plan.preview, targetSchemaVersion: 9 } }
    expect(await codeOf(() => applyRestore(database, shifted))).toBe('RESTORE_PRECONDITION_FAILED')
  })
})

/**
 * The other side of the commit.
 *
 * Everything above this block is a no-op on failure: the transaction aborted,
 * the old data is intact, and a caller may truthfully say nothing happened.
 * Once the replace-all transaction has committed, that sentence is false — and
 * the single thing a caller must never be told at that point is anything that
 * sounds like the failures above.
 *
 * Two ways confirmation fails, one verdict:
 *
 * 1. the fresh read succeeds and the counts disagree;
 * 2. the fresh read cannot be performed at all — the case this block adds,
 *    modelled on the real one: `connection.onversionchange` closes the handle
 *    when another tab upgrades the schema, so opening a transaction on it
 *    throws before a single `count` is issued.
 *
 * Both must report `RESTORE_COMMITTED_BUT_UNVERIFIABLE`, carry
 * `workingDatabaseReplaced: true` and name the snapshot — and, in both, the
 * database on disk must actually hold B.
 */
describe('applyRestore — failing after the commit', () => {
  /** What B looks like, so "the commit landed" is checkable from outside. */
  function payloadB() {
    return {
      suppliers: [supplierRecord(31), supplierRecord(32), supplierRecord(33)],
      inventoryMovements: [movementRecord(50)],
    }
  }

  /**
   * Closes the real connection the instant the restore transaction commits —
   * which is exactly what `versionchange` does when another tab starts an
   * upgrade, and is the reason this failure is reachable at all.
   *
   * The snapshot transaction is left alone, so the pre-restore snapshot is
   * genuinely written and genuinely survives.
   */
  function withConnectionLostAfterCommit(base: Database): Database {
    return {
      ...base,
      write: async <T>(
        stores: readonly StoreName[],
        work: (scope: TransactionScope) => Promise<T> | T,
      ) => {
        const result = await base.write(stores, work)
        if (!stores.includes('snapshots')) {
          base.close()
        }
        return result
      },
    }
  }

  /** Reads a database by name on a fresh connection, after the fixture's is gone. */
  async function reopenAndRead(name: string): Promise<BackupData> {
    const reopened = await openDatabase({ name })
    try {
      return await readAllStores(reopened)
    } finally {
      reopened.close()
    }
  }

  it('reports the working database as REPLACED when the confirmation read itself fails', async () => {
    await seedDatabase(database, standardSeed())
    const plan = await prepareRestore(database, await backupFileFrom(payloadB()))

    const lossy = withConnectionLostAfterCommit(database)
    const error = await errorOf(() => applyRestore(lossy, plan))

    expect(error.code).toBe('RESTORE_COMMITTED_BUT_UNVERIFIABLE')
    expect(error.details.workingDatabaseReplaced).toBe(true)
    expect(typeof error.details.preRestoreSnapshotId).toBe('string')
    expect(error.details.reason).toBe('CONFIRMATION_UNREADABLE')
    // The underlying cause is kept as a machine-readable code, never as raw
    // `DOMException` text — and its presence is what proves the read genuinely
    // failed at the storage layer rather than merely disagreeing.
    expect(error.details.persistenceCode).toBe('TRANSACTION_ABORTED')
    for (const value of Object.values(error.details)) {
      expect(typeof value).not.toBe('object')
    }

    // And the claim is true: B is what a fresh connection finds on disk.
    const after = await reopenAndRead(fixture.name)
    expect(after.suppliers).toHaveLength(3)
    expect(after.inventoryMovements).toHaveLength(1)
    expect(after.projects).toHaveLength(0)
    expect(after.suppliers.map((record) => (record as { id: string }).id)).toContain(
      payloadB().suppliers[0]!.id,
    )
    // Not A.
    expect(after.suppliers.map((record) => (record as { id: string }).id)).not.toContain(
      testUuid(1),
    )
  })

  it('leaves the pre-restore snapshot readable, because it is the only way back', async () => {
    await seedDatabase(database, standardSeed())
    const beforeA = await readAllStores(database)
    const plan = await prepareRestore(database, await backupFileFrom(payloadB()))

    const error = await errorOf(() =>
      applyRestore(withConnectionLostAfterCommit(database), plan),
    )
    const snapshotId = error.details.preRestoreSnapshotId as string

    const reopened = await openDatabase({ name: fixture.name })
    try {
      const snapshot = await readSnapshot(reopened, snapshotId)
      expect(snapshot.kind).toBe('PRE_RESTORE')
      expect(snapshot.payload).toEqual(beforeA)
    } finally {
      reopened.close()
    }
  })

  it('reports the same verdict when the confirmation read succeeds but disagrees', async () => {
    await seedDatabase(database, standardSeed())
    const plan = await prepareRestore(database, await backupFileFrom(payloadB()))

    // The restore transaction commits untouched — `verifyWithinTransaction`
    // sees the right counts and lets it through. Only the *post-commit* read
    // is made to disagree, which is the one state the in-transaction check
    // cannot catch.
    const drifting: Database = {
      ...database,
      read: <T>(stores: readonly StoreName[], work: (scope: TransactionScope) => Promise<T> | T) =>
        database.read(stores, (scope) =>
          work({
            ...scope,
            count: async (store) => (store === 'suppliers' ? 0 : scope.count(store)),
          }),
        ),
    }

    const error = await errorOf(() => applyRestore(drifting, plan))

    expect(error.code).toBe('RESTORE_COMMITTED_BUT_UNVERIFIABLE')
    expect(error.details.workingDatabaseReplaced).toBe(true)
    expect(error.details.reason).toBe('COUNT_MISMATCH')
    expect(error.details.store).toBe('suppliers')
    expect(error.details.expected).toBe(3)
    expect(error.details.actual).toBe(0)
    expect(typeof error.details.preRestoreSnapshotId).toBe('string')

    // B did commit, so the emergency code is telling the truth.
    expect((await readAllStores(database)).suppliers).toHaveLength(3)
  })

  it('never reports a committed restore with a code that implies a no-op', async () => {
    await seedDatabase(database, standardSeed())
    const plan = await prepareRestore(database, await backupFileFrom(payloadB()))

    const error = await errorOf(() =>
      applyRestore(withConnectionLostAfterCommit(database), plan),
    )

    // The two codes that mean "your data is untouched" must be unreachable
    // from here. Confusing them is what would make a user re-run a restore
    // over a database that had already been replaced.
    expect(error.code).not.toBe('RESTORE_VERIFICATION_FAILED')
    expect(error.code).not.toBe('RESTORE_PRECONDITION_FAILED')
  })
})

describe('applyRestore — what it deliberately does not touch', () => {
  it('keeps this installation’s identity rather than importing the file’s', async () => {
    await seedDatabase(database, standardSeed())
    const metaBefore = await readMeta(database)
    const file = await backupFileFrom({ suppliers: [supplierRecord(31)] })
    // The file was written by a different installation.
    const { manifest } = await prepareRestore(database, file).then((plan) => plan)
    expect(manifest?.installId).not.toBe(metaBefore.installId)

    await applyRestore(database, await prepareRestore(database, file))

    const metaAfter = await readMeta(database)
    expect(metaAfter.installId).toBe(metaBefore.installId)
    expect(metaAfter.createdAt).toBe(metaBefore.createdAt)
    expect(metaAfter.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('does not reset the local external-backup clock', async () => {
    await markExternalBackupCompleted(database, { at: '2026-09-10T08:00:00.000Z' })
    const file = await backupFileFrom({ suppliers: [supplierRecord(31)] })

    await applyRestore(database, await prepareRestore(database, file))

    // The staleness warning keeps counting from this machine's last export,
    // not from whenever the restored file happened to be written.
    expect((await readMeta(database)).lastExternalBackupAt).toBe('2026-09-10T08:00:00.000Z')
  })

  it('does not clear the snapshot store', async () => {
    await seedDatabase(database, standardSeed())
    const manual = await createSnapshot(database, { kind: 'MANUAL' })
    const daily = await createSnapshot(database, { kind: 'DAILY' })

    await applyRestore(database, await prepareRestore(database, await backupFileFrom({})))

    const ids = (await listSnapshots(database)).map((entry) => entry.id)
    expect(ids).toContain(manual.id)
    expect(ids).toContain(daily.id)
  })
})
