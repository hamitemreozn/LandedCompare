/**
 * Producing a portable organisation backup from the cloud (Phase 12).
 *
 * ## Complete, or nothing
 *
 * Every catalogue section is read through the gateway's audited list reads
 * (`readAll`, Audit A A-H1 and R-1/R-2): keyset pages reconciled against one
 * exact count, so PostgREST's `max_rows` can shorten a page but never the
 * result, and a membership withdrawn mid-read fails the read instead of
 * shortening it. The members manifest is one JSON value
 * (`api.list_organization_members`), which `max_rows` cannot truncate.
 *
 * Any failure — a transport error, a lost membership, a MEMBER's refusal on
 * the manifest, a changed session — propagates. No artifact exists until
 * every section has been read, the envelope built, and the serialised text
 * read BACK through the strict parser. A caller therefore holds either a
 * complete, verified file or an error; never a plausible partial one.
 *
 * ## Consistency across sections
 *
 * Sections are separate reads, so the file is not an atomic snapshot of the
 * whole organisation (the same honest scope `readAll` states for one list).
 * Two properties still hold, and the parser checks the second:
 *
 * - each section's id set is exactly what the caller could see at the moment
 *   of that section's reconciliation count;
 * - customers are read BEFORE customer statuses. Statuses are never deleted,
 *   so every status a customer referenced when it was read still exists when
 *   the statuses are read: the file is referentially closed.
 *
 * Finally the organisation and the session are checked again after the last
 * read, so a membership lost or an identity changed during the export fails
 * it rather than labelling one user's file with another's authority.
 */

import type {
  CustomerRecord,
  CustomerStatusRecord,
  DataGateway,
  OrganizationMember,
  ProductRecord,
  SupplierRecord,
} from '../../cloud'
import { CloudError } from '../../cloud'
import type { DigestProvider } from '../checksum'
import { backupFilename } from '../envelope'
import {
  buildCloudBackupEnvelope,
  parseCloudBackup,
  serialiseCloudBackup,
  type BackupCustomer,
  type BackupCustomerStatus,
  type BackupMember,
  type BackupProduct,
  type BackupSupplier,
  type CloudBackupCounts,
  type CloudBackupEnvelope,
} from './format'

export interface CloudBackupArtifact {
  readonly envelope: CloudBackupEnvelope
  /** The exact file contents: canonical JSON, UTF-8. */
  readonly json: string
  readonly filename: string
  readonly byteLength: number
  readonly entityCounts: CloudBackupCounts
}

export interface ExportOrganizationOptions {
  readonly now?: () => string
  readonly digestProvider?: DigestProvider
  readonly appVersion?: string
}

function audited(record: ProductRecord | SupplierRecord | CustomerRecord | CustomerStatusRecord) {
  return {
    id: record.id,
    organizationId: record.organizationId,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.createdBy === undefined ? {} : { createdBy: record.createdBy }),
    ...(record.updatedBy === undefined ? {} : { updatedBy: record.updatedBy }),
    version: record.version,
  }
}

/** Copies only the known fields, so nothing the gateway might grow later leaks into a file by accident. */
function toProduct(record: ProductRecord): BackupProduct {
  return {
    ...audited(record),
    sku: record.sku,
    name: record.name,
    ...(record.description === undefined ? {} : { description: record.description }),
    stockUnit: record.stockUnit,
    ...(record.defaultPurchaseUnit === undefined ? {} : { defaultPurchaseUnit: record.defaultPurchaseUnit }),
    ...(record.unitsPerPurchaseUnit === undefined ? {} : { unitsPerPurchaseUnit: { value: record.unitsPerPurchaseUnit.value } }),
    ...(record.manufacturer === undefined ? {} : { manufacturer: record.manufacturer }),
    ...(record.manufacturerRef === undefined ? {} : { manufacturerRef: record.manufacturerRef }),
    ...(record.note === undefined ? {} : { note: record.note }),
  }
}

