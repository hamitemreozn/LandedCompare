/**
 * Filtering, searching and sorting a master-data list — the three things all
 * of Products, Suppliers and Customers need and none of them should each
 * reinvent.
 *
 * ## Why this is not in the persistence layer
 *
 * Because it is not persisted state. A search term is what the user typed a
 * moment ago and a sort order is how they want to look at the list right now;
 * neither belongs in the database, and neither is allowed to affect what is
 * stored. `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §2, "No stored balances"
 * applies the same reasoning to stock figures, and `schema.ts` applies it to
 * `active`: at pilot volume the correct answer is to read the records and
 * reason over them, not to maintain a second structure that can disagree with
 * them.
 *
 * ## Turkish, which is where naive string handling goes wrong
 *
 * Two independent problems, and they need two different tools.
 *
 * **Case folding.** Turkish has a dotless `ı` and a dotted `İ`, so the correct
 * lower case of `I` is `ı` in Turkish and `i` everywhere else. A search for
 * "istanbul" must find a supplier stored as "İSTANBUL", which plain
 * `toLowerCase()` does not manage — it produces `i̇stanbul`, with a combining
 * dot, and the comparison fails. `toLocaleLowerCase(locale)` gets it right, so
 * that is what search uses.
 *
 * **Ordering.** `'Ç' < 'D'` is false under code-unit comparison — `Ç` is
 * U+00C7 and sorts after `Z` — so `Array.prototype.sort()` puts every Turkish
 * letter at the end of the alphabet. `Intl.Collator` knows the locale's
 * alphabet, so that is what sorting uses.
 *
 * The deliberate exception is `normaliseSku` in the persistence layer, which
 * folds case **without** a locale. A SKU is an identifier: whether two of them
 * collide must not depend on which language the user happens to have selected.
 */

import type { SupportedLocale } from '../../i18n'

export type ActiveFilter = 'ALL' | 'ACTIVE' | 'INACTIVE'

export const ACTIVE_FILTERS: readonly ActiveFilter[] = ['ALL', 'ACTIVE', 'INACTIVE']

/**
 * The active/inactive split, decided in the application layer over records
 * that have already been read.
 *
 * This is the surface the removed boolean indexes were meant to serve. They
 * could not: IndexedDB has no boolean key type, so a record carrying
 * `active: true` was silently absent from the index and a catalogue screen
 * built on it would have shown an empty list over a full store. Filtering here
 * is both correct and, at a few hundred records, free.
 */
export function matchesActiveFilter(active: boolean, filter: ActiveFilter): boolean {
  switch (filter) {
    case 'ACTIVE':
      return active
    case 'INACTIVE':
      return !active
    case 'ALL':
      return true
  }
}

/** Collators are expensive to build and cheap to reuse. One per locale. */
const collators = new Map<string, Intl.Collator>()

function collator(locale: SupportedLocale): Intl.Collator {
  let existing = collators.get(locale)
  if (existing === undefined) {
    existing = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
    collators.set(locale, existing)
  }
  return existing
}

/**
 * Locale-aware text ordering, with a code-point tie-break.
 *
 * `sensitivity: 'base'` makes the collator treat "ACME" and "Acme" as equal,
 * which is what a person reading an alphabetical list expects — and which
 * would otherwise leave the order of two such rows down to whatever order
 * IndexedDB happened to return them in. Sorting must be **deterministic**, so
 * an exact comparison breaks the tie rather than leaving it to the sort's
 * stability over an input order nobody controls.
 */
export function compareText(a: string, b: string, locale: SupportedLocale): number {
  const primary = collator(locale).compare(a, b)
  if (primary !== 0) {
    return primary
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/** Most recent first, with the identical-instant case broken deterministically. */
export function compareUpdatedAtDescending(
  a: { updatedAt: string; id: string },
  b: { updatedAt: string; id: string },
): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? 1 : -1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function normaliseSearchTerm(term: string, locale: SupportedLocale): string {
  return term.trim().toLocaleLowerCase(locale)
}

/**
 * True when any of `fields` contains `term`, case-insensitively for the
 * given locale. An empty term matches everything, which is what makes the
 * search box optional rather than a gate.
 *
 * Substring matching, not fuzzy matching and not tokenised full text. A
 * catalogue of a few hundred rows needs a predictable answer far more than it
 * needs a clever one: the user types part of a name and sees the rows that
 * contain it, every time.
 */
export function matchesSearch(
  fields: readonly (string | undefined)[],
  term: string,
  locale: SupportedLocale,
): boolean {
  const needle = normaliseSearchTerm(term, locale)
  if (needle === '') {
    return true
  }
  return fields.some(
    (field) => field !== undefined && field.toLocaleLowerCase(locale).includes(needle),
  )
}

export interface ActiveCounts {
  readonly total: number
  readonly active: number
  readonly inactive: number
}

export function countActive(records: readonly { active: boolean }[]): ActiveCounts {
  const active = records.filter((record) => record.active).length
  return { total: records.length, active, inactive: records.length - active }
}

/**
 * Trims a form field and reports an absent optional as `undefined` rather than
 * as an empty string.
 *
 * The record validators reject an empty optional string outright, and they are
 * right to: `note: ''` is not a note, it is a key that should not be there.
 * This is the one place the difference between "the user cleared the field"
 * and "the field has a value" is decided.
 */
export function optionalText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
