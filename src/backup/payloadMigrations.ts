/**
 * Migrating a backup payload that was written at an older `schemaVersion`.
 *
 * ## Why this is not the database migration runner
 *
 * `src/persistence/migrations.ts` moves *the working database* forward inside
 * IndexedDB's `upgradeneeded` transaction. This chain moves *a payload held in
 * memory*, and it runs while the working database is still whole and
 * untouched. That separation is the safety property: a restore from an older
 * backup must never use the live database as a scratchpad, because a migration
 * that fails halfway through would then have damaged the data the user was
 * about to fall back on.
 *
 * So the order is: parse → verify integrity → migrate the payload → validate
 * the migrated payload → only then write. If any step throws, nothing has been
 * written and the working database is exactly as it was.
 *
 * ## The rules, which are the canonical ones
 *
 * 1. Steps are **numbered and ordered**, `v1 → v2`, `v2 → v3`, applied in
 *    sequence. There is no "inspect the payload and adapt" path; inferring a
 *    schema from data is how corrupt data gets silently accepted.
 * 2. A step reads the previous shape explicitly and returns the new one. It
 *    never assumes the old payload already matches the current model.
 * 3. A released step is **frozen**. A later shape change is the next number,
 *    not an edit to a shipped step — a shipped step is the only thing that can
 *    read files already written.
 * 4. A payload declaring a version **newer** than this build supports is
 *    refused, never guessed at. Dropping fields a build does not understand is
 *    silent data loss wearing a success message.
 * 5. Steps are pure: `(data) => data`. No database handle, no clock, no
 *    randomness — a migration that is not reproducible cannot be tested
 *    against a fixture.
 *
 * ## A step that transforms nothing is still a step
 *
 * `v1 → v2` below returns the payload unchanged, and that is the honest
 * implementation rather than a placeholder. `schemaVersion` 2 removed three
 * unusable IndexedDB indexes (`REMOVED_BOOLEAN_INDEXES` in
 * `src/persistence/schema.ts`); indexes are a property of the *database*, and a
 * backup payload has never carried one. Every record shape is identical on both
 * sides of the bump.
 *
 * It is declared anyway, for two reasons that rule 4 makes non-negotiable.
 * Without an entry at 2, `migrateBackupPayload` would find no path from a
 * version-1 file to this build and refuse it with `BACKUP_SCHEMA_UNSUPPORTED`
 * — a file written last week, rejected because a database index was deleted.
 * And declaring it as an explicit, tested no-op is what keeps the claim
 * *checkable*: "v1 payloads need no transformation" is an assertion a test can
 * fail, whereas silently treating 1 and 2 as interchangeable would be an
 * assumption nothing could catch.
 */

import { SCHEMA_VERSION } from '../persistence/schema'
import type { BackupData } from './businessData'
import { BackupError } from './errors'

export interface PayloadMigration {
  /** The `schemaVersion` this step produces. A step from `to - 1` to `to`. */
  readonly to: number
  /** Developer-facing description. Not a user-facing string. */
  readonly description: string
  /** Pure transformation of the whole payload. Throwing fails the restore. */
  readonly migrate: (data: BackupData) => BackupData
}

/**
 * `v1 → v2`: structurally a no-op, and deliberately explicit about it.
 *
 * The database-side step of the same number deletes three indexes
 * (`src/persistence/migrations.ts`). A payload has no indexes, so there is
 * nothing here to transform — the records a version-1 file carries are already
 * exactly the records a version-2 database stores.
 *
 * Returning `data` by identity rather than cloning it is intentional: a clone
 * would suggest a transformation happened and would cost a full copy of the
 * payload to produce a structurally identical value.
 */
const activeIndexRemovalIsPayloadNeutral: PayloadMigration = {
  to: 2,
  description: 'schemaVersion 2 removed database indexes only; record shapes are unchanged',
  migrate: (data) => data,
}

/**
 * `v2 → v3`: also a no-op, for a different and more interesting reason.
 *
 * The database step of the same number (`src/persistence/migrations.ts`)
 * introduces the `products` and `customers` record types and the optional
 * `RequirementItem.productId`. A version-2 **payload** cannot carry a product
 * or a customer — no build that wrote a version-2 file had any way to put one
 * in those stores — so the records that need the new validators do not exist in
 * the files this step reads. And `productId` is optional and absent, which is
 * precisely what an unlinked requirement means: adding it as an explicit
 * `undefined` would violate §3's absent-key rule and break the checksum.
 *
 * So a version-2 file is already a valid version-3 payload, and the honest
 * transformation is identity. Declaring it is what keeps that claim testable
 * and what stops `migrateBackupPayload` refusing last week's backup with
 * `BACKUP_SCHEMA_UNSUPPORTED`.
 */
