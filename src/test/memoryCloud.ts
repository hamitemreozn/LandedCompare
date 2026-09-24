import {
  CloudError,
  type AuthChange,
  type CustomerInput,
  type CustomerRecord,
  type CustomerStatusInput,
  type CustomerStatusRecord,
  type DataGateway,
  type ProductInput,
  type ProductRecord,
  type SupplierInput,
  type SupplierRecord,
} from '../cloud'

export const TEST_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const TEST_ORGANIZATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

export interface MemoryCloud extends DataGateway {
  readonly records: {
    readonly products: Map<string, ProductRecord>
    readonly suppliers: Map<string, SupplierRecord>
    readonly customers: Map<string, CustomerRecord>
    readonly customerStatuses: Map<string, CustomerStatusRecord>
  }
}

function now(): string {
  return new Date().toISOString()
}

function absent(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

function requireRecord<T>(map: Map<string, T>, id: string): T {
  const record = map.get(id)
  if (!record) throw new CloudError('RECORD_NOT_FOUND', 'record not found')
  return record
}

interface LegacyProductShape {
  readonly id: string
  readonly sku: string
  readonly name: string
  readonly description?: string
  readonly stockUnit: string
  readonly defaultPurchaseUnit?: string
  readonly unitsPerPurchaseUnit?: { readonly value: string }
  readonly manufacturer?: string
  readonly manufacturerRef?: string
  readonly note?: string
  readonly active: boolean
}

interface LegacyPartyShape {
  readonly id: string
  readonly displayName: string
  readonly externalRef?: string
  readonly note?: string
  readonly active: boolean
}

function updateRecord<T extends { readonly version: number }>(stored: T, expectedVersion: number): void {
  if (stored.version !== expectedVersion) throw new CloudError('STALE_WRITE', 'stale write')
}

export function createMemoryCloudGateway(options: { signedIn?: boolean; failure?: CloudError } = {}): MemoryCloud {
  const products = new Map<string, ProductRecord>()
  const suppliers = new Map<string, SupplierRecord>()
  const customers = new Map<string, CustomerRecord>()
  const customerStatuses = new Map<string, CustomerStatusRecord>()
  let signedIn = options.signedIn ?? true
  let profileVersion = 1
  const authListeners = new Set<(change: AuthChange) => void>()
  const notify = (change: AuthChange) => { for (const listener of authListeners) listener(change) }
  const imports = new Map<string, { checksum: string; counts: { products: number; suppliers: number; customers: number } }>()

  const base = (id: string) => ({
    id,
    organizationId: TEST_ORGANIZATION_ID,
    active: true,
    createdAt: now(),
    updatedAt: now(),
    createdBy: TEST_USER_ID,
    updatedBy: TEST_USER_ID,
    version: 1,
  })
  const next = <T extends { readonly createdAt: string; readonly version: number }>(stored: T) => ({
    createdAt: stored.createdAt,
    updatedAt: now(),
    version: stored.version + 1,
  })
  const failure = () => {
    if (options.failure) throw options.failure
  }

  const gateway: MemoryCloud = {
    records: { products, suppliers, customers, customerStatuses },
    async currentUserId() {
      failure()
      return signedIn ? TEST_USER_ID : null
    },
    identity: {
      async listOrganizations() {
        failure()
        return [{ id: TEST_ORGANIZATION_ID, name: 'Test Company', writeLocked: false, writeLockReason: null, version: 1, updatedAt: now() }]
      },
      async listOwnMemberships() {
        failure()
        return [{ organizationId: TEST_ORGANIZATION_ID, userId: TEST_USER_ID, role: 'OWNER' as const, status: 'ACTIVE' as const }]
      },
      async readOwnProfile() {
        failure()
        return { userId: TEST_USER_ID, displayName: 'Test Owner', mustChangePassword: false, version: profileVersion }
      },
      async updateOwnProfile(displayName, expectedVersion) {
        if (expectedVersion !== profileVersion) throw new CloudError('STALE_WRITE', 'stale profile')
        profileVersion += 1
        return { userId: TEST_USER_ID, displayName, mustChangePassword: false, version: profileVersion }
      },
      async acknowledgePasswordChange(expectedVersion) {
        if (expectedVersion !== profileVersion) throw new CloudError('STALE_WRITE', 'stale profile')
        profileVersion += 1
        return { userId: TEST_USER_ID, displayName: 'Test Owner', mustChangePassword: false, version: profileVersion }
      },
    },
    catalog: {
      async listProducts() { return [...products.values()] },
      async readProduct(_organizationId, id) { return requireRecord(products, id) },
      async createProduct(_organizationId, input: ProductInput) {
        if ([...products.values()].some((record) => record.sku.trim().toLocaleLowerCase('en') === input.sku.trim().toLocaleLowerCase('en'))) {
          throw new CloudError('DUPLICATE_KEY', 'duplicate SKU')
        }
        const record: ProductRecord = {
          ...base(input.id), sku: input.sku.trim(), name: input.name.trim(), stockUnit: input.stockUnit,
          ...(absent(input.description) ? { description: absent(input.description) } : {}),
          ...(absent(input.defaultPurchaseUnit) ? { defaultPurchaseUnit: absent(input.defaultPurchaseUnit) } : {}),
          ...(input.unitsPerPurchaseUnit ? { unitsPerPurchaseUnit: { value: input.unitsPerPurchaseUnit } } : {}),
          ...(absent(input.manufacturer) ? { manufacturer: absent(input.manufacturer) } : {}),
          ...(absent(input.manufacturerRef) ? { manufacturerRef: absent(input.manufacturerRef) } : {}),
          ...(absent(input.note) ? { note: absent(input.note) } : {}),
        }
        products.set(record.id, record)
        return record
      },
      async updateProduct(_organizationId, expectedVersion, input) {
        const stored = requireRecord(products, input.id)
        updateRecord(stored, expectedVersion)
        if ([...products.values()].some((record) => record.id !== input.id && record.sku.trim().toLocaleLowerCase('en') === input.sku.trim().toLocaleLowerCase('en'))) throw new CloudError('DUPLICATE_KEY', 'duplicate SKU')
        const record: ProductRecord = {
          ...base(input.id), ...next(stored), active: stored.active, sku: input.sku.trim(), name: input.name.trim(), stockUnit: input.stockUnit,
          ...(absent(input.description) ? { description: absent(input.description) } : {}),
          ...(absent(input.defaultPurchaseUnit) ? { defaultPurchaseUnit: absent(input.defaultPurchaseUnit) } : {}),
          ...(input.unitsPerPurchaseUnit ? { unitsPerPurchaseUnit: { value: input.unitsPerPurchaseUnit } } : {}),
          ...(absent(input.manufacturer) ? { manufacturer: absent(input.manufacturer) } : {}),
          ...(absent(input.manufacturerRef) ? { manufacturerRef: absent(input.manufacturerRef) } : {}),
          ...(absent(input.note) ? { note: absent(input.note) } : {}),
        }
        products.set(record.id, record)
        return record
      },
      async setProductActive(_organizationId, id, expectedVersion, active) {
        const stored = requireRecord(products, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; products.set(id, record); return record
      },
      async listSuppliers() { return [...suppliers.values()] },
      async readSupplier(_organizationId, id) { return requireRecord(suppliers, id) },
      async createSupplier(_organizationId, input: SupplierInput) {
        const record: SupplierRecord = { ...base(input.id), displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        suppliers.set(record.id, record); return record
      },
      async updateSupplier(_organizationId, expectedVersion, input) {
        const stored = requireRecord(suppliers, input.id); updateRecord(stored, expectedVersion)
        const record: SupplierRecord = { ...base(input.id), ...next(stored), active: stored.active, displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        suppliers.set(record.id, record); return record
      },
      async setSupplierActive(_organizationId, id, expectedVersion, active) {
        const stored = requireRecord(suppliers, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; suppliers.set(id, record); return record
      },
      async listCustomers() { return [...customers.values()] },
      async readCustomer(_organizationId, id) { return requireRecord(customers, id) },
      async createCustomer(_organizationId, input: CustomerInput) {
        const record: CustomerRecord = { ...base(input.id), displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(input.customerStatusId ? { customerStatusId: input.customerStatusId } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        customers.set(record.id, record); return record
      },
      async updateCustomer(_organizationId, expectedVersion, input) {
        const stored = requireRecord(customers, input.id); updateRecord(stored, expectedVersion)
        const record: CustomerRecord = { ...base(input.id), ...next(stored), active: stored.active, displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(input.customerStatusId ? { customerStatusId: input.customerStatusId } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        customers.set(record.id, record); return record
      },
      async setCustomerActive(_organizationId, id, expectedVersion, active) {
        const stored = requireRecord(customers, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; customers.set(id, record); return record
      },
      async listCustomerStatuses() { return [...customerStatuses.values()] },
      async readCustomerStatus(_organizationId, id) { return requireRecord(customerStatuses, id) },
      async createCustomerStatus(_organizationId, input: CustomerStatusInput) {
        if ([...customerStatuses.values()].some((record) => record.code.toLowerCase() === input.code.trim().toLowerCase())) throw new CloudError('DUPLICATE_KEY', 'duplicate status')
        const record: CustomerStatusRecord = { ...base(input.id), code: input.code.trim(), sortOrder: input.sortOrder }
        customerStatuses.set(record.id, record); return record
      },
      async updateCustomerStatus(_organizationId, expectedVersion, input) {
        const stored = requireRecord(customerStatuses, input.id); updateRecord(stored, expectedVersion)
        const record: CustomerStatusRecord = { ...base(input.id), ...next(stored), active: stored.active, code: input.code.trim(), sortOrder: input.sortOrder }
        customerStatuses.set(record.id, record); return record
      },
      async setCustomerStatusActive(_organizationId, id, expectedVersion, active) {
        const stored = requireRecord(customerStatuses, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; customerStatuses.set(id, record); return record
      },
      // Mirrors api.import_catalog's contract: OWNER-only is out of scope for
      // this double, but an idempotent request id, a refused non-empty target
      // and all-or-nothing insertion are not.
      async importLegacyCatalog(input) {
        const previous = imports.get(input.requestId)
        if (previous) {
          if (previous.checksum !== input.payloadChecksum) throw new CloudError('DUPLICATE_KEY', 'request id reused')
          return previous.counts
        }
        if (products.size + suppliers.size + customers.size > 0) {
          throw new CloudError('DUPLICATE_KEY', 'catalog import target is not empty')
        }
        const stamp = (raw: { id: string; active: boolean }) => ({ ...base(raw.id), active: raw.active })
        for (const raw of input.products as readonly LegacyProductShape[]) {
          products.set(raw.id, {
            ...stamp(raw), sku: raw.sku.trim(), name: raw.name.trim(), stockUnit: raw.stockUnit.trim(),
            ...(absent(raw.description) ? { description: absent(raw.description) } : {}),
            ...(absent(raw.defaultPurchaseUnit) ? { defaultPurchaseUnit: absent(raw.defaultPurchaseUnit) } : {}),
            ...(raw.unitsPerPurchaseUnit ? { unitsPerPurchaseUnit: { value: raw.unitsPerPurchaseUnit.value } } : {}),
            ...(absent(raw.manufacturer) ? { manufacturer: absent(raw.manufacturer) } : {}),
            ...(absent(raw.manufacturerRef) ? { manufacturerRef: absent(raw.manufacturerRef) } : {}),
            ...(absent(raw.note) ? { note: absent(raw.note) } : {}),
          })
        }
        for (const raw of input.suppliers as readonly LegacyPartyShape[]) {
          suppliers.set(raw.id, { ...stamp(raw), displayName: raw.displayName.trim(), ...(absent(raw.externalRef) ? { externalRef: absent(raw.externalRef) } : {}), ...(absent(raw.note) ? { note: absent(raw.note) } : {}) })
        }
        for (const raw of input.customers as readonly LegacyPartyShape[]) {
          customers.set(raw.id, { ...stamp(raw), displayName: raw.displayName.trim(), ...(absent(raw.externalRef) ? { externalRef: absent(raw.externalRef) } : {}), ...(absent(raw.note) ? { note: absent(raw.note) } : {}) })
        }
        const counts = { products: input.products.length, suppliers: input.suppliers.length, customers: input.customers.length }
        imports.set(input.requestId, { checksum: input.payloadChecksum, counts })
        return counts
      },
    },
    async signInWithPassword() { signedIn = true; notify({ event: 'SIGNED_IN', userId: TEST_USER_ID }) },
    async signOut() { signedIn = false; notify({ event: 'SIGNED_OUT', userId: null }) },
    async changeOwnPassword() {},
    onAuthChange(listener) {
      authListeners.add(listener)
      return () => { authListeners.delete(listener) }
    },
  }
  return gateway
}
