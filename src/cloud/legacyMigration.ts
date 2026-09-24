/**
 * One-time Phase 9 IndexedDB → Phase 11 PostgreSQL catalog cutover.
 *
 * The local database is opened only while the authenticated user is on the
 * migration screen. It is never a fallback read source for the running cloud
 * application.
 *
 * ## What proves the cutover (Audit A, A-M1)
 *
 * The earlier design compared the organisation's WHOLE cloud row count with
 * the legacy row count. That broke permanently beyond 1000 rows (PostgREST's
 * response cap), the moment a colleague added a record, on a second device
 * whose catalogue was already in the cloud, and on any record the server
 * refused. Each case locked the device on the migration screen for good.
 *
 * Proof is now per record. The complete cloud catalogue is read (paginated,
 * `gateway.ts`), and every legacy record is classified by its stable id:
 *
 *   PRESENT    the cloud holds it, in the form the server's own normalisation
 *              would have produced from the legacy value — text trimmed as
 *              `btrim` trims it, and a decimal equal by exact VALUE (`1.20`
 *              is `1.2`), never by its textual scale
 *   CONFLICT   the cloud holds a record with that id, or a product with that
 *              SKU, that differs
 *   MISSING    the cloud does not hold it
 *
 * Extra cloud rows are not this migration's business and never block it. The
 * local database is retired only when EVERY legacy record is PRESENT — whether
 * because this call imported them, a lost-response retry finds them already
 * there, or another device imported the same catalogue first. A conflict, or
 * missing records in a cloud catalogue that is already in use, fails closed
 * with a named reason and the record that caused it; nothing is merged.
 *
 * The only way past a genuine conflict is `retireLegacyCatalogWithBackup`: an
 * explicit OWNER decision, preceded by a fresh complete backup file, that
 * keeps the cloud as it is and removes the stale local copy.
 */
import {
  BACKUP_STORE_NAMES,
  createSnapshot,
  downloadBackup,
  ensurePreMigrationSnapshot,
  exportBackup,
  readBusinessData,
  validateBackupData,
  type BackupArtifact,
} from '../backup'
import {
  DATABASE_NAME,
  deleteDatabase,
  openDatabase,
  readStoredSchemaVersion,
  type CustomerRecord as LegacyCustomer,
  type ProductRecord as LegacyProduct,
  type SupplierRecord as LegacySupplier,
} from '../persistence'
import {
  CATALOG_LIMITS,
  codePointLength,
  hasVisibleText,
  isCanonicalPositiveDecimal,
  sameExactDecimal,
  serverOptional,
  serverTrim,
} from './catalogRules'
import type { CustomerRecord, DataGateway, MembershipRole, ProductRecord, SupplierRecord } from './gateway'
import { CloudError, isCloudError } from './errors'

export const CATALOG_CUTOVER_MARKER_KEY = 'landedcompare.catalog-cloud-cutover.v1'
export const CATALOG_IMPORT_ATTEMPT_KEY = 'landedcompare.catalog-cloud-import-attempt.v1'

export interface LegacyCatalogCounts {
  readonly products: number
  readonly suppliers: number
  readonly customers: number
  readonly otherBusinessRecords: number
}

export type LegacyCatalogInspection =
  | { readonly state: 'COMPLETE' | 'NO_LEGACY_DATABASE' }
  | { readonly state: 'EMPTY_DATABASE'; readonly counts: LegacyCatalogCounts }
  | { readonly state: 'MIGRATION_REQUIRED'; readonly counts: LegacyCatalogCounts }

export interface LegacyMigrationOptions {
  readonly databaseName?: string
  readonly indexedDBFactory?: IDBFactory
  readonly storage?: Storage
  readonly now?: () => string
  readonly generateId?: () => string
  readonly deliverBackup?: (artifact: BackupArtifact) => void | Promise<void>
  /**
   * The caller's live role. Importing is OWNER-only; verifying that the cloud
   * already holds this catalogue — and retiring the local copy when it does —
   * writes nothing to the server and is open to any active member.
   */
  readonly role?: MembershipRole
  /**
   * Called immediately before the local database is deleted, and again before
   * the completion marker is written. The application uses it to confirm the
   * action still belongs to the signed-in user and the application state that
   * started it (Audit A source review, R-4): a backup delivery can take as
   * long as the user likes, and the session can change meanwhile. A rejection
   * aborts — before the deletion, nothing is deleted; after it, nothing is
   * marked.
   */
  readonly confirmAuthority?: () => void | Promise<void>
}

