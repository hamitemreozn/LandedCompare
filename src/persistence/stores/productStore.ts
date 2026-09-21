/**
 * The `products` store: typed reads and writes for the catalog master.
 *
 * ## "Only the active ones" is a filtered read, not an index
 *
 * There is no `active` index, and there must not be one:
 * `schemaVersion` 2 removed the three that existed because a **boolean is not a
 * valid IndexedDB key**, so a record carrying one is silently left out of the
 * index entirely (`REMOVED_BOOLEAN_INDEXES` in `schema.ts` has the full
 * account). A mirrored `activeFlag: 0 | 1` is not the repair either — it is
 * duplicated state that every writer has to keep in step. So this module offers
 * `listProductRecords`, the whole store, and filtering by `active` happens
 * above it, in the application layer, over records that are about to be
 * rendered anyway.
 *
 * ## What this module enforces, and what it leaves to Phase 13
 *
 * Enforced here, inside the write transaction:
 *
 * - **stale-write refusal** on `updatedAt` (§5, "Concurrency");
 * - **case-insensitive SKU uniqueness**, which the unique `products.sku` index
 *   cannot express because IndexedDB compares string keys by code unit.
 *
 * Deliberately **not** enforced here: Data Model I11, "`product.stockUnit` is
 * immutable once any movement exists for that product". At Phase 9 no movement
 * can exist — `inventoryMovements` has no producer until Phase 13 builds the
 * ledger — so the rule has nothing to constrain, and implementing it now would
 * mean widening every product save into a cross-store transaction against a
 * store that is provably empty. Phase 13 owns the ledger and owns this
 * invariant with it; the form says so to the user in the meantime.
 */

import type { Database } from '../database'
import { PersistenceError } from '../errors'
import type { TransactionScope } from '../idb'
import { normaliseSku, parseProductRecord, type ProductRecord } from '../records/product'
import { withoutUndefined } from '../records/shape'
import { assertNotStale } from '../staleWrite'

export async function readProductRecord(
  scope: TransactionScope,
  id: string,
): Promise<ProductRecord | undefined> {
  const stored = await scope.get<unknown>('products', id)
  return stored === undefined ? undefined : parseProductRecord(stored)
}

export async function readAllProductRecords(scope: TransactionScope): Promise<ProductRecord[]> {
  const stored = await scope.getAll<unknown>('products')
  return stored.map((record, index) => parseProductRecord(record, `products[${index}]`))
}

/**
 * Refuses a SKU that already belongs to a different product, compared the way
 * Data Model §4 defines it: trimmed, case-insensitively.
 *
 * Scanning the store rather than probing the index is not laziness — the index
 * would answer the wrong question. `products.sku` is unique but ordered by code
 * unit, so `"abc-1"` and `"ABC-1"` are two distinct keys to it and both would
 * be admitted. The scan runs inside the caller's write transaction, so a second
 * tab cannot slip a colliding SKU in between the check and the `put`.
 */
async function assertSkuAvailable(scope: TransactionScope, record: ProductRecord): Promise<void> {
  const key = normaliseSku(record.sku)
  const existing = await readAllProductRecords(scope)
  const clash = existing.find(
    (candidate) => candidate.id !== record.id && normaliseSku(candidate.sku) === key,
  )
  if (clash !== undefined) {
    throw new PersistenceError(
      'DUPLICATE_KEY',
      `Another product already uses the SKU "${record.sku}"`,
      { details: { store: 'products', field: 'sku', sku: record.sku, existingId: clash.id } },
    )
  }
}

/**
 * Writes one product, refusing a write that would overwrite someone else's and
 * a SKU that is already taken.
 *
 * `previousUpdatedAt` is the value the caller loaded; omitting it asserts "this
 * is new". The stored record is compared before the write either way, so a
 * second tab that saved first causes a refusal rather than a silent overwrite.
 */
export async function putProductRecord(
  scope: TransactionScope,
  record: ProductRecord,
  options: { previousUpdatedAt?: string } = {},
): Promise<void> {
  const validated = parseProductRecord(record)
  const stored = await readProductRecord(scope, validated.id)
  assertNotStale({
    entity: 'product',
    id: validated.id,
    storedUpdatedAt: stored?.updatedAt,
    previousUpdatedAt: options.previousUpdatedAt,
  })
  await assertSkuAvailable(scope, validated)
  // Parsing re-adds absent optionals as an explicit `undefined`; the stored
  // record must have exactly the keys it declares. See `records/shape.ts`.
  await scope.put('products', withoutUndefined(validated))
}

export function saveProduct(
  database: Database,
  record: ProductRecord,
  options: { previousUpdatedAt?: string } = {},
): Promise<void> {
  return database.write(['products'], (scope) => putProductRecord(scope, record, options))
}

export function loadProductRecord(database: Database, id: string): Promise<ProductRecord> {
  return database.read(['products'], async (scope) => {
    const record = await readProductRecord(scope, id)
    if (record === undefined) {
      throw new PersistenceError('RECORD_NOT_FOUND', `No product with id "${id}"`, {
        details: { store: 'products', id },
      })
    }
    return record
  })
}

export function listProductRecords(database: Database): Promise<ProductRecord[]> {
  return database.read(['products'], readAllProductRecords)
}
