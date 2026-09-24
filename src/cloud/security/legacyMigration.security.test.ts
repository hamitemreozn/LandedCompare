/**
 * Audit A, A-M1 — the legacy cutover against the REAL server.
 *
 * Audit A reproduced four ways a device could be locked on the migration
 * screen for good, every one of them rooted in comparing the organisation's
 * whole cloud row count with the legacy count. Each is replayed here through
 * the production gateway and PostgREST, with a legacy IndexedDB built by the
 * real persistence layer (fake-indexeddb supplies the browser API):
 *
 *   M1  1200 legacy products — beyond PostgREST's 1000-row response cap
 *   M2  a colleague's record appearing during, and after, the import
 *   M3  the organisation already holding this legacy catalogue plus rows of
 *       its own (a second device) — must converge, not refuse
 *   M4  a record valid locally that breaks a server limit — must be named
 *       before anything is sent
 *
 * plus a lost response after the server committed, and the fail-closed,
 * actionable states: a genuine conflict and a cloud already in use.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackupArtifact } from '../../backup'
import { deleteDatabase, openDatabase, saveCustomer, saveProduct, saveSupplier } from '../../persistence'
import type { ProductRecord as LegacyProduct } from '../../persistence'
import { CloudError, isCloudError } from '../errors'
import {
  inspectLegacyCatalog,
  migrateLegacyCatalog,
  retireLegacyCatalogWithBackup,
  type LegacyMigrationOptions,
} from '../legacyMigration'
import { countRows, freshOrganization, MemoryStorage, signedInGateway, type RealGateway } from './fixtures'
import { sql } from './localStack'

const INSTANT = '2026-09-01T10:00:00.000Z'
const databases: string[] = []
/** A fresh organisation with an OWNER device, a colleague's device and a MEMBER device. */
async function company(label: string): Promise<{ organizationId: string; owner: RealGateway; colleague: RealGateway; member: RealGateway }> {
  const fresh = await freshOrganization(label, ['MEMBER'])
  return {
    organizationId: fresh.organizationId,
    owner: await signedInGateway(fresh.owner.email),
    colleague: await signedInGateway(fresh.owner.email),
    member: await signedInGateway(fresh.members[0].email),
  }
}

afterEach(async () => {
  for (const name of databases.splice(0)) await deleteDatabase(name)
})

function product(index: number, overrides: Partial<LegacyProduct> = {}): LegacyProduct {
  return {
    id: crypto.randomUUID(),
    sku: `LEGACY-${index}`,
    name: `Legacy product ${index}`,
    stockUnit: 'PIECE',
    unitsPerPurchaseUnit: { value: '12345678901234567890.0047' },
    active: index % 5 !== 0,
    createdAt: INSTANT,
    updatedAt: INSTANT,
    ...overrides,
  }
}

async function legacyDatabase(products: readonly LegacyProduct[]): Promise<string> {
  const name = `legacy-security-${crypto.randomUUID()}`
  databases.push(name)
  const database = await openDatabase({ name })
  for (const record of products) await saveProduct(database, record)
  await saveSupplier(database, { id: crypto.randomUUID(), displayName: 'Legacy supplier', active: true, createdAt: INSTANT, updatedAt: INSTANT })
  await saveCustomer(database, { id: crypto.randomUUID(), displayName: 'Legacy customer', externalRef: '0001', active: true, createdAt: INSTANT, updatedAt: INSTANT })
  database.close()
  return name
}

async function exists(name: string): Promise<boolean> {
  return (await indexedDB.databases()).some((entry) => entry.name === name)
}

function options(name: string, extra: Partial<LegacyMigrationOptions> = {}): LegacyMigrationOptions {
  return { databaseName: name, storage: new MemoryStorage(), deliverBackup: () => {}, role: 'OWNER', ...extra }
}

describe('M1 — a legacy catalogue beyond the 1000-row response cap', () => {
  it('imports 1200 products, proves each one through paginated reads, and retires the local copy', async () => {
    const { organizationId, owner } = await company('M1BigLegacy')
    const name = await legacyDatabase(Array.from({ length: 1200 }, (_, index) => product(index)))
    const backups: BackupArtifact[] = []

    const result = await migrateLegacyCatalog(owner.gateway, organizationId, options(name, { deliverBackup: (artifact) => { backups.push(artifact) } }))

    expect(result).toMatchObject({ products: 1200, suppliers: 1, customers: 1, imported: true })
    expect(backups).toHaveLength(1)
    expect(await countRows('products', organizationId)).toBe(1200)
    expect(await exists(name)).toBe(false)
  }, 180_000)
})

