/**
 * The cloud boundary — foundation from Phase 10, activated in Phase 11.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §24.
 *
 * ## Status: connected and authoritative
 *
 * `App.tsx`, the runtime and every catalogue feature service use this boundary.
 * PostgreSQL is the only catalogue source after the one-time legacy cutover;
 * there is no offline queue, stale local read path or dual-master mode.
 */

export {
  CloudConfigError,
  FORBIDDEN_KEY_MARKERS,
  FORBIDDEN_KEY_PREFIXES,
  containsForbiddenKeyMaterial,
  readCloudConfig,
  type CloudConfig,
  type CloudConfigProblem,
  type CloudEnvironment,
} from './config'

export {
  CLOUD_SESSION_STORAGE_KEY,
  createCloudClient,
  createCloudClientFromEnvironment,
  type CloudClient,
  type CloudClientOptions,
} from './client'

export {
  CATALOG_LIMITS,
  canonicalDecimal,
  codePointLength,
  hasVisibleText,
  isCanonicalPositiveDecimal,
  sameExactDecimal,
  serverOptional,
  serverTrim,
} from './catalogRules'

export {
  CloudError,
  cloudErrorFromPostgrest,
  cloudErrorFromTransport,
  isCloudError,
  type CloudErrorCode,
  type CloudErrorDetails,
  type PostgrestContext,
  type PostgrestFailure,
} from './errors'

export {
  createDataGateway,
  type AdministrationGateway,
  type AuthChange,
  type CatalogGateway,
  type DataGatewayOptions,
  type CatalogImportInput,
  type CatalogImportResult,
  type CloudRecord,
  type CustomerInput,
  type CustomerRecord,
  type CustomerStatusInput,
  type CustomerStatusRecord,
  type DataGateway,
  type IdentityGateway,
  type Membership,
  type MembershipRole,
  type MembershipStatus,
  type Organization,
  type OrganizationMember,
  type ProductInput,
  type ProductRecord,
  type Profile,
  type ProvisionMemberInput,
  type ProvisionMemberResult,
  type ProvisioningAttempt,
  type ProvisioningAttemptList,
  type ProvisioningAttemptStatus,
  type SupplierInput,
  type SupplierRecord,
} from './gateway'

export {
  bootstrapCloudSession,
  type CloudBootOptions,
  type CloudBootPhase,
  type CloudBootReady,
  type CloudBootResult,
  type CloudBootSelection,
  type CloudBootStopped,
  type OrganizationChoice,
} from './boot'

export {
  CATALOG_CUTOVER_MARKER_KEY,
  CATALOG_IMPORT_ATTEMPT_KEY,
  LegacyMigrationError,
  findImportProblem,
  inspectLegacyCatalog,
  isLegacyMigrationError,
  migrateLegacyCatalog,
  retireEmptyLegacyDatabase,
  retireLegacyCatalogWithBackup,
  type LegacyCatalogCounts,
  type LegacyCatalogInspection,
  type LegacyMigrationDetails,
  type LegacyMigrationOptions,
  type LegacyMigrationReason,
  type LegacyMigrationResult,
  type LegacyStore,
} from './legacyMigration'

export { guardRuntimeGateway, type IdentityLoss } from './guardedGateway'
