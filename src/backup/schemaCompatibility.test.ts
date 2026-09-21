/**
 * Reading a `schemaVersion` 1 backup on a `schemaVersion` 2 build.
 *
 * Version 1 is a **real** version: it shipped, and files written at it exist.
 * So the compatibility path is not hypothetical, and the tests that prove it
 * cannot be either.
 *
 * What moved between 1 and 2 is a property of the database — three IndexedDB
 * indexes that a boolean key could never populate (`REMOVED_BOOLEAN_INDEXES`).
 * A backup payload has never carried an index, so the record shapes on both
 * sides of the bump are identical and the payload migration is structurally a
 * no-op.
 *
 * "Structurally a no-op" is exactly the claim that has to be *tested* rather
 * than assumed, and it is the reason the step is declared at all instead of
 * quietly treating 1 and 2 as interchangeable:
 *
 * - **without** an entry at 2, `migrateBackupPayload` finds no path and refuses
 *   a perfectly good file with `BACKUP_SCHEMA_UNSUPPORTED`;
 * - **with** it, the file is accepted and the payload is provably unchanged —
 *   which is a different and much stronger statement than "we assumed nothing
 *   needed to change".
 *
 * The three version numbers stay separate throughout, and the last block here
 * exists to keep them that way.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../persistence/database'
import { SCHEMA_VERSION } from '../persistence/schema'
import { openTestDatabase, testUuid, type TestDatabase } from '../persistence/testSupport'
import { canonicalize } from './canonicalJson'
import { emptyBackupData, type BackupData } from './businessData'
import {
  BACKUP_FORMAT_VERSION,
  buildBackupEnvelope,
  parseBackupEnvelope,
  serialiseBackupEnvelope,
} from './envelope'
import { BackupError } from './errors'
import { createBackup } from './externalBackup'
import {
  PAYLOAD_MIGRATIONS,
  assertPayloadMigrationChain,
  migrateBackupPayload,
} from './payloadMigrations'
import { applyRestore, prepareRestore } from './restore'
import { movementRecord, projectRecord, readAllStores, supplierRecord } from './testSupport'

let fixture: TestDatabase
let database: Database

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
})

afterEach(async () => {
  await fixture.destroy()
})

const INSTALL_ID = testUuid(999)
const CREATED_AT = '2026-09-19T18:32:11.482Z'

function dataWith(overrides: Record<string, readonly unknown[]>): BackupData {
  return { ...emptyBackupData(), ...overrides } as BackupData
}

/** A rich payload: two suppliers, a project with money in it, two movements. */
function businessPayload(): BackupData {
  const suppliers = [supplierRecord(31), supplierRecord(32)]
  return dataWith({
    suppliers,
    projects: [projectRecord(40, [suppliers[0]!.id, suppliers[1]!.id])],
    inventoryMovements: [
      movementRecord(50, { quantity: { value: '0.000001' } }),
      movementRecord(51, { quantity: { value: '99999999.999999' } }),
    ],
    settings: [{ key: 'locale', value: 'tr' }],
    counters: [{ key: 'PO', nextValue: 7 }],
  })
}

/**
 * A genuine, correctly checksummed file written at a chosen `schemaVersion`.
 *
 * The checksum covers `data` and nothing else, so declaring version 1 here
 * produces a file byte-identical to one the version-1 build would have
 * written — not a version-2 file with a field edited.
 */
async function fileAtVersion(data: BackupData, schemaVersion: number): Promise<string> {
  const envelope = await buildBackupEnvelope({
    data,
    createdAt: CREATED_AT,
    installId: INSTALL_ID,
    schemaVersion,
    appVersion: '0.7.0',
  })
  return serialiseBackupEnvelope(envelope)
}

describe('the released payload migration chain', () => {
  it('has a step for every version bump the database chain has', () => {
    expect(PAYLOAD_MIGRATIONS.map((step) => step.to)).toEqual([2])
    expect(() => assertPayloadMigrationChain(PAYLOAD_MIGRATIONS, SCHEMA_VERSION)).not.toThrow()
  })

  it('leaves a version-1 payload byte-identical, which is the claim it makes', () => {
    const data = businessPayload()
    const before = canonicalize(data, 'data')

    const migrated = migrateBackupPayload(data, 1, { targetVersion: 2 })

    expect(migrated.applied).toEqual([2])
    expect(migrated.fromVersion).toBe(1)
    expect(migrated.toVersion).toBe(2)
    expect(canonicalize(migrated.data, 'data')).toBe(before)
  })

  it('does nothing at all when the payload is already at the current version', () => {
    const data = businessPayload()
    const migrated = migrateBackupPayload(data, SCHEMA_VERSION)
    expect(migrated.applied).toEqual([])
    expect(migrated.data).toBe(data)
  })
})

