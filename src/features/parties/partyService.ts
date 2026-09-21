/**
 * Supplier and customer actions — the same boundary `productService.ts`
 * describes, for the two party masters.
 *
 * The two are kept in one file because they are genuinely the same record with
 * one field's difference, and splitting them would have produced two copies of
 * the same twenty lines that then drift apart. What is *not* done is to
 * collapse them into a generic "party" entity: Data Model §4 defines them as
 * two stores with two ids for a reason a shared table would erase — a purchase
 * order references a supplier, a reservation references a customer, and
 * nothing in the model ever wants "a party".
 *
 * Neither is a CRM record. A supplier is `displayName` plus the lifecycle
 * fields; a customer adds `externalRef`, the code in the system of record, so
 * a human can line the two up during the parallel run with Logo Tiger. No
 * addresses, contacts, terms, credit limits or history — Product Scope, Open
 * Decision 1 records the richer alternative and why the pilot rejected it.
 */

import {
  listCustomerRecords,
  listSupplierRecords,
  loadCustomerRecord,
  loadSupplierRecord,
  saveCustomer,
  saveSupplier,
  type CustomerRecord,
  type Database,
  type SupplierRecord,
} from '../../persistence'
import { requiredText } from '../shared/formError'
import { optionalText } from '../shared/masterData'
import type { ServiceClock } from '../catalog/productService'

function instant(options: ServiceClock): string {
  return (options.now ?? (() => new Date().toISOString()))()
}

function newId(options: ServiceClock): string {
  return (options.generateId ?? (() => crypto.randomUUID()))()
}

// ─────────────────────────────── suppliers ───────────────────────────────

export interface SupplierDraft {
  readonly displayName: string
  readonly note: string
  readonly active: boolean
}

export const EMPTY_SUPPLIER_DRAFT: SupplierDraft = { displayName: '', note: '', active: true }

export function supplierDraftFrom(record: SupplierRecord): SupplierDraft {
  return { displayName: record.displayName, note: record.note ?? '', active: record.active }
}

function buildSupplier(
  draft: SupplierDraft,
  identity: { id: string; createdAt: string; updatedAt: string },
): SupplierRecord {
  return {
    id: identity.id,
    displayName: requiredText(draft.displayName, 'displayName'),
    active: draft.active,
    note: optionalText(draft.note),
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  }
}

export function listSuppliers(database: Database): Promise<SupplierRecord[]> {
  return listSupplierRecords(database)
}

export function loadSupplier(database: Database, id: string): Promise<SupplierRecord> {
  return loadSupplierRecord(database, id)
}

export async function createSupplierRecord(
  database: Database,
  draft: SupplierDraft,
  options: ServiceClock = {},
): Promise<SupplierRecord> {
  const at = instant(options)
  const record = buildSupplier(draft, { id: newId(options), createdAt: at, updatedAt: at })
  await saveSupplier(database, record)
  return record
}

export async function updateSupplierRecord(
  database: Database,
  existing: SupplierRecord,
  draft: SupplierDraft,
  options: ServiceClock = {},
): Promise<SupplierRecord> {
  const record = buildSupplier(draft, {
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: instant(options),
  })
  await saveSupplier(database, record, { previousUpdatedAt: existing.updatedAt })
  return record
}

export async function setSupplierActive(
  database: Database,
  existing: SupplierRecord,
  active: boolean,
  options: ServiceClock = {},
): Promise<SupplierRecord> {
  const record: SupplierRecord = { ...existing, active, updatedAt: instant(options) }
  await saveSupplier(database, record, { previousUpdatedAt: existing.updatedAt })
  return record
}

// ─────────────────────────────── customers ───────────────────────────────

export interface CustomerDraft {
  readonly displayName: string
  readonly externalRef: string
  readonly note: string
  readonly active: boolean
}

export const EMPTY_CUSTOMER_DRAFT: CustomerDraft = {
  displayName: '',
  externalRef: '',
  note: '',
  active: true,
}

export function customerDraftFrom(record: CustomerRecord): CustomerDraft {
  return {
    displayName: record.displayName,
    externalRef: record.externalRef ?? '',
    note: record.note ?? '',
    active: record.active,
  }
}

function buildCustomer(
  draft: CustomerDraft,
  identity: { id: string; createdAt: string; updatedAt: string },
): CustomerRecord {
  return {
    id: identity.id,
    displayName: requiredText(draft.displayName, 'displayName'),
    externalRef: optionalText(draft.externalRef),
    active: draft.active,
    note: optionalText(draft.note),
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  }
}

export function listCustomers(database: Database): Promise<CustomerRecord[]> {
  return listCustomerRecords(database)
}

export function loadCustomer(database: Database, id: string): Promise<CustomerRecord> {
  return loadCustomerRecord(database, id)
}

export async function createCustomerRecord(
  database: Database,
  draft: CustomerDraft,
  options: ServiceClock = {},
): Promise<CustomerRecord> {
  const at = instant(options)
  const record = buildCustomer(draft, { id: newId(options), createdAt: at, updatedAt: at })
  await saveCustomer(database, record)
  return record
}

export async function updateCustomerRecord(
  database: Database,
  existing: CustomerRecord,
  draft: CustomerDraft,
  options: ServiceClock = {},
): Promise<CustomerRecord> {
  const record = buildCustomer(draft, {
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: instant(options),
  })
  await saveCustomer(database, record, { previousUpdatedAt: existing.updatedAt })
  return record
}

export async function setCustomerActive(
  database: Database,
  existing: CustomerRecord,
  active: boolean,
  options: ServiceClock = {},
): Promise<CustomerRecord> {
  const record: CustomerRecord = { ...existing, active, updatedAt: instant(options) }
  await saveCustomer(database, record, { previousUpdatedAt: existing.updatedAt })
  return record
}
