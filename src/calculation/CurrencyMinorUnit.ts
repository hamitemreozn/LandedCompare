import { parseCurrencyCode } from '../domain/monetary/CurrencyCode'
import { DECIMAL_PRECISION } from '../domain/monetary/decimal'
import type { Money } from '../domain/monetary/Money'

export class InvalidMinorUnitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMinorUnitError'
  }
}

/**
 * The amount is too large to be settled exactly at this currency's minor
 * unit: representing it would need more significant digits than the decimal
 * configuration provides (`DECIMAL_PRECISION`), so every sum built from the
 * settled value — an allocation reconciling to its total, a settled landed
 * total reconciling to its breakdown — would be silently short.
 *
 * This is a **precision** boundary derived from the engine's own
 * configuration, exactly like `MAX_MINOR_UNIT_DIGITS` below. It is **not** a
 * commercial maximum amount; this engine invents no such limit. It is also
 * not an internal-correctness failure: the arithmetic did not go wrong, the
 * input is simply outside the range this engine can settle exactly, which is
 * why it is a named, explainable error rather than an invariant assertion.
 */
export class PrecisionEnvelopeExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrecisionEnvelopeExceededError'
  }
}

/**
 * Rejects an amount that cannot be settled exactly at `minorUnit`. Called at
 * every settlement boundary (commercial total, allocation) *before* any
 * rounding or summation, so the failure names the input rather than
 * surfacing later as an allocation that will not add up.
 */
export function assertSettleableAtMinorUnit(amount: Money, minorUnit: number, subject: string): void {
  if (amount.exceedsSettlementPrecision(minorUnit)) {
    throw new PrecisionEnvelopeExceededError(
      `${subject} ${amount.toDecimalString()} ${amount.currency} cannot be settled exactly at ${String(minorUnit)} minor-unit digit(s): it needs more than the ${String(DECIMAL_PRECISION)} significant digits this engine calculates with. This is a precision limit derived from the decimal configuration, not a maximum amount.`,
    )
  }
}

/**
 * How many decimal digits a currency's minor unit has (2 for TRY/USD/EUR,
 * 0 for a currency like JPY). Supplied per project rather than looked up in a
 * global table.
 */
export type MinorUnitOverrides = Readonly<Record<string, number>>

/**
 * The deliberately tiny built-in table. This is **not** an ISO-4217 currency
 * database and is not meant to grow into one — it covers only the currencies
 * the MVP actually exercises, so the common case needs no configuration.
 * Every other currency must be declared explicitly by the caller, which is
 * also how a 0-decimal currency (JPY) is supported without hard-coding a
 * global list: `resolveMinorUnit('JPY', { JPY: 0 })`.
 */
const BUILT_IN_MINOR_UNITS: Readonly<Record<string, number | undefined>> = {
  TRY: 2,
  USD: 2,
  EUR: 2,
}

/**
 * Upper bound on a minor-unit scale. Not a business rule — it is derived from
 * the decimal configuration (`toExpNeg: -30` in `domain/monetary/decimal.ts`),
 * beyond which canonical decimal strings would stop round-tripping cleanly.
 */
const MAX_MINOR_UNIT_DIGITS = 30

/**
 * Resolves the minor-unit precision to settle a currency at.
 *
 * An explicit override always wins over the built-in table. An unknown
 * currency with no override is a **blocking error**, never a silent fallback
 * to 2 — the same stance Phase 2 takes on a missing exchange rate. Defaulting
 * to 2 would silently produce unpayable amounts for a 0-decimal currency, and
 * the user is better served by being asked than by being guessed at.
 */
export function resolveMinorUnit(currency: string, overrides?: MinorUnitOverrides): number {
  const code = parseCurrencyCode(currency)

  const override = overrides?.[code]
  if (override !== undefined) {
    assertValidMinorUnit(code, override)
    return override
  }

  const builtIn = BUILT_IN_MINOR_UNITS[code]
  if (builtIn !== undefined) {
    return builtIn
  }

  throw new InvalidMinorUnitError(
    `No minor-unit precision configured for currency "${code}". Provide it explicitly (e.g. { ${code}: 2 }) — it is not defaulted.`,
  )
}

function assertValidMinorUnit(currency: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_MINOR_UNIT_DIGITS) {
    throw new InvalidMinorUnitError(
      `Invalid minor-unit precision "${String(value)}" for currency "${currency}" (must be an integer between 0 and ${MAX_MINOR_UNIT_DIGITS})`,
    )
  }
}