export type LegacyStore = 'products' | 'suppliers' | 'customers'

/** Why a cutover stopped. Every one of them leaves the local database in place. */
export type LegacyMigrationReason =
  /** The local database holds records from later modules; catalogue-only migration would drop them. */
  | 'LEGACY_UNSUPPORTED_RECORDS'
  /** A local record breaks a server rule; it is named, and nothing was sent. */
  | 'LEGACY_RECORD_INVALID'
  /** A local record and the cloud record with the same identity differ. */
  | 'LEGACY_CONFLICT'
  /** The cloud catalogue is in use and lacks some local records; nothing is merged. */
  | 'CLOUD_NOT_EMPTY'
  /** The cloud lacks the catalogue and only an OWNER may import it. */
  | 'IMPORT_REQUIRES_OWNER'
  /** The server accepted the import but reading it back did not prove every record. */
  | 'VERIFICATION_FAILED'

export interface LegacyMigrationDetails {
  readonly store?: LegacyStore
  readonly id?: string
  readonly field?: string
  readonly rule?: string
  readonly count?: number
}

export class LegacyMigrationError extends Error {
  readonly reason: LegacyMigrationReason
  readonly details: LegacyMigrationDetails

  constructor(reason: LegacyMigrationReason, message: string, details: LegacyMigrationDetails = {}) {
    super(message)
    this.name = 'LegacyMigrationError'
    this.reason = reason
    this.details = details
  }
}

export function isLegacyMigrationError(value: unknown): value is LegacyMigrationError {
  return value instanceof LegacyMigrationError
}

/** The outcome of a completed cutover. */
export interface LegacyMigrationResult extends LegacyCatalogCounts {
  /** False when the cloud already held every record and nothing was sent. */
  readonly imported: boolean
}

function storageOf(storage: Storage | undefined): Storage | undefined {
  return storage ?? (globalThis as { localStorage?: Storage }).localStorage
}

function databaseFactory(factory: IDBFactory | undefined): IDBFactory | undefined {
  return factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB
}

function completionOrganization(storage: Storage | undefined): string | undefined {
  const value = storage?.getItem(CATALOG_CUTOVER_MARKER_KEY)
  if (value === null || value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as Record<string, unknown>).organizationId === 'string'
      ? (parsed as { organizationId: string }).organizationId
      : undefined
  } catch {
    return undefined
  }
}

async function databaseExists(name: string, factory: IDBFactory): Promise<boolean> {
  const list = (factory as { databases?: () => Promise<IDBDatabaseInfo[]> }).databases
  if (typeof list !== 'function') {
    throw new CloudError(
      'RECORD_INVALID',
      'this browser cannot safely determine whether a legacy database exists',
      { migration: 'DATABASE_ENUMERATION_UNAVAILABLE' },
    )
  }
  const entries = await list.call(factory)
  return entries.some((entry) => entry.name === name)
}

async function validatedLegacyData(options: LegacyMigrationOptions) {
  const name = options.databaseName ?? DATABASE_NAME
  await ensurePreMigrationSnapshot({
    name,
    indexedDBFactory: options.indexedDBFactory,
    now: options.now,
  })
  const database = await openDatabase({
    name,
    indexedDBFactory: options.indexedDBFactory,
    now: options.now,
    generateId: options.generateId,
  })
  try {
    const raw = await database.read(BACKUP_STORE_NAMES, readBusinessData)
    return { database, data: validateBackupData(raw) }
  } catch (cause) {
    database.close()
    throw cause
  }
}

type LegacyData = Awaited<ReturnType<typeof validatedLegacyData>>['data']

