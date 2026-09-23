/**
 * The data gateway — the one module that names the `api` schema, and the one
 * place a PostgREST failure becomes an application error code.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §24.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a single type with a method per operation the features actually call.
 * There is no repository interface per entity, no unit of work, no DTO layer
 * and no factory — the same explicit-functions philosophy
 * `src/persistence/index.ts` already follows, for the same reason: an
 * abstraction that exists to be abstract adds a file to read and removes
 * nothing.
 *
 * It exists rather than having services call `supabase` directly because it has
 * three concrete jobs:
 *
 * 1. **Boundary conversions.** `timestamptz` arrives already normalised by the
 *    `api` views (§10), and from Phase 11 decimals arrive as canonical strings
 *    that go straight to `Quantity.fromJSON` / `Money.fromJSON` without ever
 *    becoming a JavaScript `number`. One place, tested once.
 * 2. **Hiding the read/write asymmetry.** A read is a `select` on a view; every
 *    write is an `rpc()` with a typed parameter list. Two shapes, one module
 *    that knows which is which, and a service that still just asks for what it
 *    wants.
 * 3. **Error vocabulary.** PostgREST and PostgreSQL failures become
 *    `CloudErrorCode`s, so `src/i18n/persistenceText.ts` EXTENDS rather than
 *    being replaced and no raw Postgres message ever reaches a screen.
 *
 * ## Scope in Phase 11
 *
 * Identity, live membership and the complete catalogue boundary now run here.
 * Products, suppliers, customers and customer statuses are read from API views
 * and mutated through typed RPCs; no feature service has a local persistence
 * fallback. The old IndexedDB catalogue is opened only by the one-time legacy
 * migration module before this gateway becomes authoritative.
 */

import type { CloudClient } from './client'
import {
  CloudError,
  cloudErrorFromPostgrest,
  cloudErrorFromTransport,
  type PostgrestFailure,
} from './errors'

export type MembershipRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type MembershipStatus = 'ACTIVE' | 'DISABLED'

export interface Organization {
  readonly id: string
  readonly name: string
  /** True while a restore holds the write gate (§16). Reads keep working. */
  readonly writeLocked: boolean
  readonly writeLockReason: string | null
  readonly version: number
  readonly updatedAt: string
}

export interface Membership {
  readonly organizationId: string
  readonly userId: string
  readonly role: MembershipRole
  readonly status: MembershipStatus
}

export interface Profile {
  readonly userId: string
  readonly displayName: string
  /** The forced first-password-change flag of §4. A UX gate, not a control. */
  readonly mustChangePassword: boolean
  readonly version: number
}

export interface CloudRecord {
  readonly id: string
  readonly organizationId: string
  readonly active: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy?: string
  readonly updatedBy?: string
  readonly version: number
}

export interface ProductRecord extends CloudRecord {
  readonly sku: string
  readonly name: string
  readonly description?: string
  readonly stockUnit: string
  readonly defaultPurchaseUnit?: string
  /** Exact decimal. This is never a JavaScript number. */
  readonly unitsPerPurchaseUnit?: { readonly value: string }
  readonly manufacturer?: string
  readonly manufacturerRef?: string
  readonly note?: string
}

export interface SupplierRecord extends CloudRecord {
  readonly displayName: string
  /** Opaque external-system code; stored and displayed exactly as entered. */
  readonly externalRef?: string
  readonly note?: string
}

export interface CustomerRecord extends CloudRecord {
  readonly displayName: string
  /** Opaque external-system code; stored and displayed exactly as entered. */
  readonly externalRef?: string
  readonly customerStatusId?: string
  readonly note?: string
}

export interface CustomerStatusRecord extends CloudRecord {
  readonly code: string
  readonly sortOrder: number
}

export interface ProductInput {
  readonly id: string
  readonly sku: string
  readonly name: string
  readonly description?: string
  readonly stockUnit: string
  readonly defaultPurchaseUnit?: string
  readonly unitsPerPurchaseUnit?: string
  readonly manufacturer?: string
  readonly manufacturerRef?: string
  readonly note?: string
}