describe('M2 — another cloud record appears', () => {
  it('during the import: the refusal is re-decided from the records, fails closed and names why', async () => {
    const { organizationId, owner, colleague } = await company('M2During')
    const name = await legacyDatabase([product(1), product(2)])
    const realImport = owner.gateway.catalog.importLegacyCatalog.bind(owner.gateway.catalog)
    const racing = {
      ...owner.gateway,
      catalog: {
        ...owner.gateway.catalog,
        async importLegacyCatalog(input: Parameters<typeof realImport>[0]) {
          await colleague.gateway.catalog.createProduct(organizationId, { id: crypto.randomUUID(), sku: 'COLLEAGUE', name: 'Saved meanwhile', stockUnit: 'PIECE' })
          return realImport(input)
        },
      },
    }

    await expect(migrateLegacyCatalog(racing, organizationId, options(name))).rejects.toMatchObject({ reason: 'CLOUD_NOT_EMPTY' })
    expect(await exists(name)).toBe(true)
    expect(await countRows('products', organizationId)).toBe(1)
  })

  it('after the import commits: extra cloud rows do not block the proof', async () => {
    const { organizationId, owner, colleague } = await company('M2After')
    const name = await legacyDatabase([product(1), product(2)])
    const realImport = owner.gateway.catalog.importLegacyCatalog.bind(owner.gateway.catalog)
    const racing = {
      ...owner.gateway,
      catalog: {
        ...owner.gateway.catalog,
        async importLegacyCatalog(input: Parameters<typeof realImport>[0]) {
          const committed = await realImport(input)
          await colleague.gateway.catalog.createProduct(organizationId, { id: crypto.randomUUID(), sku: 'COLLEAGUE', name: 'Saved right after', stockUnit: 'PIECE' })
          return committed
        },
      },
    }

    await expect(migrateLegacyCatalog(racing, organizationId, options(name))).resolves.toMatchObject({ imported: true })
    expect(await countRows('products', organizationId)).toBe(3)
    expect(await exists(name)).toBe(false)
  })
})

describe('M3 — the organisation already holds this legacy catalogue, plus more', () => {
  it('a second device converges without importing, even for a MEMBER', async () => {
    const { organizationId, owner, colleague, member } = await company('M3SecondDevice')
    const products = [product(1), product(2), product(3)]
    const first = await legacyDatabase(products)
    await migrateLegacyCatalog(owner.gateway, organizationId, options(first))
    await colleague.gateway.catalog.createSupplier(organizationId, { id: crypto.randomUUID(), displayName: 'Added later in the cloud' })

    // The second device holds the SAME legacy catalogue (a Phase 8 backup
    // restored there), under the same ids.
    const second = `legacy-security-${crypto.randomUUID()}`
    databases.push(second)
    const database = await openDatabase({ name: second })
    for (const record of products) await saveProduct(database, record)
    database.close()

    await expect(migrateLegacyCatalog(member.gateway, organizationId, options(second, { role: 'MEMBER' }))).resolves.toMatchObject({ imported: false })
    expect(await exists(second)).toBe(false)
    expect(await countRows('products', organizationId)).toBe(3)
  })

  it('a different local catalogue meeting a cloud in use fails closed, and the OWNER can retire it with a backup', async () => {
    const { organizationId, owner } = await company('M3DifferentData')
    await owner.gateway.catalog.createProduct(organizationId, { id: crypto.randomUUID(), sku: 'CLOUD-1', name: 'Cloud', stockUnit: 'PIECE' })
    const name = await legacyDatabase([product(7)])

    await expect(migrateLegacyCatalog(owner.gateway, organizationId, options(name))).rejects.toMatchObject({
      reason: 'CLOUD_NOT_EMPTY',
      details: { count: 3 },
    })
    expect(await exists(name)).toBe(true)

    const backups: BackupArtifact[] = []
    await retireLegacyCatalogWithBackup(organizationId, options(name, { deliverBackup: (artifact) => { backups.push(artifact) } }))
    expect(backups).toHaveLength(1)
    expect(backups[0].entityCounts.products).toBe(1)
    expect(await exists(name)).toBe(false)
    expect(await countRows('products', organizationId)).toBe(1)
  })

  it('a genuine conflict with the cloud record of the same id fails closed and names the field', async () => {
    const { organizationId, owner, colleague } = await company('M3Conflict')
    const conflicting = product(1)
    const first = await legacyDatabase([conflicting])
    await migrateLegacyCatalog(owner.gateway, organizationId, options(first))
    const stored = await owner.gateway.catalog.readProduct(organizationId, conflicting.id)
    await colleague.gateway.catalog.updateProduct(organizationId, stored.version, { id: conflicting.id, sku: conflicting.sku, name: 'Edited in the cloud', stockUnit: 'PIECE', unitsPerPurchaseUnit: '12345678901234567890.0047' })

    const second = `legacy-security-${crypto.randomUUID()}`
    databases.push(second)
    const database = await openDatabase({ name: second })
    await saveProduct(database, conflicting)
    database.close()

    await expect(migrateLegacyCatalog(owner.gateway, organizationId, options(second))).rejects.toMatchObject({
      reason: 'LEGACY_CONFLICT',
      details: { store: 'products', id: conflicting.id, field: 'name', count: 1 },
    })
    expect(await exists(second)).toBe(true)
    expect((await owner.gateway.catalog.readProduct(organizationId, conflicting.id)).name).toBe('Edited in the cloud')
  })
})

