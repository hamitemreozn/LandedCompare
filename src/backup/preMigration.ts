/**
 * The `PRE_MIGRATION` snapshot, and why it cannot live inside `openDatabase`.
 *
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §4, rule 3 requires a snapshot before
 * any migration runs. IndexedDB makes the obvious implementation of that rule
 * impossible in two independent ways, and both are worth stating because both
 * look like they should work:
 *
 * 1. **`upgradeneeded` is the wrong place.** It runs *inside* the version-change
 *    transaction that rewrites the data. A snapshot written there is part of
 *    that transaction, so a migration that fails rolls the snapshot back with
 *    it — the snapshot disappears exactly in the case it exists for.
 * 2. **`openDatabase` is the wrong caller.** `src/persistence` sits *below*
 *    `src/backup` in the dependency graph (Architecture: persistence is the
 *    only module that knows IndexedDB exists, and everything else depends on
 *    it, not the reverse). Having the opener take a snapshot would invert
 *    that.
 *
 * So the correct sequence belongs to whoever starts the application, and it is
 * this:
 *
 * ```text
 *   read the stored version
 *   → if it is older than this build's, open AT THE OLD VERSION,
 *     snapshot, close
 *   → then open normally, which runs the migration
 * ```
 *
 * Opening at the old version is what makes the snapshot real: no
 * `upgradeneeded` fires, no migration runs, nothing is stamped, and the
 * snapshot commits in its own transaction before the upgrade is ever
 * attempted.
 *
 * ## What this function does not decide
 *
 * It reports, it does not enforce. If the version cannot be determined — some
 * browsers do not implement `indexedDB.databases()` — the honest answer is
 * `VERSION_UNKNOWN`, not a guess, and what to do about it is a product
 * decision with a user in it ("export a backup before upgrading"). The startup
 * sequence that acts on this result, and the screen that explains it, belong
 * to Phase 9.
 */

import { openDatabase, readStoredSchemaVersion } from '../persistence/database'
import { DATABASE_NAME, SCHEMA_VERSION } from '../persistence/schema'
import { createSnapshot, type SnapshotSummary } from './snapshots'

export type PreMigrationOutcome =
  /** The stored database is already at this build's version. Nothing to protect. */
  | 'NOT_NEEDED'
  /** No database exists yet, so there is no data a migration could damage. */
  | 'NO_DATABASE'
  /** The browser will not report the stored version. The caller must decide. */
  | 'VERSION_UNKNOWN'
  /** A snapshot was taken and committed. Safe to proceed with the upgrade. */
  | 'CREATED'

export interface PreMigrationSnapshotResult {
  readonly outcome: PreMigrationOutcome
  readonly storedVersion?: number
  readonly targetVersion: number
  readonly snapshot?: SnapshotSummary
}

export interface EnsurePreMigrationSnapshotOptions {
  readonly name?: string
  readonly targetSchemaVersion?: number
  readonly indexedDBFactory?: IDBFactory
  readonly now?: () => string
  readonly generateId?: () => string
}

/**
 * Takes a `PRE_MIGRATION` snapshot if — and only if — the stored database is
 * older than this build.
 *
 * Call it **before** `openDatabase()`, and treat anything other than
 * `CREATED`, `NOT_NEEDED` or `NO_DATABASE` as a reason to stop and ask the
 * user, because the alternative is a migration with no way back.
 */
export async function ensurePreMigrationSnapshot(
  options: EnsurePreMigrationSnapshotOptions = {},
): Promise<PreMigrationSnapshotResult> {
  const name = options.name ?? DATABASE_NAME
  const targetVersion = options.targetSchemaVersion ?? SCHEMA_VERSION

  const storedVersion = await readStoredSchemaVersion(name, {
    indexedDBFactory: options.indexedDBFactory,
  })

  if (storedVersion === undefined) {
    // `databases()` reports nothing both for "no such database" and for "not
    // supported". Distinguishing them needs a probe that would itself create
    // the database, so the ambiguity is surfaced rather than resolved by a
    // side effect.
    const enumerable =
      typeof (
        (options.indexedDBFactory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB) as {
          databases?: unknown
        }
      )?.databases === 'function'
    return {
      outcome: enumerable ? 'NO_DATABASE' : 'VERSION_UNKNOWN',
      targetVersion,
    }
  }

  if (storedVersion >= targetVersion) {
    return { outcome: 'NOT_NEEDED', storedVersion, targetVersion }
  }

  // Opened at the version it is already at: no upgrade, no migration, no
  // stamping. An empty chain because a chain reaching past `storedVersion`
  // would be rejected as inconsistent with the version being opened.
  const database = await openDatabase({
    name,
    schemaVersion: storedVersion,
    migrations: [],
    indexedDBFactory: options.indexedDBFactory,
  })
  try {
    const snapshot = await createSnapshot(database, {
      kind: 'PRE_MIGRATION',
      now: options.now,
      generateId: options.generateId,
    })
    return { outcome: 'CREATED', storedVersion, targetVersion, snapshot }
  } finally {
    // Closed whatever happened — an open connection at the old version would
    // block the upgrade this snapshot exists to permit.
    database.close()
  }
}
