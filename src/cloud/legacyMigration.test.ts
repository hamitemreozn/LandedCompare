import { afterEach, describe, expect, it } from 'vitest'
import type { BackupArtifact } from '../backup'
import {
  deleteDatabase,
  openDatabase,
  saveCustomer,
  saveProduct,
  saveSupplier,
  type CustomerRecord as LegacyCustomer,
  type ProductRecord as LegacyProduct,
  type SupplierRecord as LegacySupplier,
} from '../persistence'
import { createTestDatabaseName, TEST_INSTANT } from '../persistence/testSupport'
import { createMemoryCloudGateway, TEST_ORGANIZATION_ID } from '../test/memoryCloud'
import { CloudError } from './errors'
import type { CatalogGateway, DataGateway } from './gateway'
import {
  CATALOG_CUTOVER_MARKER_KEY,
  CATALOG_IMPORT_ATTEMPT_KEY,
  inspectLegacyCatalog,
  migrateLegacyCatalog,
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

async function legacyDatabase() {
  const name = createTestDatabaseName('catalog-cutover')
  databases.push(name)
  const database = await openDatabase({ name })
  await saveProduct(database, PRODUCT)
  await saveSupplier(database, SUPPLIER)
  await saveCustomer(database, CUSTOMER)
  database.close()
  return name
}

function importingGateway(options: { loseFirstResponse?: boolean } = {}): DataGateway {
  const memory = createMemoryCloudGateway()
  let lost = false
  const catalog: CatalogGateway = {
    ...memory.catalog,
    async importLegacyCatalog(input) {
      if ((await memory.catalog.listProducts(input.organizationId)).length === 0) {
        for (const raw of input.products as readonly LegacyProduct[]) {
          await memory.catalog.createProduct(input.organizationId, {
            id: raw.id,
            sku: raw.sku,
            name: raw.name,
            description: raw.description,
            stockUnit: raw.stockUnit,
            defaultPurchaseUnit: raw.defaultPurchaseUnit,
            unitsPerPurchaseUnit: raw.unitsPerPurchaseUnit?.value,
            manufacturer: raw.manufacturer,
            manufacturerRef: raw.manufacturerRef,
            note: raw.note,
          })
        }
        for (const raw of input.suppliers as readonly LegacySupplier[]) {
          await memory.catalog.createSupplier(input.organizationId, {
            id: raw.id,
            displayName: raw.displayName,
            note: raw.note,
          })
        }
        for (const raw of input.customers as readonly LegacyCustomer[]) {
          await memory.catalog.createCustomer(input.organizationId, {
            id: raw.id,
            displayName: raw.displayName,
            externalRef: raw.externalRef,
            note: raw.note,
          })
        }
      }
      if (options.loseFirstResponse && !lost) {
        lost = true
        throw new CloudError('SERVER_UNAVAILABLE', 'response was lost after commit')
      }
      return {
        products: input.products.length,
        suppliers: input.suppliers.length,
        customers: input.customers.length,
      }
    },
  }
  return { ...memory, catalog }
}

describe('legacy catalogue cutover', () => {
  it('detects and previews validated legacy rows before any cloud write', async () => {
    const name = await legacyDatabase()
    await expect(inspectLegacyCatalog(TEST_ORGANIZATION_ID, { databaseName: name })).resolves.toEqual({
      state: 'MIGRATION_REQUIRED',
      counts: { products: 1, suppliers: 1, customers: 1, otherBusinessRecords: 0 },
    })
  })

  it('backs up, imports, verifies, marks complete and retires IndexedDB', async () => {
    const name = await legacyDatabase()
    const backups: BackupArtifact[] = []
    const gateway = importingGateway()
    const counts = await migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, {
      databaseName: name,
      storage: localStorage,
      now: () => TEST_INSTANT,
      deliverBackup: (artifact) => { backups.push(artifact) },
    })

    expect(counts).toEqual({ products: 1, suppliers: 1, customers: 1, otherBusinessRecords: 0 })
    expect(backups).toHaveLength(1)
    expect((await gateway.catalog.listProducts(TEST_ORGANIZATION_ID))[0].unitsPerPurchaseUnit?.value).toBe('12345678901234567890.0047')
    expect((await gateway.catalog.listCustomers(TEST_ORGANIZATION_ID))[0].externalRef).toBe('0012-OPAQUE')
    expect((await indexedDB.databases()).some((entry) => entry.name === name)).toBe(false)
    await expect(inspectLegacyCatalog(TEST_ORGANIZATION_ID, { databaseName: name, storage: localStorage })).resolves.toEqual({ state: 'COMPLETE' })
  })

  it('reuses the persisted request after a lost response and converges without duplicates', async () => {
    const name = await legacyDatabase()
    const gateway = importingGateway({ loseFirstResponse: true })
    const ids = ['d9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000002', 'd9000000-0000-4000-8000-000000000003']
    const requestIds: string[] = []
    const original = gateway.catalog.importLegacyCatalog.bind(gateway.catalog)
    gateway.catalog.importLegacyCatalog = async (input) => {
      requestIds.push(input.requestId)
      return original(input)
    }
    const options = {
      databaseName: name,
      storage: localStorage,
      now: () => TEST_INSTANT,
      generateId: () => ids.shift() ?? crypto.randomUUID(),
      deliverBackup: () => {},
    }

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options)).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' })
    expect((await indexedDB.databases()).some((entry) => entry.name === name)).toBe(true)
    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, options)).resolves.toMatchObject({ products: 1 })
    expect(requestIds).toHaveLength(2)
    expect(requestIds[1]).toBe(requestIds[0])
    expect(await gateway.catalog.listProducts(TEST_ORGANIZATION_ID)).toHaveLength(1)
  })

  it('rejects a corrupt legacy row before calling the server', async () => {
    const name = createTestDatabaseName('corrupt-catalog-cutover')
    databases.push(name)
    const database = await openDatabase({ name })
    await database.write(['products'], (scope) => scope.put('products', { ...PRODUCT, unitsPerPurchaseUnit: { value: 'NaN' } }))
    database.close()
    const gateway = importingGateway()
    let called = false
    gateway.catalog.importLegacyCatalog = async () => { called = true; return { products: 0, suppliers: 0, customers: 0 } }

    await expect(migrateLegacyCatalog(gateway, TEST_ORGANIZATION_ID, {
      databaseName: name,
      storage: localStorage,
      deliverBackup: () => {},
    })).rejects.toBeDefined()
    expect(called).toBe(false)
    expect((await indexedDB.databases()).some((entry) => entry.name === name)).toBe(true)
  })
})
