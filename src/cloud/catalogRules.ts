/**
 * The server's catalogue rules, stated once on the client.
 *
 * PostgreSQL is authoritative: the table constraints and `api.import_catalog`
 * decide. This module mirrors those rules closely enough that the client can
 * name the offending record BEFORE a request is sent (Audit A, A-M1) — and so
 * that the one-time legacy migration can decide whether a cloud row is the
 * same record as a local one using the server's own normalisation.
 *
 * Mirrors, in order of authority:
 * - `supabase/migrations/20260923120000_catalog_cloud_migration.sql` —
 *   column length checks, `btrim`/`nullif` normalisation, `catalog_decimal`;
 * - `supabase/migrations/20260924120000_audit_a_remediation.sql` — typed
 *   import validation and the "visibly non-empty identifier" rule.
 */

/** Character limits, counted as PostgreSQL `length()` counts: code points. */
export const CATALOG_LIMITS = {
  products: {
    sku: 100,
    name: 300,
    description: 4000,
    stockUnit: 100,
    defaultPurchaseUnit: 100,
    manufacturer: 300,
    manufacturerRef: 300,
    note: 4000,
  },
  parties: {
    displayName: 300,
    externalRef: 300,
    note: 4000,
  },
  /** `api.import_catalog` refuses a section longer than this. */
  recordsPerSection: 10_000,
} as const

/**
 * True when the text has at least one character a person can see.
 *
 * The server rule refuses a required identifier made only of whitespace,
 * control characters or zero-width/format characters — a tab or a no-break
 * space alone used to satisfy `btrim(x) <> ''`, because `btrim` removes ASCII
 * spaces only (Audit A, A-L4). `\s`, `\p{Z}`, `\p{Cc}` and `\p{Cf}` cover the
 * same ground as the SQL character class in the remediation migration.
 */
export function hasVisibleText(value: string): boolean {
  return /[^\s\p{Z}\p{Cc}\p{Cf}]/u.test(value)
}

/** `length()` in PostgreSQL counts characters, which in UTF-8 are code points. */
export function codePointLength(value: string): number {
  return [...value].length
}

/** PostgreSQL `btrim(text)`: removes leading and trailing ASCII spaces only. */
export function serverTrim(value: string): string {
  return value.replace(/^ +| +$/g, '')
}

/** The server's `nullif(btrim(x), '')` for an optional column. */
export function serverOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = serverTrim(value)
  return trimmed === '' ? undefined : trimmed
}

/** `app_private.catalog_decimal`: a canonical, strictly positive decimal. */
export function isCanonicalPositiveDecimal(value: string): boolean {
  return /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) && /[1-9]/.test(value)
}

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * The one textual form of an exact decimal: no leading zeros in the integer
 * part, no trailing zeros in the fraction, no bare point, no negative zero.
 * `undefined` when the text is not a plain decimal at all.
 *
 * Pure string work — the value never becomes a JavaScript `number`, so no
 * digit of a large or long decimal can be lost. PostgreSQL `numeric` keeps
 * the scale it was given (`'1.20'::numeric::text` is `'1.20'`), while the
 * domain's `Quantity` writes `'1.2'`; both denote the same economic value.
 */
export function canonicalDecimal(value: string): string | undefined {
  const match = DECIMAL_TEXT.exec(value)
  if (!match) return undefined
  const integer = match[2].replace(/^0+(?=\d)/, '')
  const fraction = (match[3] ?? '').replace(/0+$/, '')
  const sign = integer === '0' && fraction === '' ? '' : match[1]
  return fraction === '' ? `${sign}${integer}` : `${sign}${integer}.${fraction}`
}

/**
 * Exact numeric equality of two optional decimal strings: `1.2` equals `1.20`
 * and `1.200`. Absent equals absent only; a present value never equals an
 * absent one; text that is not a decimal equals nothing, so it can never make
 * two different records look the same.
 */
export function sameExactDecimal(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  const canonical = canonicalDecimal(left)
  return canonical !== undefined && canonical === canonicalDecimal(right)
}
