import { parseCurrencyCode } from '../domain/monetary/CurrencyCode'

export class InvalidMinorUnitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMinorUnitError'
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