export interface SupplierInput {
  readonly id: string
  readonly displayName: string
  readonly externalRef?: string
  readonly note?: string
}

export interface CustomerInput {
  readonly id: string
  readonly displayName: string
  readonly externalRef?: string
  readonly customerStatusId?: string
  readonly note?: string
}

export interface CustomerStatusInput {
  readonly id: string
  readonly code: string
  readonly sortOrder: number
}

export interface CatalogImportInput {
  readonly requestId: string
  readonly organizationId: string
  readonly payloadChecksum: string
  readonly products: readonly unknown[]
  readonly suppliers: readonly unknown[]
  readonly customers: readonly unknown[]
}

export interface CatalogImportResult {
  readonly products: number
  readonly suppliers: number
  readonly customers: number
}

export interface CatalogGateway {
  listProducts(organizationId: string): Promise<readonly ProductRecord[]>
  readProduct(organizationId: string, id: string): Promise<ProductRecord>
  createProduct(organizationId: string, input: ProductInput): Promise<ProductRecord>
  updateProduct(organizationId: string, expectedVersion: number, input: ProductInput): Promise<ProductRecord>
  setProductActive(organizationId: string, id: string, expectedVersion: number, active: boolean): Promise<ProductRecord>

  listSuppliers(organizationId: string): Promise<readonly SupplierRecord[]>
  readSupplier(organizationId: string, id: string): Promise<SupplierRecord>
  createSupplier(organizationId: string, input: SupplierInput): Promise<SupplierRecord>
  updateSupplier(organizationId: string, expectedVersion: number, input: SupplierInput): Promise<SupplierRecord>
  setSupplierActive(organizationId: string, id: string, expectedVersion: number, active: boolean): Promise<SupplierRecord>

  listCustomers(organizationId: string): Promise<readonly CustomerRecord[]>
  readCustomer(organizationId: string, id: string): Promise<CustomerRecord>
  createCustomer(organizationId: string, input: CustomerInput): Promise<CustomerRecord>
  updateCustomer(organizationId: string, expectedVersion: number, input: CustomerInput): Promise<CustomerRecord>
  setCustomerActive(organizationId: string, id: string, expectedVersion: number, active: boolean): Promise<CustomerRecord>

  listCustomerStatuses(organizationId: string): Promise<readonly CustomerStatusRecord[]>
  readCustomerStatus(organizationId: string, id: string): Promise<CustomerStatusRecord>
  createCustomerStatus(organizationId: string, input: CustomerStatusInput): Promise<CustomerStatusRecord>
  updateCustomerStatus(organizationId: string, expectedVersion: number, input: CustomerStatusInput): Promise<CustomerStatusRecord>
  setCustomerStatusActive(organizationId: string, id: string, expectedVersion: number, active: boolean): Promise<CustomerStatusRecord>

  importLegacyCatalog(input: CatalogImportInput): Promise<CatalogImportResult>
}

export interface IdentityGateway {
  /** The organisations the caller is an ACTIVE member of. */
  listOrganizations(): Promise<readonly Organization[]>
  /**
   * The caller's own membership rows — including DISABLED ones, which is what
   * lets the boot sequence say "your access has been deactivated" instead of
   * rendering an empty product (§17).
   */
  listOwnMemberships(): Promise<readonly Membership[]>
  /** The caller's own profile, or null if provisioning never created one. */
  readOwnProfile(): Promise<Profile | null>
  /** Renames the caller. `expectedVersion` is required, never defaulted. */
  updateOwnProfile(displayName: string, expectedVersion: number): Promise<Profile>
  /** Clears the forced-change flag after the Auth password was changed. */
  acknowledgePasswordChange(expectedVersion: number): Promise<Profile>
}

