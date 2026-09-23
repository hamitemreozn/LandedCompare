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
} from './client'

export {
  CloudError,
  cloudErrorFromPostgrest,
  cloudErrorFromTransport,
  isCloudError,
  type CloudErrorCode,
  type CloudErrorDetails,
  type PostgrestFailure,
} from './errors'

export {
  createDataGateway,
  type CatalogGateway,
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
  type ProductInput,
  type ProductRecord,
  type Profile,
  type SupplierInput,
  type SupplierRecord,
} from './gateway'

export {
  bootstrapCloudSession,
  type CloudBootPhase,
  type CloudBootReady,
  type CloudBootResult,
  type CloudBootStopped,
} from './boot'

export {
  CATALOG_CUTOVER_MARKER_KEY,
  CATALOG_IMPORT_ATTEMPT_KEY,
  inspectLegacyCatalog,
  migrateLegacyCatalog,
  retireEmptyLegacyDatabase,
  type LegacyCatalogCounts,
  type LegacyCatalogInspection,
  type LegacyMigrationOptions,
} from './legacyMigration'
