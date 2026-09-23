import type { CustomerStatusInput, CustomerStatusRecord, DataGateway } from '../../cloud'
import { FormValidationError, requiredText } from '../shared/formError'
import type { ServiceClock } from '../catalog/productService'

export interface CustomerStatusDraft {
  readonly code: string
  readonly sortOrder: string
}

export const EMPTY_CUSTOMER_STATUS_DRAFT: CustomerStatusDraft = { code: '', sortOrder: '0' }

export function customerStatusDraftFrom(record: CustomerStatusRecord): CustomerStatusDraft {
  return { code: record.code, sortOrder: String(record.sortOrder) }
}

function buildInput(draft: CustomerStatusDraft, id: string): CustomerStatusInput {
  const text = draft.sortOrder.trim()
  const sortOrder = Number(text)
  if (text === '' || !Number.isSafeInteger(sortOrder)) {
    throw new FormValidationError('sortOrder', 'form.mustBeInteger')
  }
  return {
    id,
    code: requiredText(draft.code, 'code'),
    sortOrder,
  }
}

export function listCustomerStatuses(
  gateway: DataGateway,
  organizationId: string,
): Promise<readonly CustomerStatusRecord[]> {
  return gateway.catalog.listCustomerStatuses(organizationId)
}

export function loadCustomerStatus(
  gateway: DataGateway,
  organizationId: string,
  id: string,
): Promise<CustomerStatusRecord> {
  return gateway.catalog.readCustomerStatus(organizationId, id)
}

export function createCustomerStatus(
  gateway: DataGateway,
  organizationId: string,
  draft: CustomerStatusDraft,
  options: ServiceClock = {},
): Promise<CustomerStatusRecord> {
  const id = (options.generateId ?? (() => crypto.randomUUID()))()
  return gateway.catalog.createCustomerStatus(organizationId, buildInput(draft, id))
}

export function updateCustomerStatus(
  gateway: DataGateway,
  organizationId: string,
  existing: CustomerStatusRecord,
  draft: CustomerStatusDraft,
): Promise<CustomerStatusRecord> {
  return gateway.catalog.updateCustomerStatus(
    organizationId,
    existing.version,
    buildInput(draft, existing.id),
  )
}

export function setCustomerStatusActive(
  gateway: DataGateway,
  organizationId: string,
  existing: CustomerStatusRecord,
  active: boolean,
): Promise<CustomerStatusRecord> {
  return gateway.catalog.setCustomerStatusActive(
    organizationId,
    existing.id,
    existing.version,
    active,
  )
}