export interface DataGateway {
  readonly identity: IdentityGateway
  readonly catalog: CatalogGateway
  /** The signed-in user's id, or null. */
  currentUserId(): Promise<string | null>
  signInWithPassword(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  /** Changes the caller's own Auth password. Does not clear the forced flag. */
  changeOwnPassword(newPassword: string): Promise<void>
}

/** Row shapes exactly as the `api` views project them. */
interface OrganizationRow {
  id: string
  name: string
  write_locked: boolean
  write_lock_reason: string | null
  version: number
  updated_at: string
}

interface MembershipRow {
  organization_id: string
  user_id: string
  role: MembershipRole
  status: MembershipStatus
}

interface ProfileRow {
  user_id: string
  display_name: string
  must_change_password: boolean
  version: number
}

interface CatalogRow {
  id: string
  organization_id: string
  active: boolean
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
  version: number
}

interface ProductRow extends CatalogRow {
  sku: string
  name: string
  description: string | null
  stock_unit: string
  default_purchase_unit: string | null
  units_per_purchase_unit: string | null
  manufacturer: string | null
  manufacturer_ref: string | null
  note: string | null
}

interface SupplierRow extends CatalogRow {
  display_name: string
  external_ref: string | null
  note: string | null
}

interface CustomerRow extends CatalogRow {
  display_name: string
  external_ref: string | null
  customer_status_id: string | null
  note: string | null
}

interface CustomerStatusRow extends CatalogRow {
  code: string
  sort_order: number
}

const CATALOG_COLUMNS =
  'id,organization_id,active,created_at,updated_at,created_by,updated_by,version'
const PRODUCT_COLUMNS = `${CATALOG_COLUMNS},sku,name,description,stock_unit,default_purchase_unit,units_per_purchase_unit,manufacturer,manufacturer_ref,note`
const SUPPLIER_COLUMNS = `${CATALOG_COLUMNS},display_name,external_ref,note`
const CUSTOMER_COLUMNS = `${CATALOG_COLUMNS},display_name,external_ref,customer_status_id,note`
const CUSTOMER_STATUS_COLUMNS = `${CATALOG_COLUMNS},code,sort_order`

function exactDecimal(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new CloudError('RECORD_INVALID', `${field} was not returned as a canonical decimal string`)
  }
  return value
}

function baseRecord(row: CatalogRow): CloudRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    ...(row.updated_by === null ? {} : { updatedBy: row.updated_by }),
    version: row.version,
  }
}

function toProduct(row: ProductRow): ProductRecord {
  return {
    ...baseRecord(row),
    sku: row.sku,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    stockUnit: row.stock_unit,
    ...(row.default_purchase_unit === null ? {} : { defaultPurchaseUnit: row.default_purchase_unit }),
    ...(row.units_per_purchase_unit === null
      ? {}
      : { unitsPerPurchaseUnit: { value: exactDecimal(row.units_per_purchase_unit, 'units_per_purchase_unit') } }),
    ...(row.manufacturer === null ? {} : { manufacturer: row.manufacturer }),
    ...(row.manufacturer_ref === null ? {} : { manufacturerRef: row.manufacturer_ref }),
    ...(row.note === null ? {} : { note: row.note }),
  }
}

function toSupplier(row: SupplierRow): SupplierRecord {
  return {
    ...baseRecord(row),
    displayName: row.display_name,
    ...(row.external_ref === null ? {} : { externalRef: row.external_ref }),
    ...(row.note === null ? {} : { note: row.note }),
  }
}

function toCustomer(row: CustomerRow): CustomerRecord {
  return {
    ...baseRecord(row),
    displayName: row.display_name,
    ...(row.external_ref === null ? {} : { externalRef: row.external_ref }),
    ...(row.customer_status_id === null ? {} : { customerStatusId: row.customer_status_id }),
    ...(row.note === null ? {} : { note: row.note }),
  }
}