function countsOf(data: LegacyData): LegacyCatalogCounts {
  const products = data.products.length
  const suppliers = data.suppliers.length
  const customers = data.customers.length
  const otherBusinessRecords = BACKUP_STORE_NAMES
    .filter((store) => !['products', 'suppliers', 'customers'].includes(store))
    .reduce((total, store) => total + data[store].length, 0)
  return { products, suppliers, customers, otherBusinessRecords }
}

function legacyProducts(data: LegacyData): readonly LegacyProduct[] {
  return data.products as readonly LegacyProduct[]
}
function legacySuppliers(data: LegacyData): readonly LegacySupplier[] {
  return data.suppliers as readonly LegacySupplier[]
}
function legacyCustomers(data: LegacyData): readonly LegacyCustomer[] {
  return data.customers as readonly LegacyCustomer[]
}

// ───────────────────────── server-rule pre-check ─────────────────────────

interface Problem {
  readonly store: LegacyStore
  readonly id: string
  readonly field: string
  readonly rule: 'REQUIRED' | 'VISIBLE' | 'LENGTH' | 'DECIMAL' | 'DUPLICATE_SKU' | 'SECTION_SIZE'
}

function textProblem(
  store: LegacyStore,
  id: string,
  field: string,
  value: string | undefined,
  limit: number,
  required: boolean,
): Problem | undefined {
  if (value === undefined) {
    return required ? { store, id, field, rule: 'REQUIRED' } : undefined
  }
  if (codePointLength(value) > limit) return { store, id, field, rule: 'LENGTH' }
  if (required && serverTrim(value) === '') return { store, id, field, rule: 'REQUIRED' }
  if (required && !hasVisibleText(value)) return { store, id, field, rule: 'VISIBLE' }
  return undefined
}

/**
 * The first legacy record the server import would refuse, named — or nothing.
 *
 * The Phase 8 validators prove a record is structurally a legacy record; they
 * impose no length limits, because IndexedDB had none. The server does, so a
 * record that was valid locally can be refused there. Finding it here means
 * the refusal names the record, and the request is never sent.
 */
export function findImportProblem(data: LegacyData): Problem | undefined {
  const limits = CATALOG_LIMITS
  for (const store of ['products', 'suppliers', 'customers'] as const) {
    if (data[store].length > limits.recordsPerSection) {
      return { store, id: '', field: store, rule: 'SECTION_SIZE' }
    }
  }
  const skus = new Map<string, string>()
  for (const product of legacyProducts(data)) {
    const checks = [
      textProblem('products', product.id, 'sku', product.sku, limits.products.sku, true),
      textProblem('products', product.id, 'name', product.name, limits.products.name, true),
      textProblem('products', product.id, 'stockUnit', product.stockUnit, limits.products.stockUnit, true),
      textProblem('products', product.id, 'description', product.description, limits.products.description, false),
      textProblem('products', product.id, 'defaultPurchaseUnit', product.defaultPurchaseUnit, limits.products.defaultPurchaseUnit, false),
      textProblem('products', product.id, 'manufacturer', product.manufacturer, limits.products.manufacturer, false),
      textProblem('products', product.id, 'manufacturerRef', product.manufacturerRef, limits.products.manufacturerRef, false),
      textProblem('products', product.id, 'note', product.note, limits.products.note, false),
    ]
    const problem = checks.find((check) => check !== undefined)
    if (problem) return problem
    const factor = product.unitsPerPurchaseUnit?.value
    if (factor !== undefined && !isCanonicalPositiveDecimal(factor)) {
      return { store: 'products', id: product.id, field: 'unitsPerPurchaseUnit', rule: 'DECIMAL' }
    }
    const key = serverTrim(product.sku).toLowerCase()
    if (skus.has(key)) {
      return { store: 'products', id: product.id, field: 'sku', rule: 'DUPLICATE_SKU' }
    }
    skus.set(key, product.id)
  }
  for (const [store, records] of [
    ['suppliers', legacySuppliers(data)],
    ['customers', legacyCustomers(data)],
  ] as const) {
    for (const party of records as readonly (LegacySupplier & { externalRef?: string })[]) {
      const checks = [
        textProblem(store, party.id, 'displayName', party.displayName, limits.parties.displayName, true),
        textProblem(store, party.id, 'externalRef', party.externalRef, limits.parties.externalRef, false),
        textProblem(store, party.id, 'note', party.note, limits.parties.note, false),
      ]
      const problem = checks.find((check) => check !== undefined)
      if (problem) return problem
    }
  }
  return undefined
}

