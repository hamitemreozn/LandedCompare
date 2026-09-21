/**
 * The `customers` store: deliberately the most minimal record in the model.
 *
 * Canonical shape: `docs/DATA_MODEL.md` §4, "Customer" — `id`, `displayName`,
 * `externalRef?`, `active`, `note?`, `createdAt`, `updatedAt`, and nothing
 * else. **It is not a CRM record.** No addresses, contacts, payment terms,
 * credit limits, pipeline or history: it exists so that reservations and
 * outbound shipments (Phase 16) aggregate against a stable id instead of a
 * retyped company name. Product Scope, Open Decision 1 records the richer
 * alternative and why it was rejected for the pilot.
 *
 * `externalRef` is the one concession to the parallel run with Logo Tiger: the
 * customer's code in the system of record, so a human can line the two up. It
 * is free text, it is not an identifier, and nothing points at a customer by
 * it (Data Model §2, "Human-facing codes are not identifiers").
 */

import {
  expectBoolean,
  expectInstant,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectUuid,
  optional,
} from '../validation'

export interface CustomerRecord {
  readonly id: string
  readonly displayName: string
  /** The customer's code in the system of record. For people, never for joins. */
  readonly externalRef?: string
  readonly active: boolean
  readonly note?: string
  readonly createdAt: string
  readonly updatedAt: string
}

const KNOWN_KEYS = ['id', 'displayName', 'externalRef', 'active', 'note', 'createdAt', 'updatedAt']

export function parseCustomerRecord(value: unknown, path = 'customer'): CustomerRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, KNOWN_KEYS, path)
  return {
    id: expectUuid(record.id, `${path}.id`),
    displayName: expectNonEmptyString(record.displayName, `${path}.displayName`),
    externalRef: optional(record.externalRef, `${path}.externalRef`, expectNonEmptyString),
    active: expectBoolean(record.active, `${path}.active`),
    note: optional(record.note, `${path}.note`, expectNonEmptyString),
    createdAt: expectInstant(record.createdAt, `${path}.createdAt`),
    updatedAt: expectInstant(record.updatedAt, `${path}.updatedAt`),
  }
}
