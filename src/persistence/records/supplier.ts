/**
 * The `suppliers` store: the company-wide supplier master.
 *
 * The runtime domain type (`src/domain/supplier/Supplier.ts`) is `{ id,
 * displayName }` and the comparison engine wants exactly that. The persisted
 * record carries more — `active`, `note`, and the two timestamps — because a
 * supplier outlives any one analysis project and a purchase order references
 * the company-wide record, not a project-local copy (Data Model §4).
 *
 * That difference is the whole point of the persisted-vs-runtime split: the
 * store grows the fields operations need without a single line of the audited
 * engine changing.
 */

import { createSupplier, type Supplier } from '../../domain/supplier/Supplier'
import {
  expectBoolean,
  expectInstant,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectUuid,
  optional,
} from '../validation'

export interface SupplierRecord {
  readonly id: string
  readonly displayName: string
  readonly active: boolean
  readonly note?: string
  readonly createdAt: string
  readonly updatedAt: string
}

const KNOWN_KEYS = ['id', 'displayName', 'active', 'note', 'createdAt', 'updatedAt']

export function parseSupplierRecord(value: unknown, path = 'supplier'): SupplierRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, KNOWN_KEYS, path)
  return {
    id: expectUuid(record.id, `${path}.id`),
    displayName: expectNonEmptyString(record.displayName, `${path}.displayName`),
    active: expectBoolean(record.active, `${path}.active`),
    note: optional(record.note, `${path}.note`, expectNonEmptyString),
    createdAt: expectInstant(record.createdAt, `${path}.createdAt`),
    updatedAt: expectInstant(record.updatedAt, `${path}.updatedAt`),
  }
}

/**
 * Rebuilds the runtime shape through the domain factory rather than casting.
 * A stored record is untrusted input, and `createSupplier` is where the
 * domain's own rules (non-empty id and display name) live.
 */
export function toRuntimeSupplier(record: SupplierRecord): Supplier {
  return createSupplier({ id: record.id, displayName: record.displayName })
}

/**
 * Builds a persisted record from the runtime shape plus the master-data fields
 * the domain type does not carry. `updatedAt` is supplied by the caller, not
 * stamped here, because it is the value the stale-write check compares against
 * and a persistence helper inventing it would defeat that check.
 */
export function toSupplierRecord(
  supplier: Supplier,
  fields: { active: boolean; createdAt: string; updatedAt: string; note?: string },
): SupplierRecord {
  const record: SupplierRecord = {
    id: supplier.id,
    displayName: supplier.displayName,
    active: fields.active,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
  }
  return fields.note === undefined ? record : { ...record, note: fields.note }
}
