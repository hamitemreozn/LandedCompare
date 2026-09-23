/**
 * One-time Phase 9 IndexedDB → Phase 11 PostgreSQL catalog cutover.
 *
 * The local database is opened only while the authenticated OWNER is on the
 * migration screen.  It is never a fallback read source for the running cloud
 * application.  Before the server call, the complete legacy database is
 * validated, snapshotted and exported as a checksummed file.  Only after the
 * idempotent server transaction is confirmed is IndexedDB retired.
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
} from '../persistence'
import type { DataGateway } from './gateway'
import { CloudError } from './errors'

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

function countsOf(data: Awaited<ReturnType<typeof validatedLegacyData>>['data']): LegacyCatalogCounts {
  const products = data.products.length
  const suppliers = data.suppliers.length
  const customers = data.customers.length
  const otherBusinessRecords = BACKUP_STORE_NAMES
    .filter((store) => !['products', 'suppliers', 'customers'].includes(store))
    .reduce((total, store) => total + data[store].length, 0)
  return { products, suppliers, customers, otherBusinessRecords }
}

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

function markComplete(storage: Storage | undefined, organizationId: string): void {
  storage?.setItem(
    CATALOG_CUTOVER_MARKER_KEY,
    JSON.stringify({ organizationId, completedAt: new Date().toISOString() }),
  )
  storage?.removeItem(CATALOG_IMPORT_ATTEMPT_KEY)
}

export async function retireEmptyLegacyDatabase(
  organizationId: string,
  options: LegacyMigrationOptions = {},
): Promise<void> {
  const name = options.databaseName ?? DATABASE_NAME
  await deleteDatabase(name, {
    confirm: name === DATABASE_NAME ? 'DELETE_PRODUCTION_DATABASE' : undefined,
    indexedDBFactory: options.indexedDBFactory,
  })
  await confirmDatabaseRetired(name, databaseFactory(options.indexedDBFactory))
  markComplete(storageOf(options.storage), organizationId)
}

export async function migrateLegacyCatalog(
  gateway: DataGateway,
  organizationId: string,
  options: LegacyMigrationOptions = {},
): Promise<LegacyCatalogCounts> {
  const name = options.databaseName ?? DATABASE_NAME
  const storage = storageOf(options.storage)
  const { database, data } = await validatedLegacyData({ ...options, databaseName: name })

  try {
    await createSnapshot(database, {
      kind: 'PRE_IMPORT',
      now: options.now,
      generateId: options.generateId,
    })

    const result = await exportBackup(database, {
      now: options.now,
      deliver: options.deliverBackup ?? ((artifact) => downloadBackup(artifact)),
    })
    const checksum = result.artifact.envelope.integrity.value
    const previous = readAttempt(storage)
    const requestId =
      previous?.organizationId === organizationId && previous.checksum === checksum
        ? previous.requestId
        : (options.generateId ?? (() => crypto.randomUUID()))()

    storage?.setItem(
      CATALOG_IMPORT_ATTEMPT_KEY,
      JSON.stringify({ organizationId, requestId, checksum } satisfies StoredAttempt),
    )

    const imported = await gateway.catalog.importLegacyCatalog({
      requestId,
      organizationId,
      payloadChecksum: checksum,
      products: data.products,
      suppliers: data.suppliers,
      customers: data.customers,
    })
    const counts = countsOf(data)
    if (
      imported.products !== counts.products ||
      imported.suppliers !== counts.suppliers ||
      imported.customers !== counts.customers
    ) {
      throw new CloudError('RECORD_INVALID', 'server import counts did not match the validated legacy payload')
    }

    const [products, suppliers, customers] = await Promise.all([
      gateway.catalog.listProducts(organizationId),
      gateway.catalog.listSuppliers(organizationId),
      gateway.catalog.listCustomers(organizationId),
    ])
    if (
      products.length !== counts.products ||
      suppliers.length !== counts.suppliers ||
      customers.length !== counts.customers
    ) {
      throw new CloudError('RECORD_INVALID', 'cloud read-back did not confirm the imported catalog')
    }

    database.close()
    await deleteDatabase(name, {
      confirm: name === DATABASE_NAME ? 'DELETE_PRODUCTION_DATABASE' : undefined,
      indexedDBFactory: options.indexedDBFactory,
    })
    await confirmDatabaseRetired(name, databaseFactory(options.indexedDBFactory))
    markComplete(storage, organizationId)
    return counts
  } catch (cause) {
    database.close()
    throw cause
  }
}
