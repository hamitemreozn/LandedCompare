/**
 * The portable organisation backup — the file format, and the strict reader
 * that proves a file is structurally usable (Phase 12).
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §16-A and §31.
 *
 * ## What this file is, and what it is not
 *
 * An APPLICATION-LEVEL export of one organisation's LandedCompare data: the
 * catalogue, the customer-status vocabulary, and a members manifest. It is for
 * the company's own safekeeping, inspection and versioning, and it is the
 * input Phase 21's cloud restore will read.
 *
 * It is NOT an infrastructure backup. It cannot rebuild a Supabase project,
 * does not contain the schema, the functions, the policies, Auth accounts or
 * passwords, and nothing in it can sign anybody in. The operator's dump set
 * (§16-B) is the other half, and neither replaces the other.
 *
 * It is also not a second data model. The record shapes below are the
 * gateway's own records, copied field by field into a transport form; the
 * canonical store remains PostgreSQL. Nothing reads this file back into the
 * running application in Phase 12 — the parser exists to prove what was
 * written is complete and well formed.
 *
 * ## The envelope
 *
 * The Phase 8 envelope, re-pointed at a cloud payload, with the wrapper
 * version BUMPED to 2 so that no build that knows only the local format can
 * mistake one for the other:
 *
 *   magic                "LandedCompareBackup" — the same product signature
 *   backupFormatVersion  2 — the Phase 8 local device backup is 1
 *   kind                 "ORGANIZATION_EXPORT"
 *   schemaVersion        the payload version (1): the record shapes in `data`
 *   compatibility        the latest database migration those shapes match
 *   appVersion, createdAt
 *   source               the organisation id and the exporting user's id
 *   entityCounts         every array section, including empty ones
 *   integrity            SHA-256 over the canonical serialisation of `data`
 *   data                 organization, products, suppliers, customers,
 *                        customerStatuses, members
 *
 * The checksum's honest scope is the Phase 8 one: it detects corruption and
 * truncation. It is NOT tamper-proofing and NOT authentication — there is no
 * secret, so whoever edits the payload can recompute it.
 *
 * ## Exact values
 *
 * `unitsPerPurchaseUnit.value` is the decimal STRING the server returned
 * (`numeric::text` in `api.products`), byte for byte: `"1.20"` stays `"1.20"`
 * and `"12345678901234567890.0047"` stays exactly that. External system codes
 * are opaque and are copied exactly — no trimming, no case folding, no
 * interpretation (Logo or otherwise). Nothing in this module turns a value
 * into a JavaScript number.
 *
 * ## Determinism
 *
 * Keys are sorted by the canonical serialiser; every array section is sorted
 * by its stable id (members by user id). Two exports of the same data differ
 * only in `createdAt`, and their `data` checksums are identical.
 */

import { APP_VERSION } from '../../persistence/schema'
import { CATALOG_LIMITS, codePointLength, hasVisibleText, isCanonicalPositiveDecimal, serverTrim } from '../../cloud/catalogRules'
import {
  assertJsonDepthWithin,
  assertTextWithinSizeLimit,
  canonicalize,
  parseUntrustedJson,
} from '../canonicalJson'
import { CHECKSUM_ALGORITHM, isChecksumShape, sha256Hex, type DigestProvider } from '../checksum'
import { BACKUP_MAGIC } from '../envelope'
import { BackupError } from '../errors'
import { MAX_RECORDS_PER_STORE } from '../limits'

export const CLOUD_BACKUP_MAGIC = BACKUP_MAGIC
export const CLOUD_BACKUP_FORMAT_VERSION = 2
export const CLOUD_BACKUP_KIND = 'ORGANIZATION_EXPORT'
/** The payload shapes this build writes and reads. */
export const CLOUD_BACKUP_SCHEMA_VERSION = 1
export const SUPPORTED_CLOUD_BACKUP_SCHEMA_VERSIONS: readonly number[] = [1]
/**
 * The newest migration whose tables the payload shapes describe. Recorded so a
 * later reader can tell which database a file came from; it is provenance,
 * and the reader does not refuse a file for naming an older one.
 */
export const CLOUD_SCHEMA_MIGRATION = '20260925120000'
export const CLOUD_INTEGRITY_SCOPE = 'data'

