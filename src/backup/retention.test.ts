/**
 * The retention policy, as a pure function.
 *
 * Retention fails quietly by nature: nobody notices a snapshot that was pruned
 * when it should not have been until the day they reach for it. So the policy
 * is exercised directly against hand-built summaries — every rule, every
 * exemption, and the interaction between the per-kind rules and the quota
 * ceiling.
 */

import { describe, expect, it } from 'vitest'
import { emptyBackupData, countEntities } from './businessData'
import { DEFAULT_RETENTION_POLICY, planRetention } from './retention'
import type { SnapshotKind, SnapshotSummary } from './snapshots'

const COUNTS = countEntities(emptyBackupData())

function snapshot(
  id: string,
  kind: SnapshotKind,
  createdAt: string,
  sizeBytes = 1_000,
): SnapshotSummary {
  return {
    id,
    kind,
    createdAt,
    schemaVersion: 1,
    appVersion: '0.8.0',
    entityCounts: COUNTS,
    sizeBytes,
    totalRecords: 0,
  }
}

/** `2026-09-19T08:00:00.000Z` from `19`. */
function day(dayOfMonth: number, hour = 8): string {
  return `2026-09-${String(dayOfMonth).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`
}

function dailyRun(days: readonly number[]): SnapshotSummary[] {
  return days.map((d) => snapshot(`daily-${d}`, 'DAILY', day(d)))
}

describe('planRetention — per-kind allowances', () => {
  it('keeps the newest 7 daily snapshots', () => {
    // Ten consecutive days. Days 14–20 are one ISO week and 21–23 the next, so
    // the weekly promotion re-elects only snapshots the newest-7 rule already
    // kept — leaving the allowance visible on its own.
    const summaries = dailyRun([14, 15, 16, 17, 18, 19, 20, 21, 22, 23])
    const plan = planRetention(summaries, { now: day(23, 12) })

    expect(plan.keepIds).toHaveLength(7)
    expect([...plan.keepIds].sort()).toEqual(
      ['daily-17', 'daily-18', 'daily-19', 'daily-20', 'daily-21', 'daily-22', 'daily-23'].sort(),
    )
    expect([...plan.pruneIds].sort()).toEqual(['daily-14', 'daily-15', 'daily-16'].sort())
  })

  it('promotes the newest daily of each of the last four weeks and drops the rest', () => {
    // One snapshot a week for eight weeks, so the newest-7 rule and the
    // four-week window disagree — which is the only way to see the window.
    const weekly = [
      ['w1', '2026-07-27'],
      ['w2', '2026-08-03'],
      ['w3', '2026-08-10'],
      ['w4', '2026-08-17'],
      ['w5', '2026-08-24'],
      ['w6', '2026-08-31'],
      ['w7', '2026-09-07'],
      ['w8', '2026-09-14'],
    ] as const
    const summaries = weekly.map(([id, date]) =>
      snapshot(id, 'DAILY', `${date}T08:00:00.000Z`),
    )
    const plan = planRetention(summaries, { now: '2026-09-16T12:00:00.000Z' })

    // Newest 7 = w2…w8. w1 is both outside that and outside the four-week
    // promotion window (which reaches back to the week of 2026-08-24).
    expect(plan.pruneIds).toEqual(['w1'])
    expect(plan.keepIds).toHaveLength(7)
  })

  it('keeps a weekly-promoted daily that has fallen out of the newest seven', () => {
    // Eight dailies in the two most recent weeks plus one from three weeks
    // back. The old one is ninth by recency, so only the weekly promotion
    // saves it — and it is the sole daily of its week.
    const recent = dailyRun([15, 16, 17, 18, 19, 20, 21, 22])
    const older = snapshot('old-week', 'DAILY', '2026-09-02T08:00:00.000Z')
    const plan = planRetention([...recent, older], { now: day(22, 12) })

    expect(plan.keepIds).toContain('old-week')
    expect(plan.pruneIds).toEqual(['daily-15'])
  })

  it('keeps the newest 3 pre-import snapshots', () => {
    const summaries = [1, 2, 3, 4, 5].map((n) =>
      snapshot(`import-${n}`, 'PRE_IMPORT', day(n)),
    )
    const plan = planRetention(summaries, { now: day(9) })
    expect([...plan.keepIds].sort()).toEqual(['import-3', 'import-4', 'import-5'])
  })

  it('keeps the newest 5 manual snapshots', () => {
    const summaries = [1, 2, 3, 4, 5, 6, 7].map((n) => snapshot(`manual-${n}`, 'MANUAL', day(n)))
    const plan = planRetention(summaries, { now: day(9) })
    expect(plan.keepIds).toHaveLength(5)
    expect(plan.pruneIds).toEqual(['manual-2', 'manual-1'])
  })

  it('keeps the newest 3 pre-migration snapshots and every one under 30 days old', () => {
    const summaries = [
      snapshot('m-old-1', 'PRE_MIGRATION', '2026-01-01T08:00:00.000Z'),
      snapshot('m-old-2', 'PRE_MIGRATION', '2026-02-01T08:00:00.000Z'),
      snapshot('m-1', 'PRE_MIGRATION', '2026-09-01T08:00:00.000Z'),
      snapshot('m-2', 'PRE_MIGRATION', '2026-09-05T08:00:00.000Z'),
      snapshot('m-3', 'PRE_MIGRATION', '2026-09-10T08:00:00.000Z'),
      snapshot('m-4', 'PRE_MIGRATION', '2026-09-15T08:00:00.000Z'),
    ]
    const plan = planRetention(summaries, { now: '2026-09-19T12:00:00.000Z' })

    // Newest 3: m-2, m-3, m-4. Under 30 days: m-1 as well.
    expect([...plan.keepIds].sort()).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
    expect([...plan.protectedIds].sort()).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
    expect([...plan.pruneIds].sort()).toEqual(['m-old-1', 'm-old-2'])
  })

  it('stops protecting a pre-migration snapshot once it passes 30 days', () => {
    const summaries = [
      snapshot('m-1', 'PRE_MIGRATION', '2026-07-01T08:00:00.000Z'),
      snapshot('m-2', 'PRE_MIGRATION', '2026-09-01T08:00:00.000Z'),
      snapshot('m-3', 'PRE_MIGRATION', '2026-09-05T08:00:00.000Z'),
      snapshot('m-4', 'PRE_MIGRATION', '2026-09-10T08:00:00.000Z'),
    ]
    const plan = planRetention(summaries, { now: '2026-09-19T12:00:00.000Z' })
    expect(plan.protectedIds).not.toContain('m-1')
    expect(plan.pruneIds).toEqual(['m-1'])
  })
})

