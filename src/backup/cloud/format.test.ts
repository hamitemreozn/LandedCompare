/**
 * The organisation backup format: what is written, and everything the reader
 * refuses. The HTTP half — a real export from the local stack, past
 * `max_rows` — is `src/cloud/security/portableBackup.security.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { canonicalize } from '../canonicalJson'
import { sha256Hex } from '../checksum'
import { isBackupError, type BackupErrorCode } from '../errors'
import {
  CLOUD_BACKUP_FORMAT_VERSION,
  CLOUD_BACKUP_SECTIONS,
  buildCloudBackupEnvelope,
  parseCloudBackup,
  serialiseCloudBackup,
  type BackupCustomer,
  type BackupProduct,
  type CloudBackupData,
} from './format'

const ORG = '11111111-1111-4111-8111-111111111111'
const USER = 'aaaaaaaa-0000-4000-8000-000000000001'
const AT = '2026-09-25T10:00:00.000Z'
const HOSTILE = '12345678901234567890.0047'

function uuid(n: number, prefix = '00000000'): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function audit(id: string) {
  return { id, organizationId: ORG, active: true, createdAt: AT, updatedAt: AT, createdBy: USER, updatedBy: USER, version: 1 }
}

function product(n: number, extra: Partial<BackupProduct> = {}): BackupProduct {
  return { ...audit(uuid(n, '10000000')), sku: `SKU-${n}`, name: `Product ${n}`, stockUnit: 'PIECE', ...extra }
}

function sampleData(overrides: Partial<CloudBackupData> = {}): CloudBackupData {
  const status = { ...audit(uuid(1, '30000000')), code: 'A+', sortOrder: 10 }
  const customer: BackupCustomer = { ...audit(uuid(1, '20000000')), displayName: 'Müşteri', externalRef: '120-34-00-11-001', customerStatusId: status.id }
  return {
    organization: { id: ORG, name: 'Deneme Şirketi A', version: 1, updatedAt: AT },
    products: [product(2, { unitsPerPurchaseUnit: { value: HOSTILE } }), product(1, { unitsPerPurchaseUnit: { value: '1.20' } })],
    suppliers: [{ ...audit(uuid(1, '40000000')), displayName: 'Tedarikçi', externalRef: '0001 ' }],
    customers: [customer],
    customerStatuses: [status],
    members: [{ userId: USER, displayName: 'Ayşe Yılmaz', email: 'owner-a@example.test', role: 'OWNER', status: 'ACTIVE', version: 1, createdAt: AT, updatedAt: AT }],
    ...overrides,
  }
}

async function file(data: CloudBackupData = sampleData()): Promise<string> {
  return serialiseCloudBackup(await buildCloudBackupEnvelope({ data, createdAt: AT, exportedBy: USER }))
}

/** Edits the parsed file, re-serialises it, and optionally re-computes the checksum so a deeper check is reached. */
async function edited(mutate: (value: Record<string, any>) => void, options: { rechecksum?: boolean } = {}): Promise<string> {
  const value = JSON.parse(await file()) as Record<string, any>
  mutate(value)
  if (options.rechecksum) {
    value.integrity.value = await sha256Hex(canonicalize(value.data, 'data'))
    for (const section of CLOUD_BACKUP_SECTIONS) value.entityCounts[section] = value.data[section]?.length ?? 0
  }
  return JSON.stringify(value)
}

async function refusal(text: string): Promise<{ code: BackupErrorCode; details: Record<string, unknown> }> {
  try {
    await parseCloudBackup(text)
  } catch (cause) {
    if (isBackupError(cause)) return { code: cause.code, details: cause.details }
    throw cause
  }
  throw new Error('the file was accepted')
}

