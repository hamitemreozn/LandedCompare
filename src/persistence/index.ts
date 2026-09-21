/**
 * The persistence module's public surface.
 *
 * **This is the only module in the application that knows IndexedDB exists.**
 * `src/domain`, `src/calculation` and `src/comparison` are storage-agnostic and
 * stay that way; React components and future `src/operations` code reach
 * storage through the functions below, never through `indexedDB` directly.
 *
 * The dependency direction:
 *
 * ```text
 *   features / operations / domain
 *             ↓
 *         persistence          ← here
 *             ↓
 *          IndexedDB
 * ```
 */

export {
  openDatabase,
  deleteDatabase,
  readStoredSchemaVersion,
  type Database,
  type OpenDatabaseOptions,
} from './database'
export {
  PersistenceError,
  isPersistenceError,
  classifyRequestFailure,
  toPersistenceError,
  type PersistenceErrorCode,
  type PersistenceErrorDetails,
} from './errors'
export type { TransactionScope, TransactionMode } from './idb'
export {
  APP_VERSION,
  BUSINESS_STORE_NAMES,
  DATABASE_NAME,
  SCHEMA_VERSION,
  STORE_NAMES,
  type StoreName,
} from './schema'
export {
  MIGRATIONS,
  assertMigrationChain,
  selectMigrations,
  type Migration,
  type MigrationContext,
} from './migrations'
export { assertNotStale, type StaleWriteCheck } from './staleWrite'

export type { MetaRecord } from './records/meta'
export type { SupplierRecord } from './records/supplier'
export type { ProjectRecord, QuoteRecord, QuoteItemRecord, RequirementItemRecord } from './records/project'
export type { SettingRecord, SettingValue } from './records/settings'
export type { CounterRecord } from './records/counter'
export {
  MOVEMENT_TYPES,
  MOVEMENT_DIRECTIONS,
  ADJUSTMENT_REASONS,
  SOURCE_KINDS,
  type InventoryMovementRecord,
  type MovementType,
  type MovementDirection,
  type AdjustmentReason,
  type SourceKind,
} from './records/inventoryMovement'
export { toSupplierRecord, toRuntimeSupplier } from './records/supplier'

export { readMeta } from './stores/metaStore'
export { readSetting, readAllSettings, writeSetting, deleteSetting } from './stores/settingsStore'
export { readCounter, reserveNextCounterValue } from './stores/counterStore'
export {
  saveSupplier,
  loadSupplier,
  loadSupplierRecord,
  listSupplierRecords,
  putSupplierRecord,
  readSupplierRecord,
} from './stores/supplierStore'
export {
  saveProject,
  loadProject,
  listProjectSummaries,
  deleteProject,
  readProjectRecord,
  type ProjectSummary,
} from './stores/projectStore'
export {
  appendInventoryMovements,
  postInventoryMovements,
  listMovementsForProduct,
  countInventoryMovements,
} from './stores/inventoryMovementStore'

export {
  createAutosaveController,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RETRY_DELAYS_MS,
  type AutosaveController,
  type AutosaveOptions,
  type AutosaveStatus,
  type AutosaveScheduler,
  type SaveState,
} from './autosave'
export {
  estimateStorage,
  isStoragePersisted,
  requestPersistentStorage,
  type PersistenceGrant,
  type StorageUsage,
} from './storage'
export { createTabAdvisory, type TabAdvisory, type TabAdvisoryMessage } from './tabAdvisory'
