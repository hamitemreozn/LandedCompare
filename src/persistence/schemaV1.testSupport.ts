/**
 * A frozen, byte-accurate reproduction of the `schemaVersion` 1 database.
 *
 * Test-only. Not a test file, and never imported by production code.
 *
 * ## Why this file has to exist
 *
 * `schemaVersion` 2 deletes three indexes that version 1 created
 * (`REMOVED_BOOLEAN_INDEXES` in `schema.ts`). A test for that migration is only
 * worth anything if the database it upgrades **actually has those indexes** —
 * and the production `STORE_DEFINITIONS` no longer declares them, so opening at
 * `schemaVersion: 1` through `openDatabase()` would produce a version-1
 * database that was never version 1: same version number, missing exactly the
 * indexes under test. The migration would then "pass" by having nothing to do.
 *
 * So the v1 layout is transcribed here, verbatim from commit `5929695`, and
 * written through the raw IndexedDB API. What the migration tests upgrade is a
 * genuine Phase 7 database: the same stores, the same indexes — including the
 * three unusable ones — and a `meta` record stamped at version 1 by the same
 * fields `stampMeta` wrote.
 *
 * ## It is frozen
 *
 * This is a historical fixture, not a second copy of the schema. It describes
 * what version 1 *was*, so it never changes again. A future `v2 → v3` test gets
 * a `schemaV2.testSupport.ts` of its own rather than an edit here — editing a
 * past version's fixture to match the present is how a migration test quietly
 * stops testing the migration.
 */

import { META_KEY } from './records/meta'

interface V1IndexDefinition {
  readonly name: string
  readonly keyPath: string | readonly string[]
  readonly unique?: boolean
}

interface V1StoreDefinition {
  readonly name: string
  readonly keyPath: string
  readonly indexes: readonly V1IndexDefinition[]
}

/** The `schemaVersion` 1 store layout, exactly as commit `5929695` created it. */
export const V1_STORE_DEFINITIONS: readonly V1StoreDefinition[] = [
  { name: 'meta', keyPath: 'key', indexes: [] },
  { name: 'settings', keyPath: 'key', indexes: [] },
  { name: 'counters', keyPath: 'key', indexes: [] },
  {
    name: 'products',
    keyPath: 'id',
    indexes: [
      { name: 'sku', keyPath: 'sku', unique: true },
      // The defect, preserved on purpose: a boolean cannot be an IndexedDB key,
      // so this index was created and then never contained a single entry.
      { name: 'active', keyPath: 'active' },
    ],
  },
  { name: 'suppliers', keyPath: 'id', indexes: [{ name: 'active', keyPath: 'active' }] },
  { name: 'customers', keyPath: 'id', indexes: [{ name: 'active', keyPath: 'active' }] },
  { name: 'projects', keyPath: 'id', indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }] },
  {
    name: 'purchaseOrders',
    keyPath: 'id',
    indexes: [
      { name: 'supplierId', keyPath: 'supplierId' },
      { name: 'status', keyPath: 'status' },
      { name: 'code', keyPath: 'code', unique: true },
    ],
  },
  {
    name: 'inboundShipments',
    keyPath: 'id',
    indexes: [
      { name: 'supplierId', keyPath: 'supplierId' },
      { name: 'status', keyPath: 'status' },
      { name: 'code', keyPath: 'code', unique: true },
    ],
  },
  {
    name: 'warehouseReceipts',
    keyPath: 'id',
    indexes: [
      { name: 'inboundShipmentId', keyPath: 'inboundShipmentId' },
      { name: 'postedAt', keyPath: 'postedAt' },
    ],
  },
  {
    name: 'inventoryMovements',
    keyPath: 'id',
    indexes: [
      { name: 'productId', keyPath: 'productId' },
      { name: 'occurredAt', keyPath: 'occurredAt' },
      { name: 'productId_occurredAt', keyPath: ['productId', 'occurredAt'] },
      { name: 'type', keyPath: 'type' },
      { name: 'sourceId', keyPath: 'source.id' },
    ],
  },
  {
    name: 'inventoryReservations',
    keyPath: 'id',
    indexes: [
      { name: 'productId', keyPath: 'productId' },
      { name: 'customerId', keyPath: 'customerId' },
      { name: 'status', keyPath: 'status' },
    ],
  },
  {
    name: 'outboundShipments',
    keyPath: 'id',
    indexes: [
      { name: 'customerId', keyPath: 'customerId' },
      { name: 'status', keyPath: 'status' },
      { name: 'code', keyPath: 'code', unique: true },
    ],
  },
  {
    name: 'snapshots',
    keyPath: 'id',
    indexes: [
      { name: 'createdAt', keyPath: 'createdAt' },
      { name: 'kind', keyPath: 'kind' },
    ],
  },
]

/** The build marker `schemaVersion` 1 databases were stamped with. */
export const V1_APP_VERSION = '0.7.0'

export const V1_INSTALL_ID = '00000000-0000-4000-8000-000000000001'
export const V1_CREATED_AT = '2026-09-01T09:00:00.000Z'

/** Records to seed, keyed by v1 store name. */
export type V1Seed = Readonly<Record<string, readonly unknown[]>>

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Creates a genuine `schemaVersion` 1 database and seeds it.
 *
 * Raw `indexedDB.open` rather than `openDatabase()`, because the point is to
 * reproduce a build that no longer exists: the v1 layout above, the v1 `meta`
 * stamp, and no migration chain anywhere near it. The connection is closed
 * before this resolves, so the caller can immediately open at version 2 and
 * trigger the upgrade without being blocked by its own fixture.
 */
export async function createLegacyV1Database(name: string, seed: V1Seed = {}): Promise<void> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const definition of V1_STORE_DEFINITIONS) {
        const store = database.createObjectStore(definition.name, { keyPath: definition.keyPath })
        for (const index of definition.indexes) {
          store.createIndex(index.name, index.keyPath as string | string[], {
            unique: index.unique ?? false,
          })
        }
      }
      request.transaction!.objectStore('meta').put({
        key: META_KEY,
        schemaVersion: 1,
        appVersion: V1_APP_VERSION,
        installId: V1_INSTALL_ID,
        createdAt: V1_CREATED_AT,
      })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })

  const stores = Object.keys(seed).filter((store) => seed[store]!.length > 0)
  if (stores.length > 0) {
    const transaction = connection.transaction(stores, 'readwrite')
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
    for (const store of stores) {
      for (const record of seed[store]!) {
        transaction.objectStore(store).put(record)
      }
    }
    await committed
  }

  connection.close()
}

/**
 * The index names a stored database actually declares, read without upgrading
 * it.
 *
 * Opening with no version opens at whatever version is already there, so this
 * observes the database rather than changing it — which is the only way an
 * assertion about "the index is gone" means anything.
 */
export async function readIndexNames(name: string, store: string): Promise<string[]> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    return [...connection.transaction([store], 'readonly').objectStore(store).indexNames].sort()
  } finally {
    connection.close()
  }
}

/** Every record of a store, read without upgrading the database. */
export async function readStoredRecords(name: string, store: string): Promise<unknown[]> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    return await promisify(
      connection.transaction([store], 'readonly').objectStore(store).getAll() as IDBRequest<unknown[]>,
    )
  } finally {
    connection.close()
  }
}