function toCustomerStatus(row: CustomerStatusRow): CustomerStatusRecord {
  return { ...baseRecord(row), code: row.code, sortOrder: row.sort_order }
}

function optionalParameter(value: string | undefined): string {
  return value ?? ''
}

function one<T>(rows: readonly T[]): T {
  if (rows.length !== 1) {
    throw new CloudError('RECORD_NOT_FOUND', 'the server did not return exactly one row')
  }
  return rows[0]
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    writeLocked: row.write_locked,
    writeLockReason: row.write_lock_reason,
    version: row.version,
    updatedAt: row.updated_at,
  }
}

function toProfile(row: ProfileRow): Profile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    mustChangePassword: row.must_change_password,
    version: row.version,
  }
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Runs a Supabase call and converts both failure shapes into one.
 *
 * `supabase-js` reports a PostgREST error as a value on the result and a
 * network failure as a thrown `TypeError`, so a caller that only checked
 * `result.error` would treat "the server is unreachable" as success with no
 * data — which is the empty-screen failure §13 refuses. Both paths land here.
 */
async function run<T>(
  operation: () => PromiseLike<{ data: T | null; error: PostgrestFailure | null }>,
): Promise<T> {
  let result: { data: T | null; error: PostgrestFailure | null }
  try {
    result = await operation()
  } catch (cause) {
    throw cloudErrorFromTransport(cause, isOnline())
  }

  if (result.error) {
    throw cloudErrorFromPostgrest(result.error)
  }
  if (result.data === null) {
    throw new CloudError('RECORD_NOT_FOUND', 'the server returned no row')
  }
  return result.data
}