const catalogRecordTypesArePayloadNeutral: PayloadMigration = {
  to: 3,
  description: 'schemaVersion 3 added record types for stores a v2 payload cannot have filled',
  migrate: (data) => data,
}

export const PAYLOAD_MIGRATIONS: readonly PayloadMigration[] = [
  activeIndexRemovalIsPayloadNeutral,
  catalogRecordTypesArePayloadNeutral,
]

/**
 * Checks a chain is usable before anything runs it: contiguous from 2 upward,
 * no duplicates, nothing beyond the schema version it claims to reach.
 *
 * Mirrors `assertMigrationChain` in the persistence layer deliberately — the
 * two chains move the same shapes and a divergence between them would mean a
 * backup and a database of the same version were no longer the same thing.
 */
export function assertPayloadMigrationChain(
  migrations: readonly PayloadMigration[],
  schemaVersion: number,
): void {
  let expected = 2
  for (const migration of migrations) {
    if (migration.to !== expected) {
      throw new Error(
        `Payload migration chain is not contiguous: expected a step to version ${expected}, found ${migration.to}`,
      )
    }
    expected += 1
  }
  const highest = migrations.at(-1)?.to ?? 1
  if (highest > schemaVersion) {
    throw new Error(
      `Payload migration chain reaches version ${highest}, beyond schemaVersion ${schemaVersion}`,
    )
  }
}

export interface MigratePayloadOptions {
  readonly migrations?: readonly PayloadMigration[]
  readonly targetVersion?: number
}

export interface MigratedPayload {
  readonly data: BackupData
  readonly fromVersion: number
  readonly toVersion: number
  /** The version numbers actually applied, in order. Empty when nothing ran. */
  readonly applied: readonly number[]
}

/**
 * Applies the steps needed to bring `data` from `fromVersion` to the version
 * this build expects.
 *
 * Refusals, in the order they are checked:
 *
 * - **newer than supported** → `BACKUP_SCHEMA_TOO_NEW`. The build cannot know
 *   what it would be dropping.
 * - **older with a gap in the chain** → `BACKUP_SCHEMA_UNSUPPORTED`. A missing
 *   step is not an invitation to improvise one.
 * - **a step throws** → `BACKUP_MIGRATION_FAILED`, with the step named. The
 *   caller has written nothing at this point, and must not start.
 */
export function migrateBackupPayload(
  data: BackupData,
  fromVersion: number,
  options: MigratePayloadOptions = {},
): MigratedPayload {
  const migrations = options.migrations ?? PAYLOAD_MIGRATIONS
  const target = options.targetVersion ?? SCHEMA_VERSION
  assertPayloadMigrationChain(migrations, target)

  if (fromVersion > target) {
    throw new BackupError(
      'BACKUP_SCHEMA_TOO_NEW',
      'The backup was written by a newer version of this application and cannot be read',
      { details: { backupSchemaVersion: fromVersion, supportedSchemaVersion: target } },
    )
  }

  if (fromVersion === target) {
    return { data, fromVersion, toVersion: target, applied: [] }
  }

  const steps = migrations.filter((step) => step.to > fromVersion && step.to <= target)
  const reachable = steps.length === target - fromVersion
  if (!reachable) {
    throw new BackupError(
      'BACKUP_SCHEMA_UNSUPPORTED',
      `No migration path from backup schemaVersion ${fromVersion} to ${target}`,
      { details: { backupSchemaVersion: fromVersion, supportedSchemaVersion: target } },
    )
  }

  let current = data
  const applied: number[] = []
  for (const step of steps) {
    try {
      current = step.migrate(current)
    } catch (cause) {
      throw new BackupError(
        'BACKUP_MIGRATION_FAILED',
        `Backup migration to schemaVersion ${step.to} failed; nothing was written`,
        { details: { targetVersion: step.to, description: step.description }, cause },
      )
    }
    applied.push(step.to)
  }

  return { data: current, fromVersion, toVersion: target, applied }
}
