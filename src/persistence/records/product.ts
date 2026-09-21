/**
 * The `products` store: the catalog master, and the anchor of the whole
 * inventory ledger.
 *
 * Canonical shape: `docs/DATA_MODEL.md` §4, "Product". Nothing is added to it
 * here, and one thing is deliberately absent: **there is no stock quantity on a
 * product.** Physical stock is `Σ(IN) − Σ(OUT)` over the append-only movement
 * ledger (Data Model I1), and a number stored on the product would be a second,
 * competing answer that nothing keeps in step. The ledger is Phase 13.
 *
 * `stockUnit` is the load-bearing field: every movement for this product is
 * expressed in it and the ledger performs no conversion, ever. Data Model I11
 * therefore makes it immutable once any movement exists. That rule cannot be
 * enforced here at Phase 9 — `inventoryMovements` has no writer yet and no
 * movement can exist — so the check lives where it can be proven, in
 * `stores/productStore.ts`, which reads the ledger inside the same transaction
 * as the write it guards.
 *
 * ## SKU uniqueness is case-insensitive, which an index cannot express
 *
 * Data Model §4 says `sku` is "unique, trimmed, case-insensitive compare". The
 * `products.sku` IndexedDB index is unique, but IndexedDB compares string keys
 * by code unit, so `"ABC-1"` and `"abc-1"` are two different keys and both
 * would be accepted. The index stays — it is a real constraint and a useful
 * backstop against an exact duplicate slipping past application code — and the
 * case-insensitive rule is enforced in the store helper, inside the write
 * transaction. `normaliseSku` below is the one definition of "the same SKU"
 * that both sides use.
 */

import { Quantity, type QuantitySnapshot } from '../../domain/quantity/Quantity'
import {
  expectBoolean,
  expectDecimalString,
  expectInstant,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectUuid,
  invalidRecord,
  optional,
} from '../validation'

export interface ProductRecord {
  readonly id: string
  /** Trimmed as entered. Unique, compared case-insensitively — see `normaliseSku`. */
  readonly sku: string
  readonly name: string
  readonly description?: string
  /** THE unit the inventory ledger is kept in. Immutable once movements exist. */
  readonly stockUnit: string
  readonly defaultPurchaseUnit?: string
  /** Stock units per purchase unit, e.g. 50 pieces per box. Strictly positive. */
  readonly unitsPerPurchaseUnit?: QuantitySnapshot
  readonly manufacturer?: string
  readonly manufacturerRef?: string
  readonly active: boolean
  readonly note?: string
  readonly createdAt: string
  readonly updatedAt: string
}

const KNOWN_KEYS = [
  'id',
  'sku',
  'name',
  'description',
  'stockUnit',
  'defaultPurchaseUnit',
  'unitsPerPurchaseUnit',
  'manufacturer',
  'manufacturerRef',
  'active',
  'note',
  'createdAt',
  'updatedAt',
]

/**
 * The comparison key for "is this the same SKU?".
 *
 * `toLowerCase()`, not `toLocaleLowerCase()`. The locale-aware form folds
 * Turkish `I` to the dotless `ı`, so `"ISO-1"` and `"ıso-1"` would collide
 * under a Turkish UI and not under an English one — the same catalogue would
 * accept or refuse a SKU depending on which language the user had selected.
 * Identity must not depend on presentation, so this fold is locale-independent.
 */
export function normaliseSku(sku: string): string {
  return sku.trim().toLowerCase()
}

function parseQuantitySnapshot(value: unknown, path: string): QuantitySnapshot {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, ['value'], path)
  return { value: expectDecimalString(record.value, `${path}.value`) }
}

/**
 * A pack factor of zero or a negative one is not a unit conversion, it is a
 * division by zero waiting for Phase 14. Rejected at the boundary rather than
 * at the point it would be used.
 */
function parsePositiveQuantitySnapshot(value: unknown, path: string): QuantitySnapshot {
  const snapshot = parseQuantitySnapshot(value, path)
  if (Quantity.fromJSON(snapshot).isZero()) {
    throw invalidRecord(path, 'expected a quantity greater than zero')
  }
  return snapshot
}

export function parseProductRecord(value: unknown, path = 'product'): ProductRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, KNOWN_KEYS, path)
  const sku = expectNonEmptyString(record.sku, `${path}.sku`)
  if (sku !== sku.trim()) {
    throw invalidRecord(`${path}.sku`, 'expected a trimmed SKU')
  }
  return {
    id: expectUuid(record.id, `${path}.id`),
    sku,
    name: expectNonEmptyString(record.name, `${path}.name`),
    description: optional(record.description, `${path}.description`, expectNonEmptyString),
    stockUnit: expectNonEmptyString(record.stockUnit, `${path}.stockUnit`),
    defaultPurchaseUnit: optional(
      record.defaultPurchaseUnit,
      `${path}.defaultPurchaseUnit`,
      expectNonEmptyString,
    ),
    unitsPerPurchaseUnit: optional(
      record.unitsPerPurchaseUnit,
      `${path}.unitsPerPurchaseUnit`,
      parsePositiveQuantitySnapshot,
    ),
    manufacturer: optional(record.manufacturer, `${path}.manufacturer`, expectNonEmptyString),
    manufacturerRef: optional(record.manufacturerRef, `${path}.manufacturerRef`, expectNonEmptyString),
    active: expectBoolean(record.active, `${path}.active`),
    note: optional(record.note, `${path}.note`, expectNonEmptyString),
    createdAt: expectInstant(record.createdAt, `${path}.createdAt`),
    updatedAt: expectInstant(record.updatedAt, `${path}.updatedAt`),
  }
}
