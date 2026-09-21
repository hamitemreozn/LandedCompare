/**
 * Internal snapshots, against a real IndexedDB implementation.
 *
 * The property that matters most here is **coherence**: a snapshot must be a
 * state the database actually had, not a stitched-together sequence of reads.
 * The test for it writes into the database *while* a snapshot is in flight,
 * which is the only way to tell a one-transaction implementation from one that
 * merely looks like one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../persistence/database'
import { SCHEMA_VERSION } from '../persistence/schema'
import { openTestDatabase, testUuid, type TestDatabase } from '../persistence/testSupport'
import { BackupError } from './errors'
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  parseSnapshotMetadata,
  readSnapshot,
} from './snapshots'
import { ensureDailySnapshot, applyRetention, runSnapshotMaintenance, utcDay } from './maintenance'
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

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (cause) {
    return cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
  }
  return 'did-not-throw'
}

const clock = (instant: string) => () => instant

describe('createSnapshot', () => {
  it('captures every business store and records why it was taken', async () => {
    await seedDatabase(database, standardSeed())

    const summary = await createSnapshot(database, {
      kind: 'MANUAL',
      now: clock('2026-09-19T12:00:00.000Z'),
    })

    expect(summary.kind).toBe('MANUAL')
    expect(summary.createdAt).toBe('2026-09-19T12:00:00.000Z')
    expect(summary.schemaVersion).toBe(SCHEMA_VERSION)
    expect(summary.entityCounts.suppliers).toBe(2)
    expect(summary.entityCounts.projects).toBe(1)
    expect(summary.entityCounts.inventoryMovements).toBe(2)
    expect(summary.entityCounts.settings).toBe(2)
    expect(summary.entityCounts.counters).toBe(1)
    expect(summary.sizeBytes).toBeGreaterThan(0)
    expect(summary.totalRecords).toBe(8)
  })

  it('stores each of the five kinds', async () => {
    for (const kind of ['MANUAL', 'DAILY', 'PRE_MIGRATION', 'PRE_IMPORT', 'PRE_RESTORE'] as const) {
      const summary = await createSnapshot(database, { kind })
      expect(summary.kind).toBe(kind)
    }
    const listed = await listSnapshots(database)
    expect(listed.map((entry) => entry.kind).sort()).toEqual(
      ['DAILY', 'MANUAL', 'PRE_IMPORT', 'PRE_MIGRATION', 'PRE_RESTORE'].sort(),
    )
  })

  it('round-trips its payload exactly, decimal strings included', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)

    const summary = await createSnapshot(database, { kind: 'MANUAL' })
    const stored = await readSnapshot(database, summary.id)

    expect(stored.payload).toEqual(before)
    const movement = stored.payload.inventoryMovements[0] as { quantity: { value: string } }
    // Character-exact, not "numerically close".
    expect(movement.quantity.value).toBe('12.345')
    const project = stored.payload.projects[0] as {
      quotes: { items: { quotedUnitPrice: { amount: string } }[] }[]
    }
    expect(project.quotes[0]!.items[0]!.quotedUnitPrice.amount).toBe('3.335')
  })

  it('captures one coherent state even when writes land during the snapshot', async () => {
    const suppliers = [supplierRecord(1), supplierRecord(2)]
    await seedDatabase(database, {
      suppliers,
      projects: [projectRecord(10, [suppliers[0]!.id, suppliers[1]!.id])],
    })

    // A concurrent write, issued without awaiting, racing the snapshot. If the
    // snapshot read its stores in separate transactions, it could capture the
    // new supplier but the old project list — a state that never existed.
    const concurrentWrite = seedDatabase(database, {
      suppliers: [supplierRecord(3)],
      projects: [projectRecord(11, [suppliers[0]!.id])],
    })
    const snapshotPromise = createSnapshot(database, { kind: 'MANUAL' })

    const [summary] = await Promise.all([snapshotPromise, concurrentWrite])
    const stored = await readSnapshot(database, summary.id)

    // Whichever transaction won, the snapshot's suppliers and projects agree
    // with each other: either both are pre-write, or both are post-write.
    const supplierCount = stored.payload.suppliers.length
    const projectCount = stored.payload.projects.length
    expect([
      [2, 1],
      [3, 2],
    ]).toContainEqual([supplierCount, projectCount])

    // And every supplier a stored project references actually exists in the
    // same snapshot — the invariant a torn read would break.
    const ids = new Set(stored.payload.suppliers.map((record) => (record as { id: string }).id))
    for (const project of stored.payload.projects as { supplierIds: string[] }[]) {
      for (const supplierId of project.supplierIds) {
        expect(ids.has(supplierId)).toBe(true)
      }
    }
  })

  it('does not modify business data', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)

    await createSnapshot(database, { kind: 'MANUAL' })
    await createSnapshot(database, { kind: 'DAILY' })

    expect(await readAllStores(database)).toEqual(before)
  })

  it('lists newest first without loading payloads', async () => {
    await createSnapshot(database, { kind: 'DAILY', now: clock('2026-09-17T08:00:00.000Z') })
    await createSnapshot(database, { kind: 'MANUAL', now: clock('2026-09-19T08:00:00.000Z') })
    await createSnapshot(database, { kind: 'MANUAL', now: clock('2026-09-18T08:00:00.000Z') })

    const listed = await listSnapshots(database)
    expect(listed.map((entry) => entry.createdAt)).toEqual([
      '2026-09-19T08:00:00.000Z',
      '2026-09-18T08:00:00.000Z',
      '2026-09-17T08:00:00.000Z',
    ])
    expect(listed[0]).not.toHaveProperty('payload')
  })

  it('refuses a snapshot record that has been tampered with', () => {
    expect(() => parseSnapshotMetadata({ id: 'nope' })).toThrow(BackupError)
    expect(() =>
      parseSnapshotMetadata({
        id: testUuid(1),
        kind: 'SOMETHING_ELSE',
        createdAt: '2026-09-19T12:00:00.000Z',
        schemaVersion: 1,
        appVersion: '0.8.0',
        entityCounts: {},
        sizeBytes: 1,
        payload: {},
      }),
    ).toThrow(BackupError)
  })

  it('refuses to delete a non-MANUAL snapshot when the caller restricts the kinds', async () => {
    const manual = await createSnapshot(database, { kind: 'MANUAL' })
    const preRestore = await createSnapshot(database, { kind: 'PRE_RESTORE' })

    expect(
      await codeOf(() => deleteSnapshot(database, preRestore.id, { allowKinds: ['MANUAL'] })),
    ).toBe('RESTORE_PRECONDITION_FAILED')
    await deleteSnapshot(database, manual.id, { allowKinds: ['MANUAL'] })

    const remaining = await listSnapshots(database)
    expect(remaining.map((entry) => entry.id)).toEqual([preRestore.id])
  })
})

describe('ensureDailySnapshot', () => {
  it('creates one on the first call of the day', async () => {
    const result = await ensureDailySnapshot(database, { now: clock('2026-09-19T09:00:00.000Z') })
    expect(result).toMatchObject({ created: true, reason: 'CREATED', day: '2026-09-19' })
    expect(await listSnapshots(database)).toHaveLength(1)
  })

  it('does nothing on later calls the same day', async () => {
    await ensureDailySnapshot(database, { now: clock('2026-09-19T09:00:00.000Z') })
    const second = await ensureDailySnapshot(database, { now: clock('2026-09-19T17:45:00.000Z') })
    const third = await ensureDailySnapshot(database, { now: clock('2026-09-19T23:59:59.999Z') })

    expect(second.created).toBe(false)
    expect(second.reason).toBe('ALREADY_EXISTS_TODAY')
    expect(third.created).toBe(false)
    expect(await listSnapshots(database)).toHaveLength(1)
  })

  it('creates a new one the next day', async () => {
    await ensureDailySnapshot(database, { now: clock('2026-09-19T09:00:00.000Z') })
    await ensureDailySnapshot(database, { now: clock('2026-09-20T09:00:00.000Z') })
    const listed = await listSnapshots(database)
    expect(listed).toHaveLength(2)
    expect(listed.map((entry) => utcDay(entry.createdAt))).toEqual(['2026-09-20', '2026-09-19'])
  })

  it('is not confused by snapshots of other kinds taken the same day', async () => {
    await createSnapshot(database, { kind: 'MANUAL', now: clock('2026-09-19T08:00:00.000Z') })
    const result = await ensureDailySnapshot(database, { now: clock('2026-09-19T09:00:00.000Z') })
    expect(result.created).toBe(true)
  })
})

describe('applyRetention against the database', () => {
  it('prunes down to the daily allowance and keeps the newest', async () => {
    for (let day = 1; day <= 12; day += 1) {
      const date = `2026-09-${String(day).padStart(2, '0')}`
      await createSnapshot(database, { kind: 'DAILY', now: clock(`${date}T08:00:00.000Z`) })
    }

    const result = await applyRetention(database, {
      now: clock('2026-09-12T12:00:00.000Z'),
      quotaBytes: 10 * 1024 * 1024 * 1024,
    })

    const remaining = await listSnapshots(database)
    expect(remaining.length).toBeLessThan(12)
    expect(remaining[0]!.createdAt).toBe('2026-09-12T08:00:00.000Z')
    expect(result.prunedIds.length).toBe(12 - remaining.length)
  })

  it('never prunes the newest PRE_RESTORE snapshot, even under the quota ceiling', async () => {
    await seedDatabase(database, standardSeed())
    const preRestore = await createSnapshot(database, {
      kind: 'PRE_RESTORE',
      now: clock('2026-09-01T08:00:00.000Z'),
    })
    for (let day = 2; day <= 9; day += 1) {
      await createSnapshot(database, {
        kind: 'DAILY',
        now: clock(`2026-09-0${day}T08:00:00.000Z`),
      })
    }

    // A ceiling of effectively zero: everything prunable must go.
    const result = await applyRetention(database, {
      now: clock('2026-09-09T12:00:00.000Z'),
      quotaBytes: 1,
    })

    expect(result.overCeiling).toBe(true)
    expect(result.protectedIds).toContain(preRestore.id)
    const remaining = await listSnapshots(database)
    expect(remaining.map((entry) => entry.id)).toEqual([preRestore.id])
  })

  it('still applies the per-kind policy when the browser will not estimate quota', async () => {
    for (let day = 1; day <= 10; day += 1) {
      const date = `2026-09-${String(day).padStart(2, '0')}`
      await createSnapshot(database, { kind: 'DAILY', now: clock(`${date}T08:00:00.000Z`) })
    }

    // `navigator.storage.estimate` is absent in this environment, so the
    // ceiling simply does not apply — and nothing fails because of it.
    const result = await applyRetention(database, { now: clock('2026-09-10T12:00:00.000Z') })

    expect(result.quotaKnown).toBe(false)
    expect(result.ceilingBytes).toBeUndefined()
    expect(result.overCeiling).toBe(false)
    expect(result.prunedIds.length).toBeGreaterThan(0)
    expect((await listSnapshots(database)).length).toBeLessThan(10)
  })
})

describe('runSnapshotMaintenance', () => {
  it('takes the daily snapshot and enforces retention in one pass', async () => {
    await seedDatabase(database, standardSeed())
    for (let day = 1; day <= 9; day += 1) {
      await createSnapshot(database, { kind: 'DAILY', now: clock(`2026-09-0${day}T08:00:00.000Z`) })
    }

    const result = await runSnapshotMaintenance(database, {
      now: clock('2026-09-19T08:00:00.000Z'),
    })

    expect(result.daily.created).toBe(true)
    expect(result.retention.prunedIds.length).toBeGreaterThan(0)
    const remaining = await listSnapshots(database)
    expect(remaining[0]!.createdAt).toBe('2026-09-19T08:00:00.000Z')
  })

  it('leaves business data untouched', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)
    await runSnapshotMaintenance(database, { now: clock('2026-09-19T08:00:00.000Z') })
    expect(await readAllStores(database)).toEqual(before)
  })
})

describe('snapshot payload validation', () => {
  it('rejects a snapshot whose payload was corrupted in place', async () => {
    await seedDatabase(database, standardSeed())
    const summary = await createSnapshot(database, { kind: 'MANUAL' })

    // Simulate a hand-edit through devtools: a stored snapshot is untrusted
    // data like anything else read back out of IndexedDB.
    await database.write(['snapshots'], async (scope) => {
      const stored = (await scope.get<Record<string, unknown>>('snapshots', summary.id))!
      const payload = stored.payload as Record<string, unknown[]>
      payload.inventoryMovements = [{ ...movementRecord(20), quantity: { value: '-5' } }]
      await scope.put('snapshots', stored)
    })

    expect(await codeOf(() => readSnapshot(database, summary.id))).toBe('BACKUP_RECORD_INVALID')
  })

  it('rejects an unknown snapshot id', async () => {
    expect(await codeOf(() => readSnapshot(database, testUuid(4242)))).toBe('SNAPSHOT_INVALID')
  })
})
