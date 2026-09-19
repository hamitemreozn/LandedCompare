import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSupplier } from '../../domain/supplier/Supplier'
import type { Database } from '../database'
import { toRuntimeSupplier, toSupplierRecord, type SupplierRecord } from '../records/supplier'
import { SCHEMA_VERSION } from '../schema'
import { openTestDatabase, TEST_INSTANT, testUuid, type TestDatabase } from '../testSupport'
import { readMeta } from './metaStore'
import { deleteSetting, readAllSettings, readSetting, writeSetting } from './settingsStore'
import {
  listSupplierRecords,
  loadSupplier,
  loadSupplierRecord,
  saveSupplier,
} from './supplierStore'

let fixture: TestDatabase
let database: Database

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
})

afterEach(async () => {
  await fixture.destroy()
})

function record(seed: number, overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    ...toSupplierRecord(createSupplier({ id: testUuid(seed), displayName: `Supplier ${seed}` }), {
      active: true,
      createdAt: TEST_INSTANT,
      updatedAt: TEST_INSTANT,
    }),
    ...overrides,
  }
}

describe('supplier master', () => {
  it('round-trips a record and rebuilds the runtime shape the engine expects', async () => {
    await saveSupplier(database, record(1, { note: 'İstanbul merkezli' }))

    const stored = await loadSupplierRecord(database, testUuid(1))
    expect(stored.note).toBe('İstanbul merkezli')
    expect(stored.active).toBe(true)

    const runtime = await loadSupplier(database, testUuid(1))
    // The domain type is deliberately narrower than the record: operational
    // fields stay in persistence and never reach the comparison engine.
    expect(Object.keys(runtime).sort()).toEqual(['displayName', 'id'])
    expect(runtime).toEqual(toRuntimeSupplier(stored))
  })

  it('deactivates rather than deleting, so references stay resolvable', async () => {
    await saveSupplier(database, record(2))
    await saveSupplier(database, record(2, { active: false, updatedAt: '2026-09-20T00:00:00.000Z' }), {
      previousUpdatedAt: TEST_INSTANT,
    })

    const stored = await loadSupplierRecord(database, testUuid(2))
    expect(stored.active).toBe(false)
    expect(await listSupplierRecords(database)).toHaveLength(1)
  })

  it('refuses a write whose loaded version is stale', async () => {
    await saveSupplier(database, record(3))
    await expect(saveSupplier(database, record(3))).rejects.toMatchObject({ code: 'STALE_WRITE' })
  })

  it('reports a missing supplier by name', async () => {
    await expect(loadSupplierRecord(database, testUuid(99))).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    })
  })

  it('refuses to store a record the reader could not validate', async () => {
    await expect(
      saveSupplier(database, record(4, { displayName: '   ' })),
    ).rejects.toMatchObject({ code: 'RECORD_INVALID' })
    expect(await listSupplierRecords(database)).toEqual([])
  })

  it('rejects a corrupted stored record on read instead of returning it', async () => {
    await saveSupplier(database, record(5))
    await database.write(['suppliers'], (scope) =>
      scope.put('suppliers', { ...record(5), active: 'yes' }),
    )

    await expect(loadSupplierRecord(database, testUuid(5))).rejects.toMatchObject({
      code: 'RECORD_INVALID',
    })
  })
})

describe('settings', () => {
  it('round-trips strings, numbers and booleans', async () => {
    await writeSetting(database, 'ui.density', 'compact')
    await writeSetting(database, 'ui.rowsPerPage', 50)
    await writeSetting(database, 'ui.showArchived', false)

    expect((await readSetting(database, 'ui.density'))?.value).toBe('compact')
    expect((await readSetting(database, 'ui.rowsPerPage'))?.value).toBe(50)
    expect((await readSetting(database, 'ui.showArchived'))?.value).toBe(false)
    expect(await readAllSettings(database)).toHaveLength(3)
  })

  it('returns undefined for a key that was never written', async () => {
    expect(await readSetting(database, 'nothing.here')).toBeUndefined()
  })

  it('refuses a value it could not read back', async () => {
    await expect(
      writeSetting(database, 'ui.theme', { dark: true } as never),
    ).rejects.toMatchObject({ code: 'RECORD_INVALID' })
    expect(await readAllSettings(database)).toEqual([])
  })

  it('deletes a preference', async () => {
    await writeSetting(database, 'ui.density', 'comfortable')
    await deleteSetting(database, 'ui.density')
    expect(await readSetting(database, 'ui.density')).toBeUndefined()
  })

  it('leaves the Phase 6 locale preference alone', async () => {
    // The locale is read from localStorage before this database is open, so
    // the first paint does not wait on IndexedDB. Phase 7 does not move it.
    expect(await readAllSettings(database)).toEqual([])
  })
})

describe('meta', () => {
  it('is readable through the store as well as from the open handle', async () => {
    const meta = await readMeta(database)
    expect(meta).toEqual(database.meta)
    expect(meta.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('has no external backup timestamp before Phase 8 writes one', async () => {
    expect((await readMeta(database)).lastExternalBackupAt).toBeUndefined()
  })
})