export function createDataGateway(client: CloudClient): DataGateway {
  const identity: IdentityGateway = {
    async listOrganizations() {
      const rows = await run<OrganizationRow[]>(() =>
        client.from('organizations').select('id,name,write_locked,write_lock_reason,version,updated_at'),
      )
      return rows.map(toOrganization)
    },

    async listOwnMemberships() {
      const rows = await run<MembershipRow[]>(() =>
        client.from('memberships').select('organization_id,user_id,role,status'),
      )
      return rows.map((row) => ({
        organizationId: row.organization_id,
        userId: row.user_id,
        role: row.role,
        status: row.status,
      }))
    },

    async readOwnProfile() {
      const userId = await currentUserId()
      if (userId === null) {
        throw new CloudError('SESSION_EXPIRED', 'there is no signed-in user')
      }
      const rows = await run<ProfileRow[]>(() =>
        client
          .from('profiles')
          .select('user_id,display_name,must_change_password,version')
          .eq('user_id', userId),
      )
      // Zero rows is a real state, not an error: an auth account can exist
      // without a profile if provisioning failed between the two, and §4 case A
      // is specifically about converging from there.
      return rows.length === 0 ? null : toProfile(rows[0])
    },

    async updateOwnProfile(displayName, expectedVersion) {
      const rows = await run<ProfileRow[]>(() =>
        client.rpc('update_own_profile', {
          p_display_name: displayName,
          p_expected_version: expectedVersion,
        }),
      )
      return toProfile(rows[0])
    },

    async acknowledgePasswordChange(expectedVersion) {
      const rows = await run<ProfileRow[]>(() =>
        client.rpc('acknowledge_password_change', { p_expected_version: expectedVersion }),
      )
      return toProfile(rows[0])
    },
  }

  const catalog: CatalogGateway = {
    async listProducts(organizationId) {
      const rows = await run<ProductRow[]>(() =>
        client.from('products').select(PRODUCT_COLUMNS).eq('organization_id', organizationId),
      )
      return rows.map(toProduct)
    },
    async readProduct(organizationId, id) {
      const rows = await run<ProductRow[]>(() =>
        client.from('products').select(PRODUCT_COLUMNS).eq('organization_id', organizationId).eq('id', id),
      )
      return toProduct(one(rows))
    },
    async createProduct(organizationId, input) {
      const rows = await run<ProductRow[]>(() => client.rpc('create_product', productParams(organizationId, input)))
      return toProduct(one(rows))
    },
    async updateProduct(organizationId, expectedVersion, input) {
      const rows = await run<ProductRow[]>(() => client.rpc('update_product', {
        ...productParams(organizationId, input), p_expected_version: expectedVersion,
      }))
      return toProduct(one(rows))
    },
    async setProductActive(organizationId, id, expectedVersion, active) {
      const rows = await run<ProductRow[]>(() => client.rpc('set_product_active', {
        p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
      }))
      return toProduct(one(rows))
    },

    async listSuppliers(organizationId) {
      const rows = await run<SupplierRow[]>(() => client.from('suppliers').select(SUPPLIER_COLUMNS).eq('organization_id', organizationId))
      return rows.map(toSupplier)
    },
    async readSupplier(organizationId, id) {
      const rows = await run<SupplierRow[]>(() => client.from('suppliers').select(SUPPLIER_COLUMNS).eq('organization_id', organizationId).eq('id', id))
      return toSupplier(one(rows))
    },
    async createSupplier(organizationId, input) {
      const rows = await run<SupplierRow[]>(() => client.rpc('create_supplier', partyParams(organizationId, input)))
      return toSupplier(one(rows))
    },
    async updateSupplier(organizationId, expectedVersion, input) {
      const rows = await run<SupplierRow[]>(() => client.rpc('update_supplier', {
        ...partyParams(organizationId, input), p_expected_version: expectedVersion,
      }))
      return toSupplier(one(rows))
    },
    async setSupplierActive(organizationId, id, expectedVersion, active) {
      const rows = await run<SupplierRow[]>(() => client.rpc('set_supplier_active', {
        p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
      }))
      return toSupplier(one(rows))
    },

    async listCustomers(organizationId) {
      const rows = await run<CustomerRow[]>(() => client.from('customers').select(CUSTOMER_COLUMNS).eq('organization_id', organizationId))
      return rows.map(toCustomer)
    },
    async readCustomer(organizationId, id) {
      const rows = await run<CustomerRow[]>(() => client.from('customers').select(CUSTOMER_COLUMNS).eq('organization_id', organizationId).eq('id', id))
      return toCustomer(one(rows))
    },
    async createCustomer(organizationId, input) {
      const rows = await run<CustomerRow[]>(() => client.rpc('create_customer', customerParams(organizationId, input)))
      return toCustomer(one(rows))
    },
    async updateCustomer(organizationId, expectedVersion, input) {
      const rows = await run<CustomerRow[]>(() => client.rpc('update_customer', {
        ...customerParams(organizationId, input), p_expected_version: expectedVersion,
      }))
      return toCustomer(one(rows))
    },
    async setCustomerActive(organizationId, id, expectedVersion, active) {
      const rows = await run<CustomerRow[]>(() => client.rpc('set_customer_active', {
        p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
      }))
      return toCustomer(one(rows))
    },

    async listCustomerStatuses(organizationId) {
      const rows = await run<CustomerStatusRow[]>(() => client.from('customer_statuses').select(CUSTOMER_STATUS_COLUMNS)
        .eq('organization_id', organizationId).order('sort_order').order('code'))
      return rows.map(toCustomerStatus)
    },
    async readCustomerStatus(organizationId, id) {
      const rows = await run<CustomerStatusRow[]>(() => client.from('customer_statuses').select(CUSTOMER_STATUS_COLUMNS)
        .eq('organization_id', organizationId).eq('id', id))
      return toCustomerStatus(one(rows))
    },
    async createCustomerStatus(organizationId, input) {
      const rows = await run<CustomerStatusRow[]>(() => client.rpc('create_customer_status', statusParams(organizationId, input)))
      return toCustomerStatus(one(rows))
    },
    async updateCustomerStatus(organizationId, expectedVersion, input) {
      const rows = await run<CustomerStatusRow[]>(() => client.rpc('update_customer_status', {
        ...statusParams(organizationId, input), p_expected_version: expectedVersion,
      }))
      return toCustomerStatus(one(rows))
    },
    async setCustomerStatusActive(organizationId, id, expectedVersion, active) {
      const rows = await run<CustomerStatusRow[]>(() => client.rpc('set_customer_status_active', {
        p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
      }))
      return toCustomerStatus(one(rows))
    },

    async importLegacyCatalog(input) {
      return run<CatalogImportResult>(() => client.rpc('import_catalog', {
        p_request_id: input.requestId,
        p_organization_id: input.organizationId,
        p_payload_checksum: input.payloadChecksum,
        p_products: input.products,
        p_suppliers: input.suppliers,
        p_customers: input.customers,
      }))
    },
  }

  async function currentUserId(): Promise<string | null> {
    try {
      const { data, error } = await client.auth.getSession()
      if (error) {
        throw new CloudError('SESSION_EXPIRED', 'the session could not be read')
      }
      return data.session?.user.id ?? null
    } catch (cause) {
      throw cloudErrorFromTransport(cause, isOnline())
    }
  }

  return {
    identity,
    catalog,
    currentUserId,

    async signInWithPassword(email, password) {
      let result: Awaited<ReturnType<typeof client.auth.signInWithPassword>>
      try {
        result = await client.auth.signInWithPassword({ email, password })
      } catch (cause) {
        throw cloudErrorFromTransport(cause, isOnline())
      }
      if (result.error) {
        // Wrong credentials and a disabled account are deliberately the same
        // answer. Distinguishing them would turn the sign-in form into an
        // oracle for which addresses have accounts, which is the enumeration
        // problem §7 closes everywhere else.
        throw new CloudError('SESSION_EXPIRED', 'the e-mail address or password is not correct')
      }
    },

    async signOut() {
      try {
        await client.auth.signOut()
      } catch (cause) {
        throw cloudErrorFromTransport(cause, isOnline())
      }
    },

    async changeOwnPassword(newPassword) {
      let result: Awaited<ReturnType<typeof client.auth.updateUser>>
      try {
        result = await client.auth.updateUser({ password: newPassword })
      } catch (cause) {
        throw cloudErrorFromTransport(cause, isOnline())
      }
      if (result.error) {
        throw new CloudError('RECORD_INVALID', 'the password was refused')
      }
    },
  }
}