function toSupplier(record: SupplierRecord): BackupSupplier {
  return {
    ...audited(record),
    displayName: record.displayName,
    ...(record.externalRef === undefined ? {} : { externalRef: record.externalRef }),
    ...(record.note === undefined ? {} : { note: record.note }),
  }
}

function toCustomer(record: CustomerRecord): BackupCustomer {
  return {
    ...audited(record),
    displayName: record.displayName,
    ...(record.externalRef === undefined ? {} : { externalRef: record.externalRef }),
    ...(record.customerStatusId === undefined ? {} : { customerStatusId: record.customerStatusId }),
    ...(record.note === undefined ? {} : { note: record.note }),
  }
}

function toCustomerStatus(record: CustomerStatusRecord): BackupCustomerStatus {
  return { ...audited(record), code: record.code, sortOrder: record.sortOrder }
}

function toMember(member: OrganizationMember): BackupMember {
  return {
    userId: member.userId,
    displayName: member.displayName,
    email: member.email,
    role: member.role,
    status: member.status,
    version: member.version,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  }
}

async function requireOrganization(gateway: DataGateway, organizationId: string) {
  const organization = (await gateway.identity.listOrganizations()).find((candidate) => candidate.id === organizationId)
  if (!organization) {
    throw new CloudError('NO_MEMBERSHIP', 'the organisation is not visible to the caller')
  }
  return organization
}

/**
 * Reads the whole organisation and returns a verified backup file, or
 * throws. OWNER/ADMIN only: the members manifest is read through an RPC that
 * refuses anyone else, so a MEMBER's export fails on the server, not in the
 * screen.
 */
export async function exportOrganizationBackup(
  gateway: DataGateway,
  organizationId: string,
  options: ExportOrganizationOptions = {},
): Promise<CloudBackupArtifact> {
  const exportedBy = await gateway.currentUserId()
  if (exportedBy === null) {
    throw new CloudError('SESSION_EXPIRED', 'nobody is signed in')
  }
  const organization = await requireOrganization(gateway, organizationId)

  // Sequential on purpose: customers strictly before customer statuses (see
  // "Consistency across sections"), and one failure stops everything.
  const products = await gateway.catalog.listProducts(organizationId)
  const suppliers = await gateway.catalog.listSuppliers(organizationId)
  const customers = await gateway.catalog.listCustomers(organizationId)
  const customerStatuses = await gateway.catalog.listCustomerStatuses(organizationId)
  const members = await gateway.admin.listMembers(organizationId)

  // Still the same person, still a member of this organisation.
  await requireOrganization(gateway, organizationId)
  if ((await gateway.currentUserId()) !== exportedBy) {
    throw new CloudError('SESSION_EXPIRED', 'the signed-in user changed during the export')
  }

  const createdAt = (options.now ?? (() => new Date().toISOString()))()
  const envelope = await buildCloudBackupEnvelope({
    data: {
      organization: { id: organization.id, name: organization.name, version: organization.version, updatedAt: organization.updatedAt },
      products: products.map(toProduct),
      suppliers: suppliers.map(toSupplier),
      customers: customers.map(toCustomer),
      customerStatuses: customerStatuses.map(toCustomerStatus),
      members: members.map(toMember),
    },
    createdAt,
    exportedBy,
    appVersion: options.appVersion,
    digestProvider: options.digestProvider,
  })
  const json = serialiseCloudBackup(envelope)

  // The file is handed over only if it reads back as a complete, valid
  // organisation backup — the same parser a later restore will use.
  await parseCloudBackup(json, { digestProvider: options.digestProvider })

  return {
    envelope,
    json,
    filename: backupFilename(createdAt, `LandedCompare_OrganizationBackup_${organization.id.slice(0, 8)}`),
    byteLength: new TextEncoder().encode(json).byteLength,
    entityCounts: envelope.entityCounts,
  }
}
