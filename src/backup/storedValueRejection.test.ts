/**
 * A value the backup format cannot represent must stop the backup, not survive
 * it in a damaged form.
 *
 * ## The failure this file exists to prevent
 *
 * `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer` and the typed arrays are all
 * **valid IndexedDB values**. The store accepts them, structured clone
 * preserves them, and they read back as themselves. Nothing in the persistence
 * layer is wrong about that.
 *
 * What was wrong was the boundary above it. The old normaliser walked every
 * object by its own enumerable properties, so a `Date` — which has none —
 * became `{}`, and a `Uint8Array` became `{ "0": 12, "1": 7 }`. That happened
 * *before* `canonicalize()` ran, so by the time the serialiser could have
 * refused, the value it was handed was a perfectly ordinary plain object. The
 * result was the worst possible outcome: a snapshot that succeeded, a backup
 * file that verified against its own checksum, and business data silently
 * gone.
 *
 * So these tests do not check an error message. They check that **no
 * checksum-bearing artifact is produced at all**, and that the database is
 * left with nothing new in it.
 *
 * ## Why the codes look layered
 *
 * Both paths do their reading inside an IndexedDB transaction, and
 * `runInTransaction` re-types whatever a callback throws through
 * `toPersistenceError`. So the surfaced error is a `PersistenceError`
 * (`TRANSACTION_ABORTED`) carrying the original `BackupError` as its `cause`.
 * That flattening is a known, separately recorded observation about the generic
 * transaction boundary; it is asserted here rather than worked around, because
 * a test that pretended the code were different would stop describing the
 * system.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../persistence/database'
import { isPersistenceError } from '../persistence/errors'
import { openTestDatabase, type TestDatabase } from '../persistence/testSupport'
import { BackupError } from './errors'
import { createBackup, exportBackup } from './externalBackup'
import { createSnapshot, listSnapshots } from './snapshots'
import { readAllStores, seedDatabase, standardSeed } from './testSupport'
import { supplierRecord } from './testSupport'

let fixture: TestDatabase
let database: Database

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
  await seedDatabase(database, standardSeed())
})

afterEach(async () => {
  await fixture.destroy()
})

/**
 * Writes a value straight into a store, past the typed helpers.
 *
 * That is not cheating: it is the only way to reproduce how such a value gets
 * in. A future store with no validator yet, a hand-edit in devtools, or a
 * later phase writing a `Date` where a string was meant — all of them land in
 * IndexedDB exactly like this, and none of them go through a parser first.
 */
async function storeRaw(store: 'settings' | 'suppliers', record: unknown): Promise<void> {
  await database.write([store], (scope) => scope.put(store, record))
}

/** The `BackupError` behind whatever the transaction boundary re-typed it as. */
function backupCause(error: unknown): BackupError | undefined {
  if (error instanceof BackupError) {
    return error
  }
  if (isPersistenceError(error) && error.cause instanceof BackupError) {
    return error.cause
  }
  return undefined
}

async function rejectionOf(run: () => Promise<unknown>): Promise<BackupError> {
  try {
    await run()
  } catch (cause) {
    const backup = backupCause(cause)
    if (backup === undefined) {
      throw new Error(`expected a BackupError, got ${String(cause)}`)
    }
    return backup
  }
  throw new Error('expected the operation to fail')
}

/** The cases that survive a structured clone as themselves. */
const UNSUPPORTED_STORED_VALUES: readonly [string, () => unknown][] = [
  ['a Date', () => new Date('2026-09-19T12:00:00.000Z')],
  ['a Map', () => new Map<string, number>([['a', 1]])],
  ['a Set', () => new Set<number>([1, 2, 3])],
  ['a RegExp', () => /abc/g],
  ['an ArrayBuffer', () => new ArrayBuffer(8)],
  ['a Uint8Array', () => new Uint8Array([12, 7])],
]

describe('a snapshot over an unsupported stored value', () => {
  for (const [label, build] of UNSUPPORTED_STORED_VALUES) {
    it(`refuses to snapshot ${label}, and writes no snapshot`, async () => {
      await storeRaw('settings', { key: 'odd', value: build() })

      const error = await rejectionOf(() => createSnapshot(database, { kind: 'MANUAL' }))
      expect(error.code).toBe('CANONICALIZATION_FAILED')

      // Nothing was recorded. A snapshot of a database this module cannot
      // represent would be a restorable-looking copy that is not one.
      expect(await listSnapshots(database)).toHaveLength(0)
    })
  }

  it('refuses when the unsupported value is nested inside a business record', async () => {
    await storeRaw('suppliers', { ...supplierRecord(77), note: new Date() } as unknown)

    const error = await rejectionOf(() => createSnapshot(database, { kind: 'PRE_RESTORE' }))
    expect(error.code).toBe('CANONICALIZATION_FAILED')
    expect(await listSnapshots(database)).toHaveLength(0)
  })

  it('leaves the working data exactly as it was', async () => {
    const before = await readAllStores(database)
    await storeRaw('settings', { key: 'odd', value: new Uint8Array([1, 2, 3]) })

    await rejectionOf(() => createSnapshot(database, { kind: 'MANUAL' }))

    const after = await readAllStores(database)
    expect(after.suppliers).toEqual(before.suppliers)
    expect(after.projects).toEqual(before.projects)
    expect(after.inventoryMovements).toEqual(before.inventoryMovements)
  })
})

describe('a backup over an unsupported stored value', () => {
  for (const [label, build] of UNSUPPORTED_STORED_VALUES) {
    it(`refuses to produce a file for ${label}`, async () => {
      await storeRaw('settings', { key: 'odd', value: build() })

      const error = await rejectionOf(() => createBackup(database))
      expect(error.code).toBe('CANONICALIZATION_FAILED')
      // The path names the store the value was found in, so a support question
      // has an answer without anyone opening devtools.
      expect(String(error.details.path)).toContain('settings')
    })
  }

  it('refuses when the unsupported value is nested inside a business record', async () => {
    await storeRaw('suppliers', { ...supplierRecord(77), note: new Map() } as unknown)
    const error = await rejectionOf(() => createBackup(database))
    expect(error.code).toBe('CANONICALIZATION_FAILED')
    expect(String(error.details.path)).toContain('suppliers')
  })

  it('never reaches delivery, so lastExternalBackupAt is not stamped', async () => {
    await storeRaw('settings', { key: 'odd', value: new Date() })

    let delivered = 0
    await rejectionOf(() =>
      exportBackup(database, {
        deliver: () => {
          delivered += 1
        },
      }),
    )

    expect(delivered).toBe(0)
    // A freshness clock moved by an export that never happened would be worse
    // than no clock at all.
    const meta = await database.read(['meta'], (scope) =>
      scope.get<{ lastExternalBackupAt?: string }>('meta', 'meta'),
    )
    expect(meta?.lastExternalBackupAt).toBeUndefined()
  })
})

describe('the same database without the unsupported value', () => {
  it('snapshots and backs up normally, so the refusal is about the value', async () => {
    const snapshot = await createSnapshot(database, { kind: 'MANUAL' })
    expect(snapshot.totalRecords).toBe(8)

    const artifact = await createBackup(database)
    expect(artifact.envelope.integrity.value).toMatch(/^[0-9a-f]{64}$/)
    expect(artifact.totalRecords).toBe(8)
  })
})