describe('planRetention — the pre-restore guarantee', () => {
  it('keeps the newest 3 pre-restore snapshots and protects the newest', () => {
    const summaries = [1, 2, 3, 4, 5].map((n) => snapshot(`restore-${n}`, 'PRE_RESTORE', day(n)))
    const plan = planRetention(summaries, { now: day(9) })
    expect([...plan.keepIds].sort()).toEqual(['restore-3', 'restore-4', 'restore-5'])
    expect(plan.protectedIds).toEqual(['restore-5'])
  })

  it('never prunes the newest pre-restore snapshot, whatever the quota pressure', () => {
    const summaries = [
      snapshot('restore-newest', 'PRE_RESTORE', day(1), 5_000_000),
      ...dailyRun([2, 3, 4, 5]).map((entry) => ({ ...entry, sizeBytes: 5_000_000 })),
    ]
    // A ceiling far below even one snapshot.
    const plan = planRetention(summaries, { now: day(9), quotaBytes: 1_000 })

    expect(plan.keepIds).toEqual(['restore-newest'])
    expect(plan.protectedIds).toContain('restore-newest')
    expect(plan.overCeiling).toBe(true)
  })

  it('reports being over the ceiling rather than silently giving up', () => {
    const summaries = [snapshot('restore-newest', 'PRE_RESTORE', day(1), 10_000_000)]
    const plan = planRetention(summaries, { now: day(9), quotaBytes: 1_000 })
    expect(plan.overCeiling).toBe(true)
    expect(plan.pruneIds).toHaveLength(0)
  })
})

