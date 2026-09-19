import type { Supplier } from '../../domain/supplier/Supplier'
import type { Database } from '../database'
import { PersistenceError } from '../errors'
import type { TransactionScope } from '../idb'
import { parseSupplierRecord, toRuntimeSupplier, type SupplierRecord } from '../records/supplier'
import { assertNotStale } from '../staleWrite'

export async function readSupplierRecord(
  scope: TransactionScope,
  id: string,
): Promise<SupplierRecord | undefined> {
  const stored = await scope.get<unknown>('suppliers', id)
  return stored === undefined ? undefined : parseSupplierRecord(stored)
}

export async function readAllSupplierRecords(scope: TransactionScope): Promise<SupplierRecord[]> {
  const stored = await scope.getAll<unknown>('suppliers')
  return stored.map((record, index) => parseSupplierRecord(record, `suppliers[${index}]`))
}

/**
 * Writes one supplier, refusing a write that would overwrite someone else's.
 *
 * `previousUpdatedAt` is the value the caller loaded. Omitting it asserts "this
 * is new". Either way the stored record is compared before the write, so a
 * second tab that saved first causes a refusal rather than a silent overwrite
 * (Local Persistence & Backup §5, "Concurrency").
 */
export async function putSupplierRecord(
  scope: TransactionScope,
  record: SupplierRecord,
  options: { previousUpdatedAt?: string } = {},
): Promise<void> {
  const validated = parseSupplierRecord(record)
  const stored = await readSupplierRecord(scope, validated.id)
  assertNotStale({
    entity: 'supplier',
    id: validated.id,
    storedUpdatedAt: stored?.updatedAt,
    previousUpdatedAt: options.previousUpdatedAt,
  })
  await scope.put('suppliers', validated)
}

export function saveSupplier(
  database: Database,
  record: SupplierRecord,
  options: { previousUpdatedAt?: string } = {},
): Promise<void> {
  return database.write(['suppliers'], (scope) => putSupplierRecord(scope, record, options))
}

export function loadSupplierRecord(database: Database, id: string): Promise<SupplierRecord> {
  return database.read(['suppliers'], async (scope) => {
    const record = await readSupplierRecord(scope, id)
    if (record === undefined) {
      throw new PersistenceError('RECORD_NOT_FOUND', `No supplier with id "${id}"`, {
        details: { store: 'suppliers', id },
      })
    }
    return record
  })
}

export function listSupplierRecords(database: Database): Promise<SupplierRecord[]> {
  return database.read(['suppliers'], readAllSupplierRecords)
}

/** The runtime domain shape, rebuilt through `createSupplier`. */
export async function loadSupplier(database: Database, id: string): Promise<Supplier> {
  return toRuntimeSupplier(await loadSupplierRecord(database, id))
}
