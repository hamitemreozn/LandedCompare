/**
 * External backup generation, the `lastExternalBackupAt` contract, and the
 * staleness rule.
 *
 * The contract being defended here is a narrow one and easy to break by
 * accident: **a backup is only "taken" once the file has actually been
 * produced and delivered.** A timestamp written optimistically, before
 * generation or despite a failed delivery, silences the one warning that
 * protects a single-machine pilot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../persistence/database'
import { readMeta } from '../persistence/stores/metaStore'
import { openTestDatabase, type TestDatabase } from '../persistence/testSupport'
import { BackupError } from './errors'
import {
  createBackup,
  describeOrigin,
  exportBackup,
  externalBackupStatus,
  isExternalBackupStale,
  markExternalBackupCompleted,
  type BackupArtifact,
} from './externalBackup'
import { downloadBackup, toBackupBlob } from './download'
import { parseBackupEnvelope, verifyBackupChecksum, verifyEntityCounts } from './envelope'
import { readAllStores, seedDatabase, standardSeed } from './testSupport'
import { SCHEMA_VERSION } from '../persistence/schema'

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

describe('createBackup', () => {
  it('produces a complete, self-verifying file', async () => {
    await seedDatabase(database, standardSeed())
    const artifact = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })

    const parsed = parseBackupEnvelope(JSON.parse(artifact.json))
    expect(parsed.manifest.magic).toBe('LandedCompareBackup')
    expect(parsed.manifest.backupFormatVersion).toBe(1)
    expect(parsed.manifest.schemaVersion).toBe(SCHEMA_VERSION)
    expect(parsed.manifest.installId).toBe(database.meta.installId)
    await expect(
      verifyBackupChecksum(parsed.rawData, parsed.manifest.integrity),
    ).resolves.toBeUndefined()
    expect(() => verifyEntityCounts(parsed.manifest.entityCounts, parsed.rawData)).not.toThrow()
  })

  it('counts every entity it carries', async () => {
    await seedDatabase(database, standardSeed())
    const artifact = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })

    expect(artifact.entityCounts.suppliers).toBe(2)
    expect(artifact.entityCounts.projects).toBe(1)
    expect(artifact.entityCounts.inventoryMovements).toBe(2)
    expect(artifact.entityCounts.settings).toBe(2)
    expect(artifact.entityCounts.counters).toBe(1)
    expect(artifact.totalRecords).toBe(8)
    expect(artifact.byteLength).toBe(new TextEncoder().encode(artifact.json).byteLength)
  })

  it('excludes snapshots, so a backup is not a backup of backups', async () => {
    await seedDatabase(database, standardSeed())
    const { createSnapshot } = await import('./snapshots')
    await createSnapshot(database, { kind: 'MANUAL' })

    const artifact = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    expect(Object.keys(artifact.envelope.data)).not.toContain('snapshots')
    expect(Object.keys(artifact.envelope.data)).not.toContain('meta')
  })

  it('names the file deterministically and safely', async () => {
    const artifact = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    expect(artifact.filename).toBe('LandedCompare_Backup_2026-09-19_1832.json')
  })

  it('gives the same bytes for the same data and the same timestamp', async () => {
    await seedDatabase(database, standardSeed())
    const first = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    const second = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    expect(second.json).toBe(first.json)
  })

  it('gives the same checksum for the same data at a different timestamp', async () => {
    await seedDatabase(database, standardSeed())
    const first = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    const second = await createBackup(database, { now: clock('2026-09-20T09:00:00.000Z') })

    // The digest covers `data`, so only the manifest moved.
    expect(second.envelope.integrity.value).toBe(first.envelope.integrity.value)
    expect(second.json).not.toBe(first.json)
  })

  it('keeps decimal strings and timestamps character-exact in the file', async () => {
    await seedDatabase(database, standardSeed())
    const artifact = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })

    expect(artifact.json).toContain('"value":"12.345"')
    expect(artifact.json).toContain('"amount":"3.335"')
    expect(artifact.json).toContain('"createdAt":"2026-09-19T12:00:00.000Z"')
  })

  it('does not modify business data', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)
    await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    expect(await readAllStores(database)).toEqual(before)
  })

  it('does not stamp lastExternalBackupAt merely by generating a file', async () => {
    await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    expect((await readMeta(database)).lastExternalBackupAt).toBeUndefined()
  })

  it('backs up an empty database without complaining', async () => {
    const artifact = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    expect(artifact.totalRecords).toBe(0)
    const parsed = parseBackupEnvelope(JSON.parse(artifact.json))
    await expect(
      verifyBackupChecksum(parsed.rawData, parsed.manifest.integrity),
    ).resolves.toBeUndefined()
  })
})

describe('exportBackup', () => {
  it('stamps lastExternalBackupAt only after delivery succeeds', async () => {
    await seedDatabase(database, standardSeed())
    const delivered: BackupArtifact[] = []

    const result = await exportBackup(database, {
      now: clock('2026-09-19T18:32:11.482Z'),
      deliver: (artifact) => {
        // Not stamped yet at the moment of delivery.
        delivered.push(artifact)
      },
    })

    expect(delivered).toHaveLength(1)
    expect(result.meta.lastExternalBackupAt).toBe('2026-09-19T18:32:11.482Z')
    expect((await readMeta(database)).lastExternalBackupAt).toBe('2026-09-19T18:32:11.482Z')
  })

  it('leaves the timestamp alone when delivery fails', async () => {
    await seedDatabase(database, standardSeed())

    await expect(
      exportBackup(database, {
        now: clock('2026-09-19T18:32:11.482Z'),
        deliver: () => {
          throw new Error('the user cancelled the save dialog')
        },
      }),
    ).rejects.toThrow('the user cancelled the save dialog')

    expect((await readMeta(database)).lastExternalBackupAt).toBeUndefined()
  })

  it('leaves an earlier timestamp intact when a later export fails', async () => {
    await exportBackup(database, { now: clock('2026-09-10T08:00:00.000Z'), deliver: () => {} })
    await expect(
      exportBackup(database, {
        now: clock('2026-09-19T08:00:00.000Z'),
        deliver: () => Promise.reject(new Error('disk full')),
      }),
    ).rejects.toThrow('disk full')

    // Still the old one — so the staleness warning keeps counting from it.
    expect((await readMeta(database)).lastExternalBackupAt).toBe('2026-09-10T08:00:00.000Z')
  })

  it('does not stamp when generation itself fails', async () => {
    const brokenDigest = { digest: undefined } as unknown as {
      digest(a: string, b: BufferSource): Promise<ArrayBuffer>
    }
    await expect(
      exportBackup(database, {
        now: clock('2026-09-19T08:00:00.000Z'),
        digestProvider: brokenDigest,
        deliver: () => {
          throw new Error('delivery should never be reached')
        },
      }),
    ).rejects.toBeInstanceOf(BackupError)

    expect((await readMeta(database)).lastExternalBackupAt).toBeUndefined()
  })

  it('does not modify business data', async () => {
    await seedDatabase(database, standardSeed())
    const before = await readAllStores(database)
    await exportBackup(database, { now: clock('2026-09-19T08:00:00.000Z'), deliver: () => {} })
    expect(await readAllStores(database)).toEqual(before)
  })

  it('preserves installId and createdAt when stamping', async () => {
    const before = await readMeta(database)
    await markExternalBackupCompleted(database, { at: '2026-09-19T08:00:00.000Z' })
    const after = await readMeta(database)

    expect(after.installId).toBe(before.installId)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.schemaVersion).toBe(before.schemaVersion)
  })
})

describe('external backup staleness', () => {
  it('treats "never exported" as the loudest state', () => {
    const status = externalBackupStatus({}, '2026-09-19T08:00:00.000Z')
    expect(status.state).toBe('NEVER')
    expect(status.lastExternalBackupAt).toBeUndefined()
    expect(isExternalBackupStale({}, '2026-09-19T08:00:00.000Z')).toBe(true)
  })

  it('is fresh inside the seven-day window', () => {
    const meta = { lastExternalBackupAt: '2026-09-13T08:00:00.000Z' }
    const status = externalBackupStatus(meta, '2026-09-19T08:00:00.000Z')
    expect(status.state).toBe('FRESH')
    expect(status.ageDays).toBe(6)
    expect(isExternalBackupStale(meta, '2026-09-19T08:00:00.000Z')).toBe(false)
  })

  it('goes stale exactly at seven days', () => {
    const meta = { lastExternalBackupAt: '2026-09-12T08:00:00.000Z' }
    expect(externalBackupStatus(meta, '2026-09-19T07:59:59.999Z').state).toBe('FRESH')
    expect(externalBackupStatus(meta, '2026-09-19T08:00:00.000Z').state).toBe('STALE')
  })

  it('reports the age in whole days for a later UI to render', () => {
    const meta = { lastExternalBackupAt: '2026-09-01T08:00:00.000Z' }
    const status = externalBackupStatus(meta, '2026-09-19T20:00:00.000Z')
    expect(status.state).toBe('STALE')
    expect(status.ageDays).toBe(18)
    expect(status.staleAfterDays).toBe(7)
  })

  it('honours a caller-supplied window without hard-coding one', () => {
    const meta = { lastExternalBackupAt: '2026-09-17T08:00:00.000Z' }
    expect(externalBackupStatus(meta, '2026-09-19T08:00:00.000Z', 1).state).toBe('STALE')
    expect(externalBackupStatus(meta, '2026-09-19T08:00:00.000Z', 30).state).toBe('FRESH')
  })

  it('returns machine-readable state only — no user-facing text', () => {
    const status = externalBackupStatus({ lastExternalBackupAt: '2026-09-01T08:00:00.000Z' }, '2026-09-19T08:00:00.000Z')
    expect(Object.values(status).every((value) => typeof value !== 'function')).toBe(true)
    expect(status.state).toMatch(/^(NEVER|FRESH|STALE)$/)
  })

  it('reflects a real export end to end', async () => {
    expect(isExternalBackupStale(await readMeta(database), '2026-09-19T08:00:00.000Z')).toBe(true)
    await exportBackup(database, { now: clock('2026-09-19T08:00:00.000Z'), deliver: () => {} })
    expect(isExternalBackupStale(await readMeta(database), '2026-09-20T08:00:00.000Z')).toBe(false)
    expect(isExternalBackupStale(await readMeta(database), '2026-10-20T08:00:00.000Z')).toBe(true)
  })
})

describe('download helper', () => {
  it('produces a JSON blob of exactly the file bytes', async () => {
    await seedDatabase(database, standardSeed())
    const artifact = await createBackup(database, { now: clock('2026-09-19T08:00:00.000Z') })
    const blob = toBackupBlob(artifact)
    expect(blob.type).toBe('application/json')
    // jsdom's `Blob` has no `text()`, so the byte count is what is comparable
    // here — and it is the assertion that matters: the blob carries the whole
    // file, not a truncated copy.
    expect(blob.size).toBe(artifact.byteLength)
  })

  it('initiates a download with the right filename and releases the object URL', async () => {
    const artifact = await createBackup(database, { now: clock('2026-09-19T18:32:11.482Z') })
    const created: string[] = []
    const revoked: string[] = []
    let clicked = 0

    const anchor = {
      href: '',
      download: '',
      rel: '',
      click: () => {
        clicked += 1
      },
    } as unknown as HTMLAnchorElement

    downloadBackup(artifact, {
      document: {
        createElement: () => anchor,
        body: { appendChild: () => {}, removeChild: () => {} },
      },
      urlFactory: {
        createObjectURL: () => {
          created.push('blob:fake')
          return 'blob:fake'
        },
        revokeObjectURL: (url) => revoked.push(url),
      },
    })

    expect(anchor.download).toBe('LandedCompare_Backup_2026-09-19_1832.json')
    expect(clicked).toBe(1)
    expect(revoked).toEqual(created)
  })

  it('reports an environment that cannot download instead of throwing a bare TypeError', async () => {
    const artifact = await createBackup(database, { now: clock('2026-09-19T08:00:00.000Z') })
    const urlFactory = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} }

    // No DOM at all — the case a non-browser host hits.
    expect(() => downloadBackup(artifact, { document: {} as never, urlFactory })).toThrow(
      BackupError,
    )
    // A DOM, but no object-URL support.
    expect(() =>
      downloadBackup(artifact, {
        document: { createElement: () => ({}) as HTMLAnchorElement, body: { appendChild: () => {}, removeChild: () => {} } },
        urlFactory: {} as never,
      }),
    ).toThrow(BackupError)
  })
})

describe('describeOrigin', () => {
  it('exposes the browser origin a later UI must warn about', () => {
    const info = describeOrigin(database, {
      origin: 'http://localhost:5173',
      protocol: 'http:',
      host: 'localhost:5173',
    })
    expect(info.origin).toBe('http://localhost:5173')
    expect(info.databaseName).toBe(database.name)
    expect(info.schemaVersion).toBe(SCHEMA_VERSION)
    expect(info.installId).toBe(database.meta.installId)
  })

  it('does not fail when there is no location at all', () => {
    const info = describeOrigin(database, {})
    expect(info.origin).toBe('unknown')
  })
})
