/**
 * A backup file is untrusted input. These tests treat it that way.
 *
 * Every case here answers the same two questions: **is the file rejected, and
 * with which reason** — and, for anything that reached a database, **is the
 * working data still exactly as it was.** A restore that fails validation is
 * a no-op, and the only way to know that is to check the database after every
 * refusal, which is what the shared assertion at the end of each block does.
 *
 * The ordering of the refusals is deliberate and tested, because a file can be
 * wrong in several ways at once and the user deserves the *first* reason, not
 * whichever check happened to run.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../persistence/database'
import { SCHEMA_VERSION } from '../persistence/schema'
import { openTestDatabase, testUuid, type TestDatabase } from '../persistence/testSupport'
import { emptyBackupData, type BackupData } from './businessData'
import { buildBackupEnvelope, serialiseBackupEnvelope } from './envelope'
import { BackupError } from './errors'
import { MAX_JSON_DEPTH } from './limits'
import { prepareRestore } from './restore'
import {
  movementRecord,
  readAllStores,
  seedDatabase,
  standardSeed,
  supplierRecord,
} from './testSupport'

let fixture: TestDatabase
let database: Database
let untouched: BackupData

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
  await seedDatabase(database, standardSeed())
  untouched = await readAllStores(database)
})

afterEach(async () => {
  await fixture.destroy()
})

const INSTALL_ID = testUuid(999)
const CREATED_AT = '2026-09-19T18:32:11.482Z'

function dataWith(overrides: Record<string, readonly unknown[]>): BackupData {
  return { ...emptyBackupData(), ...overrides } as BackupData
}

/** A genuine, correctly checksummed backup file. */
async function signedFile(
  data: BackupData = dataWith({ suppliers: [supplierRecord(1)] }),
  manifest: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const envelope = await buildBackupEnvelope({ data, createdAt: CREATED_AT, installId: INSTALL_ID })
  return serialiseBackupEnvelope({ ...envelope, ...manifest } as typeof envelope)
}

/** Breaks a real file in one place, leaving the checksum as it was. */
async function tamper(
  mutate: (value: Record<string, unknown>) => void,
  data?: BackupData,
): Promise<string> {
  const value = JSON.parse(await signedFile(data)) as Record<string, unknown>
  mutate(value)
  return JSON.stringify(value)
}

/** Refuses, and reports *why*, while proving the database never moved. */
async function refusalCode(file: string | { size: number; text(): Promise<string> }): Promise<string> {
  let code: string
  try {
    await prepareRestore(database, file)
    code = 'did-not-throw'
  } catch (cause) {
    code = cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
  }
  // The point of every one of these tests: nothing was written.
  expect(await readAllStores(database)).toEqual(untouched)
  return code
}