describe('restoring a schemaVersion 1 backup file', () => {
  it('accepts it and reports the step it applied', async () => {
    const plan = await prepareRestore(database, await fileAtVersion(businessPayload(), 1))

    expect(plan.preview.backupSchemaVersion).toBe(1)
    expect(plan.preview.targetSchemaVersion).toBe(SCHEMA_VERSION)
    expect(plan.preview.migrationsApplied).toEqual([2])
    // The manifest's own wrapper version did not move with the schema.
    expect(plan.preview.backupFormatVersion).toBe(BACKUP_FORMAT_VERSION)
  })

  it('carries the business data through unchanged, record for record', async () => {
    const data = businessPayload()
    const plan = await prepareRestore(database, await fileAtVersion(data, 1))

    expect(plan.data.suppliers).toEqual(data.suppliers)
    expect(plan.data.projects).toEqual(data.projects)
    expect(plan.data.inventoryMovements).toEqual(data.inventoryMovements)
    expect(plan.data.settings).toEqual(data.settings)
    expect(plan.data.counters).toEqual(data.counters)
  })

  it('writes it, and the decimal strings survive the version change character for character', async () => {
    const data = businessPayload()
    await applyRestore(database, await prepareRestore(database, await fileAtVersion(data, 1)))

    const after = await readAllStores(database)
    expect(after.suppliers).toHaveLength(2)
    expect(after.projects).toHaveLength(1)
    const values = (after.inventoryMovements as { quantity: { value: string } }[])
      .map((record) => record.quantity.value)
      .sort()
    expect(values).toEqual(['0.000001', '99999999.999999'])
  })

  it('emits schemaVersion 2 when the restored database is backed up again', async () => {
    await applyRestore(
      database,
      await prepareRestore(database, await fileAtVersion(businessPayload(), 1)),
    )

    const artifact = await createBackup(database)
    expect(artifact.envelope.schemaVersion).toBe(SCHEMA_VERSION)
    expect(artifact.envelope.schemaVersion).toBe(2)
    // Still the same wrapper. The payload moved; the envelope did not.
    expect(artifact.envelope.backupFormatVersion).toBe(BACKUP_FORMAT_VERSION)

    const reparsed = parseBackupEnvelope(JSON.parse(artifact.json))
    expect(reparsed.manifest.schemaVersion).toBe(2)
  })

  it('re-reads its own version-2 output with no migration at all', async () => {
    await applyRestore(
      database,
      await prepareRestore(database, await fileAtVersion(businessPayload(), 1)),
    )
    const artifact = await createBackup(database)

    const plan = await prepareRestore(database, artifact.json)
    expect(plan.preview.backupSchemaVersion).toBe(2)
    expect(plan.preview.migrationsApplied).toEqual([])
  })
})

describe('when the compatibility path fails', () => {
  it('leaves the working database untouched if a payload step throws', async () => {
    await applyRestore(
      database,
      await prepareRestore(database, await fileAtVersion(businessPayload(), 1)),
    )
    const untouched = await readAllStores(database)

    let code: string
    try {
      await prepareRestore(database, await fileAtVersion(dataWith({}), 1), {
        migrations: [
          {
            to: 2,
            description: 'a step that cannot cope with a version-1 payload',
            migrate: () => {
              throw new Error('unexpected shape')
            },
          },
        ],
      })
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
    }

    expect(code).toBe('BACKUP_MIGRATION_FAILED')
    // The payload is migrated in memory, never in the database — so a step
    // that throws cannot have damaged the data the user was about to fall back
    // on.
    expect(await readAllStores(database)).toEqual(untouched)
  })

  it('refuses a version-0 payload rather than inventing a step for it', async () => {
    const file = await fileAtVersion(dataWith({ suppliers: [supplierRecord(31)] }), 1)
    const tampered = JSON.parse(file) as Record<string, unknown>
    tampered.schemaVersion = 0

    let code: string
    try {
      await prepareRestore(database, JSON.stringify(tampered))
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
    }
    expect(code).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('still refuses a payload from a version this build has never seen', async () => {
    const file = await fileAtVersion(dataWith({}), SCHEMA_VERSION + 1)
    let code: string
    try {
      await prepareRestore(database, file)
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
    }
    expect(code).toBe('BACKUP_SCHEMA_TOO_NEW')
  })
})

describe('the three version numbers stay three version numbers', () => {
  it('moved schemaVersion without moving backupFormatVersion', () => {
    // The whole point of keeping them apart: an index was removed from the
    // database, which is a payload-shape question, and the envelope that wraps
    // the payload did not change at all.
    expect(SCHEMA_VERSION).toBe(2)
    expect(BACKUP_FORMAT_VERSION).toBe(1)
  })

  it('keeps the IndexedDB version equal to schemaVersion, as this design requires', () => {
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.meta.schemaVersion).toBe(SCHEMA_VERSION)
  })
})
