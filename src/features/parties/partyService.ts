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
  type CustomerInput,
  type CustomerRecord,
  type DataGateway,
  type SupplierInput,
  type SupplierRecord,
} from '../../cloud'
import { requiredText } from '../shared/formError'
import { optionalText } from '../shared/masterData'
import type { ServiceClock } from '../catalog/productService'

function newId(options: ServiceClock): string {
  return (options.generateId ?? (() => crypto.randomUUID()))()
}

// ─────────────────────────────── suppliers ───────────────────────────────

export interface SupplierDraft {
  readonly displayName: string
  readonly externalRef: string
  readonly note: string
  readonly active: boolean
}

export const EMPTY_SUPPLIER_DRAFT: SupplierDraft = {
  displayName: '',
  externalRef: '',
  note: '',
  active: true,
}

export function supplierDraftFrom(record: SupplierRecord): SupplierDraft {
  return {
    displayName: record.displayName,
    externalRef: record.externalRef ?? '',
    note: record.note ?? '',
    active: record.active,
  }
}

function buildSupplier(
  draft: SupplierDraft,
  id: string,
): SupplierInput {
  return {
    id,
    displayName: requiredText(draft.displayName, 'displayName'),
    externalRef: optionalText(draft.externalRef),
    note: optionalText(draft.note),
  }
}

export function listSuppliers(gateway: DataGateway, organizationId: string): Promise<readonly SupplierRecord[]> {
  return gateway.catalog.listSuppliers(organizationId)
}

export function loadSupplier(gateway: DataGateway, organizationId: string, id: string): Promise<SupplierRecord> {
  return gateway.catalog.readSupplier(organizationId, id)
}

export async function createSupplierRecord(
  gateway: DataGateway,
  organizationId: string,
  draft: SupplierDraft,
  options: ServiceClock = {},
): Promise<SupplierRecord> {
  return gateway.catalog.createSupplier(organizationId, buildSupplier(draft, newId(options)))
}

export async function updateSupplierRecord(
  gateway: DataGateway,
  organizationId: string,
  existing: SupplierRecord,
  draft: SupplierDraft,
  options: ServiceClock = {},
): Promise<SupplierRecord> {
  void options
  return gateway.catalog.updateSupplier(
    organizationId,
    existing.version,
    buildSupplier(draft, existing.id),
  )
}

export async function setSupplierActive(
  gateway: DataGateway,
  organizationId: string,
  existing: SupplierRecord,
  active: boolean,
): Promise<SupplierRecord> {
  return gateway.catalog.setSupplierActive(organizationId, existing.id, existing.version, active)
}

// ─────────────────────────────── customers ───────────────────────────────

export interface CustomerDraft {
  readonly displayName: string
  readonly externalRef: string
  readonly customerStatusId: string
  readonly note: string
  readonly active: boolean
}

export const EMPTY_CUSTOMER_DRAFT: CustomerDraft = {
  displayName: '',
  externalRef: '',
  customerStatusId: '',
  note: '',
  active: true,
}

export function customerDraftFrom(record: CustomerRecord): CustomerDraft {
  return {
    displayName: record.displayName,
    externalRef: record.externalRef ?? '',
    customerStatusId: record.customerStatusId ?? '',
    note: record.note ?? '',
    active: record.active,
  }
}

function buildCustomer(
  draft: CustomerDraft,
  id: string,
): CustomerInput {
  return {
    id,
    displayName: requiredText(draft.displayName, 'displayName'),
    externalRef: optionalText(draft.externalRef),
    customerStatusId: optionalText(draft.customerStatusId),
    note: optionalText(draft.note),
  }
}

export function listCustomers(gateway: DataGateway, organizationId: string): Promise<readonly CustomerRecord[]> {
  return gateway.catalog.listCustomers(organizationId)
}

export function loadCustomer(gateway: DataGateway, organizationId: string, id: string): Promise<CustomerRecord> {
  return gateway.catalog.readCustomer(organizationId, id)
}

export async function createCustomerRecord(
  gateway: DataGateway,
  organizationId: string,
  draft: CustomerDraft,
  options: ServiceClock = {},
): Promise<CustomerRecord> {
  return gateway.catalog.createCustomer(organizationId, buildCustomer(draft, newId(options)))
}

export async function updateCustomerRecord(
  gateway: DataGateway,
  organizationId: string,
  existing: CustomerRecord,
  draft: CustomerDraft,
  options: ServiceClock = {},
): Promise<CustomerRecord> {
  void options
  return gateway.catalog.updateCustomer(
    organizationId,
    existing.version,
    buildCustomer(draft, existing.id),
  )
}

export async function setCustomerActive(
  gateway: DataGateway,
  organizationId: string,
  existing: CustomerRecord,
  active: boolean,
): Promise<CustomerRecord> {
  return gateway.catalog.setCustomerActive(organizationId, existing.id, existing.version, active)
}
