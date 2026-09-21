/**
 * Defensive bounds on untrusted backup input.
 *
 * A restore parser reads a file the application did not write and cannot
 * trust. Without limits, a hostile or simply broken file can exhaust memory or
 * the call stack before a single validation rule has run — which is why every
 * one of these is checked *before* the work it bounds, not after.
 *
 * The numbers are chosen for the single-machine pilot described in
 * `docs/PRODUCT_SCOPE.md` and are deliberately generous: a pilot year of
 * purchase orders, shipments, receipts and stock movements is a few tens of
 * thousands of records and single-digit megabytes. A limit small enough to
 * reject real data would just teach the user to work around it.
 */

/**
 * Hard cap on a backup file, from `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §9.
 *
 * Applied to a `Blob`/`File` size *before* it is read into memory, and to the
 * UTF-8 byte length of a string before it is parsed.
 */
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024

/**
 * Maximum JSON nesting depth, counted on the raw text before `JSON.parse`
 * runs.
 *
 * The deepest legitimate path in this schema is about ten levels
 * (envelope → data → projects → record → quotes → quote → items → item →
 * money → string), so 32 leaves room for several future nested aggregates
 * while still bounding a `[[[[…]]]]` bomb that would otherwise be parsed in
 * full before anything could object.
 */
export const MAX_JSON_DEPTH = 32

/** Maximum records in any single store of a backup payload. */
export const MAX_RECORDS_PER_STORE = 200_000

/** Maximum records across the whole payload. */
export const MAX_TOTAL_RECORDS = 1_000_000

/**
 * UTF-8 byte length without allocating an encoded copy.
 *
 * `new TextEncoder().encode(text).byteLength` would double peak memory for a
 * hundred-megabyte file, which is exactly the case the size limit exists to
 * survive.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A well-formed surrogate pair is one four-byte code point.
        bytes += 4
        index += 1
        continue
      }
      bytes += 3
    } else {
      bytes += 3
    }
  }
  return bytes
}
