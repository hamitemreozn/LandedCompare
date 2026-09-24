/**
 * The one-time legacy cutover, against a gateway double that keeps the
 * server's contract: an idempotent request id, a refused non-empty target and
 * all-or-nothing insertion (`src/test/memoryCloud.ts`). The same scenarios run
 * against the REAL local server in `security/legacyMigration.security.test.ts`.
 *
 * Audit A, A-M1 and A-L2: proof is per record, never an organisation-wide
 * count; every stop names its reason and leaves the local database in place;
 * the catalogue-only safety check lives inside the migration itself.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BackupArtifact } from '../backup'
import {
  deleteDatabase,
  openDatabase,
  saveCustomer,
  saveProduct,
  saveSupplier,
  writeSetting,
  type CustomerRecord as LegacyCustomer,
  type ProductRecord as LegacyProduct,
  type SupplierRecord as LegacySupplier,
} from '../persistence'
import { createTestDatabaseName, TEST_INSTANT } from '../persistence/testSupport'
import { createMemoryCloudGateway, TEST_ORGANIZATION_ID, type MemoryCloud } from '../test/memoryCloud'
import { CloudError } from './errors'
import {
  CATALOG_CUTOVER_MARKER_KEY,
  CATALOG_IMPORT_ATTEMPT_KEY,
  findImportProblem,
  inspectLegacyCatalog,
  migrateLegacyCatalog,
  retireLegacyCatalogWithBackup,
  type LegacyMigrationOptions,
} from './legacyMigration'

const PRODUCT: LegacyProduct = {
  id: 'd1000000-0000-4000-8000-000000000001',
  sku: 'LEGACY-1',
  name: 'Legacy product',
  stockUnit: 'PIECE',
  defaultPurchaseUnit: 'BOX',
  unitsPerPurchaseUnit: { value: '12345678901234567890.0047' },
  active: true,
  createdAt: TEST_INSTANT,
  updatedAt: TEST_INSTANT,
}
const SUPPLIER: LegacySupplier = {
  id: 'd2000000-0000-4000-8000-000000000001',
  displayName: 'Legacy supplier',
  active: true,
  createdAt: TEST_INSTANT,
  updatedAt: TEST_INSTANT,
}
const CUSTOMER: LegacyCustomer = {
  id: 'd3000000-0000-4000-8000-000000000001',
  displayName: 'Legacy customer',
  externalRef: '0012-OPAQUE',
  active: false,
  createdAt: TEST_INSTANT,
  updatedAt: TEST_INSTANT,
}

const databases: string[] = []

afterEach(async () => {
  localStorage.removeItem(CATALOG_CUTOVER_MARKER_KEY)
  localStorage.removeItem(CATALOG_IMPORT_ATTEMPT_KEY)
  for (const name of databases.splice(0)) await deleteDatabase(name)
})

async function legacyDatabase(products: readonly LegacyProduct[] = [PRODUCT]) {
  const name = createTestDatabaseName('catalog-cutover')
  databases.push(name)
  const database = await openDatabase({ name })
  for (const product of products) await saveProduct(database, product)
  await saveSupplier(database, SUPPLIER)
  await saveCustomer(database, CUSTOMER)
  database.close()
  return name
}

async function exists(name: string): Promise<boolean> {
  return (await indexedDB.databases()).some((entry) => entry.name === name)
}

function options(name: string, extra: Partial<LegacyMigrationOptions> = {}): LegacyMigrationOptions {
  return {
    databaseName: name,
    storage: localStorage,
    now: () => TEST_INSTANT,
    deliverBackup: () => {},
    role: 'OWNER',
    ...extra,
  }
}

function countingImports(gateway: MemoryCloud): string[] {
  const requestIds: string[] = []
  const original = gateway.catalog.importLegacyCatalog.bind(gateway.catalog)
  gateway.catalog.importLegacyCatalog = async (input) => {
    requestIds.push(input.requestId)
    return original(input)
  }
  return requestIds
}

/** Seeds the cloud with exactly what a successful import of the fixtures would store. */
async function cloudAlreadyHoldsTheLegacyCatalogue(gateway: MemoryCloud) {
  await gateway.catalog.importLegacyCatalog({
    requestId: 'e0000000-0000-4000-8000-000000000001',
    organizationId: TEST_ORGANIZATION_ID,
    payloadChecksum: 'a'.repeat(64),
    products: [PRODUCT],
    suppliers: [SUPPLIER],
    customers: [CUSTOMER],
  })
}

