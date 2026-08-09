const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/

/**
 * ISO-4217-style three-letter uppercase currency code (e.g. "USD", "EUR").
 * Branded so a plain string cannot be assigned without going through
 * `parseCurrencyCode`. No hard-coded list of currencies is enforced here —
 * validation is structural (shape), not membership in a fixed table.
 */
export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' }

export class InvalidCurrencyCodeError extends Error {
  constructor(value: string) {
    super(`Invalid currency code: "${value}" (expected 3 uppercase letters, e.g. "USD")`)
    this.name = 'InvalidCurrencyCodeError'
  }
}

export function isValidCurrencyCode(value: string): boolean {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value)
}

export function parseCurrencyCode(value: string): CurrencyCode {
  if (!isValidCurrencyCode(value)) {
    throw new InvalidCurrencyCodeError(value)
  }
  return value as CurrencyCode
}
