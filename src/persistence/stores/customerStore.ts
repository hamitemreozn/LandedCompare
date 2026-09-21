/**
 * The `customers` store: typed reads and writes for the customer master.
 *
 * The same two rules as every other master store, and nothing more:
 * stale-write refusal on `updatedAt`, and "only the active ones" answered by
 * reading the store and filtering above this layer rather than through an
 * index a boolean key cannot populate (see `stores/productStore.ts` and
 * `REMOVED_BOOLEAN_INDEXES` in `schema.ts`).
 *
 * `externalRef` is **not** unique. It is the customer's code in Logo Tiger,
 * recorded so a human can line the two systems up during the parallel run;
 * making it a constraint would mean the pilot could not save a customer until
 * someone had looked the code up.
 */

import type { Database } from '../database'
import { PersistenceError } from '../errors'
import type { TransactionScope } from '../idb'
import { parseCustomerRecord, type CustomerRecord } from '../records/customer'
import { withoutUndefined } from '../records/shape'
import { assertNotStale } from '../staleWrite'

export async function readCustomerRecord(
  scope: TransactionScope,
  id: string,
): Promise<CustomerRecord | undefined> {
  const stored = await scope.get<unknown>('customers', id)
  return stored === undefined ? undefined : parseCustomerRecord(stored)
}

export async function readAllCustomerRecords(scope: TransactionScope): Promise<CustomerRecord[]> {
  const stored = await scope.getAll<unknown>('customers')
  return stored.map((record, index) => parseCustomerRecord(record, `customers[${index}]`))
}

export async function putCustomerRecord(
  scope: TransactionScope,
  record: CustomerRecord,
  options: { previousUpdatedAt?: string } = {},
): Promise<void> {
  const validated = parseCustomerRecord(record)
  const stored = await readCustomerRecord(scope, validated.id)
  assertNotStale({
    entity: 'customer',
    id: validated.id,
    storedUpdatedAt: stored?.updatedAt,
    previousUpdatedAt: options.previousUpdatedAt,
  })
  await scope.put('customers', withoutUndefined(validated))
}

export function saveCustomer(
  database: Database,
  record: CustomerRecord,
  options: { previousUpdatedAt?: string } = {},
): Promise<void> {
  return database.write(['customers'], (scope) => putCustomerRecord(scope, record, options))
}

export function loadCustomerRecord(database: Database, id: string): Promise<CustomerRecord> {
  return database.read(['customers'], async (scope) => {
    const record = await readCustomerRecord(scope, id)
    if (record === undefined) {
      throw new PersistenceError('RECORD_NOT_FOUND', `No customer with id "${id}"`, {
        details: { store: 'customers', id },
      })
    }
    return record
  })
}

export function listCustomerRecords(database: Database): Promise<CustomerRecord[]> {
  return database.read(['customers'], readAllCustomerRecords)
}