// ───────────────────────── per-record proof ─────────────────────────

function sameOptional(local: string | undefined, cloud: string | undefined): boolean {
  return serverOptional(local) === cloud
}

/** The first field on which the cloud product is NOT what the import would have stored. */
function productDifference(local: LegacyProduct, cloud: ProductRecord): string | undefined {
  if (serverTrim(local.sku) !== cloud.sku) return 'sku'
  if (serverTrim(local.name) !== cloud.name) return 'name'
  if (serverTrim(local.stockUnit) !== cloud.stockUnit) return 'stockUnit'
  if (!sameOptional(local.description, cloud.description)) return 'description'
  if (!sameOptional(local.defaultPurchaseUnit, cloud.defaultPurchaseUnit)) return 'defaultPurchaseUnit'
  // Economic value, not representation: the cloud keeps the scale PostgreSQL
  // was given, the app writes Quantity's shortest form, and `1.20` is `1.2`.
  if (!sameExactDecimal(local.unitsPerPurchaseUnit?.value, cloud.unitsPerPurchaseUnit?.value)) return 'unitsPerPurchaseUnit'
  if (!sameOptional(local.manufacturer, cloud.manufacturer)) return 'manufacturer'
  if (!sameOptional(local.manufacturerRef, cloud.manufacturerRef)) return 'manufacturerRef'
  if (!sameOptional(local.note, cloud.note)) return 'note'
  if (local.active !== cloud.active) return 'active'
  return undefined
}

/**
 * Suppliers and customers: the fields a legacy record carries. A customer
 * status assigned in the cloud after the import is additional cloud
 * information, not a disagreement — the legacy record never had one.
 */
function partyDifference(
  local: LegacySupplier & { externalRef?: string },
  cloud: SupplierRecord | CustomerRecord,
): string | undefined {
  if (serverTrim(local.displayName) !== cloud.displayName) return 'displayName'
  if (!sameOptional(local.externalRef, cloud.externalRef)) return 'externalRef'
  if (!sameOptional(local.note, cloud.note)) return 'note'
  if (local.active !== cloud.active) return 'active'
  return undefined
}

interface Comparison {
  readonly missing: readonly { store: LegacyStore; id: string }[]
  readonly conflicts: readonly { store: LegacyStore; id: string; field: string }[]
  /** Whether the cloud organisation already holds ANY catalogue row. */
  readonly cloudInUse: boolean
}

async function compareWithCloud(gateway: DataGateway, organizationId: string, data: LegacyData): Promise<Comparison> {
  // Complete id sets: gateway.ts pages, then reconciles against one exact
  // count, so no record committed before that count is missing here.
  const [products, suppliers, customers] = await Promise.all([
    gateway.catalog.listProducts(organizationId),
    gateway.catalog.listSuppliers(organizationId),
    gateway.catalog.listCustomers(organizationId),
  ])
  const missing: { store: LegacyStore; id: string }[] = []
  const conflicts: { store: LegacyStore; id: string; field: string }[] = []

  const productsById = new Map(products.map((record) => [record.id.toLowerCase(), record]))
  const productsBySku = new Map(products.map((record) => [record.sku.toLowerCase(), record]))
  for (const local of legacyProducts(data)) {
    const cloud = productsById.get(local.id.toLowerCase())
    if (cloud) {
      const field = productDifference(local, cloud)
      if (field) conflicts.push({ store: 'products', id: local.id, field })
      continue
    }
    const sameSku = productsBySku.get(serverTrim(local.sku).toLowerCase())
    if (sameSku) {
      // A different cloud product already owns this SKU: importing would be
      // refused by the unique index, and merging the two is not ours to do.
      conflicts.push({ store: 'products', id: local.id, field: 'sku' })
      continue
    }
    missing.push({ store: 'products', id: local.id })
  }

  for (const [store, locals, clouds] of [
    ['suppliers', legacySuppliers(data), suppliers],
    ['customers', legacyCustomers(data), customers],
  ] as const) {
    const byId = new Map<string, SupplierRecord | CustomerRecord>(
      (clouds as readonly (SupplierRecord | CustomerRecord)[]).map((record) => [record.id.toLowerCase(), record]),
    )
    for (const local of locals as readonly (LegacySupplier & { externalRef?: string })[]) {
      const cloud = byId.get(local.id.toLowerCase())
      if (!cloud) {
        missing.push({ store, id: local.id })
        continue
      }
      const field = partyDifference(local, cloud)
      if (field) conflicts.push({ store, id: local.id, field })
    }
  }

  return {
    missing,
    conflicts,
    cloudInUse: products.length + suppliers.length + customers.length > 0,
  }
}

