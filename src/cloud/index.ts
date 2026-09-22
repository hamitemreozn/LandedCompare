/**
 * The cloud boundary — Phase 10's application-side deliverable.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §24.
 *
 * ## Status: built, proved, and deliberately not connected
 *
 * Nothing in this folder is imported by `src/App.tsx`, `src/app/runtime.ts` or
 * any feature service. That is the Phase 10/11 boundary, and it is a design
 * decision rather than unfinished work:
 *
 * - Products, suppliers and customers still read and write IndexedDB, exactly
 *   as they did in Phase 9. The application is unchanged and unbroken.
 * - Phase 11 moves the catalog to PostgreSQL and re-points the feature services
 *   at this gateway **in one move**, then drops the local database.
 *
 * A half-migration would put some entities in the cloud and some on the device,
 * which is two sources of truth — the single thing the whole cloud architecture
 * exists to prevent. Worse, it would be two sources of truth arranged so that
 * the boot gate refuses to start when the server is unreachable while the
 * product catalogue is sitting on the local disk the whole time.
 *
 * So what Phase 10 ships here is the *seam*, with its conversions, its error
 * vocabulary and its boot states written and tested against a real PostgreSQL
 * instance — which is what makes Phase 11 a re-pointing rather than a design.
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
  type DataGateway,
  type IdentityGateway,
  type Membership,
  type MembershipRole,
  type MembershipStatus,
  type Organization,
  type Profile,
} from './gateway'

export {
  bootstrapCloudSession,
  type CloudBootPhase,
  type CloudBootReady,
  type CloudBootResult,
  type CloudBootStopped,
} from './boot'