describe('legacy catalogue cutover', () => {
  it('detects and previews validated legacy rows before any cloud write', async () => {
    const name = await legacyDatabase()
    await expect(inspectLegacyCatalog(TEST_ORGANIZATION_ID, { databaseName: name })).resolves.toEqual({
      state: 'MIGRATION_REQUIRED',
      counts: { products: 1, suppliers: 1, customers: 1, otherBusinessRecords: 0 },
    })
  })

  it('backs up, imports, proves every record, marks complete and retires IndexedDB', async () => {
    const name = await legacyDatabase()
    const backups: BackupArtifact[] = []
    const gateway = createMemoryCloudGateway()
    const result = await migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name, {
      deliverBackup: (artifact) => { backups.push(artifact) },
    }))

    expect(result).toEqual({ products: 1, suppliers: 1, customers: 1, otherBusinessRecords: 0, imported: true })
    expect(backups).toHaveLength(1)
    expect((await gateway.catalog.listProducts(TEST_ORGANIZATION_ID))[0].unitsPerPurchaseUnit?.value).toBe('12345678901234567890.0047')
    expect((await gateway.catalog.listCustomers(TEST_ORGANIZATION_ID))[0]).toMatchObject({ externalRef: '0012-OPAQUE', active: false })
    expect(await exists(name)).toBe(false)
    await expect(inspectLegacyCatalog(TEST_ORGANIZATION_ID, { databaseName: name, storage: localStorage })).resolves.toEqual({ state: 'COMPLETE' })
  })

  it('converges after a lost response without a second server write or a duplicate', async () => {
    const name = await legacyDatabase()
    const gateway = createMemoryCloudGateway()
    const requestIds = countingImports(gateway)
    const counted = gateway.catalog.importLegacyCatalog
    let lost = false
    gateway.catalog.importLegacyCatalog = async (input) => {
      const committed = await counted(input)
      if (!lost) {
        lost = true
        throw new CloudError('SERVER_UNAVAILABLE', 'the response was lost after commit')
      }
      return committed
    }

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' })
    expect(await exists(name)).toBe(true)
    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).resolves.toMatchObject({ products: 1, imported: false })
    expect(requestIds).toHaveLength(1)
    expect(await gateway.catalog.listProducts(TEST_ORGANIZATION_ID)).toHaveLength(1)
    expect(await exists(name)).toBe(false)
  })

  it('reuses the persisted request id when an attempt failed before reaching the server', async () => {
    const name = await legacyDatabase()
    const gateway = createMemoryCloudGateway()
    const requestIds = countingImports(gateway)
    const counted = gateway.catalog.importLegacyCatalog
    let failed = false
    gateway.catalog.importLegacyCatalog = async (input) => {
      if (!failed) {
        failed = true
        requestIds.push(input.requestId)
        throw new CloudError('OFFLINE', 'no network')
      }
      return counted(input)
    }
    const ids = ['d9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000002']
    const generateId = () => ids.shift() ?? crypto.randomUUID()

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name, { generateId }))).rejects.toMatchObject({ code: 'OFFLINE' })
    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name, { generateId }))).resolves.toMatchObject({ imported: true })
    expect(requestIds).toHaveLength(2)
    expect(requestIds[1]).toBe(requestIds[0])
  })

  it('converges when the cloud already holds every legacy record, plus rows of its own', async () => {
    const name = await legacyDatabase()
    const gateway = createMemoryCloudGateway()
    await cloudAlreadyHoldsTheLegacyCatalogue(gateway)
    await gateway.catalog.createProduct(TEST_ORGANIZATION_ID, { id: crypto.randomUUID(), sku: 'CLOUD-ONLY', name: 'Added in the cloud', stockUnit: 'PIECE' })
    const requestIds = countingImports(gateway)

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name, { role: 'MEMBER' }))).resolves.toMatchObject({ imported: false })
    expect(requestIds).toHaveLength(0)
    expect(await exists(name)).toBe(false)
  })

  it('fails closed with a named conflict, keeps the local database, and merges nothing', async () => {
    const name = await legacyDatabase()
    const gateway = createMemoryCloudGateway()
    await cloudAlreadyHoldsTheLegacyCatalogue(gateway)
    const stored = await gateway.catalog.readProduct(TEST_ORGANIZATION_ID, PRODUCT.id)
    await gateway.catalog.updateProduct(TEST_ORGANIZATION_ID, stored.version, {
      id: PRODUCT.id, sku: PRODUCT.sku, name: 'Renamed in the cloud', stockUnit: 'PIECE',
    })

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({
      reason: 'LEGACY_CONFLICT',
      details: { store: 'products', id: PRODUCT.id, field: 'name', count: 1 },
    })
    expect(await exists(name)).toBe(true)
    expect((await gateway.catalog.readProduct(TEST_ORGANIZATION_ID, PRODUCT.id)).name).toBe('Renamed in the cloud')
  })

  it('refuses to merge into a cloud catalogue that is already in use', async () => {
    const name = await legacyDatabase()
    const gateway = createMemoryCloudGateway()
    await gateway.catalog.createProduct(TEST_ORGANIZATION_ID, { id: crypto.randomUUID(), sku: 'OTHER-DEVICE', name: 'Different data', stockUnit: 'PIECE' })
    const requestIds = countingImports(gateway)

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({
      reason: 'CLOUD_NOT_EMPTY',
      details: { count: 3 },
    })
    expect(requestIds).toHaveLength(0)
    expect(await exists(name)).toBe(true)
  })

  it('re-decides from the records when a colleague saves between comparison and import', async () => {
    const name = await legacyDatabase()
    const gateway = createMemoryCloudGateway()
    const original = gateway.catalog.importLegacyCatalog.bind(gateway.catalog)
    gateway.catalog.importLegacyCatalog = async (input) => {
      await gateway.catalog.createProduct(TEST_ORGANIZATION_ID, { id: crypto.randomUUID(), sku: 'COLLEAGUE', name: 'Saved meanwhile', stockUnit: 'PIECE' })
      return original(input)
    }

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({ reason: 'CLOUD_NOT_EMPTY' })
    expect(await exists(name)).toBe(true)
  })

  it('names a record the server would refuse and never sends the request', async () => {
    const tooLong = { ...PRODUCT, id: 'd1000000-0000-4000-8000-000000000002', sku: 'S'.repeat(101) }
    const name = await legacyDatabase([PRODUCT, tooLong])
    const gateway = createMemoryCloudGateway()
    const requestIds = countingImports(gateway)

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({
      reason: 'LEGACY_RECORD_INVALID',
      details: { store: 'products', id: tooLong.id, field: 'sku', rule: 'LENGTH' },
    })
    expect(requestIds).toHaveLength(0)
    expect(await exists(name)).toBe(true)
  })

  it('refuses an identifier with no visible character, as the server does', async () => {
    const invisible = { ...PRODUCT, id: 'd1000000-0000-4000-8000-000000000003', sku: 'ZW-1', name: String.fromCodePoint(0x200b) }
    const name = await legacyDatabase([invisible])
    await expect(migrateLegacyCatalog(createMemoryCloudGateway(), TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({
      reason: 'LEGACY_RECORD_INVALID',
      details: { id: invisible.id, field: 'name', rule: 'VISIBLE' },
    })
  })

  it('keeps the catalogue-only safety check inside the migration, not only in the screen', async () => {
    const name = await legacyDatabase()
    const database = await openDatabase({ name })
    await writeSetting(database, 'landedcompare.probe', 'kept')
    database.close()
    const gateway = createMemoryCloudGateway()
    const requestIds = countingImports(gateway)

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({
      reason: 'LEGACY_UNSUPPORTED_RECORDS',
      details: { count: 1 },
    })
    await expect(retireLegacyCatalogWithBackup(TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({
      reason: 'LEGACY_UNSUPPORTED_RECORDS',
    })
    expect(requestIds).toHaveLength(0)
    expect(await exists(name)).toBe(true)
  })

  it('lets a member converge on a catalogue the cloud already holds, but not import one', async () => {
    const name = await legacyDatabase()
    const gateway = createMemoryCloudGateway()
    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name, { role: 'MEMBER' }))).rejects.toMatchObject({
      reason: 'IMPORT_REQUIRES_OWNER',
    })
    expect(await exists(name)).toBe(true)
  })

  it('retires a conflicting local copy only on an OWNER decision, after a fresh backup', async () => {
    const name = await legacyDatabase()
    const backups: BackupArtifact[] = []
    await expect(retireLegacyCatalogWithBackup(TEST_ORGANIZATION_ID, options(name, { role: 'ADMIN' }))).rejects.toMatchObject({
      reason: 'IMPORT_REQUIRES_OWNER',
    })
    expect(await exists(name)).toBe(true)

    await retireLegacyCatalogWithBackup(TEST_ORGANIZATION_ID, options(name, { deliverBackup: (artifact) => { backups.push(artifact) } }))
    expect(backups).toHaveLength(1)
    expect(backups[0].entityCounts.products).toBe(1)
    expect(await exists(name)).toBe(false)
    expect(JSON.parse(localStorage.getItem(CATALOG_CUTOVER_MARKER_KEY) ?? '{}')).toMatchObject({
      organizationId: TEST_ORGANIZATION_ID,
      resolution: 'RETIRED_WITH_BACKUP',
    })
  })

  it('rejects a corrupt legacy row before calling the server', async () => {
    const name = createTestDatabaseName('corrupt-catalog-cutover')
    databases.push(name)
    const database = await openDatabase({ name })
    await database.write(['products'], (scope) => scope.put('products', { ...PRODUCT, unitsPerPurchaseUnit: { value: 'NaN' } }))
    database.close()
    const gateway = createMemoryCloudGateway()
    const requestIds = countingImports(gateway)

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toBeDefined()
    expect(requestIds).toHaveLength(0)
    expect(await exists(name)).toBe(true)
  })
})