describe('planRetention — the quota ceiling', () => {
  it('uses 40% of the estimated quota', () => {
    const plan = planRetention([], { now: day(9), quotaBytes: 1_000_000 })
    expect(plan.ceilingBytes).toBe(400_000)
    expect(plan.quotaKnown).toBe(true)
  })

  it('removes the oldest prunable snapshot first', () => {
    // Five manual snapshots, all within the allowance, but together over the
    // ceiling. Only the ceiling decides here, and it must start at the back.
    const summaries = [1, 2, 3, 4, 5].map((n) => snapshot(`manual-${n}`, 'MANUAL', day(n), 100))
    const plan = planRetention(summaries, { now: day(9), quotaBytes: 750 })

    expect(plan.ceilingBytes).toBe(300)
    expect(plan.keepIds).toEqual(['manual-3', 'manual-4', 'manual-5'])
    expect(plan.pruneIds).toEqual(['manual-2', 'manual-1'])
    expect(plan.totalBytesAfter).toBe(300)
    expect(plan.overCeiling).toBe(false)
  })

  it('does not apply a ceiling when the browser will not estimate quota', () => {
    const summaries = [1, 2, 3].map((n) => snapshot(`manual-${n}`, 'MANUAL', day(n), 10_000_000))
    const plan = planRetention(summaries, { now: day(9) })

    expect(plan.quotaKnown).toBe(false)
    expect(plan.ceilingBytes).toBeUndefined()
    expect(plan.overCeiling).toBe(false)
    expect(plan.pruneIds).toHaveLength(0)
  })

  it('treats a zero or negative quota estimate as unknown rather than as zero headroom', () => {
    const summaries = [snapshot('manual-1', 'MANUAL', day(1), 100)]
    expect(planRetention(summaries, { now: day(9), quotaBytes: 0 }).quotaKnown).toBe(false)
    expect(planRetention(summaries, { now: day(9), quotaBytes: -1 }).pruneIds).toHaveLength(0)
  })
})

describe('planRetention — determinism', () => {
  it('produces the same plan for the same inputs in a different order', () => {
    const summaries = [
      ...dailyRun([10, 11, 12, 13, 14, 15, 16, 17, 18]),
      snapshot('manual-a', 'MANUAL', day(11)),
      snapshot('restore-a', 'PRE_RESTORE', day(12)),
      snapshot('import-a', 'PRE_IMPORT', day(13)),
    ]
    const forwards = planRetention(summaries, { now: day(19) })
    const backwards = planRetention([...summaries].reverse(), { now: day(19) })

    expect([...backwards.keepIds].sort()).toEqual([...forwards.keepIds].sort())
    expect([...backwards.pruneIds].sort()).toEqual([...forwards.pruneIds].sort())
  })

  it('breaks ties on identical timestamps by id, so the plan cannot drift', () => {
    const sameInstant = ['f', 'a', 'c', 'e', 'b', 'd'].map((id) =>
      snapshot(id, 'MANUAL', day(5)),
    )
    const first = planRetention(sameInstant, { now: day(9) })
    const second = planRetention([...sameInstant].reverse(), { now: day(9) })

    expect(first.keepIds.length).toBe(DEFAULT_RETENTION_POLICY.manualKeep)
    expect([...second.keepIds].sort()).toEqual([...first.keepIds].sort())
    expect([...second.pruneIds].sort()).toEqual([...first.pruneIds].sort())
  })

  it('keeps every kind bounded, so snapshots cannot grow without limit', () => {
    const summaries: SnapshotSummary[] = []
    for (let n = 1; n <= 40; n += 1) {
      const at = new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString()
      summaries.push(snapshot(`d-${n}`, 'DAILY', at))
      summaries.push(snapshot(`m-${n}`, 'MANUAL', at))
      summaries.push(snapshot(`i-${n}`, 'PRE_IMPORT', at))
      summaries.push(snapshot(`r-${n}`, 'PRE_RESTORE', at))
    }
    const plan = planRetention(summaries, { now: '2026-06-01T00:00:00.000Z' })

    const kept = new Set(plan.keepIds)
    expect(kept.size).toBeLessThanOrEqual(7 + 4 + 5 + 3 + 3)
    expect(plan.pruneIds.length).toBe(summaries.length - kept.size)
  })

  it('reports byte totals before and after', () => {
    const summaries = [1, 2, 3, 4, 5, 6, 7].map((n) => snapshot(`manual-${n}`, 'MANUAL', day(n), 100))
    const plan = planRetention(summaries, { now: day(9) })
    expect(plan.totalBytesBefore).toBe(700)
    expect(plan.totalBytesAfter).toBe(500)
  })
})
