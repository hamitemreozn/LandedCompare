/**
 * The one stored-shape rule that is not about types: **an absent optional field
 * is stored by the key not existing.**
 *
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §3 states it, and it matters for three
 * separate reasons: `expectNoUnknownKeys` stays honest, a record read back has
 * exactly the keys it was written with, and `canonicalize()` — which has no
 * representation for `undefined` at all — can checksum it.
 *
 * The rule is easy to break by accident because the *read* path reintroduces
 * the key: `optional()` returns `undefined`, so a parsed record carries
 * `note: undefined` as an own property, and handing that straight to `put()`
 * writes it. `records/project.ts` has long guarded its write path with a
 * private copy of this function; extracting it here is what lets the record
 * types introduced in Phase 9 be correct from their first line rather than
 * inheriting the gap. (That the *existing* Phase 7 store helpers still write
 * the parsed record verbatim is a recorded, deferred finding — see
 * `docs/IMPLEMENTATION_PLAN.md`, Phase 8, "One Phase 7 observation". Phase 8's
 * payload normaliser means backup, snapshot and restore are correct regardless,
 * so it is a tidiness defect rather than a data one, and quietly rewriting
 * audited foundations as a side effect of UI work is not how it gets fixed.)
 */

export function withoutUndefined<T extends object>(record: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result as T
}