/** The array sections, in the order the envelope lists them. */
export const CLOUD_BACKUP_SECTIONS = ['customerStatuses', 'customers', 'members', 'products', 'suppliers'] as const
export type CloudBackupSection = (typeof CLOUD_BACKUP_SECTIONS)[number]
export type CloudBackupCounts = Readonly<Record<CloudBackupSection, number>>

type Role = 'OWNER' | 'ADMIN' | 'MEMBER'
type Status = 'ACTIVE' | 'DISABLED'

interface AuditedRecord {
  readonly id: string
  readonly organizationId: string
  readonly active: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy?: string
  readonly updatedBy?: string
  readonly version: number
}

export interface BackupProduct extends AuditedRecord {
  readonly sku: string
  readonly name: string
  readonly description?: string
  readonly stockUnit: string
  readonly defaultPurchaseUnit?: string
  /** Exact decimal text, exactly as the server returned it. */
  readonly unitsPerPurchaseUnit?: { readonly value: string }
  readonly manufacturer?: string
  readonly manufacturerRef?: string
  readonly note?: string
}

export interface BackupSupplier extends AuditedRecord {
  readonly displayName: string
  /** Opaque external-system code, copied exactly. */
  readonly externalRef?: string
  readonly note?: string
}

export interface BackupCustomer extends AuditedRecord {
  readonly displayName: string
  /** Opaque external-system code, copied exactly. */
  readonly externalRef?: string
  readonly customerStatusId?: string
  readonly note?: string
}

export interface BackupCustomerStatus extends AuditedRecord {
  readonly code: string
  readonly sortOrder: number
}

/**
 * Who should have access, and as what — the manifest that makes access
 * recoverable if Auth accounts ever have to be re-created (§16-B). No
 * password, token, hash or any other credential; an e-mail address is an
 * identifier, and re-provisioning from it issues new credentials.
 */