function blocked(comparison: Comparison): LegacyMigrationError | undefined {
  if (comparison.conflicts.length > 0) {
    const first = comparison.conflicts[0]
    return new LegacyMigrationError(
      'LEGACY_CONFLICT',
      'local records differ from the cloud records with the same identity',
      { store: first.store, id: first.id, field: first.field, count: comparison.conflicts.length },
    )
  }
  if (comparison.missing.length > 0 && comparison.cloudInUse) {
    const first = comparison.missing[0]
    return new LegacyMigrationError(
      'CLOUD_NOT_EMPTY',
      'the cloud catalogue is in use and does not hold every local record',
      { store: first.store, id: first.id, count: comparison.missing.length },
    )
  }
  return undefined
}

// ───────────────────────── inspection ─────────────────────────

export async function inspectLegacyCatalog(
  organizationId: string,
  options: LegacyMigrationOptions = {},
): Promise<LegacyCatalogInspection> {
  const storage = storageOf(options.storage)
  if (completionOrganization(storage) === organizationId) {
    return { state: 'COMPLETE' }
  }

  const factory = databaseFactory(options.indexedDBFactory)
  if (factory === undefined) return { state: 'NO_LEGACY_DATABASE' }
  const name = options.databaseName ?? DATABASE_NAME
  if (!(await databaseExists(name, factory))) {
    return { state: 'NO_LEGACY_DATABASE' }
  }

  // Explicitly read the old version before opening.  This is a safety check,
  // not merely information: a future-version database must never be opened by
  // this build and an old one must be snapshotted before its upgrade.
  await readStoredSchemaVersion(name, { indexedDBFactory: factory })
  const { database, data } = await validatedLegacyData({ ...options, databaseName: name })
  database.close()
  const counts = countsOf(data)
  return {
    state:
      counts.products + counts.suppliers + counts.customers + counts.otherBusinessRecords === 0
        ? 'EMPTY_DATABASE'
        : 'MIGRATION_REQUIRED',
    counts,
  }
}

interface StoredAttempt {
  readonly organizationId: string
  readonly requestId: string
  readonly checksum: string
}

function readAttempt(storage: Storage | undefined): StoredAttempt | undefined {
  const value = storage?.getItem(CATALOG_IMPORT_ATTEMPT_KEY)
  if (value === null || value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<StoredAttempt>
    return typeof parsed.organizationId === 'string' &&
      typeof parsed.requestId === 'string' &&
      typeof parsed.checksum === 'string'
      ? (parsed as StoredAttempt)
      : undefined
  } catch {
    return undefined
  }
}

async function confirmDatabaseRetired(name: string, factory: IDBFactory | undefined): Promise<void> {
  if (factory === undefined) return
  const list = (factory as { databases?: () => Promise<IDBDatabaseInfo[]> }).databases
  if (typeof list !== 'function') return
  const entries = await list.call(factory)
  if (entries.some((entry) => entry.name === name)) {
    throw new CloudError(
      'RECORD_INVALID',
      'the cloud import succeeded but another tab prevented legacy database retirement',
      { migration: 'LOCAL_DATABASE_STILL_OPEN' },
    )
  }
}

