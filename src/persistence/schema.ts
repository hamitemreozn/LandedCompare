/**
 * The IndexedDB store layout, and the one place the schema version lives.
 *
 * Canonical source: `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §2 (stores) and §4
 * (versioning). This file is the executable form of that table; if the two ever
 * disagree, the document is wrong or this file is, and one of them gets fixed —
 * they are not allowed to drift.
 */

/**
 * One database for the whole application, named once, never derived from a
 * route, a project, a user or a random id. IndexedDB is already scoped to the
 * browser origin, so a second database name would buy isolation the origin
 * already provides while splitting the data a backup has to cover.
 *
 * Note the limit that the name cannot lift: **the origin is the boundary.** A
 * different browser, a different profile, or a cleared profile is a different
 * (or empty) database. Nothing in this layer can reach across that, which is
 * why external backup files exist (Phase 8).
 */
export const DATABASE_NAME = 'landedcompare'

/**
 * The shape of the stored data, as an integer.
 *
 * `schemaVersion` and the IndexedDB database version are two different
 * concepts that this application deliberately keeps **numerically equal**:
 *
 * - the IndexedDB version is a browser-level property of one database, and is
 *   the only thing that can trigger `upgradeneeded`;
 * - `schemaVersion` describes the record shapes, is stamped into the `meta`
 *   store, and travels with data that has left the database — a Phase 8 backup
 *   file has a `schemaVersion` and no IndexedDB version at all.
 *
 * Keeping them equal means one migration chain serves both the database and any
 * exported payload. `assertSchemaVersionConsistency` (see `database.ts`)
 * enforces the equality rather than trusting it, and the `meta` record is what
 * makes the application-level version readable independently of the connection.
 *
 * Bumping this number is what creates a migration step (see `migrations.ts`).
 *
 * **Version 2** removes three indexes version 1 should never have declared —
 * `products.active`, `suppliers.active` and `customers.active`. See
 * `REMOVED_BOOLEAN_INDEXES` below for why they could not work, and
 * `migrations.ts` for the step that deletes them from a stored v1 database.
 */
export const SCHEMA_VERSION = 2

/**
 * Informational build marker recorded in `meta`. Never branched on — it exists
 * so a support question ("which build wrote this?") has an answer.
 */
export const APP_VERSION = '0.7.0'

export const STORE_NAMES = [
  'meta',
  'settings',
  'counters',
  'products',
  'suppliers',
  'customers',
  'projects',
  'purchaseOrders',
  'inboundShipments',
  'warehouseReceipts',
  'inventoryMovements',
  'inventoryReservations',
  'outboundShipments',
  'snapshots',
] as const

export type StoreName = (typeof STORE_NAMES)[number]

/**
 * Stores holding user and business data, as opposed to platform bookkeeping.
 *
 * This is the set a Phase 8 backup covers and a restore replaces; `meta` and
 * `snapshots` are excluded there for the reasons in
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §7 and §8. Recording the split here
 * keeps Phase 8 from having to re-derive it from a store list.
 */
export const BUSINESS_STORE_NAMES = STORE_NAMES.filter(
  (name) => name !== 'meta' && name !== 'snapshots',
)

interface IndexDefinition {
  readonly name: string
  readonly keyPath: string | readonly string[]
  readonly unique?: boolean
  readonly multiEntry?: boolean
}

/**
 * Indexes that existed at `schemaVersion` 1 and must not exist from 2 onward.
 *
 * ## Why they were wrong
 *
 * **A boolean is not a valid IndexedDB key.** The valid key types are number,
 * string, `Date`, binary data and arrays of those; anything else makes the
 * record *unindexable*. IndexedDB does not report this — it does not reject the
 * `put`, it does not warn, it simply leaves that record out of the index. So
 * `products`, `suppliers` and `customers` could hold hundreds of records while
 * their `active` index held **zero entries**, and a perfectly reasonable
 * `index('active').getAll(true)` would answer "there are none" instead of
 * failing.
 *
 * That is the worst failure shape available: a query that looks correct,
 * returns successfully, and is silently empty. A catalogue screen built on it
 * would show a blank list over a populated database.
 *
 * ## Why they are removed rather than repaired
 *
 * The obvious repair is a second, index-friendly copy of the same fact — an
 * `activeFlag: 1 | 0`, or an `activeKey: 'ACTIVE' | 'INACTIVE'` written beside
 * `active`. That buys an index at the cost of two fields that mean the same
 * thing and can disagree: every writer has to remember both, and the day one
 * forgets, the index and the record contradict each other with nothing to
 * detect it. Duplicated state whose only justification is a lookup is a
 * correctness liability, and this schema does not take it.
 *
 * `active` stays exactly what it is — `active: boolean` on the record, the
 * canonical domain field — and "only the active ones" is answered by reading
 * the store and filtering the result. At pilot volume (a few hundred products,
 * suppliers and customers) that is a single-digit-millisecond scan over data
 * that is being rendered anyway, which is the same reasoning §2 "No stored
 * balances" already applies to stock figures. If catalogue volume ever makes it
 * a real cost, the answer is an index on a field that is genuinely a key — not
 * a mirrored copy of a boolean.
 */
export const REMOVED_BOOLEAN_INDEXES: readonly { store: StoreName; index: string }[] = [
  { store: 'products', index: 'active' },
  { store: 'suppliers', index: 'active' },
  { store: 'customers', index: 'active' },
]

interface StoreDefinition {
  readonly name: StoreName
  readonly keyPath: string
  readonly indexes: readonly IndexDefinition[]
}

/**
 * Every store is created at `schemaVersion` 1, including the ones whose records
 * are written by a later phase.
 *
 * This is intentional and is the Phase 7 deliverable named in
 * `docs/IMPLEMENTATION_PLAN.md`: creating an object store with its indexes *is*
 * a schema change, so deferring it would mean a migration per later phase for
 * no benefit. What is deferred is the record types and the typed read/write
 * operations — those arrive with the phase that owns the entity, and until then
 * a store simply holds nothing.
 */
export const STORE_DEFINITIONS: readonly StoreDefinition[] = [
  { name: 'meta', keyPath: 'key', indexes: [] },
  { name: 'settings', keyPath: 'key', indexes: [] },
  { name: 'counters', keyPath: 'key', indexes: [] },
  // No `active` index on the three master stores: see `REMOVED_BOOLEAN_INDEXES`.
  { name: 'products', keyPath: 'id', indexes: [{ name: 'sku', keyPath: 'sku', unique: true }] },
  { name: 'suppliers', keyPath: 'id', indexes: [] },
  { name: 'customers', keyPath: 'id', indexes: [] },
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

/**
 * Creates any store in `STORE_DEFINITIONS` that does not exist yet, with its
 * indexes. Runs inside an `upgradeneeded` transaction.
 *
 * Idempotent by construction — which is the one place idempotence is
 * semantically correct in this layer. "Ensure this store exists" has the same
 * meaning whether it runs once or twice; a data migration does not, which is
 * why migrations are numbered and applied exactly once instead.
 */
export function createMissingStores(database: IDBDatabase, transaction: IDBTransaction): void {
  for (const definition of STORE_DEFINITIONS) {
    const store = database.objectStoreNames.contains(definition.name)
      ? transaction.objectStore(definition.name)
      : database.createObjectStore(definition.name, { keyPath: definition.keyPath })

    for (const index of definition.indexes) {
      if (!store.indexNames.contains(index.name)) {
        store.createIndex(index.name, index.keyPath as string | string[], {
          unique: index.unique ?? false,
          multiEntry: index.multiEntry ?? false,
        })
      }
    }
  }
}
