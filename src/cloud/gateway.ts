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
 *
 * ## Complete reads (Audit A, A-H1)
 *
 * PostgREST caps every response at the server's `max_rows` (1000 on this
 * project) and says nothing when it does. A catalogue list is therefore read
 * in keyset pages ordered by `id`, each page asking for an exact count of the
 * rows still ahead of it. The loop ends only when the server reports none
 * left, so a cap of any size — larger or smaller than the page — can shorten a
 * page but can never shorten the result. A page that is empty while the count
 * says rows remain is refused rather than treated as the end.
 *
 * The pages are separate requests, so a traversal alone is not a picture of
 * one moment: a row committed behind the cursor while it moves would be
 * missed, and a membership withdrawn between two pages would end the loop
 * early (Audit A source review, R-1/R-2). Every traversal is therefore
 * RECONCILED against one exact count of the whole visible set, taken after
 * it. What that proves, and what it does not, is stated on `readAll`.
 * Products, suppliers, customers and customer statuses are read from API views
 * and mutated through typed RPCs; no feature service has a local persistence
 * fallback. The old IndexedDB catalogue is opened only by the one-time legacy
 * migration module before this gateway becomes authoritative.
 */

import {
  isAuthApiError,
  isAuthRetryableFetchError,
  type AuthChangeEvent,
} from '@supabase/supabase-js'
import { CLOUD_SESSION_STORAGE_KEY, type CloudClient } from './client'
import {
  CloudError,
  cloudErrorFromPostgrest,
  cloudErrorFromTransport,
  isCloudError,
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

/** An authentication state change, reduced to what the application acts on. */
export interface AuthChange {
  readonly event: AuthChangeEvent
  /** The user the session now belongs to, or null when there is none. */
  readonly userId: string | null
}

export interface DataGateway {
  readonly identity: IdentityGateway
  readonly catalog: CatalogGateway
  /** The signed-in user's id, or null. */
  currentUserId(): Promise<string | null>
  signInWithPassword(email: string, password: string): Promise<void>
  /**
   * Ends the session ON THIS DEVICE, unconditionally, then asks the server to
   * revoke it as a best effort. Resolves only once no credential remains in
   * local storage; rejects if one does.
   */
  signOut(): Promise<void>
  /** Changes the caller's own Auth password. Does not clear the forced flag. */
  changeOwnPassword(newPassword: string): Promise<void>
  /**
   * Observes sign-in, sign-out, token refresh and session replacement —
   * including those made in another tab, which Supabase relays over a
   * BroadcastChannel. Returns the unsubscribe function.
   */
  onAuthChange(listener: (change: AuthChange) => void): () => void
}

export interface DataGatewayOptions {
  /**
   * Keyset page size for catalogue reads. Any value is correct — the loop
   * trusts the server's count, not the page size — so tests set it above and
   * below the server's `max_rows` to prove exactly that.
   */
  readonly pageSize?: number
  /** Where the session is persisted; must be the storage the client uses. */
  readonly storage?: Storage
  readonly storageKey?: string
}

const DEFAULT_PAGE_SIZE = 500
/** A guard against a server that keeps reporting rows it never returns. */
const MAX_PAGES = 10_000
/**
 * How many whole traversals one list read may take before it gives up. A
 * traversal is repeated only when rows were committed behind the cursor while
 * it ran; under writes that never pause, the read fails explicitly instead of
 * looping or returning a set it could not reconcile.
 */
export const MAX_CATALOG_TRAVERSALS = 3

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

interface PostgrestOutcome<T> {
  data: T | null
  error: PostgrestFailure | null
  count?: number | null
  status?: number
}

/**
 * Runs a Supabase call and converts every failure shape into one.
 *
 * `postgrest-js` reports BOTH a PostgREST error and a network failure as a
 * returned value — the latter with `status: 0` — so the status travels into
 * the classifier. A thrown value is still handled, for the transport layers
 * that do throw.
 */
async function execute<T>(
  operation: () => PromiseLike<PostgrestOutcome<T>>,
): Promise<{ data: T; count: number | null }> {
  let result: PostgrestOutcome<T>
  try {
    result = await operation()
  } catch (cause) {
    throw cloudErrorFromTransport(cause, isOnline())
  }

  if (result.error) {
    throw cloudErrorFromPostgrest(result.error, { status: result.status, online: isOnline() })
  }
  if (result.data === null) {
    throw new CloudError('RECORD_NOT_FOUND', 'the server returned no row')
  }
  return { data: result.data, count: result.count ?? null }
}

async function run<T>(operation: () => PromiseLike<PostgrestOutcome<T>>): Promise<T> {
  return (await execute(operation)).data
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function createDataGateway(client: CloudClient, options: DataGatewayOptions = {}): DataGateway {
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE))
  const storageKey = options.storageKey ?? CLOUD_SESSION_STORAGE_KEY
  const storage = (): Storage | undefined =>
    options.storage ?? (globalThis as { localStorage?: Storage }).localStorage

  /**
   * True when the caller can currently see this organisation, which under RLS
   * means: an ACTIVE membership, right now. Read from live database state, not
   * from anything cached at boot.
   */
  async function organizationVisible(organizationId: string): Promise<boolean> {
    const rows = await run<{ id: string }[]>(() =>
      client.from('organizations').select('id').eq('id', organizationId),
    )
    return rows.length === 1
  }

  /**
   * An empty answer from an RLS-protected view means "nothing you may see",
   * which is EITHER an empty catalogue OR a membership that no longer exists.
   * The second must never be rendered as the first — "your catalogue is empty,
   * add your first product" said to someone whose access was just withdrawn
   * is exactly the empty-screen failure §13 forbids.
   */
  async function assertStillMember(organizationId: string): Promise<void> {
    if (!(await organizationVisible(organizationId))) {
      throw new CloudError('NO_MEMBERSHIP', 'the caller no longer has an active membership in this organization')
    }
  }

  /**
   * Every row of one catalogue view for one organisation.
   *
   * ## What a successful return guarantees
   *
   * The returned ID SET is exactly the set of rows the caller could see at one
   * instant: the moment of the reconciliation count taken after the last
   * page. The argument rests on three properties of the catalogue, each held
   * by the schema rather than by this module:
   *
   * - no catalogue row can be deleted by any client path (posture P4a/P4b);
   * - no row changes organisation (`assert_tenant_immutable` trigger), and no
   *   RPC changes an `id`;
   * - pages are keyset pages on that immutable `id`, so no row is read twice.
   *
   * Every row a traversal collected therefore still exists, in this
   * organisation, when the count runs — so, while the membership holds, the
   * collected set is a SUBSET of the set the count measures. A subset with the
   * same size is the same set. A row committed behind the cursor during the
   * traversal makes the count larger, and the whole traversal is repeated, at
   * most `MAX_CATALOG_TRAVERSALS` times before the read fails explicitly. A
   * count SMALLER than what was collected means rows became invisible, which
   * for these tables means the membership was withdrawn: `NO_MEMBERSHIP`.
   *
   * ## What it does NOT guarantee
   *
   * It is not an atomic snapshot of the CONTENT. Each page is its own
   * request; a row updated after its page was read is returned as that page
   * saw it, so two rows may reflect different instants. Writes are protected
   * separately, by `expected_version`. Rows committed after the count are not
   * included, as they could not be by any read. If a DELETE path or a
   * mutable `id` were ever introduced, the subset argument above would no
   * longer hold and this function would have to change with it.
   */
  async function readAll<Row extends { id: string }>(view: string, columns: string, organizationId: string): Promise<Row[]> {
    for (let traversal = 1; traversal <= MAX_CATALOG_TRAVERSALS; traversal += 1) {
      const rows = await traverse<Row>(view, columns, organizationId)
      if (new Set(rows.map((row) => row.id)).size !== rows.length) {
        throw new CloudError('UNEXPECTED', 'the catalogue read returned a row twice')
      }
      const total = await visibleTotal(view, organizationId)
      if (total === rows.length) {
        if (rows.length === 0) await assertStillMember(organizationId)
        return rows
      }
      if (total < rows.length) {
        // Rows already read are no longer visible. Catalogue rows are never
        // deleted and never change organisation, so this is a withdrawn
        // membership — reported as such, never as a shorter catalogue.
        await assertStillMember(organizationId)
      }
      // Otherwise rows were committed behind the cursor: read everything again.
    }
    throw new CloudError('UNEXPECTED', 'the catalogue kept changing while it was being read')
  }

  /** The exact number of rows of one view the caller can see right now, in one statement. */
  async function visibleTotal(view: string, organizationId: string): Promise<number> {
    const { count } = await execute<{ id: string }[]>(() =>
      client.from(view).select('id', { count: 'exact' }).eq('organization_id', organizationId).limit(1) as unknown as
        PromiseLike<PostgrestOutcome<{ id: string }[]>>,
    )
    if (count === null) {
      throw new CloudError('UNEXPECTED', 'the server did not report how many rows the read covers')
    }
    return count
  }

  /** One keyset traversal: pages until the server's per-page count says none remain. */
  async function traverse<Row extends { id: string }>(view: string, columns: string, organizationId: string): Promise<Row[]> {
    const rows: Row[] = []
    let afterId: string | undefined
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES) {
        throw new CloudError('UNEXPECTED', 'the catalogue read did not converge')
      }
      const { data, count } = await execute<Row[]>(() => {
        let query = client
          .from(view)
          .select(columns, { count: 'exact' })
          .eq('organization_id', organizationId)
        if (afterId !== undefined) {
          query = query.gt('id', afterId)
        }
        return query.order('id', { ascending: true }).limit(pageSize) as unknown as PromiseLike<PostgrestOutcome<Row[]>>
      })
      if (count === null) {
        throw new CloudError('UNEXPECTED', 'the server did not report how many rows the read covers')
      }
      rows.push(...data)
      if (count <= data.length) {
        break
      }
      if (data.length === 0) {
        throw new CloudError('UNEXPECTED', 'the server reported rows it did not return')
      }
      afterId = data[data.length - 1].id
    }
    return rows
  }

  /** Exactly one row, or a NOT_FOUND that is not really a lost membership. */
  async function exactlyOne<T>(rows: readonly T[], organizationId: string): Promise<T> {
    if (rows.length === 1) {
      return rows[0]
    }
    if (rows.length === 0) {
      await assertStillMember(organizationId)
    }
    return one(rows)
  }

  /**
   * A catalogue mutation. A FORBIDDEN refusal is re-examined against live
   * membership, so "you are no longer a member here" is distinguished from
   * "your role may not do this" (the import's OWNER requirement).
   */
  async function mutate<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      if (isCloudError(cause) && cause.code === 'FORBIDDEN' && !(await organizationVisible(organizationId).catch(() => true))) {
        throw new CloudError('NO_MEMBERSHIP', 'the caller no longer has an active membership in this organization')
      }
      throw cause
    }
  }

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
      return (await readAll<ProductRow>('products', PRODUCT_COLUMNS, organizationId)).map(toProduct)
    },
    async readProduct(organizationId, id) {
      const rows = await run<ProductRow[]>(() =>
        client.from('products').select(PRODUCT_COLUMNS).eq('organization_id', organizationId).eq('id', id),
      )
      return toProduct(await exactlyOne(rows, organizationId))
    },
    async createProduct(organizationId, input) {
      return mutate(organizationId, async () =>
        toProduct(one(await run<ProductRow[]>(() => client.rpc('create_product', productParams(organizationId, input))))),
      )
    },
    async updateProduct(organizationId, expectedVersion, input) {
      return mutate(organizationId, async () =>
        toProduct(one(await run<ProductRow[]>(() => client.rpc('update_product', {
          ...productParams(organizationId, input), p_expected_version: expectedVersion,
        })))),
      )
    },
    async setProductActive(organizationId, id, expectedVersion, active) {
      return mutate(organizationId, async () =>
        toProduct(one(await run<ProductRow[]>(() => client.rpc('set_product_active', {
          p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
        })))),
      )
    },

    async listSuppliers(organizationId) {
      return (await readAll<SupplierRow>('suppliers', SUPPLIER_COLUMNS, organizationId)).map(toSupplier)
    },
    async readSupplier(organizationId, id) {
      const rows = await run<SupplierRow[]>(() => client.from('suppliers').select(SUPPLIER_COLUMNS).eq('organization_id', organizationId).eq('id', id))
      return toSupplier(await exactlyOne(rows, organizationId))
    },
    async createSupplier(organizationId, input) {
      return mutate(organizationId, async () =>
        toSupplier(one(await run<SupplierRow[]>(() => client.rpc('create_supplier', partyParams(organizationId, input))))),
      )
    },
    async updateSupplier(organizationId, expectedVersion, input) {
      return mutate(organizationId, async () =>
        toSupplier(one(await run<SupplierRow[]>(() => client.rpc('update_supplier', {
          ...partyParams(organizationId, input), p_expected_version: expectedVersion,
        })))),
      )
    },
    async setSupplierActive(organizationId, id, expectedVersion, active) {
      return mutate(organizationId, async () =>
        toSupplier(one(await run<SupplierRow[]>(() => client.rpc('set_supplier_active', {
          p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
        })))),
      )
    },

    async listCustomers(organizationId) {
      return (await readAll<CustomerRow>('customers', CUSTOMER_COLUMNS, organizationId)).map(toCustomer)
    },
    async readCustomer(organizationId, id) {
      const rows = await run<CustomerRow[]>(() => client.from('customers').select(CUSTOMER_COLUMNS).eq('organization_id', organizationId).eq('id', id))
      return toCustomer(await exactlyOne(rows, organizationId))
    },
    async createCustomer(organizationId, input) {
      return mutate(organizationId, async () =>
        toCustomer(one(await run<CustomerRow[]>(() => client.rpc('create_customer', customerParams(organizationId, input))))),
      )
    },
    async updateCustomer(organizationId, expectedVersion, input) {
      return mutate(organizationId, async () =>
        toCustomer(one(await run<CustomerRow[]>(() => client.rpc('update_customer', {
          ...customerParams(organizationId, input), p_expected_version: expectedVersion,
        })))),
      )
    },
    async setCustomerActive(organizationId, id, expectedVersion, active) {
      return mutate(organizationId, async () =>
        toCustomer(one(await run<CustomerRow[]>(() => client.rpc('set_customer_active', {
          p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
        })))),
      )
    },

    async listCustomerStatuses(organizationId) {
      // Read in id order like every catalogue list, then presented in the
      // stable display order: sort_order, then the case-folded code, then id,
      // so two screens can never disagree about the sequence.
      const rows = await readAll<CustomerStatusRow>('customer_statuses', CUSTOMER_STATUS_COLUMNS, organizationId)
      return rows.map(toCustomerStatus).sort((left, right) =>
        left.sortOrder - right.sortOrder ||
        compareText(left.code.toLowerCase(), right.code.toLowerCase()) ||
        compareText(left.id, right.id),
      )
    },
    async readCustomerStatus(organizationId, id) {
      const rows = await run<CustomerStatusRow[]>(() => client.from('customer_statuses').select(CUSTOMER_STATUS_COLUMNS)
        .eq('organization_id', organizationId).eq('id', id))
      return toCustomerStatus(await exactlyOne(rows, organizationId))
    },
    async createCustomerStatus(organizationId, input) {
      return mutate(organizationId, async () =>
        toCustomerStatus(one(await run<CustomerStatusRow[]>(() => client.rpc('create_customer_status', statusParams(organizationId, input))))),
      )
    },
    async updateCustomerStatus(organizationId, expectedVersion, input) {
      return mutate(organizationId, async () =>
        toCustomerStatus(one(await run<CustomerStatusRow[]>(() => client.rpc('update_customer_status', {
          ...statusParams(organizationId, input), p_expected_version: expectedVersion,
        })))),
      )
    },
    async setCustomerStatusActive(organizationId, id, expectedVersion, active) {
      return mutate(organizationId, async () =>
        toCustomerStatus(one(await run<CustomerStatusRow[]>(() => client.rpc('set_customer_status_active', {
          p_id: id, p_organization_id: organizationId, p_expected_version: expectedVersion, p_active: active,
        })))),
      )
    },

    async importLegacyCatalog(input) {
      return mutate(input.organizationId, () => run<CatalogImportResult>(() => client.rpc('import_catalog', {
        p_request_id: input.requestId,
        p_organization_id: input.organizationId,
        p_payload_checksum: input.payloadChecksum,
        p_products: input.products,
        p_suppliers: input.suppliers,
        p_customers: input.customers,
      })))
    },
  }

  /** Network trouble while talking to Auth is not a verdict about the session. */
  function authFailure(error: unknown, whenRefused: CloudError): CloudError {
    if (isAuthRetryableFetchError(error)) {
      return cloudErrorFromTransport(error, isOnline())
    }
    if (isAuthApiError(error) && error.status >= 500) {
      return new CloudError('SERVER_UNAVAILABLE', 'the authentication service is not answering')
    }
    return whenRefused
  }

  async function currentUserId(): Promise<string | null> {
    let result: Awaited<ReturnType<typeof client.auth.getSession>>
    try {
      result = await client.auth.getSession()
    } catch (cause) {
      throw cloudErrorFromTransport(cause, isOnline())
    }
    if (result.error) {
      // A refresh the server REFUSED ends the session; a refresh that could
      // not be attempted because the network is down does not. Reporting the
      // second as "session expired" would send an offline user to a sign-in
      // form that cannot work either.
      throw authFailure(result.error, new CloudError('SESSION_EXPIRED', 'the session could not be refreshed'))
    }
    return result.data.session?.user.id ?? null
  }

  /** Removes every key auth-js keeps for this session from local storage. */
  function clearStoredSession(): void {
    const store = storage()
    if (!store) return
    for (const key of [storageKey, `${storageKey}-user`, `${storageKey}-code-verifier`]) {
      store.removeItem(key)
    }
  }

  function storedAccessToken(): string | undefined {
    try {
      const raw = storage()?.getItem(storageKey)
      if (!raw) return undefined
      const parsed = JSON.parse(raw) as { access_token?: unknown }
      return typeof parsed.access_token === 'string' ? parsed.access_token : undefined
    } catch {
      return undefined
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
        // problem §7 closes everywhere else. A network failure is NOT that
        // answer: it is OFFLINE or SERVER_UNAVAILABLE.
        throw authFailure(result.error, new CloudError('INVALID_CREDENTIALS', 'the e-mail address or password is not correct'))
      }
    },

    async signOut() {
      // Audit A, A-M3. auth-js loads — and, for an expired access token,
      // REFRESHES — the session before it removes it; with the network down
      // that refresh fails and the session used to survive in storage, so the
      // previous user came back the moment the connection did.
      //
      // 1. Capture the access token for a best-effort server revocation.
      // 2. Sign out LOCALLY. If auth-js cannot, clear its storage keys
      //    directly and sign out again, which now finds no session and emits
      //    SIGNED_OUT to this tab and every other tab.
      // 3. Refuse to report success while any credential remains stored.
      // 4. Only then ask the server to revoke the session everywhere. Offline,
      //    that fails — harmlessly, because the device no longer holds it.
      const accessToken = storedAccessToken()

      let local: { error: unknown } = { error: null }
      try {
        local = await client.auth.signOut({ scope: 'local' })
      } catch (cause) {
        local = { error: cause }
      }
      if (local.error || storage()?.getItem(storageKey) != null) {
        clearStoredSession()
        try {
          await client.auth.signOut({ scope: 'local' })
        } catch {
          // The storage is already clear; the event is a courtesy to listeners.
        }
      }

      if (storage()?.getItem(storageKey) != null) {
        throw new CloudError('UNEXPECTED', 'the local session could not be removed')
      }

      if (accessToken) {
        try {
          await client.auth.admin.signOut(accessToken, 'global')
        } catch {
          // Best effort by definition: an expired token or no network cannot
          // revoke, and neither leaves anything usable on this device.
        }
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
        throw authFailure(result.error, new CloudError('RECORD_INVALID', 'the password was refused'))
      }
    },

    onAuthChange(listener) {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        listener({ event, userId: session?.user.id ?? null })
      })
      return () => data.subscription.unsubscribe()
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