type CompletionResolution = 'VERIFIED_IN_CLOUD' | 'EMPTY_DATABASE' | 'RETIRED_WITH_BACKUP'

function markComplete(
  storage: Storage | undefined,
  organizationId: string,
  resolution: CompletionResolution,
  backupChecksum?: string,
): void {
  storage?.setItem(
    CATALOG_CUTOVER_MARKER_KEY,
    JSON.stringify({
      organizationId,
      completedAt: new Date().toISOString(),
      resolution,
      ...(backupChecksum ? { backupChecksum } : {}),
    }),
  )
  storage?.removeItem(CATALOG_IMPORT_ATTEMPT_KEY)
}

export async function retireEmptyLegacyDatabase(
  organizationId: string,
  options: LegacyMigrationOptions = {},
): Promise<void> {
  const name = options.databaseName ?? DATABASE_NAME
  // Empty, so nothing of value is at stake — but the deletion and the marker
  // still belong to the boot that observed the emptiness, not to a later one.
  await options.confirmAuthority?.()
  await deleteDatabase(name, {
    confirm: name === DATABASE_NAME ? 'DELETE_PRODUCTION_DATABASE' : undefined,
    indexedDBFactory: options.indexedDBFactory,
  })
  await confirmDatabaseRetired(name, databaseFactory(options.indexedDBFactory))
  await options.confirmAuthority?.()
  markComplete(storageOf(options.storage), organizationId, 'EMPTY_DATABASE')
}

/** Refuses — before anything is written anywhere — a database this build cannot fully migrate. */
function assertCatalogueOnly(counts: LegacyCatalogCounts): void {
  if (counts.otherBusinessRecords > 0) {
    throw new LegacyMigrationError(
      'LEGACY_UNSUPPORTED_RECORDS',
      'the local database holds records from later modules',
      { count: counts.otherBusinessRecords },
    )
  }
}

async function retire(
  database: { close(): void },
  name: string,
  options: LegacyMigrationOptions,
): Promise<void> {
  database.close()
  await deleteDatabase(name, {
    confirm: name === DATABASE_NAME ? 'DELETE_PRODUCTION_DATABASE' : undefined,
    indexedDBFactory: options.indexedDBFactory,
  })
  await confirmDatabaseRetired(name, databaseFactory(options.indexedDBFactory))
}

/**
 * Validates, backs up, imports when needed, proves every record, and only then
 * retires the local database.
 *
 * Safety checks live HERE, not in the screen that calls it: a catalogue-only
 * migration refuses a database holding later-module records whatever the UI
 * shows (Audit A, A-L2).
 */
