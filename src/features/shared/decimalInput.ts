/**
 * Locale-aware decimal **input**, over a canonical dot-separated storage form.
 *
 * A Turkish user types `12,5`. An English user types `12.5`. Both mean the
 * same quantity, and what is stored is `"12.5"` in either case — the canonical
 * decimal string `Quantity` accepts and every backup, checksum and comparison
 * in this codebase already depends on.
 *
 * ## What this is not
 *
 * It is **not** a number parser. `parseFloat` never appears here and must not:
 * a pack factor becomes a multiplier on every purchase-order line converted
 * with it, and routing an exact decimal through a binary float to "clean it
 * up" is precisely the class of defect Checkpoint 3 spent a phase removing
 * from the engine. This function rewrites separator characters and nothing
 * else; the resulting string is handed to `Quantity.fromString`, which remains
 * the authority on whether it is a valid quantity at all.
 *
 * ## The rule, and why grouping is refused
 *
 * Thousands separators are not accepted. That is what keeps the whole thing
 * free of magnitude guessing:
 *
 * | Input | tr | en |
 * | --- | --- | --- |
 * | `50` | `50` | `50` |
 * | `12,5` | `12.5` | `12.5` |
 * | `12.5` | `12.5` | `12.5` |
 * | `1,500` | `1.500` | **ambiguous** |
 * | `1.500` | **ambiguous** | `1.500` |
 * | `1.500,25` | not a number | not a number |
 *
 * One separator is a decimal point unless it is **the current locale's
 * grouping character followed by exactly three digits**, which is the only
 * shape that can honestly be read two ways: a Turkish `1.500` is either one
 * thousand five hundred or one and a half, and the difference is a factor of a
 * thousand on every future order line. That case is refused by name, with a
 * message that offers both unambiguous spellings, rather than resolved by a
 * convention the user did not know they were relying on.
 *
 * Everything else is decided by the shape alone: `12.5` in Turkish cannot be
 * grouping (groups are always three digits), so it is a decimal point typed in
 * the other convention and is accepted as one.
 */

import type { SupportedLocale } from '../../i18n'

export type DecimalParseFailure = 'NOT_A_NUMBER' | 'AMBIGUOUS_SEPARATOR'

export type DecimalParseResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly reason: DecimalParseFailure }

interface Separators {
  readonly decimal: string
  readonly grouping: string
}

function separatorsFor(locale: SupportedLocale): Separators {
  return locale === 'tr' ? { decimal: ',', grouping: '.' } : { decimal: '.', grouping: ',' }
}

const DIGITS_ONLY = /^\d+$/
const ALLOWED_CHARACTERS = /^[\d.,]+$/

/**
 * Turns what the user typed into the canonical decimal string, or says why it
 * cannot.
 *
 * The caller is expected to have decided already that an empty value means
 * "absent"; this function treats it as not a number, because a field that is
 * present and blank is not a quantity.
 */
export function parseDecimalInput(input: string, locale: SupportedLocale): DecimalParseResult {
  const text = input.trim()
  if (text === '' || !ALLOWED_CHARACTERS.test(text)) {
    return { ok: false, reason: 'NOT_A_NUMBER' }
  }

  if (DIGITS_ONLY.test(text)) {
    return { ok: true, canonical: text }
  }

  const separatorCount = [...text].filter((character) => character === '.' || character === ',').length
  if (separatorCount !== 1) {
    // Two or more separators can only be a grouped number, which this field
    // does not accept. One is the case handled below; zero was handled above.
    return { ok: false, reason: 'NOT_A_NUMBER' }
  }

  const index = text.search(/[.,]/)
  const separator = text[index]!
  const whole = text.slice(0, index)
  const fraction = text.slice(index + 1)

  if (!DIGITS_ONLY.test(whole) || !DIGITS_ONLY.test(fraction)) {
    return { ok: false, reason: 'NOT_A_NUMBER' }
  }

  const { grouping } = separatorsFor(locale)
  if (separator === grouping && fraction.length === 3) {
    // The one genuinely two-way reading. Refused rather than guessed.
    return { ok: false, reason: 'AMBIGUOUS_SEPARATOR' }
  }

  return { ok: true, canonical: `${whole}.${fraction}` }
}

/**
 * The inverse, for putting a stored value back into the input box.
 *
 * Only the decimal separator is localised — no grouping is inserted, so the
 * value the user sees is the value `parseDecimalInput` reads back unchanged.
 * A round trip through this pair must be exact: a formatter that added
 * thousands separators would produce text its own parser then refuses.
 */
export function formatDecimalForInput(canonical: string, locale: SupportedLocale): string {
  const { decimal } = separatorsFor(locale)
  return decimal === '.' ? canonical : canonical.replace('.', decimal)
}