function productParams(organizationId: string, input: ProductInput) {
  return {
    p_id: input.id,
    p_organization_id: organizationId,
    p_sku: input.sku,
    p_name: input.name,
    p_description: optionalParameter(input.description),
    p_stock_unit: input.stockUnit,
    p_default_purchase_unit: optionalParameter(input.defaultPurchaseUnit),
    p_units_per_purchase_unit: optionalParameter(input.unitsPerPurchaseUnit),
    p_manufacturer: optionalParameter(input.manufacturer),
    p_manufacturer_ref: optionalParameter(input.manufacturerRef),
    p_note: optionalParameter(input.note),
  }
}

function partyParams(organizationId: string, input: SupplierInput) {
  return {
    p_id: input.id,
    p_organization_id: organizationId,
    p_display_name: input.displayName,
    p_external_ref: optionalParameter(input.externalRef),
    p_note: optionalParameter(input.note),
  }
}

function customerParams(organizationId: string, input: CustomerInput) {
  return {
    p_id: input.id,
    p_organization_id: organizationId,
    p_display_name: input.displayName,
    p_external_ref: optionalParameter(input.externalRef),
    p_customer_status_id: input.customerStatusId ?? null,
    p_note: optionalParameter(input.note),
  }
}

function statusParams(organizationId: string, input: CustomerStatusInput) {
  return {
    p_id: input.id,
    p_organization_id: organizationId,
    p_code: input.code,
    p_sort_order: input.sortOrder,
  }
}
