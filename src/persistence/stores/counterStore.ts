import type { Database } from '../database'
import type { TransactionScope } from '../idb'
import { parseCounterRecord, type CounterRecord } from '../records/counter'

export async function readCounterRecord(
  scope: TransactionScope,
  key: string,
): Promise<CounterRecord | undefined> {
  const stored = await scope.get<unknown>('counters', key)
  return stored === undefined ? undefined : parseCounterRecord(stored)
}

export function readCounter(database: Database, key: string): Promise<CounterRecord | undefined> {
  return database.read(['counters'], (scope) => readCounterRecord(scope, key))
}

/**
 * Reserves the next value of a sequence and advances it, in one transaction.
 *
 * Takes a `TransactionScope` rather than a `Database` so the reservation can
 * join the transaction that writes the document it numbers — which is the
 * whole reason the `counters` store appears alongside `warehouseReceipts` and
 * `inventoryMovements` in the transaction table of
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §2. A document that failed to save
 * must not leave its number consumed *and* must not leave the number free for
 * a second document; joining the transaction is what makes both true.
 */
export async function reserveNextCounterValue(
  scope: TransactionScope,
  key: string,
): Promise<number> {
  const existing = await readCounterRecord(scope, key)
  const value = existing?.nextValue ?? 1
  await scope.put('counters', { key, nextValue: value + 1 } satisfies CounterRecord)
  return value
}
