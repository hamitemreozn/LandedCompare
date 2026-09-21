/**
 * Snapshot housekeeping: the daily snapshot, and applying retention.
 *
 * ## There is no background scheduler, and this module does not pretend there
 * ## is one
 *
 * A browser tab gets no guaranteed timer. `setInterval` stops when the tab is
 * closed, throttles when it is backgrounded, and is gone entirely when the
 * machine sleeps. An "automatic nightly snapshot" implemented that way would
 * silently not happen on exactly the days the computer was turned off, which
 * are the days a user is least likely to notice.
 *
 * So "daily" means what it can honestly mean in a browser:
 *
 * > when the application is opened, if no `DAILY` snapshot exists for the
 * > current day, take one.
 *
 * That is `ensureDailySnapshot()`. It is idempotent within a day — the second,
 * third and hundredth call do nothing — and it is driven by the application's
 * lifecycle, not by a clock this code does not control.
 *
 * The day boundary is **UTC**, taken from the ISO instant, so the same inputs
 * decide the same way on every machine and in every test. The visible
 * consequence in Istanbul (UTC+3) is that a snapshot taken at 02:00 local
 * belongs to the previous UTC day; the practical cost is that a snapshot can
 * be up to a few hours older than a local-midnight rule would give, which is
 * not a difference any recovery scenario turns on.
 */

import type { Database } from '../persistence/database'
import { estimateStorage } from '../persistence/storage'
import { createSnapshot, listSnapshots, type SnapshotSummary } from './snapshots'
import { DEFAULT_RETENTION_POLICY, planRetention, type RetentionPolicy } from './retention'

/** The UTC calendar day of an ISO instant. String slicing, never `Date` formatting. */
export function utcDay(instant: string): string {
  return instant.slice(0, 10)
}

export interface DailySnapshotResult {
  readonly created: boolean
  readonly snapshotId?: string
  /** `CREATED` | `ALREADY_EXISTS_TODAY`. Machine-readable, for a later UI. */
  readonly reason: 'CREATED' | 'ALREADY_EXISTS_TODAY'
  readonly day: string
}

export interface EnsureDailySnapshotOptions {
  readonly now?: () => string
  readonly generateId?: () => string
  /** Supplied by `runSnapshotMaintenance` so the list is read once, not twice. */
  readonly snapshots?: readonly SnapshotSummary[]
}

export async function ensureDailySnapshot(
  database: Database,
  options: EnsureDailySnapshotOptions = {},
): Promise<DailySnapshotResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const instant = now()
  const day = utcDay(instant)

  const existing = options.snapshots ?? (await listSnapshots(database))
  const alreadyToday = existing.some(
    (summary) => summary.kind === 'DAILY' && utcDay(summary.createdAt) === day,
  )
  if (alreadyToday) {
    return { created: false, reason: 'ALREADY_EXISTS_TODAY', day }
  }

  const summary = await createSnapshot(database, {
    kind: 'DAILY',
    now: () => instant,
    generateId: options.generateId,
  })
  return { created: true, snapshotId: summary.id, reason: 'CREATED', day }
}

export interface ApplyRetentionOptions {
  readonly now?: () => string
  readonly policy?: RetentionPolicy
  /** Injected so the quota-unavailable path is testable without a browser. */
  readonly quotaBytes?: number
  readonly snapshots?: readonly SnapshotSummary[]
}

export interface RetentionResult {
  readonly prunedIds: readonly string[]
  readonly retainedIds: readonly string[]
  readonly protectedIds: readonly string[]
  readonly totalBytesBefore: number
  readonly totalBytesAfter: number
  readonly ceilingBytes?: number
  readonly quotaKnown: boolean
  /** Snapshots still exceed the ceiling; the UI must say so rather than hide it. */
  readonly overCeiling: boolean
}

/**
 * Reads the snapshot list, plans, and deletes what the plan prunes.
 *
 * Quota estimation is a *hint*. If `navigator.storage.estimate()` is missing
 * or throws, the ceiling is simply not applied and `quotaKnown` is false — the
 * per-kind policy still runs, snapshots are still bounded, and the application
 * does not fail because a browser declined to answer a question about free
 * space.
 */
export async function applyRetention(
  database: Database,
  options: ApplyRetentionOptions = {},
): Promise<RetentionResult> {
  const now = (options.now ?? (() => new Date().toISOString()))()
  const summaries = options.snapshots ?? (await listSnapshots(database))

  let quotaBytes = options.quotaBytes
  if (quotaBytes === undefined) {
    const usage = await estimateStorage()
    quotaBytes = usage.supported ? usage.quotaBytes : undefined
  }

  const plan = planRetention(summaries, {
    now,
    quotaBytes,
    policy: options.policy ?? DEFAULT_RETENTION_POLICY,
  })

  if (plan.pruneIds.length > 0) {
    await database.write(['snapshots'], async (scope) => {
      for (const id of plan.pruneIds) {
        await scope.delete('snapshots', id)
      }
    })
  }

  return {
    prunedIds: plan.pruneIds,
    retainedIds: plan.keepIds,
    protectedIds: plan.protectedIds,
    totalBytesBefore: plan.totalBytesBefore,
    totalBytesAfter: plan.totalBytesAfter,
    ceilingBytes: plan.ceilingBytes,
    quotaKnown: plan.quotaKnown,
    overCeiling: plan.overCeiling,
  }
}

export interface SnapshotMaintenanceResult {
  readonly daily: DailySnapshotResult
  readonly retention: RetentionResult
}

/**
 * What the application calls on open: take today's snapshot if it is missing,
 * then enforce retention.
 *
 * In that order, so a new daily snapshot participates in the same retention
 * pass that removes the one it replaces — otherwise the store would briefly
 * hold `dailyKeep + 1` snapshots and the ceiling would be evaluated against a
 * number that is about to be wrong.
 */
export async function runSnapshotMaintenance(
  database: Database,
  options: EnsureDailySnapshotOptions & ApplyRetentionOptions = {},
): Promise<SnapshotMaintenanceResult> {
  const daily = await ensureDailySnapshot(database, options)
  const retention = await applyRetention(database, { ...options, snapshots: undefined })
  return { daily, retention }
}