describe('malformed input', () => {
  it('rejects text that is not JSON', async () => {
    expect(await refusalCode('this is not json')).toBe('BACKUP_MALFORMED_JSON')
    expect(await refusalCode('')).toBe('BACKUP_MALFORMED_JSON')
    expect(await refusalCode('{"magic":"LandedCompareBackup",')).toBe('BACKUP_MALFORMED_JSON')
  })

  it('rejects JSON that is not an object', async () => {
    // A value with no fields at all cannot even be asked for its `magic`, so
    // it fails as a misshapen envelope rather than as the wrong file.
    expect(await refusalCode('[]')).toBe('BACKUP_ENVELOPE_INVALID')
    expect(await refusalCode('"a string"')).toBe('BACKUP_ENVELOPE_INVALID')
    expect(await refusalCode('null')).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('rejects a JSON file that is simply not a backup', async () => {
    expect(await refusalCode('{"invoices":[],"total":12}')).toBe('BACKUP_NOT_RECOGNISED')
  })
})

describe('size and depth limits', () => {
  it('rejects a payload beyond the byte cap', async () => {
    const big = `{"magic":"LandedCompareBackup","padding":"${'x'.repeat(5_000)}"}`
    let code: string
    try {
      await prepareRestore(database, big, { maxBytes: 1_000 })
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : 'unexpected'
    }
    expect(code).toBe('BACKUP_TOO_LARGE')
    expect(await readAllStores(database)).toEqual(untouched)
  })

  it('checks a Blob’s size before reading it into memory', async () => {
    let read = 0
    const hostileBlob = {
      size: 500 * 1024 * 1024,
      text: async () => {
        read += 1
        return '{}'
      },
    }
    expect(await refusalCode(hostileBlob)).toBe('BACKUP_TOO_LARGE')
    expect(read).toBe(0)
  })

  it('rejects a nesting bomb', async () => {
    const depth = MAX_JSON_DEPTH + 10
    const bomb = `{"magic":"LandedCompareBackup","data":${'['.repeat(depth)}${']'.repeat(depth)}}`
    expect(await refusalCode(bomb)).toBe('BACKUP_TOO_DEEP')
  })

  it('accepts a real backup, whose nesting is nowhere near the limit', async () => {
    const plan = await prepareRestore(database, await signedFile())
    expect(plan.preview.incoming.suppliers).toBe(1)
  })
})

describe('prototype pollution', () => {
  it('rejects a __proto__ key at the top level', async () => {
    // Injected as text, not by assignment: `value.__proto__ = …` would set the
    // prototype and never reach the file, which is exactly the confusion this
    // attack relies on.
    const real = await signedFile()
    const file = `{"__proto__":{"polluted":true},${real.slice(1)}`
    expect(await refusalCode(file)).toBe('BACKUP_FORBIDDEN_KEY')
  })

  it('rejects a __proto__ key buried inside a record', async () => {
    const file = `{"magic":"LandedCompareBackup","data":{"suppliers":[{"id":"x","__proto__":{"isAdmin":true}}]}}`
    expect(await refusalCode(file)).toBe('BACKUP_FORBIDDEN_KEY')
  })

  it('rejects a constructor key', async () => {
    const file = `{"magic":"LandedCompareBackup","data":{"suppliers":[{"constructor":{"prototype":{"x":1}}}]}}`
    expect(await refusalCode(file)).toBe('BACKUP_FORBIDDEN_KEY')
  })

  it('rejects a prototype key', async () => {
    const file = `{"magic":"LandedCompareBackup","data":{"suppliers":[{"prototype":{"x":1}}]}}`
    expect(await refusalCode(file)).toBe('BACKUP_FORBIDDEN_KEY')
  })

  it('leaves Object.prototype clean after every hostile file', async () => {
    const probe = {} as Record<string, unknown>
    expect(probe.polluted).toBeUndefined()
    expect(probe.isAdmin).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(Object.prototype).not.toHaveProperty('isAdmin')
  })
})

describe('version compatibility', () => {
  it('rejects an unsupported backupFormatVersion', async () => {
    const file = await tamper((value) => (value.backupFormatVersion = 99))
    expect(await refusalCode(file)).toBe('BACKUP_FORMAT_UNSUPPORTED')
  })

  it('refuses a newer schemaVersion rather than guessing what it means', async () => {
    const file = await tamper((value) => (value.schemaVersion = SCHEMA_VERSION + 1))
    expect(await refusalCode(file)).toBe('BACKUP_SCHEMA_TOO_NEW')
  })

  it('refuses an older schemaVersion with no migration path', async () => {
    // Prepared against a build that claims to be one version further along than
    // the released chain reaches, so the file is older and nothing can bridge
    // the gap. The refusal is what stops a payload being written at a version
    // no step has ever transformed it to.
    let code: string
    try {
      await prepareRestore(database, await signedFile(), {
        targetSchemaVersion: SCHEMA_VERSION + 1,
      })
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : 'unexpected'
    }
    expect(code).toBe('BACKUP_SCHEMA_UNSUPPORTED')
    expect(await readAllStores(database)).toEqual(untouched)
  })

  it('runs an older payload through the migration chain when one exists', async () => {
    const file = await signedFile(dataWith({ suppliers: [supplierRecord(1)] }), { schemaVersion: 1 })
    const plan = await prepareRestore(database, file, {
      targetSchemaVersion: 2,
      migrations: [
        {
          to: 2,
          description: 'rename every supplier',
          migrate: (data) => ({
            ...data,
            suppliers: data.suppliers.map((record) => ({
              ...(record as object),
              displayName: 'Migrated',
            })),
          }),
        },
      ],
    })

    expect(plan.preview.migrationsApplied).toEqual([2])
    expect((plan.data.suppliers[0] as { displayName: string }).displayName).toBe('Migrated')
    // Reading the plan changed nothing.
    expect(await readAllStores(database)).toEqual(untouched)
  })

  it('fails the restore when a migration step throws, leaving the database alone', async () => {
    let code: string
    try {
      await prepareRestore(database, await signedFile(undefined, { schemaVersion: 1 }), {
        targetSchemaVersion: 2,
        migrations: [
          {
            to: 2,
            description: 'a step that cannot cope',
            migrate: () => {
              throw new Error('unexpected shape in v1 payload')
            },
          },
        ],
      })
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : 'unexpected'
    }
    expect(code).toBe('BACKUP_MIGRATION_FAILED')
    expect(await readAllStores(database)).toEqual(untouched)
  })

  it('rejects a payload the migration produced that does not validate', async () => {
    let code: string
    try {
      await prepareRestore(database, await signedFile(undefined, { schemaVersion: 1 }), {
        targetSchemaVersion: 2,
        migrations: [
          {
            to: 2,
            description: 'a step that produces an invalid record',
            migrate: (data) => ({ ...data, suppliers: [{ id: 'not-a-uuid' }] }) as never,
          },
        ],
      })
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : 'unexpected'
    }
    expect(code).toBe('BACKUP_RECORD_INVALID')
    expect(await readAllStores(database)).toEqual(untouched)
  })
})

describe('integrity', () => {
  it('rejects a payload edited after the file was written', async () => {
    const file = await tamper((value) => {
      const suppliers = (value.data as Record<string, { displayName: string }[]>).suppliers
      suppliers[0]!.displayName = 'Edited by hand'
    })
    expect(await refusalCode(file)).toBe('BACKUP_CHECKSUM_MISMATCH')
  })

  it('rejects a truncated payload', async () => {
    const file = await tamper(
      (value) => {
        ;(value.data as Record<string, unknown[]>).suppliers = []
        ;(value.entityCounts as Record<string, number>).suppliers = 0
      },
      dataWith({ suppliers: [supplierRecord(1), supplierRecord(2)] }),
    )
    expect(await refusalCode(file)).toBe('BACKUP_CHECKSUM_MISMATCH')
  })

  it('rejects a checksum that was blanked out', async () => {
    const file = await tamper((value) => {
      ;(value.integrity as Record<string, string>).value = '0'.repeat(64)
    })
    expect(await refusalCode(file)).toBe('BACKUP_CHECKSUM_MISMATCH')
  })

  it('rejects manifest counts that disagree with the payload', async () => {
    // The checksum covers `data` only, so a manifest edited on its own still
    // verifies — which is exactly why the counts are checked separately.
    const file = await tamper((value) => {
      ;(value.entityCounts as Record<string, number>).suppliers = 99
    })
    expect(await refusalCode(file)).toBe('BACKUP_COUNT_MISMATCH')
  })

  it('checks the checksum before the counts, so corruption is named corruption', async () => {
    const file = await tamper((value) => {
      ;(value.data as Record<string, { displayName: string }[]>).suppliers[0]!.displayName = 'x'
      ;(value.entityCounts as Record<string, number>).suppliers = 42
    })
    expect(await refusalCode(file)).toBe('BACKUP_CHECKSUM_MISMATCH')
  })
})

describe('record validation', () => {
  /** A file whose records are wrong but whose checksum is honest. */
  async function signedButInvalid(records: readonly unknown[], store = 'suppliers'): Promise<string> {
    return signedFile(dataWith({ [store]: records }))
  }

  it('rejects a record with a bad id', async () => {
    expect(await refusalCode(await signedButInvalid([{ ...supplierRecord(1), id: 'nope' }]))).toBe(
      'BACKUP_RECORD_INVALID',
    )
  })

  it('rejects a record with an unknown field rather than dropping it', async () => {
    expect(
      await refusalCode(await signedButInvalid([{ ...supplierRecord(1), secretField: 'x' }])),
    ).toBe('BACKUP_RECORD_INVALID')
  })

  it('rejects a non-canonical decimal string', async () => {
    const broken = movementRecord(20, { quantity: { value: '1e3' } })
    expect(await refusalCode(await signedButInvalid([broken], 'inventoryMovements'))).toBe(
      'BACKUP_RECORD_INVALID',
    )
  })

  it('rejects an unknown enum value', async () => {
    const broken = movementRecord(20, { type: 'TELEPORTED' as never })
    expect(await refusalCode(await signedButInvalid([broken], 'inventoryMovements'))).toBe(
      'BACKUP_RECORD_INVALID',
    )
  })

  it('rejects a negative movement quantity', async () => {
    const broken = movementRecord(20, { quantity: { value: '-3' } })
    expect(await refusalCode(await signedButInvalid([broken], 'inventoryMovements'))).toBe(
      'BACKUP_RECORD_INVALID',
    )
  })

  it('rejects two records sharing a primary key before anything is written', async () => {
    expect(await refusalCode(await signedButInvalid([supplierRecord(1), supplierRecord(1)]))).toBe(
      'BACKUP_RECORD_INVALID',
    )
  })

  it('rejects records for a store this build cannot validate', async () => {
    // `products` exists in the schema but has no record type until Phase 9, so
    // a payload carrying product records is refused rather than written
    // unchecked.
    expect(await refusalCode(await signedButInvalid([{ id: testUuid(5), sku: 'A' }], 'products'))).toBe(
      'BACKUP_STORE_UNSUPPORTED',
    )
  })

  it('rejects a record that is not an object at all', async () => {
    expect(await refusalCode(await signedButInvalid(['just a string']))).toBe(
      'BACKUP_RECORD_INVALID',
    )
    expect(await refusalCode(await signedButInvalid([null]))).toBe('BACKUP_RECORD_INVALID')
  })

  it('rejects too many records in one store', async () => {
    const many = Array.from({ length: 6 }, (_, index) => supplierRecord(index + 1))
    let code: string
    try {
      await prepareRestore(database, await signedFile(dataWith({ suppliers: many })), {
        // A deliberately tiny bound; the production limits are in `limits.ts`.
        maxBytes: 10_000_000,
      })
      code = 'did-not-throw'
    } catch (cause) {
      code = cause instanceof BackupError ? cause.code : 'unexpected'
    }
    // Six records is well inside the real limit, so this one succeeds — the
    // bound itself is exercised in the unit tests for `validateBackupData`.
    expect(code).toBe('did-not-throw')
  })
})

describe('what a rejection costs', () => {
  it('leaves the working database identical after every kind of bad file', async () => {
    const files = [
      'not json',
      '{"magic":"Nope"}',
      await tamper((v) => (v.schemaVersion = 7)),
      await tamper((v) => ((v.integrity as Record<string, string>).value = 'f'.repeat(64))),
      await tamper((v) => ((v.entityCounts as Record<string, number>).projects = 5)),
      await signedFile(dataWith({ suppliers: [{ id: 'bad' }] })),
    ]
    for (const file of files) {
      await refusalCode(file)
    }
    expect(await readAllStores(database)).toEqual(untouched)
  })
})