describe('writing an organisation backup', () => {
  it('writes the versioned envelope with every section counted, including empty ones', async () => {
    const envelope = JSON.parse(await file(sampleData({ suppliers: [] })))
    expect(envelope).toMatchObject({
      magic: 'LandedCompareBackup',
      backupFormatVersion: 2,
      kind: 'ORGANIZATION_EXPORT',
      schemaVersion: 1,
      compatibility: { cloudSchemaMigration: '20260925120000' },
      createdAt: AT,
      source: { organizationId: ORG, exportedBy: USER },
      entityCounts: { customerStatuses: 1, customers: 1, members: 1, products: 2, suppliers: 0 },
      integrity: { algorithm: 'SHA-256', scope: 'data' },
    })
    expect(envelope.integrity.value).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps exact decimals as the server wrote them — strings, digit for digit, trailing zeros included', async () => {
    const text = await file()
    expect(text).toContain(`"unitsPerPurchaseUnit":{"value":"${HOSTILE}"}`)
    expect(text).toContain('"unitsPerPurchaseUnit":{"value":"1.20"}')
    const parsed = await parseCloudBackup(text)
    expect(parsed.data.products.map((record) => record.unitsPerPurchaseUnit?.value)).toEqual(['1.20', HOSTILE])
    expect(typeof parsed.data.products[1].unitsPerPurchaseUnit?.value).toBe('string')
  })

  it('keeps opaque external codes exactly, including leading zeros and a trailing space', async () => {
    const parsed = await parseCloudBackup(await file())
    expect(parsed.data.suppliers[0].externalRef).toBe('0001 ')
    expect(parsed.data.customers[0].externalRef).toBe('120-34-00-11-001')
  })

  it('is deterministic: the same data in any order produces byte-identical data and one checksum', async () => {
    const forward = sampleData()
    const reversed = sampleData({ products: [...forward.products].reverse() })
    const [left, right] = [JSON.parse(await file(forward)), JSON.parse(await file(reversed))]
    expect(left).toEqual(right)
    expect(left.data.products.map((record: BackupProduct) => record.id)).toEqual([uuid(1, '10000000'), uuid(2, '10000000')])
  })

  it('holds 1000+ records in one section, all of them, in id order', async () => {
    const products = Array.from({ length: 1205 }, (_, index) => product(1205 - index))
    const parsed = await parseCloudBackup(await file(sampleData({ products })))
    expect(parsed.data.products).toHaveLength(1205)
    expect(parsed.manifest.entityCounts.products).toBe(1205)
    expect(new Set(parsed.data.products.map((record) => record.id)).size).toBe(1205)
  })

  it('carries no credential of any kind', async () => {
    const text = (await file()).toLowerCase()
    for (const forbidden of ['password', 'token', 'secret', 'sb_secret_', 'service_role', 'encrypted', 'hash"']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('reading an organisation backup refuses', () => {
  it('a file that is not a LandedCompare backup', async () => {
    expect((await refusal(JSON.stringify({ hello: 'world' }))).code).toBe('BACKUP_NOT_RECOGNISED')
  })

  it('the Phase 8 device backup (wrapper version 1) and any other version', async () => {
    expect((await refusal(await edited((value) => { value.backupFormatVersion = 1 })))).toMatchObject({
      code: 'BACKUP_FORMAT_UNSUPPORTED', details: { backupFormatVersion: 1, supported: String(CLOUD_BACKUP_FORMAT_VERSION) },
    })
    expect((await refusal(await edited((value) => { value.backupFormatVersion = 3 }))).code).toBe('BACKUP_FORMAT_UNSUPPORTED')
  })

  it('a payload version newer than this build', async () => {
    expect((await refusal(await edited((value) => { value.schemaVersion = 2 }))).code).toBe('BACKUP_SCHEMA_TOO_NEW')
  })

  it('a wrong kind, an unknown envelope field, a bad timestamp', async () => {
    expect((await refusal(await edited((value) => { value.kind = 'DEVICE' }))).code).toBe('BACKUP_ENVELOPE_INVALID')
    expect((await refusal(await edited((value) => { value.extra = true }))).code).toBe('BACKUP_ENVELOPE_INVALID')
    expect((await refusal(await edited((value) => { value.createdAt = '25.09.2026' }))).code).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('a missing section, and a section that is not an array', async () => {
    expect((await refusal(await edited((value) => { delete value.data.customers })))).toMatchObject({
      code: 'BACKUP_ENVELOPE_INVALID', details: { section: 'customers' },
    })
    expect((await refusal(await edited((value) => { value.data.members = {} }))).code).toBe('BACKUP_ENVELOPE_INVALID')
    expect((await refusal(await edited((value) => { value.data.projects = [] }))).code).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('counts that disagree with the payload — a truncated file', async () => {
    expect(await refusal(await edited((value) => { value.data.products.pop() }))).toMatchObject({
      code: 'BACKUP_COUNT_MISMATCH', details: { store: 'products', declared: 2, actual: 1 },
    })
  })

  it('a payload whose checksum does not match — a corrupted or edited file', async () => {
    expect((await refusal(await edited((value) => { value.data.products[0].name = 'Edited' }))).code).toBe('BACKUP_CHECKSUM_MISMATCH')
  })

  it('a record with an unknown field, even with a recomputed checksum', async () => {
    expect(await refusal(await edited((value) => { value.data.suppliers[0].password = 'x' }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { section: 'suppliers', field: 'password', reason: 'UNKNOWN_FIELD' },
    })
  })

  it('a duplicate stable id', async () => {
    expect(await refusal(await edited((value) => { value.data.products[1].id = value.data.products[0].id }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { section: 'products', reason: 'DUPLICATE_ID' },
    })
  })

  it('records out of id order', async () => {
    expect(await refusal(await edited((value) => { value.data.products.reverse() }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { section: 'products', reason: 'OUT_OF_ORDER' },
    })
  })

  it('a decimal carried as a JSON number, or in a non-canonical form', async () => {
    for (const bad of [1.2, '1,20', '01.2', '0', '-1', '1e3', '']) {
      expect(await refusal(await edited((value) => { value.data.products[0].unitsPerPurchaseUnit = { value: bad } }, { rechecksum: true }))).toMatchObject({
        code: 'BACKUP_RECORD_INVALID', details: { field: 'unitsPerPurchaseUnit', reason: 'NOT_AN_EXACT_DECIMAL' },
      })
    }
  })

  it('required text that is missing or only invisible characters', async () => {
    expect(await refusal(await edited((value) => { delete value.data.products[0].sku }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { field: 'sku', reason: 'REQUIRED_TEXT' },
    })
    expect(await refusal(await edited((value) => { value.data.suppliers[0].displayName = '​ ' }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { field: 'displayName', reason: 'INVISIBLE_TEXT' },
    })
  })

  it('a record that belongs to another organisation', async () => {
    expect(await refusal(await edited((value) => { value.data.customers[0].organizationId = uuid(9) }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { field: 'organizationId', reason: 'FOREIGN_ORGANIZATION' },
    })
  })

  it('a customer pointing at a status the file does not contain', async () => {
    expect(await refusal(await edited((value) => { value.data.customerStatuses = [] }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { section: 'customers', field: 'customerStatusId', reason: 'MISSING_REFERENCE' },
    })
  })

  it('a member with an unknown role', async () => {
    expect(await refusal(await edited((value) => { value.data.members[0].role = 'SUPERUSER' }, { rechecksum: true }))).toMatchObject({
      code: 'BACKUP_RECORD_INVALID', details: { section: 'members', field: 'role' },
    })
  })

  it('prototype-polluting keys anywhere in the file', async () => {
    const text = (await file()).replace('"data":{', '"data":{"__proto__":{},')
    expect((await refusal(text)).code).toBe('BACKUP_FORBIDDEN_KEY')
  })
})