export interface BackupMember {
  readonly userId: string
  readonly displayName: string | null
  readonly email: string | null
  readonly role: Role
  readonly status: Status
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface BackupOrganization {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly updatedAt: string
}

export interface CloudBackupData {
  readonly organization: BackupOrganization
  readonly customerStatuses: readonly BackupCustomerStatus[]
  readonly customers: readonly BackupCustomer[]
  readonly members: readonly BackupMember[]
  readonly products: readonly BackupProduct[]
  readonly suppliers: readonly BackupSupplier[]
}

export interface CloudBackupManifest {
  readonly magic: typeof CLOUD_BACKUP_MAGIC
  readonly backupFormatVersion: typeof CLOUD_BACKUP_FORMAT_VERSION
  readonly kind: typeof CLOUD_BACKUP_KIND
  readonly schemaVersion: number
  readonly compatibility: { readonly cloudSchemaMigration: string }
  readonly appVersion: string
  readonly createdAt: string
  readonly source: { readonly organizationId: string; readonly exportedBy: string }
  readonly entityCounts: CloudBackupCounts
  readonly integrity: { readonly algorithm: typeof CHECKSUM_ALGORITHM; readonly scope: typeof CLOUD_INTEGRITY_SCOPE; readonly value: string }
}

export interface CloudBackupEnvelope extends CloudBackupManifest {
  readonly data: CloudBackupData
}

const ENVELOPE_KEYS = [
  'appVersion', 'backupFormatVersion', 'compatibility', 'createdAt', 'data', 'entityCounts',
  'integrity', 'kind', 'magic', 'schemaVersion', 'source',
]
const DATA_KEYS = ['organization', ...CLOUD_BACKUP_SECTIONS]
const AUDIT_KEYS = ['id', 'organizationId', 'active', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'version']
const PRODUCT_KEYS = [...AUDIT_KEYS, 'sku', 'name', 'description', 'stockUnit', 'defaultPurchaseUnit', 'unitsPerPurchaseUnit', 'manufacturer', 'manufacturerRef', 'note']
const PARTY_KEYS = [...AUDIT_KEYS, 'displayName', 'externalRef', 'note']
const CUSTOMER_KEYS = [...PARTY_KEYS, 'customerStatusId']
const STATUS_KEYS = [...AUDIT_KEYS, 'code', 'sortOrder']
const MEMBER_KEYS = ['userId', 'displayName', 'email', 'role', 'status', 'version', 'createdAt', 'updatedAt']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MIGRATION_ID = /^\d{14}$/
/** Shape only: Auth decided the address; this refuses what is plainly not one. */
const EMAIL = /^[^@\s]+@[^@\s]+$/
/** `customer_statuses_sort_order_safe`. */
const SORT_ORDER_LIMIT = 1_000_000
/** `customer_statuses_code_valid`. */
const STATUS_CODE_LIMIT = 100

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Sorted copies: the writer's half of determinism. */
export function sortCloudBackupData(data: CloudBackupData): CloudBackupData {
  const byId = <T extends { readonly id: string }>(records: readonly T[]) => [...records].sort((a, b) => compareText(a.id, b.id))
  return {
    organization: data.organization,
    customerStatuses: byId(data.customerStatuses),
    customers: byId(data.customers),
    members: [...data.members].sort((a, b) => compareText(a.userId, b.userId)),
    products: byId(data.products),
    suppliers: byId(data.suppliers),
  }
}

export function countCloudBackupSections(data: CloudBackupData): CloudBackupCounts {
  return {
    customerStatuses: data.customerStatuses.length,
    customers: data.customers.length,
    members: data.members.length,
    products: data.products.length,
    suppliers: data.suppliers.length,
  }
}

export interface BuildCloudBackupOptions {
  readonly data: CloudBackupData
  readonly createdAt: string
  readonly exportedBy: string
  readonly appVersion?: string
  readonly digestProvider?: DigestProvider
}

/** A complete, sorted, checksummed envelope. */
export async function buildCloudBackupEnvelope(options: BuildCloudBackupOptions): Promise<CloudBackupEnvelope> {
  const data = sortCloudBackupData(options.data)
  const value = await sha256Hex(canonicalize(data, 'data'), options.digestProvider)
  return {
    magic: CLOUD_BACKUP_MAGIC,
    backupFormatVersion: CLOUD_BACKUP_FORMAT_VERSION,
    kind: CLOUD_BACKUP_KIND,
    schemaVersion: CLOUD_BACKUP_SCHEMA_VERSION,
    compatibility: { cloudSchemaMigration: CLOUD_SCHEMA_MIGRATION },
    appVersion: options.appVersion ?? APP_VERSION,
    createdAt: options.createdAt,
    source: { organizationId: data.organization.id, exportedBy: options.exportedBy },
    entityCounts: countCloudBackupSections(data),
    integrity: { algorithm: CHECKSUM_ALGORITHM, scope: CLOUD_INTEGRITY_SCOPE, value },
    data,
  }
}

/** The file's bytes: canonical JSON, so equivalent exports are byte-comparable. */
export function serialiseCloudBackup(envelope: CloudBackupEnvelope): string {
  return canonicalize(envelope, 'backup')
}

// ---------------------------------------------------------------------------
// Reading — structural validation, in a fixed order, each step with its own code
// ---------------------------------------------------------------------------

function envelopeFailure(reason: string, details: Record<string, string | number> = {}): BackupError {
  return new BackupError('BACKUP_ENVELOPE_INVALID', `Organisation backup envelope is invalid: ${reason}`, {
    details: { reason, ...details },
  })
}

function recordFailure(section: string, index: number, field: string, reason: string): BackupError {
  return new BackupError('BACKUP_RECORD_INVALID', `Organisation backup record ${section}[${index}].${field} is invalid: ${reason}`, {
    details: { section, index, field, reason },
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key))
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** One record-level checker: returns the failing field and reason, or undefined. */
type FieldProblem = readonly [field: string, reason: string] | undefined

function requiredIdentifier(record: Record<string, unknown>, field: string, limit: number): FieldProblem {
  const value = record[field]
  if (typeof value !== 'string') return [field, 'REQUIRED_TEXT']
  if (!hasVisibleText(value)) return [field, 'INVISIBLE_TEXT']
  if (codePointLength(value) > limit) return [field, 'TOO_LONG']
  return undefined
}

/**
 * Optional text is either absent or a string the server could have stored:
 * within its limit and not blank BY THE SERVER'S RULE — `nullif(btrim(x), '')`
 * removes ASCII spaces only, so a value of one tab is legitimately stored and
 * must be accepted here exactly as it is.
 */
function optionalText(record: Record<string, unknown>, field: string, limit: number): FieldProblem {
  if (!(field in record)) return undefined
  const value = record[field]
  if (typeof value !== 'string') return [field, 'NOT_TEXT']
  if (serverTrim(value) === '') return [field, 'BLANK_TEXT']
  if (codePointLength(value) > limit) return [field, 'TOO_LONG']
  return undefined
}

function auditProblem(record: Record<string, unknown>, organizationId: string): FieldProblem {
  if (typeof record.id !== 'string' || !UUID.test(record.id)) return ['id', 'NOT_A_UUID']
  if (record.organizationId !== organizationId) return ['organizationId', 'FOREIGN_ORGANIZATION']
  if (typeof record.active !== 'boolean') return ['active', 'NOT_BOOLEAN']
  if (typeof record.createdAt !== 'string' || !INSTANT.test(record.createdAt)) return ['createdAt', 'NOT_AN_INSTANT']
  if (typeof record.updatedAt !== 'string' || !INSTANT.test(record.updatedAt)) return ['updatedAt', 'NOT_AN_INSTANT']
  for (const field of ['createdBy', 'updatedBy']) {
    if (field in record && (typeof record[field] !== 'string' || !UUID.test(record[field] as string))) return [field, 'NOT_A_UUID']
  }
  if (!isNonNegativeInteger(record.version) || record.version < 1) return ['version', 'NOT_A_VERSION']
  return undefined
}

function productProblem(record: Record<string, unknown>): FieldProblem {
  const limits = CATALOG_LIMITS.products
  const problem =
    requiredIdentifier(record, 'sku', limits.sku) ??
    requiredIdentifier(record, 'name', limits.name) ??
    requiredIdentifier(record, 'stockUnit', limits.stockUnit) ??
    optionalText(record, 'description', limits.description) ??
    optionalText(record, 'defaultPurchaseUnit', limits.defaultPurchaseUnit) ??
    optionalText(record, 'manufacturer', limits.manufacturer) ??
    optionalText(record, 'manufacturerRef', limits.manufacturerRef) ??
    optionalText(record, 'note', limits.note)
  if (problem) return problem
  if ('unitsPerPurchaseUnit' in record) {
    const quantity = record.unitsPerPurchaseUnit
    if (!isObject(quantity) || exactKeys(quantity, ['value']) !== undefined || !('value' in quantity)) {
      return ['unitsPerPurchaseUnit', 'NOT_A_DECIMAL_OBJECT']
    }
    // A string, and a canonical positive one — a JSON number here would
    // already have lost digits in whatever produced it.
    if (typeof quantity.value !== 'string' || !isCanonicalPositiveDecimal(quantity.value)) {
      return ['unitsPerPurchaseUnit', 'NOT_AN_EXACT_DECIMAL']
    }
  }
  return undefined
}

function partyProblem(record: Record<string, unknown>): FieldProblem {
  const limits = CATALOG_LIMITS.parties
  return (
    requiredIdentifier(record, 'displayName', limits.displayName) ??
    optionalText(record, 'externalRef', limits.externalRef) ??
    optionalText(record, 'note', limits.note)
  )
}

function customerProblem(record: Record<string, unknown>): FieldProblem {
  const problem = partyProblem(record)
  if (problem) return problem
  if ('customerStatusId' in record && (typeof record.customerStatusId !== 'string' || !UUID.test(record.customerStatusId))) {
    return ['customerStatusId', 'NOT_A_UUID']
  }
  return undefined
}

function statusProblem(record: Record<string, unknown>): FieldProblem {
  const problem = requiredIdentifier(record, 'code', STATUS_CODE_LIMIT)
  if (problem) return problem
  if (typeof record.sortOrder !== 'number' || !Number.isSafeInteger(record.sortOrder) || Math.abs(record.sortOrder) > SORT_ORDER_LIMIT) {
    return ['sortOrder', 'NOT_A_SORT_ORDER']
  }
  return undefined
}

function memberProblem(record: Record<string, unknown>): FieldProblem {
  if (typeof record.userId !== 'string' || !UUID.test(record.userId)) return ['userId', 'NOT_A_UUID']
  // `profiles_display_name_not_blank` is `btrim(display_name) <> ''`.
  if (record.displayName !== null && (typeof record.displayName !== 'string' || serverTrim(record.displayName) === '')) {
    return ['displayName', 'REQUIRED_TEXT']
  }
  if (record.email !== null && (typeof record.email !== 'string' || !EMAIL.test(record.email))) return ['email', 'NOT_AN_EMAIL']
  if (record.role !== 'OWNER' && record.role !== 'ADMIN' && record.role !== 'MEMBER') return ['role', 'UNKNOWN_ROLE']
  if (record.status !== 'ACTIVE' && record.status !== 'DISABLED') return ['status', 'UNKNOWN_STATUS']
  if (!isNonNegativeInteger(record.version) || record.version < 1) return ['version', 'NOT_A_VERSION']
  if (typeof record.createdAt !== 'string' || !INSTANT.test(record.createdAt)) return ['createdAt', 'NOT_AN_INSTANT']
  if (typeof record.updatedAt !== 'string' || !INSTANT.test(record.updatedAt)) return ['updatedAt', 'NOT_AN_INSTANT']
  return undefined
}

interface SectionRule {
  readonly keys: readonly string[]
  readonly idField: 'id' | 'userId'
  readonly audited: boolean
  readonly check: (record: Record<string, unknown>) => FieldProblem
}

const SECTION_RULES: Readonly<Record<CloudBackupSection, SectionRule>> = {
  customerStatuses: { keys: STATUS_KEYS, idField: 'id', audited: true, check: statusProblem },
  customers: { keys: CUSTOMER_KEYS, idField: 'id', audited: true, check: customerProblem },
  members: { keys: MEMBER_KEYS, idField: 'userId', audited: false, check: memberProblem },
  products: { keys: PRODUCT_KEYS, idField: 'id', audited: true, check: productProblem },
  suppliers: { keys: PARTY_KEYS, idField: 'id', audited: true, check: partyProblem },
}

function validateSection(section: CloudBackupSection, records: readonly unknown[], organizationId: string): void {
  const rule = SECTION_RULES[section]
  const seen = new Set<string>()
  let previous: string | undefined
  records.forEach((value, index) => {
    if (!isObject(value)) throw recordFailure(section, index, '$', 'NOT_AN_OBJECT')
    const unknown = exactKeys(value, rule.keys)
    if (unknown !== undefined) throw recordFailure(section, index, unknown, 'UNKNOWN_FIELD')
    const problem = (rule.audited ? auditProblem(value, organizationId) : undefined) ?? rule.check(value)
    if (problem) throw recordFailure(section, index, problem[0], problem[1])
    const id = value[rule.idField] as string
    if (seen.has(id)) throw recordFailure(section, index, rule.idField, 'DUPLICATE_ID')
    seen.add(id)
    // The writer sorts every section by its id, so a file out of order was
    // not written by this application and is refused rather than re-sorted.
    if (previous !== undefined && compareText(previous, id) > 0) throw recordFailure(section, index, rule.idField, 'OUT_OF_ORDER')
    previous = id
  })
}

function parseOrganization(value: unknown, organizationId: string): BackupOrganization {
  if (!isObject(value)) throw envelopeFailure('data.organization must be an object')
  if (exactKeys(value, ['id', 'name', 'version', 'updatedAt']) !== undefined) throw envelopeFailure('data.organization carries an unknown field')
  if (value.id !== organizationId) throw envelopeFailure('data.organization.id must equal source.organizationId')
  // `organizations_name_not_blank` is `btrim(name) <> ''`.
  if (typeof value.name !== 'string' || serverTrim(value.name) === '') throw envelopeFailure('data.organization.name must not be blank')
  if (!isNonNegativeInteger(value.version) || value.version < 1) throw envelopeFailure('data.organization.version must be a positive integer')
  if (typeof value.updatedAt !== 'string' || !INSTANT.test(value.updatedAt)) throw envelopeFailure('data.organization.updatedAt must be an instant')
  return { id: value.id, name: value.name, version: value.version, updatedAt: value.updatedAt }
}

export interface ParsedCloudBackup {
  readonly manifest: CloudBackupManifest
  readonly data: CloudBackupData
}

export interface ParseCloudBackupOptions {
  readonly digestProvider?: DigestProvider
}

/**
 * Reads an organisation backup and proves it is complete and well formed, or
 * refuses it with a specific code. Accepts the file's text or an already
 * parsed value.
 *
 * Order: size and depth before parsing; prototype-safe parsing; magic;
 * wrapper version; kind; the manifest; the data sections' presence; counts
 * against the payload; the checksum; then every record, with duplicate ids,
 * order and the customer → status references. Nothing is repaired.
 */
export async function parseCloudBackup(input: string | unknown, options: ParseCloudBackupOptions = {}): Promise<ParsedCloudBackup> {
  let value: unknown = input
  if (typeof input === 'string') {
    assertTextWithinSizeLimit(input)
    assertJsonDepthWithin(input)
    value = parseUntrustedJson(input)
  }

  if (!isObject(value)) throw envelopeFailure('expected a JSON object')
  if (value.magic !== CLOUD_BACKUP_MAGIC) {
    throw new BackupError('BACKUP_NOT_RECOGNISED', 'This file is not a LandedCompare backup', { details: { expected: CLOUD_BACKUP_MAGIC } })
  }
  if (value.backupFormatVersion !== CLOUD_BACKUP_FORMAT_VERSION) {
    throw new BackupError('BACKUP_FORMAT_UNSUPPORTED', 'This file is not an organisation backup this build reads', {
      details: {
        backupFormatVersion: typeof value.backupFormatVersion === 'number' ? value.backupFormatVersion : String(value.backupFormatVersion),
        supported: String(CLOUD_BACKUP_FORMAT_VERSION),
      },
    })
  }
  const unknownKey = exactKeys(value, ENVELOPE_KEYS)
  if (unknownKey !== undefined) throw envelopeFailure('the envelope carries a field this build does not know', { field: unknownKey })
  if (value.kind !== CLOUD_BACKUP_KIND) throw envelopeFailure('kind must be ORGANIZATION_EXPORT')

  if (typeof value.schemaVersion !== 'number' || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw envelopeFailure('schemaVersion must be a positive integer')
  }
  if (!SUPPORTED_CLOUD_BACKUP_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    const newest = Math.max(...SUPPORTED_CLOUD_BACKUP_SCHEMA_VERSIONS)
    throw new BackupError(
      value.schemaVersion > newest ? 'BACKUP_SCHEMA_TOO_NEW' : 'BACKUP_SCHEMA_UNSUPPORTED',
      `This build does not read organisation backup payload version ${value.schemaVersion}`,
      { details: { schemaVersion: value.schemaVersion, supported: SUPPORTED_CLOUD_BACKUP_SCHEMA_VERSIONS.join(',') } },
    )
  }

  const compatibility = value.compatibility
  if (!isObject(compatibility) || exactKeys(compatibility, ['cloudSchemaMigration']) !== undefined ||
      typeof compatibility.cloudSchemaMigration !== 'string' || !MIGRATION_ID.test(compatibility.cloudSchemaMigration)) {
    throw envelopeFailure('compatibility.cloudSchemaMigration must be a migration timestamp')
  }
  if (typeof value.appVersion !== 'string' || value.appVersion.trim() === '') throw envelopeFailure('appVersion must be a non-empty string')
  if (typeof value.createdAt !== 'string' || !INSTANT.test(value.createdAt)) throw envelopeFailure('createdAt must be an ISO-8601 UTC instant')

  const source = value.source
  if (!isObject(source) || exactKeys(source, ['organizationId', 'exportedBy']) !== undefined ||
      typeof source.organizationId !== 'string' || !UUID.test(source.organizationId) ||
      typeof source.exportedBy !== 'string' || !UUID.test(source.exportedBy)) {
    throw envelopeFailure('source must name the organisation and the exporting user by id')
  }
  const organizationId = source.organizationId

  const counts = value.entityCounts
  if (!isObject(counts)) throw envelopeFailure('entityCounts must be an object')
  const unknownCount = exactKeys(counts, CLOUD_BACKUP_SECTIONS)
  if (unknownCount !== undefined) throw envelopeFailure('entityCounts names a section this build does not know', { section: unknownCount })
  for (const section of CLOUD_BACKUP_SECTIONS) {
    if (!isNonNegativeInteger(counts[section])) throw envelopeFailure('entityCounts must list every section as a non-negative integer', { section })
  }

  const integrity = value.integrity
  if (!isObject(integrity) || exactKeys(integrity, ['algorithm', 'scope', 'value']) !== undefined ||
      integrity.algorithm !== CHECKSUM_ALGORITHM || integrity.scope !== CLOUD_INTEGRITY_SCOPE || !isChecksumShape(integrity.value)) {
    throw envelopeFailure('integrity must be a SHA-256 over data')
  }

  const data = value.data
  if (!isObject(data)) throw envelopeFailure('data must be an object')
  const unknownSection = exactKeys(data, DATA_KEYS)
  if (unknownSection !== undefined) throw envelopeFailure('data names a section this build does not know', { section: unknownSection })
  const organization = parseOrganization(data.organization, organizationId)
  for (const section of CLOUD_BACKUP_SECTIONS) {
    const records = data[section]
    if (!Array.isArray(records)) throw envelopeFailure('data must contain an array for every section', { section })
    if (records.length > MAX_RECORDS_PER_STORE) {
      throw new BackupError('BACKUP_TOO_LARGE', 'A section exceeds the supported record count', { details: { section, count: records.length } })
    }
  }

  // The manifest is outside the checksum, so its counts are cross-checked
  // against the payload: a truncated or hand-edited file disagrees here.
  for (const section of CLOUD_BACKUP_SECTIONS) {
    const actual = (data[section] as unknown[]).length
    if (counts[section] !== actual) {
      throw new BackupError('BACKUP_COUNT_MISMATCH', `The backup declares ${String(counts[section])} ${section} but carries ${actual}`, {
        details: { store: section, declared: counts[section] as number, actual },
      })
    }
  }

  const actualChecksum = await sha256Hex(canonicalize(data, 'data'), options.digestProvider)
  if (actualChecksum !== integrity.value) {
    throw new BackupError('BACKUP_CHECKSUM_MISMATCH', 'The organisation backup failed its integrity check; it is corrupt, truncated or edited', {
      details: { expected: integrity.value, actual: actualChecksum, algorithm: CHECKSUM_ALGORITHM },
    })
  }

  for (const section of CLOUD_BACKUP_SECTIONS) {
    validateSection(section, data[section] as unknown[], organizationId)
  }

  const statusIds = new Set((data.customerStatuses as { id: string }[]).map((status) => status.id))
  ;(data.customers as { customerStatusId?: string }[]).forEach((customer, index) => {
    if (customer.customerStatusId !== undefined && !statusIds.has(customer.customerStatusId)) {
      throw recordFailure('customers', index, 'customerStatusId', 'MISSING_REFERENCE')
    }
  })

  const manifest: CloudBackupManifest = {
    magic: CLOUD_BACKUP_MAGIC,
    backupFormatVersion: CLOUD_BACKUP_FORMAT_VERSION,
    kind: CLOUD_BACKUP_KIND,
    schemaVersion: value.schemaVersion,
    compatibility: { cloudSchemaMigration: compatibility.cloudSchemaMigration },
    appVersion: value.appVersion,
    createdAt: value.createdAt,
    source: { organizationId, exportedBy: source.exportedBy },
    entityCounts: Object.fromEntries(CLOUD_BACKUP_SECTIONS.map((section) => [section, counts[section] as number])) as CloudBackupCounts,
    integrity: { algorithm: CHECKSUM_ALGORITHM, scope: CLOUD_INTEGRITY_SCOPE, value: integrity.value },
  }

  return {
    manifest,
    data: {
      organization,
      customerStatuses: data.customerStatuses as BackupCustomerStatus[],
      customers: data.customers as BackupCustomer[],
      members: data.members as BackupMember[],
      products: data.products as BackupProduct[],
      suppliers: data.suppliers as BackupSupplier[],
    },
  }
}