describe('M4 — a record valid locally that breaks a server limit', () => {
  it('is named before anything is sent, and nothing is imported', async () => {
    const { organizationId, owner } = await company('M4Limits')
    const offending = product(2, { note: 'n'.repeat(4001) })
    const name = await legacyDatabase([product(1), offending])
    expect((await inspectLegacyCatalog(organizationId, options(name))).state).toBe('MIGRATION_REQUIRED')

    await expect(migrateLegacyCatalog(owner.gateway, organizationId, options(name))).rejects.toMatchObject({
      reason: 'LEGACY_RECORD_INVALID',
      details: { store: 'products', id: offending.id, field: 'note', rule: 'LENGTH' },
    })
    expect(await countRows('products', organizationId)).toBe(0)
    expect(Number(await sql(`select count(*) from app_data.admin_events where organization_id = '${organizationId}'`))).toBe(0)
    expect(await exists(name)).toBe(true)
  })
})

describe('a lost response after the server committed', () => {
  it('converges on retry: no duplicate, one import event, local copy retired only after proof', async () => {
    const { organizationId, owner } = await company('LostResponse')
    const name = await legacyDatabase([product(1), product(2)])
    const realImport = owner.gateway.catalog.importLegacyCatalog.bind(owner.gateway.catalog)
    let lost = false
    const flaky = {
      ...owner.gateway,
      catalog: {
        ...owner.gateway.catalog,
        async importLegacyCatalog(input: Parameters<typeof realImport>[0]) {
          const committed = await realImport(input)
          if (!lost) {
            // What the browser sees: the commit happened, the answer did not arrive.
            lost = true
            throw new CloudError('SERVER_UNAVAILABLE', 'the response was lost after commit')
          }
          return committed
        },
      },
    }
    const storage = new MemoryStorage()

    const first = await migrateLegacyCatalog(flaky, organizationId, options(name, { storage })).catch((cause: unknown) => cause)
    expect(isCloudError(first) && first.code).toBe('SERVER_UNAVAILABLE')
    expect(await exists(name)).toBe(true)

    await expect(migrateLegacyCatalog(flaky, organizationId, options(name, { storage }))).resolves.toMatchObject({ products: 2, imported: false })
    expect(await countRows('products', organizationId)).toBe(2)
    expect(Number(await sql(`select count(*) from app_data.admin_events where organization_id = '${organizationId}' and event_type = 'ORGANIZATION_DATA_IMPORTED'`))).toBe(1)
    expect(await exists(name)).toBe(false)
  })
})

describe('exact decimal equivalence against the real server (source review, R-3)', () => {
  it('PostgreSQL keeps 1.20, the app writes 1.2 — a second device still converges without a conflict', async () => {
    const { organizationId, owner, colleague, member } = await company('DecimalScale')
    const scaled = product(1, { unitsPerPurchaseUnit: { value: '1.20' } })
    const first = await legacyDatabase([scaled])
    await migrateLegacyCatalog(owner.gateway, organizationId, options(first))
    // The server kept the scale it was given.
    expect((await owner.gateway.catalog.readProduct(organizationId, scaled.id)).unitsPerPurchaseUnit?.value).toBe('1.20')

    // A colleague saves the product through the application, whose Quantity
    // writes the shortest form: same value, different text.
    const stored = await colleague.gateway.catalog.readProduct(organizationId, scaled.id)
    await colleague.gateway.catalog.updateProduct(organizationId, stored.version, {
      id: scaled.id, sku: scaled.sku, name: scaled.name, stockUnit: scaled.stockUnit, unitsPerPurchaseUnit: '1.2',
    })
    expect((await owner.gateway.catalog.readProduct(organizationId, scaled.id)).unitsPerPurchaseUnit?.value).toBe('1.2')

    const second = `legacy-security-${crypto.randomUUID()}`
    databases.push(second)
    const database = await openDatabase({ name: second })
    await saveProduct(database, scaled)
    database.close()

    await expect(migrateLegacyCatalog(member.gateway, organizationId, options(second, { role: 'MEMBER' }))).resolves.toMatchObject({ imported: false })
    expect(await exists(second)).toBe(false)
  })

  it('a genuinely different factor is still a conflict', async () => {
    const { organizationId, owner, colleague } = await company('DecimalDiffers')
    const original = product(1, { unitsPerPurchaseUnit: { value: '1.20' } })
    await migrateLegacyCatalog(owner.gateway, organizationId, options(await legacyDatabase([original])))
    const stored = await colleague.gateway.catalog.readProduct(organizationId, original.id)
    await colleague.gateway.catalog.updateProduct(organizationId, stored.version, {
      id: original.id, sku: original.sku, name: original.name, stockUnit: original.stockUnit, unitsPerPurchaseUnit: '1.21',
    })

    const second = `legacy-security-${crypto.randomUUID()}`
    databases.push(second)
    const database = await openDatabase({ name: second })
    await saveProduct(database, original)
    database.close()

    await expect(migrateLegacyCatalog(owner.gateway, organizationId, options(second))).rejects.toMatchObject({
      reason: 'LEGACY_CONFLICT',
      details: { store: 'products', id: original.id, field: 'unitsPerPurchaseUnit' },
    })
    expect(await exists(second)).toBe(true)
  })
})
