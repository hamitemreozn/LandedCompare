/**
 * Snapshot retention.
 *
 * Browser storage is finite and a snapshot is a full copy of the database, so
 * "keep everything" is not a policy — it is how the origin runs out of quota
 * and the next real save fails. The rules are the canonical ones
 * (`docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §6):
 *
 * | Kind | Keep |
 * | --- | --- |
 * | `DAILY` | the newest 7, plus the newest of each of the last 4 weeks |
 * | `PRE_MIGRATION` | the newest 3, and never pruned within 30 days |
 * | `PRE_IMPORT` | the newest 3 |
 * | `PRE_RESTORE` | the newest 3, and **the newest is never pruned** |
 * | `MANUAL` | the newest 5 |
 *
 * Plus a global ceiling: total snapshot bytes stay under 40% of the estimated
 * quota. When it is exceeded, the oldest prunable snapshot goes first — and
 * the two exemptions above hold even then.
 *
 * ## Why planning is a pure function
 *
 * `planRetention()` takes summaries and returns which ids to keep and which to
 * prune. No database, no clock, no storage API. That makes the policy
 * exhaustively testable against hand-built fixtures, which matters because the
 * failure mode is not loud: a policy that quietly prunes the wrong snapshot is
 * only discovered by the person who needed it.
 *
 * ## Two protections that are not negotiable
 *
 * **The newest `PRE_RESTORE` snapshot is never pruned**, by any rule, including
 * the quota ceiling. It is the escape hatch from the single most destructive
 * operation in the application, and a ceiling that could delete it would make
 * the restore guarantee conditional on free disk space.
 *
 * **A `PRE_MIGRATION` snapshot younger than 30 days is never pruned.** A
 * migration that is *technically* successful and *logically* wrong is
 * discovered weeks later, by someone noticing a number is off — which is
 * exactly the window this exemption covers.
 *
 * ## No timers
 *
 * Nothing here schedules anything. Retention runs when the application asks it
 * to, which in practice is on open and after a snapshot is taken. A browser
 * has no guaranteed background scheduler and pretending otherwise would mean
 * the policy silently stops applying whenever the tab is closed.
 */

import type { SnapshotKind, SnapshotSummary } from './snapshots'

export interface RetentionPolicy {
  readonly dailyKeep: number
  readonly weeklyPromotionWeeks: number
  readonly preMigrationKeep: number
  readonly preMigrationProtectDays: number
  readonly preImportKeep: number
  readonly preRestoreKeep: number
  readonly manualKeep: number
  /** Share of the estimated quota that all snapshots together may occupy. */
  readonly quotaFraction: number
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  dailyKeep: 7,
  weeklyPromotionWeeks: 4,
  preMigrationKeep: 3,
  preMigrationProtectDays: 30,
  preImportKeep: 3,
  preRestoreKeep: 3,
  manualKeep: 5,
  quotaFraction: 0.4,
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A Monday-based week index derived from the UTC epoch day.
 *
 * Epoch day 0 (1970-01-01) was a Thursday, so `+3` shifts the boundary to
 * Monday. Integer arithmetic on an instant, never a locale-dependent calendar
 * call — the weekly promotion must group the same way on every machine.
 */
function weekIndex(instant: string): number {
  const epochDay = Math.floor(Date.parse(instant) / DAY_MS)
  return Math.floor((epochDay + 3) / 7)
}

/**
 * Newest first, ties broken by id.
 *
 * The tie-break is what makes "the newest 7" deterministic when two snapshots
 * share a millisecond — otherwise the same inputs could prune different
 * records on different runs, and the policy would not be testable.
 */
function newestFirst(a: SnapshotSummary, b: SnapshotSummary): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1
  }
  return a.id < b.id ? 1 : -1
}

function ofKind(summaries: readonly SnapshotSummary[], kind: SnapshotKind): SnapshotSummary[] {
  return summaries.filter((summary) => summary.kind === kind).sort(newestFirst)
}

export interface RetentionPlanOptions {
  readonly now: string
  /** From `navigator.storage.estimate()`. Absent when the browser will not say. */
  readonly quotaBytes?: number
  readonly policy?: RetentionPolicy
}

export interface RetentionPlan {
  readonly keepIds: readonly string[]
  readonly pruneIds: readonly string[]
  /** Ids no rule may remove, whatever the pressure. */
  readonly protectedIds: readonly string[]
  readonly totalBytesBefore: number
  readonly totalBytesAfter: number
  readonly ceilingBytes?: number
  readonly quotaKnown: boolean
  /**
   * True when the ceiling is still exceeded after pruning everything prunable.
   *
   * The canonical rule is that snapshotting then degrades **loudly** — the
   * user is told snapshots are paused and asked to export a backup — rather
   * than silently stopping. This flag is that signal, in machine-readable
   * form for a later UI.
   */
  readonly overCeiling: boolean
}

