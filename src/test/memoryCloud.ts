import {
  CloudError,
  type AdministrationGateway,
  type AuthChange,
  type CustomerInput,
  type CustomerRecord,
  type CustomerStatusInput,
  type CustomerStatusRecord,
  type DataGateway,
  type MembershipRole,
  type MembershipStatus,
  type OrganizationMember,
  type ProductInput,
  type ProductRecord,
  type SupplierInput,
  type SupplierRecord,
} from '../cloud'

export const TEST_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const TEST_ORGANIZATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface RecordMaps {
  readonly products: Map<string, ProductRecord>
  readonly suppliers: Map<string, SupplierRecord>
  readonly customers: Map<string, CustomerRecord>
  readonly customerStatuses: Map<string, CustomerStatusRecord>
}

/** One organisation of the double, and the signed-in user's membership in it. */
export interface MemoryOrganization {
  readonly id: string
  readonly name: string
  role: MembershipRole
  status: MembershipStatus
}

export interface MemoryCloud extends DataGateway {
  /** The records of the first (default) organisation. */
  readonly records: RecordMaps
  /** Records per organisation id: a user in two companies sees two catalogues. */
  recordsFor(organizationId: string): RecordMaps
  /** The signed-in user's memberships, mutable so a test can disable one "on the server". */
  readonly organizations: MemoryOrganization[]
  /** Colleagues per organisation, as an administrator lists them. */
  membersFor(organizationId: string): Map<string, OrganizationMember>
  /** Every call the admin double received, in order, for assertions. */
  readonly adminCalls: string[]
  /** Access tokens of every invitation session adopted, for assertions. */
  readonly adoptedInvitations: string[]
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

export function createMemoryCloudGateway(options: {
  signedIn?: boolean
  failure?: CloudError
  organizations?: readonly { id: string; name: string; role?: MembershipRole; status?: MembershipStatus }[]
} = {}): MemoryCloud {
  const organizations: MemoryOrganization[] = (options.organizations ?? [{ id: TEST_ORGANIZATION_ID, name: 'Test Company' }])
    .map((organization) => ({ id: organization.id, name: organization.name, role: organization.role ?? 'OWNER', status: organization.status ?? 'ACTIVE' }))
  /** Like the server's `updated_at`: stable until the organisation itself changes. */
  const organizationsUpdatedAt = now()
  const recordMaps = new Map<string, RecordMaps>()
  const recordsFor = (organizationId: string): RecordMaps => {
    let maps = recordMaps.get(organizationId)
    if (!maps) {
      maps = { products: new Map(), suppliers: new Map(), customers: new Map(), customerStatuses: new Map() }
      recordMaps.set(organizationId, maps)
    }
    return maps
  }
  const { products, suppliers, customers, customerStatuses } = recordsFor(organizations[0]?.id ?? TEST_ORGANIZATION_ID)
  /** The live membership of the signed-in user, as RLS would see it. */
  const activeIn = (organizationId: string) =>
    organizations.find((organization) => organization.id === organizationId && organization.status === 'ACTIVE')
  const requireActive = (organizationId: string) => {
    if (!activeIn(organizationId)) throw new CloudError('NO_MEMBERSHIP', 'no active membership')
  }
  const memberMaps = new Map<string, Map<string, OrganizationMember>>()
  const membersFor = (organizationId: string): Map<string, OrganizationMember> => {
    let members = memberMaps.get(organizationId)
    if (!members) {
      const self = organizations.find((organization) => organization.id === organizationId)
      members = new Map()
      if (self) {
        members.set(TEST_USER_ID, {
          userId: TEST_USER_ID, displayName: 'Test Owner', email: 'owner@example.test', role: self.role,
          status: self.status, version: 1, createdAt: now(), updatedAt: now(),
        })
      }
      memberMaps.set(organizationId, members)
    }
    return members
  }
  const adminCalls: string[] = []
  const requireAdministrator = (organizationId: string): MembershipRole => {
    const membership = activeIn(organizationId)
    if (!membership || membership.role === 'MEMBER') throw new CloudError('FORBIDDEN', 'not an administrator')
    return membership.role
  }
  let signedIn = options.signedIn ?? true
  let profileVersion = 1
  /** Set by an adopted invitation: the invited person has not chosen a password yet. */
  let mustChangePassword = false
  const adoptedInvitations: string[] = []
  const authListeners = new Set<(change: AuthChange) => void>()
  const notify = (change: AuthChange) => { for (const listener of authListeners) listener(change) }
  const imports = new Map<string, { checksum: string; counts: { products: number; suppliers: number; customers: number } }>()

  const base = (id: string, organizationId: string = organizations[0]?.id ?? TEST_ORGANIZATION_ID) => ({
    id,
    organizationId,
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

  const admin: AdministrationGateway = {
    async listMembers(organizationId) {
      failure(); adminCalls.push(`listMembers:${organizationId}`)
      requireAdministrator(organizationId)
      return [...membersFor(organizationId).values()].sort((left, right) => left.userId.localeCompare(right.userId))
    },
    async setMemberRole(organizationId, userId, expectedVersion, role) {
      adminCalls.push(`setMemberRole:${organizationId}:${userId}:${role}`)
      const actor = requireAdministrator(organizationId)
      if (userId === TEST_USER_ID) throw new CloudError('FORBIDDEN', 'own membership')
      const member = membersFor(organizationId).get(userId)
      if (!member) throw new CloudError('RECORD_NOT_FOUND', 'no such member')
      if (actor !== 'OWNER' && (member.role === 'OWNER' || role === 'OWNER')) throw new CloudError('FORBIDDEN', 'owner only')
      if (member.version !== expectedVersion) throw new CloudError('STALE_WRITE', 'stale membership')
      const next = member.role === role ? member : { ...member, role, version: member.version + 1, updatedAt: now() }
      membersFor(organizationId).set(userId, next)
      return next
    },
    async setMemberStatus(organizationId, userId, expectedVersion, status) {
      adminCalls.push(`setMemberStatus:${organizationId}:${userId}:${status}`)
      const actor = requireAdministrator(organizationId)
      if (userId === TEST_USER_ID) throw new CloudError('FORBIDDEN', 'own membership')
      const member = membersFor(organizationId).get(userId)
      if (!member) throw new CloudError('RECORD_NOT_FOUND', 'no such member')
      if (actor !== 'OWNER' && member.role === 'OWNER') throw new CloudError('FORBIDDEN', 'owner only')
      if (member.version !== expectedVersion) throw new CloudError('STALE_WRITE', 'stale membership')
      const next = member.status === status ? member : { ...member, status, version: member.version + 1, updatedAt: now() }
      membersFor(organizationId).set(userId, next)
      return next
    },
    async listInFlightProvisioningAttempts(organizationId) {
      adminCalls.push(`listInFlightProvisioningAttempts:${organizationId}`)
      requireAdministrator(organizationId)
      return { attempts: [], total: 0 }
    },
    async clearProvisioningAttempt(organizationId, requestId) {
      adminCalls.push(`clearProvisioningAttempt:${organizationId}:${requestId}`)
      if (requireAdministrator(organizationId) !== 'OWNER') throw new CloudError('FORBIDDEN', 'owner only')
      throw new CloudError('RECORD_NOT_FOUND', 'no such attempt')
    },
    async provisionMember(input) {
      adminCalls.push(`provisionMember:${input.organizationId}:${input.requestId}:${input.email}:${input.role}`)
      const actor = requireAdministrator(input.organizationId)
      if (input.role === 'OWNER' && actor !== 'OWNER') throw new CloudError('FORBIDDEN', 'owner only')
      const members = membersFor(input.organizationId)
      const existing = [...members.values()].find((member) => member.email === input.email.trim().toLowerCase())
      const userId = existing?.userId ?? `cccccccc-cccc-4ccc-8ccc-${String(members.size).padStart(12, '0')}`
      members.set(userId, {
        // Like the server (P12-M1): an existing global profile keeps its name.
        userId, displayName: existing?.displayName ?? input.displayName.trim(), email: input.email.trim().toLowerCase(), role: input.role,
        status: 'ACTIVE', version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? now(), updatedAt: now(),
      })
      return { status: 'SUCCEEDED' }
    },
  }

  const gateway: MemoryCloud = {
    records: { products, suppliers, customers, customerStatuses },
    recordsFor,
    organizations,
    membersFor,
    adminCalls,
    adoptedInvitations,
    admin,
    async currentUserId() {
      failure()
      return signedIn ? TEST_USER_ID : null
    },
    async currentUserEmail() {
      failure()
      return signedIn ? 'owner@example.test' : null
    },
    identity: {
      async listOrganizations() {
        failure()
        return organizations
          .filter((organization) => organization.status === 'ACTIVE')
          .map((organization) => ({ id: organization.id, name: organization.name, writeLocked: false, writeLockReason: null, version: 1, updatedAt: organizationsUpdatedAt }))
      },
      async listOwnMemberships() {
        failure()
        return organizations.map((organization) => ({ organizationId: organization.id, userId: TEST_USER_ID, role: organization.role, status: organization.status }))
      },
      async readOwnProfile() {
        failure()
        return { userId: TEST_USER_ID, displayName: 'Test Owner', mustChangePassword, version: profileVersion }
      },
      async updateOwnProfile(displayName, expectedVersion) {
        if (expectedVersion !== profileVersion) throw new CloudError('STALE_WRITE', 'stale profile')
        profileVersion += 1
        return { userId: TEST_USER_ID, displayName, mustChangePassword: false, version: profileVersion }
      },
      async acknowledgePasswordChange(expectedVersion) {
        if (expectedVersion !== profileVersion) throw new CloudError('STALE_WRITE', 'stale profile')
        profileVersion += 1
        mustChangePassword = false
        return { userId: TEST_USER_ID, displayName: 'Test Owner', mustChangePassword: false, version: profileVersion }
      },
    },
    catalog: {
      async listProducts(organizationId) { failure(); requireActive(organizationId); return [...recordsFor(organizationId).products.values()] },
      async readProduct(organizationId, id) { return requireRecord(recordsFor(organizationId).products, id) },
      async createProduct(organizationId, input: ProductInput) {
        if ([...recordsFor(organizationId).products.values()].some((record) => record.sku.trim().toLocaleLowerCase('en') === input.sku.trim().toLocaleLowerCase('en'))) {
          throw new CloudError('DUPLICATE_KEY', 'duplicate SKU')
        }
        const record: ProductRecord = {
          ...base(input.id, organizationId), sku: input.sku.trim(), name: input.name.trim(), stockUnit: input.stockUnit,
          ...(absent(input.description) ? { description: absent(input.description) } : {}),
          ...(absent(input.defaultPurchaseUnit) ? { defaultPurchaseUnit: absent(input.defaultPurchaseUnit) } : {}),
          ...(input.unitsPerPurchaseUnit ? { unitsPerPurchaseUnit: { value: input.unitsPerPurchaseUnit } } : {}),
          ...(absent(input.manufacturer) ? { manufacturer: absent(input.manufacturer) } : {}),
          ...(absent(input.manufacturerRef) ? { manufacturerRef: absent(input.manufacturerRef) } : {}),
          ...(absent(input.note) ? { note: absent(input.note) } : {}),
        }
        recordsFor(organizationId).products.set(record.id, record)
        return record
      },
      async updateProduct(organizationId, expectedVersion, input) {
        const stored = requireRecord(recordsFor(organizationId).products, input.id)
        updateRecord(stored, expectedVersion)
        if ([...recordsFor(organizationId).products.values()].some((record) => record.id !== input.id && record.sku.trim().toLocaleLowerCase('en') === input.sku.trim().toLocaleLowerCase('en'))) throw new CloudError('DUPLICATE_KEY', 'duplicate SKU')
        const record: ProductRecord = {
          ...base(input.id, organizationId), ...next(stored), active: stored.active, sku: input.sku.trim(), name: input.name.trim(), stockUnit: input.stockUnit,
          ...(absent(input.description) ? { description: absent(input.description) } : {}),
          ...(absent(input.defaultPurchaseUnit) ? { defaultPurchaseUnit: absent(input.defaultPurchaseUnit) } : {}),
          ...(input.unitsPerPurchaseUnit ? { unitsPerPurchaseUnit: { value: input.unitsPerPurchaseUnit } } : {}),
          ...(absent(input.manufacturer) ? { manufacturer: absent(input.manufacturer) } : {}),
          ...(absent(input.manufacturerRef) ? { manufacturerRef: absent(input.manufacturerRef) } : {}),
          ...(absent(input.note) ? { note: absent(input.note) } : {}),
        }
        recordsFor(organizationId).products.set(record.id, record)
        return record
      },
      async setProductActive(organizationId, id, expectedVersion, active) {
        const stored = requireRecord(recordsFor(organizationId).products, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; recordsFor(organizationId).products.set(id, record); return record
      },
      async listSuppliers(organizationId) { failure(); requireActive(organizationId); return [...recordsFor(organizationId).suppliers.values()] },
      async readSupplier(organizationId, id) { return requireRecord(recordsFor(organizationId).suppliers, id) },
      async createSupplier(organizationId, input: SupplierInput) {
        const record: SupplierRecord = { ...base(input.id, organizationId), displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        recordsFor(organizationId).suppliers.set(record.id, record); return record
      },
      async updateSupplier(organizationId, expectedVersion, input) {
        const stored = requireRecord(recordsFor(organizationId).suppliers, input.id); updateRecord(stored, expectedVersion)
        const record: SupplierRecord = { ...base(input.id, organizationId), ...next(stored), active: stored.active, displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        recordsFor(organizationId).suppliers.set(record.id, record); return record
      },
      async setSupplierActive(organizationId, id, expectedVersion, active) {
        const stored = requireRecord(recordsFor(organizationId).suppliers, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; recordsFor(organizationId).suppliers.set(id, record); return record
      },
      async listCustomers(organizationId) { failure(); requireActive(organizationId); return [...recordsFor(organizationId).customers.values()] },
      async readCustomer(organizationId, id) { return requireRecord(recordsFor(organizationId).customers, id) },
      async createCustomer(organizationId, input: CustomerInput) {
        const record: CustomerRecord = { ...base(input.id, organizationId), displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(input.customerStatusId ? { customerStatusId: input.customerStatusId } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        recordsFor(organizationId).customers.set(record.id, record); return record
      },
      async updateCustomer(organizationId, expectedVersion, input) {
        const stored = requireRecord(recordsFor(organizationId).customers, input.id); updateRecord(stored, expectedVersion)
        const record: CustomerRecord = { ...base(input.id, organizationId), ...next(stored), active: stored.active, displayName: input.displayName.trim(), ...(absent(input.externalRef) ? { externalRef: absent(input.externalRef) } : {}), ...(input.customerStatusId ? { customerStatusId: input.customerStatusId } : {}), ...(absent(input.note) ? { note: absent(input.note) } : {}) }
        recordsFor(organizationId).customers.set(record.id, record); return record
      },
      async setCustomerActive(organizationId, id, expectedVersion, active) {
        const stored = requireRecord(recordsFor(organizationId).customers, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; recordsFor(organizationId).customers.set(id, record); return record
      },
      async listCustomerStatuses(organizationId) { failure(); requireActive(organizationId); return [...recordsFor(organizationId).customerStatuses.values()] },
      async readCustomerStatus(organizationId, id) { return requireRecord(recordsFor(organizationId).customerStatuses, id) },
      async createCustomerStatus(organizationId, input: CustomerStatusInput) {
        if ([...recordsFor(organizationId).customerStatuses.values()].some((record) => record.code.toLowerCase() === input.code.trim().toLowerCase())) throw new CloudError('DUPLICATE_KEY', 'duplicate status')
        const record: CustomerStatusRecord = { ...base(input.id, organizationId), code: input.code.trim(), sortOrder: input.sortOrder }
        recordsFor(organizationId).customerStatuses.set(record.id, record); return record
      },
      async updateCustomerStatus(organizationId, expectedVersion, input) {
        const stored = requireRecord(recordsFor(organizationId).customerStatuses, input.id); updateRecord(stored, expectedVersion)
        const record: CustomerStatusRecord = { ...base(input.id, organizationId), ...next(stored), active: stored.active, code: input.code.trim(), sortOrder: input.sortOrder }
        recordsFor(organizationId).customerStatuses.set(record.id, record); return record
      },
      async setCustomerStatusActive(organizationId, id, expectedVersion, active) {
        const stored = requireRecord(recordsFor(organizationId).customerStatuses, id); updateRecord(stored, expectedVersion)
        const record = { ...stored, ...next(stored), active }; recordsFor(organizationId).customerStatuses.set(id, record); return record
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
    async adoptInvitationSession(accessToken) {
      failure()
      adoptedInvitations.push(accessToken)
      if (accessToken === 'expired') throw new CloudError('SESSION_EXPIRED', 'the invitation link is no longer valid')
      signedIn = true
      mustChangePassword = true
      notify({ event: 'SIGNED_IN', userId: TEST_USER_ID })
    },
    onAuthChange(listener) {
      authListeners.add(listener)
      return () => { authListeners.delete(listener) }
    },
  }
  return gateway
}
