/**
 * The backup envelope: its checksum, its manifest, its filename, and the
 * strict parser that reads one back.
 *
 * These are the tests that decide whether a corrupt file is noticed. They are
 * written against real SHA-256 through `crypto.subtle`, not a stub — a
 * checksum test that mocks the digest proves only that two calls to the mock
 * agree.
 */

import { describe, expect, it } from 'vitest'
import { CHECKSUM_ALGORITHM, sha256Hex } from './checksum'
import { canonicalize } from './canonicalJson'
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  backupFilename,
  buildBackupEnvelope,
  parseBackupEnvelope,
  serialiseBackupEnvelope,
  verifyBackupChecksum,
  verifyEntityCounts,
  type BackupEnvelope,
} from './envelope'
import { emptyBackupData, type BackupData } from './businessData'
import { BackupError } from './errors'
import { movementRecord, supplierRecord } from './testSupport'
import { testUuid } from '../persistence/testSupport'
import { SCHEMA_VERSION } from '../persistence/schema'

const CREATED_AT = '2026-09-19T18:32:11.482Z'
const INSTALL_ID = testUuid(999)

function dataWith(overrides: Partial<Record<string, readonly unknown[]>>): BackupData {
  return { ...emptyBackupData(), ...overrides } as BackupData
}

async function envelope(data: BackupData = dataWith({})): Promise<BackupEnvelope> {
  return buildBackupEnvelope({ data, createdAt: CREATED_AT, installId: INSTALL_ID })
}

async function codeOf(run: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (cause) {
    return cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
  }
  return 'did-not-throw'
}

