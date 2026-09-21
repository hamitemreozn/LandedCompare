import type { SupportedLocale } from './locale'

/**
 * Locale-aware PRESENTATION helpers, built on `Intl.NumberFormat`.
 *
 * These are display only. They accept an already-settled, safe-to-show value
 * (typically `Money#toDecimalString()` or another final engine output) and
 * return a formatted string for rendering. They never round, recompute, or
 * feed back into a financial calculation, and the engine's `Money`/`Decimal`
 * results remain the authoritative values regardless of what is shown here.
 * Do not parse these strings back into numbers for arithmetic.
 */

function toIntlLocale(locale: SupportedLocale): string {
  return locale === 'tr' ? 'tr-TR' : 'en-US'
}

export function formatNumber(
  value: string | number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(toIntlLocale(locale), options).format(Number(value))
}

/**
 * `amount` must already be a settled display value (e.g. `Money#toDecimalString()`).
 * `currencyCode` drives `Intl`'s own minor-unit display rules (e.g. 0 digits
 * for JPY); this does not redefine or override the engine's minor-unit logic,
 * it only controls how many digits are shown.
 */
export function formatCurrency(
  amount: string | number,
  currencyCode: string,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(toIntlLocale(locale), {
    style: 'currency',
    currency: currencyCode,
    ...options,
  }).format(Number(amount))
}

/**
 * An ISO instant (`createdAt`, `updatedAt`) as a readable local date and time.
 *
 * The **stored** value is always UTC with milliseconds, because that is what
 * makes `updatedAt` comparable as a string and the stale-write check
 * meaningful. This turns it into something a person reads, in their own time
 * zone, and the result is never parsed back — same contract as the number
 * helpers above.
 *
 * An unparseable value is returned as it was stored rather than rendered as
 * "Invalid Date": if a record ever carries a timestamp this build does not
 * understand, showing the raw value is what lets someone diagnose it.
 */
export function formatInstant(instant: string, locale: SupportedLocale): string {
  const parsed = Date.parse(instant)
  if (Number.isNaN(parsed)) {
    return instant
  }
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}

/** `value` is a fraction (e.g. `0.1856`, not `18.56`) — `Intl` multiplies by 100 for display. */
export function formatPercentage(
  value: string | number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(toIntlLocale(locale), {
    style: 'percent',
    ...options,
  }).format(Number(value))
}