describe('exact decimal equivalence in the per-record proof (source review, R-3)', () => {
  const withFactor = (value: string | undefined): LegacyProduct => {
    const { unitsPerPurchaseUnit: _omitted, ...rest } = PRODUCT
    return value === undefined ? rest : { ...rest, unitsPerPurchaseUnit: { value } }
  }

  async function cloudHolding(product: LegacyProduct) {
    const gateway = createMemoryCloudGateway()
    await gateway.catalog.importLegacyCatalog({
      requestId: 'e0000000-0000-4000-8000-000000000002',
      organizationId: TEST_ORGANIZATION_ID,
      payloadChecksum: 'b'.repeat(64),
      products: [product],
      suppliers: [SUPPLIER],
      customers: [CUSTOMER],
    })
    return gateway
  }

  for (const [local, cloud] of [
    ['1.20', '1.2'],
    ['1.2', '1.20'],
    ['1.200', '1.2'],
    ['12345678901234567890.004700', '12345678901234567890.0047'],
  ] as const) {
    it(`local ${local} and cloud ${cloud} are the same record: converges, nothing imported`, async () => {
      const name = await legacyDatabase([withFactor(local)])
      const gateway = await cloudHolding(withFactor(cloud))
      const requestIds = countingImports(gateway)

      await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).resolves.toMatchObject({ imported: false })
      expect(requestIds).toHaveLength(0)
      expect(await exists(name)).toBe(false)
    })
  }

  for (const [local, cloud] of [
    ['1.21', '1.2'],
    ['12345678901234567890.0047', '12345678901234567890.0048'],
    ['1.2', undefined],
    [undefined, '1.2'],
  ] as const) {
    it(`local ${String(local)} and cloud ${String(cloud)} differ: a named conflict`, async () => {
      const name = await legacyDatabase([withFactor(local)])
      const gateway = await cloudHolding(withFactor(cloud))

      await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).rejects.toMatchObject({
        reason: 'LEGACY_CONFLICT',
        details: { store: 'products', id: PRODUCT.id, field: 'unitsPerPurchaseUnit' },
      })
      expect(await exists(name)).toBe(true)
    })
  }

  it('absent on both sides is the same record', async () => {
    const name = await legacyDatabase([withFactor(undefined)])
    const gateway = await cloudHolding(withFactor(undefined))
    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).resolves.toMatchObject({ imported: false })
  })

  it('post-import verification uses the same equality: a server that stores 1.2 for 1.20 still proves the import', async () => {
    const name = await legacyDatabase([withFactor('1.20')])
    const gateway = createMemoryCloudGateway()
    const original = gateway.catalog.importLegacyCatalog.bind(gateway.catalog)
    gateway.catalog.importLegacyCatalog = (input) =>
      original({
        ...input,
        products: (input.products as LegacyProduct[]).map((product) => ({ ...product, unitsPerPurchaseUnit: { value: '1.2' } })),
      })

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options(name))).resolves.toMatchObject({ imported: true })
    expect((await gateway.catalog.readProduct(TEST_ORGANIZATION_ID, PRODUCT.id)).unitsPerPurchaseUnit?.value).toBe('1.2')
    expect(await exists(name)).toBe(false)
  })

  it('zero, negative and non-canonical factors are still refused before anything is sent', () => {
    for (const value of ['0', '0.00', '-1.5', '01.5']) {
      const data = { products: [withFactor(value)], suppliers: [], customers: [] } as unknown as Parameters<typeof findImportProblem>[0]
      expect(findImportProblem(data), value).toMatchObject({ store: 'products', field: 'unitsPerPurchaseUnit', rule: 'DECIMAL' })
    }
  })
})