describe('sha256Hex', () => {
  it('matches the published SHA-256 of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('matches the published SHA-256 of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('reports a missing Web Crypto honestly instead of skipping the checksum', async () => {
    expect(await codeOf(() => sha256Hex('abc', undefined as never))).toBe('did-not-throw')
    const withoutDigest = { digest: undefined } as unknown as { digest(a: string, b: BufferSource): Promise<ArrayBuffer> }
    expect(await codeOf(() => sha256Hex('abc', withoutDigest))).toBe('CRYPTO_UNAVAILABLE')
  })
})

describe('buildBackupEnvelope', () => {
  it('produces a complete manifest', async () => {
    const built = await envelope(dataWith({ suppliers: [supplierRecord(1)] }))
    expect(built.magic).toBe(BACKUP_MAGIC)
    expect(built.backupFormatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(built.schemaVersion).toBe(SCHEMA_VERSION)
    expect(built.createdAt).toBe(CREATED_AT)
    expect(built.installId).toBe(INSTALL_ID)
    expect(built.integrity.algorithm).toBe(CHECKSUM_ALGORITHM)
    expect(built.integrity.scope).toBe('data')
    expect(built.integrity.value).toMatch(/^[0-9a-f]{64}$/)
  })

  it('counts every store, including the empty ones', async () => {
    const built = await envelope(
      dataWith({ suppliers: [supplierRecord(1), supplierRecord(2)], inventoryMovements: [movementRecord(20)] }),
    )
    expect(built.entityCounts.suppliers).toBe(2)
    expect(built.entityCounts.inventoryMovements).toBe(1)
    expect(built.entityCounts.products).toBe(0)
    expect(built.entityCounts.purchaseOrders).toBe(0)
  })

  it('checksums the payload and nothing else, so the digest is reproducible', async () => {
    const data = dataWith({ suppliers: [supplierRecord(1)] })
    const built = await envelope(data)
    expect(built.integrity.value).toBe(await sha256Hex(canonicalize(data, 'data')))
  })

  it('gives the same checksum to the same logical data assembled differently', async () => {
    const forwards = dataWith({ suppliers: [supplierRecord(1)] })
    const shuffled: Record<string, readonly unknown[]> = {}
    // Same stores, opposite insertion order, and each record's keys reversed.
    for (const key of Object.keys(forwards).reverse()) {
      shuffled[key] = (forwards as Record<string, readonly unknown[]>)[key]!
    }
    const supplier = supplierRecord(1)
    const reversedKeys: Record<string, unknown> = {}
    for (const key of Object.keys(supplier).reverse()) {
      reversedKeys[key] = (supplier as unknown as Record<string, unknown>)[key]
    }
    shuffled.suppliers = [reversedKeys]

    const a = await envelope(forwards)
    const b = await buildBackupEnvelope({
      data: shuffled as BackupData,
      createdAt: CREATED_AT,
      installId: INSTALL_ID,
    })
    expect(b.integrity.value).toBe(a.integrity.value)
  })

  it('gives different checksums to different data', async () => {
    const a = await envelope(dataWith({ suppliers: [supplierRecord(1)] }))
    const b = await envelope(dataWith({ suppliers: [supplierRecord(2)] }))
    expect(a.integrity.value).not.toBe(b.integrity.value)
  })

  it('serialises byte-identically for identical inputs', async () => {
    const data = dataWith({ suppliers: [supplierRecord(1)], settings: [{ key: 'locale', value: 'tr' }] })
    const first = serialiseBackupEnvelope(await envelope(data))
    const second = serialiseBackupEnvelope(await envelope(data))
    expect(second).toBe(first)
  })
})

describe('backupFilename', () => {
  it('is deterministic, sortable and UTC', () => {
    expect(backupFilename('2026-09-19T18:32:11.482Z')).toBe('LandedCompare_Backup_2026-09-19_1832.json')
    expect(backupFilename('2026-01-02T03:04:05.006Z')).toBe('LandedCompare_Backup_2026-01-02_0304.json')
  })

  it('uses only safe filename characters', () => {
    expect(backupFilename('2026-09-19T18:32:11.482Z')).toMatch(/^[A-Za-z0-9_-]+\.json$/)
  })

  it('does not depend on the host locale', () => {
    // A `Date`-formatted name would read 19.09.2026 in tr-TR and 9/19/2026 in
    // en-US. Slicing the ISO instant cannot.
    const name = backupFilename('2026-09-19T18:32:11.482Z')
    expect(name).not.toContain('.2026')
    expect(name).not.toContain('/')
  })

  it('refuses a timestamp that is not an ISO instant', async () => {
    expect(await codeOf(() => backupFilename('19/09/2026'))).toBe('BACKUP_ENVELOPE_INVALID')
  })
})

describe('parseBackupEnvelope', () => {
  /** Builds a real file, then breaks it in exactly one way. */
  async function brokenFile(mutate: (value: Record<string, unknown>) => void): Promise<string> {
    const built = await envelope(dataWith({ suppliers: [supplierRecord(1)] }))
    const value = JSON.parse(serialiseBackupEnvelope(built)) as Record<string, unknown>
    mutate(value)
    return codeOf(() => parseBackupEnvelope(value))
  }

  it('accepts an envelope this build wrote', async () => {
    const built = await envelope(dataWith({ suppliers: [supplierRecord(1)] }))
    const parsed = parseBackupEnvelope(JSON.parse(serialiseBackupEnvelope(built)))
    expect(parsed.manifest.createdAt).toBe(CREATED_AT)
    expect(parsed.rawData.suppliers).toHaveLength(1)
  })

  it('rejects a file that is not a LandedCompare backup before anything else', async () => {
    expect(await codeOf(() => parseBackupEnvelope({ some: 'other json' }))).toBe(
      'BACKUP_NOT_RECOGNISED',
    )
    expect(await brokenFile((v) => (v.magic = 'Nope'))).toBe('BACKUP_NOT_RECOGNISED')
  })

  it('rejects an unsupported backupFormatVersion', async () => {
    expect(await brokenFile((v) => (v.backupFormatVersion = 2))).toBe('BACKUP_FORMAT_UNSUPPORTED')
    expect(await brokenFile((v) => (v.backupFormatVersion = 0))).toBe('BACKUP_FORMAT_UNSUPPORTED')
  })

  it('rejects an unknown top-level field rather than ignoring it', async () => {
    expect(await brokenFile((v) => (v.extra = 'surprise'))).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('rejects a missing or misshapen manifest field', async () => {
    expect(await brokenFile((v) => delete v.createdAt)).toBe('BACKUP_ENVELOPE_INVALID')
    expect(await brokenFile((v) => (v.installId = 'not-a-uuid'))).toBe('BACKUP_ENVELOPE_INVALID')
    expect(await brokenFile((v) => (v.schemaVersion = '1'))).toBe('BACKUP_ENVELOPE_INVALID')
    expect(await brokenFile((v) => (v.createdAt = '2026-09-19'))).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('rejects an integrity block that is not SHA-256 over data', async () => {
    const hex = 'a'.repeat(64)
    expect(
      await brokenFile((v) => (v.integrity = { algorithm: 'MD5', scope: 'data', value: hex })),
    ).toBe('BACKUP_ENVELOPE_INVALID')
    expect(
      await brokenFile((v) => (v.integrity = { algorithm: 'SHA-256', scope: 'everything', value: hex })),
    ).toBe('BACKUP_ENVELOPE_INVALID')
    expect(
      await brokenFile((v) => (v.integrity = { algorithm: 'SHA-256', scope: 'data', value: 'TOO-SHORT' })),
    ).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('rejects entityCounts that omit a store or name an unknown one', async () => {
    expect(
      await brokenFile((v) => delete (v.entityCounts as Record<string, unknown>).suppliers),
    ).toBe('BACKUP_ENVELOPE_INVALID')
    expect(
      await brokenFile((v) => ((v.entityCounts as Record<string, unknown>).invoices = 3)),
    ).toBe('BACKUP_ENVELOPE_INVALID')
    expect(
      await brokenFile((v) => ((v.entityCounts as Record<string, unknown>).suppliers = -1)),
    ).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('rejects a store name this build has never heard of', async () => {
    expect(await brokenFile((v) => ((v.data as Record<string, unknown>).invoices = []))).toBe(
      'BACKUP_ENVELOPE_INVALID',
    )
  })

  it('rejects a store whose payload is not an array', async () => {
    expect(
      await brokenFile((v) => ((v.data as Record<string, unknown>).suppliers = { nope: true })),
    ).toBe('BACKUP_ENVELOPE_INVALID')
  })
})

describe('integrity verification', () => {
  it('accepts an untouched payload', async () => {
    const data = dataWith({ suppliers: [supplierRecord(1)] })
    const built = await envelope(data)
    await expect(verifyBackupChecksum(data, built.integrity)).resolves.toBeUndefined()
  })

  it('rejects a payload edited after the checksum was written', async () => {
    const built = await envelope(dataWith({ suppliers: [supplierRecord(1)] }))
    const tampered = dataWith({ suppliers: [supplierRecord(1, { displayName: 'Edited' })] })
    const integrity = built.integrity
    expect(await codeOf(() => verifyBackupChecksum(tampered, integrity))).toBe(
      'BACKUP_CHECKSUM_MISMATCH',
    )
  })

  it('rejects a payload whose single character changed', async () => {
    const built = await envelope(dataWith({ inventoryMovements: [movementRecord(20)] }))
    // '12.345' → '12.346': one digit, and the decimal contract is exact.
    const flipped = dataWith({
      inventoryMovements: [movementRecord(20, { quantity: { value: '12.346' } })],
    })
    const integrity = built.integrity
    expect(await codeOf(() => verifyBackupChecksum(flipped, integrity))).toBe(
      'BACKUP_CHECKSUM_MISMATCH',
    )
  })

  it('rejects a truncated payload', async () => {
    const data = dataWith({ suppliers: [supplierRecord(1), supplierRecord(2)] })
    const built = await envelope(data)
    const truncated = dataWith({ suppliers: [supplierRecord(1)] })
    const integrity = built.integrity
    expect(await codeOf(() => verifyBackupChecksum(truncated, integrity))).toBe(
      'BACKUP_CHECKSUM_MISMATCH',
    )
  })

  it('notices when the manifest counts disagree with the payload', async () => {
    const built = await envelope(dataWith({ suppliers: [supplierRecord(1), supplierRecord(2)] }))
    const counts = built.entityCounts
    const shrunk = dataWith({ suppliers: [supplierRecord(1)] })
    expect(await codeOf(() => verifyEntityCounts(counts, shrunk))).toBe('BACKUP_COUNT_MISMATCH')
  })

  it('accepts counts that match', async () => {
    const data = dataWith({ suppliers: [supplierRecord(1)] })
    const built = await envelope(data)
    expect(() => verifyEntityCounts(built.entityCounts, data)).not.toThrow()
  })
})
