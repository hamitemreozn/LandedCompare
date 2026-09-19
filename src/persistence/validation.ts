/**
 * Runtime validation at the persistence boundary.
 *
 * Data coming out of IndexedDB is **untrusted**, even though this application
 * wrote it. It may have been written by an older build, half-migrated, edited
 * by hand through devtools, or corrupted. `record as ProjectRecord` is a
 * compile-time assertion about runtime data and proves nothing, so every read
 * goes through the checks below and a record that fails is rejected with
 * `RECORD_INVALID` rather than flowing into the domain.
 *
 * These are small explicit validators rather than a schema framework. The
 * repository has no validation library, the record shapes are few and stable,
 * and the domain factories (`createProject`, `Money.fromJSON`, …) already carry
 * the semantic rules — what is needed here is the structural layer beneath
 * them, not a second copy of them.
 */

import { PersistenceError } from './errors'

/**
 * Keys that must never be copied out of stored data.
 *
 * Structured clone does not itself resurrect a prototype, but a record can
 * carry an own property literally named `__proto__`, and a later
 * `Object.assign`/spread of that record onto a live object is the realistic
 * prototype-pollution path. Rejecting the key at the boundary closes it once
 * instead of relying on every consumer to be careful.
 */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function invalidRecord(path: string, reason: string): PersistenceError {
  return new PersistenceError('RECORD_INVALID', `Stored record is invalid at "${path}": ${reason}`, {
    details: { path, reason },
  })
}

/** A plain object, with no inherited or pollution-carrying keys. */
export function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRecord(path, 'expected an object')
  }
  for (const key of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw invalidRecord(path, `forbidden key "${key}"`)
    }
  }
  return value as Record<string, unknown>
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw invalidRecord(path, 'expected a string')
  }
  return value
}

export function expectNonEmptyString(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (text.trim() === '') {
    throw invalidRecord(path, 'expected a non-empty string')
  }
  return text
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidRecord(path, 'expected a boolean')
  }
  return value
}

/**
 * A finite integer. Used for `schemaVersion` and counter values only — never
 * for anything monetary, which stays a decimal string end to end.
 */
export function expectInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalidRecord(path, 'expected a safe integer')
  }
  return value
}

/** UUID as produced by `crypto.randomUUID()`. Identity, never array position. */
export function expectUuid(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!UUID_PATTERN.test(text)) {
    throw invalidRecord(path, 'expected a UUID')
  }
  return text
}

/**
 * An instant: ISO 8601 UTC with milliseconds and a `Z`, exactly as
 * `new Date().toISOString()` produces. Compared as a string everywhere, so the
 * fixed width matters — the pattern is what makes `updatedAt` ordering and the
 * stale-write check meaningful.
 */
export function expectInstant(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw invalidRecord(path, 'expected an ISO-8601 UTC instant (…T…Z, milliseconds)')
  }
  return text
}

/**
 * A business date: `YYYY-MM-DD`, no time and no zone. Kept distinct from an
 * instant on purpose — an ETA is a day, and storing it as a timestamp makes it
 * shift across midnight depending on who is reading it (Data Model §2).
 */
export function expectBusinessDate(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!BUSINESS_DATE_PATTERN.test(text)) {
    throw invalidRecord(path, 'expected a YYYY-MM-DD business date')
  }
  return text
}

/**
 * A canonical decimal string, the persisted form of every monetary and
 * quantity value.
 *
 * Exponential notation is rejected rather than parsed: `Money`/`Quantity`
 * serialise through `.toFixed()`, so `1e3` cannot have been written by this
 * application, and accepting it would mean the round trip is no longer
 * character-exact.
 */
export function expectDecimalString(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!DECIMAL_STRING_PATTERN.test(text)) {
    throw invalidRecord(path, 'expected a canonical decimal string (no exponent notation)')
  }
  return text
}

export function expectCurrencyCode(value: unknown, path: string): string {
  const text = expectString(value, path)
  if (!/^[A-Z]{3}$/.test(text)) {
    throw invalidRecord(path, 'expected a three-letter uppercase currency code')
  }
  return text
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidRecord(path, 'expected an array')
  }
  return value
}

/**
 * An enum-like string, checked against the closed set this build knows.
 *
 * An unknown value is rejected, never passed through. A stored status this
 * build does not understand means the record was written by a newer build or
 * was corrupted, and quietly treating it as "some other status" is how a
 * document ends up in a state no rule covers.
 */
export function expectEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const text = expectString(value, path)
  if (!(allowed as readonly string[]).includes(text)) {
    throw invalidRecord(path, `expected one of: ${allowed.join(', ')}`)
  }
  return text as T
}

/**
 * Reads an optional field. `undefined` and a missing key mean "absent"; `null`
 * does not, because nothing in this layer writes `null` and accepting it would
 * make "absent" two different values.
 */
export function optional<T>(
  value: unknown,
  path: string,
  read: (value: unknown, path: string) => T,
): T | undefined {
  if (value === undefined) {
    return undefined
  }
  return read(value, path)
}

/**
 * Rejects keys the current schema does not define.
 *
 * An unexpected key is a symptom — a newer build's field, or a hand-edit — and
 * dropping it silently is how data disappears through a successful-looking
 * read. Surfacing it is cheap; the alternative is not.
 */
export function expectNoUnknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      throw invalidRecord(`${path}.${key}`, 'unknown field')
    }
  }
}