/**
 * Decides which snapshots survive.
 *
 * Runs in two passes, and the order matters: the per-kind policy decides what
 * is *wanted*, then the quota ceiling removes from what remains, oldest first,
 * skipping the protected set. A ceiling applied first would have deleted
 * records the policy considered essential before the policy ever saw them.
 */
export function planRetention(
  summaries: readonly SnapshotSummary[],
  options: RetentionPlanOptions,
): RetentionPlan {
  const policy = options.policy ?? DEFAULT_RETENTION_POLICY
  const nowMs = Date.parse(options.now)

  const keep = new Set<string>()
  const protectedIds = new Set<string>()

  const daily = ofKind(summaries, 'DAILY')
  for (const summary of daily.slice(0, policy.dailyKeep)) {
    keep.add(summary.id)
  }
  // Weekly promotion: the newest daily of each of the last N weeks survives
  // even once it has fallen out of the newest-7 window, so a month of history
  // stays reachable at one snapshot per week instead of one per day.
  const currentWeek = weekIndex(options.now)
  const newestPerWeek = new Map<number, SnapshotSummary>()
  for (const summary of daily) {
    const week = weekIndex(summary.createdAt)
    if (week <= currentWeek && week > currentWeek - policy.weeklyPromotionWeeks) {
      if (!newestPerWeek.has(week)) {
        newestPerWeek.set(week, summary)
      }
    }
  }
  for (const summary of newestPerWeek.values()) {
    keep.add(summary.id)
  }

  const preMigration = ofKind(summaries, 'PRE_MIGRATION')
  for (const summary of preMigration.slice(0, policy.preMigrationKeep)) {
    keep.add(summary.id)
  }
  for (const summary of preMigration) {
    const ageMs = nowMs - Date.parse(summary.createdAt)
    if (ageMs < policy.preMigrationProtectDays * DAY_MS) {
      keep.add(summary.id)
      protectedIds.add(summary.id)
    }
  }

  for (const summary of ofKind(summaries, 'PRE_IMPORT').slice(0, policy.preImportKeep)) {
    keep.add(summary.id)
  }

  const preRestore = ofKind(summaries, 'PRE_RESTORE')
  for (const summary of preRestore.slice(0, policy.preRestoreKeep)) {
    keep.add(summary.id)
  }
  const newestPreRestore = preRestore[0]
  if (newestPreRestore !== undefined) {
    keep.add(newestPreRestore.id)
    protectedIds.add(newestPreRestore.id)
  }

  for (const summary of ofKind(summaries, 'MANUAL').slice(0, policy.manualKeep)) {
    keep.add(summary.id)
  }

  const prune = summaries.filter((summary) => !keep.has(summary.id)).map((summary) => summary.id)
  const prunedSet = new Set(prune)

  const totalBytesBefore = summaries.reduce((sum, summary) => sum + summary.sizeBytes, 0)
  let retained = summaries.filter((summary) => !prunedSet.has(summary.id))
  let totalBytesAfter = retained.reduce((sum, summary) => sum + summary.sizeBytes, 0)

  const quotaKnown = typeof options.quotaBytes === 'number' && options.quotaBytes > 0
  const ceilingBytes = quotaKnown
    ? Math.floor((options.quotaBytes as number) * policy.quotaFraction)
    : undefined

  if (ceilingBytes !== undefined) {
    // Oldest first, so the ceiling costs the least recoverable history.
    const candidates = [...retained].sort(newestFirst).reverse()
    for (const candidate of candidates) {
      if (totalBytesAfter <= ceilingBytes) {
        break
      }
      if (protectedIds.has(candidate.id)) {
        continue
      }
      prunedSet.add(candidate.id)
      totalBytesAfter -= candidate.sizeBytes
    }
    retained = summaries.filter((summary) => !prunedSet.has(summary.id))
  }

  return {
    keepIds: retained.map((summary) => summary.id),
    pruneIds: summaries
      .filter((summary) => prunedSet.has(summary.id))
      .sort(newestFirst)
      .map((summary) => summary.id),
    protectedIds: [...protectedIds],
    totalBytesBefore,
    totalBytesAfter,
    ceilingBytes,
    quotaKnown,
    overCeiling: ceilingBytes !== undefined && totalBytesAfter > ceilingBytes,
  }
}
