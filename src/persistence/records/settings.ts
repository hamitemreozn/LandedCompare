/**
 * The `settings` store: user preferences, one record per key.
 *
 * Values are restricted to strings, finite numbers and booleans. A preference
 * that wants a richer shape gets its own typed record and its own validator;
 * an open `unknown` value here would mean every reader re-validates, which is
 * how one of them eventually does not.
 *
 * The Phase 6 locale preference is **not** migrated here. It lives in
 * `localStorage` under `landedcompare.locale` and is read before this database
 * is open — moving it would make the first paint wait on IndexedDB to know
 * which language to render. Phase 9+ decides whether the preference is worth
 * mirroring; until then this store stays empty and `src/i18n` is untouched.
 */

import {
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  invalidRecord,
} from '../validation'

export type SettingValue = string | number | boolean

export interface SettingRecord {
  readonly key: string
  readonly value: SettingValue
}

export function parseSettingRecord(value: unknown, path = 'setting'): SettingRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, ['key', 'value'], path)
  const stored = record.value
  if (
    typeof stored !== 'string' &&
    typeof stored !== 'boolean' &&
    !(typeof stored === 'number' && Number.isFinite(stored))
  ) {
    throw invalidRecord(`${path}.value`, 'expected a string, finite number or boolean')
  }
  return { key: expectNonEmptyString(record.key, `${path}.key`), value: stored }
}
