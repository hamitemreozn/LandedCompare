/**
 * The canonical unit vocabulary.
 *
 * ## The problem this solves
 *
 * `Product.stockUnit` is a free string, and the unit dropdown offers
 * translated labels. If what is stored is the *label*, then a Turkish user and
 * an English user picking the same unit from the same list create two
 * different persisted values — `"Adet"` and `"Piece"` — for one semantic fact.
 * On a single-user local pilot that is untidy. The moment the data is shared
 * (a server, two accounts, one company) it is a defect: nothing can group,
 * compare or validate a quantity across the two, and `movement.unit ===
 * product.stockUnit` (Data Model I11) becomes a question about which language
 * someone had selected.
 *
 * So a **predefined** unit is stored as a locale-independent code —
 * `PIECE`, `BOX`, `CARTON` — and the label is resolved at render time.
 * Changing the interface language changes what is shown and never what is
 * stored.
 *
 * ## Why there is still only one field
 *
 * The obvious shape is `unitCode` plus `unitLabel`, and it is the wrong one:
 * two fields that mean the same thing, which every writer has to keep in step,
 * and which disagree the first time one is forgotten. This schema has already
 * refused that trade once — `REMOVED_BOOLEAN_INDEXES` in
 * `src/persistence/schema.ts` is the same argument about `active`.
 *
 * `stockUnit` therefore stays a single `string` holding **either** a canonical
 * code **or** a unit the company typed itself. The two are told apart by
 * membership in `CANONICAL_UNITS`, which is a total function over the value —
 * no flag, no second column, no ambiguity. A company that counts in "Rulo"
 * stores exactly `"Rulo"`, it is displayed exactly as `"Rulo"` in every
 * language, and nothing ever translates or rewrites it.
 *
 * ## No migration, deliberately
 *
 * There is no pilot data. The only stored units are development records
 * holding label-shaped strings like `"Adet"` or `"adet"`, and under the rule
 * above those are simply **custom units**: they remain valid, they display
 * verbatim, and nothing touches them. That is a graceful degradation rather
 * than a data problem, so `schemaVersion` does not move — the record shape is
 * unchanged, and a fabricated migration step over a handful of developer rows
 * would be ceremony, not safety.
 */

export const CANONICAL_UNITS = [
  'PIECE',
  'BOX',
  'PACKAGE',
  'CARTON',
  'SET',
  'METER',
  'KILOGRAM',
  'LITER',
] as const

export type CanonicalUnit = (typeof CANONICAL_UNITS)[number]

/** The one place a canonical unit becomes a translation key. */
export const UNIT_TRANSLATION_KEY: Record<CanonicalUnit, string> = {
  PIECE: 'units.piece',
  BOX: 'units.box',
  PACKAGE: 'units.package',
  CARTON: 'units.carton',
  SET: 'units.set',
  METER: 'units.meter',
  KILOGRAM: 'units.kilogram',
  LITER: 'units.liter',
}

export function isCanonicalUnit(value: string): value is CanonicalUnit {
  return (CANONICAL_UNITS as readonly string[]).includes(value)
}

/**
 * How a stored unit is shown: translated if it is one of ours, verbatim if it
 * is the company's own.
 *
 * The fallback is the point. A custom unit has no translation and must never
 * acquire one by accident, so an unrecognised value is returned unchanged
 * rather than passed through `t()` — which would render a missing-key string
 * over perfectly good data.
 */
export function unitLabel(value: string, translate: (key: string) => string): string {
  return isCanonicalUnit(value) ? translate(UNIT_TRANSLATION_KEY[value]) : value
}
