/**
 * The append-only ledger's storage operations.
 *
 * Note what is **not** exported: there is no `updateInventoryMovement` and no
 * `deleteInventoryMovement`. That absence is the design (Data Model R3, I9) —
 * a posted movement is corrected by appending a reversal, never by rewriting
 * history. Keeping the generic write path out of this module means a later
 * phase has to add it deliberately rather than reach for it by habit.
 *
 * Stock arithmetic is not here either. Phase 13 owns it.
 */

import type { Database } from '../database'
import { PersistenceError, classifyRequestFailure, isPersistenceError } from '../errors'
import type { TransactionScope } from '../idb'
import {
  parseInventoryMovementRecord,
  type InventoryMovementRecord,
} from '../records/inventoryMovement'

/**
 * Appends movements inside a caller-supplied transaction.
 *
 * This is the shape later phases need: posting a warehouse receipt writes the
 * receipt document *and* its movements in one transaction, and dispatching an
 * outbound shipment does the same — never as two awaited writes, because a
 * document without its ledger effect (or the reverse) is precisely the
 * corruption the ledger exists to prevent.
 */
export async function appendInventoryMovements(
  scope: TransactionScope,
  movements: readonly InventoryMovementRecord[],
): Promise<void> {
  for (const movement of movements) {
    const record = parseInventoryMovementRecord(movement)
    try {
      // `add`, never `put`: re-writing an existing movement id must fail
      // rather than silently replace a posted row.
      await scope.add('inventoryMovements', record)
    } catch (cause) {
      // The rejection may still be the raw `ConstraintError` from IndexedDB —
      // `runInTransaction` only classifies it once it reaches the boundary, and
      // by then the movement id is out of scope.
      const code = isPersistenceError(cause) ? cause.code : classifyRequestFailure(cause)
      if (code === 'DUPLICATE_KEY') {
        throw new PersistenceError(
          'APPEND_ONLY_VIOLATION',
          `Inventory movement "${record.id}" already exists; movements are append-only`,
          { details: { movementId: record.id }, cause },
        )
      }
      throw cause
    }
  }
}

export function postInventoryMovements(
  database: Database,
  movements: readonly InventoryMovementRecord[],
): Promise<void> {
  return database.write(['inventoryMovements'], (scope) =>
    appendInventoryMovements(scope, movements),
  )
}

/**
 * Every movement for one product, in `occurredAt` order.
 *
 * Read through the `[productId, occurredAt]` compound index — the reason that
 * index exists, and the reason the ledger is the one thing in this schema that
 * is not embedded in an aggregate. Ordering is by the business fact
 * (`occurredAt`), not by when the row happened to be written.
 */
export function listMovementsForProduct(
  database: Database,
  productId: string,
): Promise<InventoryMovementRecord[]> {
  return database.read(['inventoryMovements'], async (scope) => {
    const range = IDBKeyRange.bound([productId, ''], [productId, '￿'])
    const stored = await scope.getAllFromIndex<unknown>(
      'inventoryMovements',
      'productId_occurredAt',
      range,
    )
    return stored.map((record, index) =>
      parseInventoryMovementRecord(record, `inventoryMovements[${index}]`),
    )
  })
}

export function countInventoryMovements(database: Database): Promise<number> {
  return database.read(['inventoryMovements'], (scope) => scope.count('inventoryMovements'))
}