export async function migrateLegacyCatalog(
  gateway: DataGateway,
  organizationId: string,
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const name = options.databaseName ?? DATABASE_NAME
  const storage = storageOf(options.storage)
  const { database, data } = await validatedLegacyData({ ...options, databaseName: name })

  try {
    const counts = countsOf(data)
    assertCatalogueOnly(counts)

    const problem = findImportProblem(data)
    if (problem) {
      throw new LegacyMigrationError('LEGACY_RECORD_INVALID', 'a local record breaks a server rule', problem)
    }

    await createSnapshot(database, {
      kind: 'PRE_IMPORT',
      now: options.now,
      generateId: options.generateId,
    })

    // The complete, checksummed backup is delivered BEFORE any server write,
    // and before any path that could retire the local copy.
    const backup = await exportBackup(database, {
      now: options.now,
      deliver: options.deliverBackup ?? ((artifact) => downloadBackup(artifact)),
    })
    const checksum = backup.artifact.envelope.integrity.value

    let comparison = await compareWithCloud(gateway, organizationId, data)
    const stop = blocked(comparison)
    if (stop) throw stop

    let imported = false
    if (comparison.missing.length > 0) {
      if (options.role !== undefined && options.role !== 'OWNER') {
        throw new LegacyMigrationError(
          'IMPORT_REQUIRES_OWNER',
          'the cloud does not hold this catalogue and only an OWNER may import it',
          { count: comparison.missing.length },
        )
      }

      const previous = readAttempt(storage)
      const requestId =
        previous?.organizationId === organizationId && previous.checksum === checksum
          ? previous.requestId
          : (options.generateId ?? (() => crypto.randomUUID()))()
      storage?.setItem(
        CATALOG_IMPORT_ATTEMPT_KEY,
        JSON.stringify({ organizationId, requestId, checksum } satisfies StoredAttempt),
      )

      try {
        await gateway.catalog.importLegacyCatalog({
          requestId,
          organizationId,
          payloadChecksum: checksum,
          products: data.products,
          suppliers: data.suppliers,
          customers: data.customers,
        })
        imported = true
      } catch (cause) {
        if (isCloudError(cause) && cause.code === 'FORBIDDEN') {
          throw new LegacyMigrationError(
            'IMPORT_REQUIRES_OWNER',
            'only an OWNER may import the catalogue',
            { count: comparison.missing.length },
          )
        }
        // DUPLICATE_KEY means the target stopped being empty — a colleague
        // saved a record, or another device finished first. Decide from the
        // records themselves, never from the refusal alone.
        if (!(isCloudError(cause) && cause.code === 'DUPLICATE_KEY')) throw cause
        const again = await compareWithCloud(gateway, organizationId, data)
        const stopAgain = blocked(again)
        if (stopAgain) throw stopAgain
        if (again.missing.length > 0) throw cause
      }

      comparison = await compareWithCloud(gateway, organizationId, data)
      if (comparison.missing.length > 0 || comparison.conflicts.length > 0) {
        const first = comparison.conflicts[0] ?? comparison.missing[0]
        throw new LegacyMigrationError(
          'VERIFICATION_FAILED',
          'reading the cloud back did not prove every imported record',
          { store: first.store, id: first.id, count: comparison.missing.length + comparison.conflicts.length },
        )
      }
    }

    // Every legacy record is PRESENT in the cloud, in the server's form.
    await options.confirmAuthority?.()
    await retire(database, name, options)
    await options.confirmAuthority?.()
    markComplete(storage, organizationId, 'VERIFIED_IN_CLOUD', checksum)
    return { ...counts, imported }
  } catch (cause) {
    database.close()
    throw cause
  }
}

/**
 * The explicit way past a conflict: keep the cloud, retire the stale local
 * copy — after a fresh complete backup file has been delivered.
 *
 * OWNER only, and never automatic: the screen offers it after a named
 * conflict, behind a confirmation. Records that are missing from, or differ
 * from, the cloud survive in the delivered file and nowhere else, which is
 * exactly what the confirmation says. A database holding later-module records
 * is still refused.
 */
export async function retireLegacyCatalogWithBackup(
  organizationId: string,
  options: LegacyMigrationOptions = {},
): Promise<LegacyCatalogCounts> {
  if (options.role !== 'OWNER') {
    throw new LegacyMigrationError('IMPORT_REQUIRES_OWNER', 'only an OWNER may retire the local catalogue')
  }
  const name = options.databaseName ?? DATABASE_NAME
  const { database, data } = await validatedLegacyData({ ...options, databaseName: name })
  try {
    const counts = countsOf(data)
    assertCatalogueOnly(counts)
    await createSnapshot(database, {
      kind: 'PRE_IMPORT',
      now: options.now,
      generateId: options.generateId,
    })
    const backup = await exportBackup(database, {
      now: options.now,
      deliver: options.deliverBackup ?? ((artifact) => downloadBackup(artifact)),
    })
    // Checked HERE, after the backup delivery and right before the deletion,
    // not only when the button was pressed.
    await options.confirmAuthority?.()
    await retire(database, name, options)
    await options.confirmAuthority?.()
    markComplete(storageOf(options.storage), organizationId, 'RETIRED_WITH_BACKUP', backup.artifact.envelope.integrity.value)
    return counts
  } catch (cause) {
    database.close()
    throw cause
  }
}
