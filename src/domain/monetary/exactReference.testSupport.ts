/**
 * An **independent** exact-decimal reference, built on native `BigInt` and
 * nothing else.
 *
 * Why it exists: the monetary precision regression tests have to prove that
 * `decimal.js`-based arithmetic produces the mathematically correct answer.
 * Checking that with the same helpers that perform the arithmetic would only
 * prove the implementation agrees with itself — a premature rounding would be
 * reproduced identically on both sides and the test would pass while the
 * money was wrong.
 *
 * So this file deliberately shares no code with `decimal.ts`. A value is a
 * pair of arbitrary-precision integers (`digits`, `scale`) meaning
 * `digits / 10^scale`; `BigInt` has no precision budget at all, so every
 * operation below is exact by construction, not by configuration. Only
 * `roundHalfUp` discards information, and only where it is asked to.
 *
 * Not a test file — a test-only support module, like
 * `src/comparison/testSupport.ts`.
 */

/** `digits / 10^scale`. `scale` is a digit count, never a financial value. */
export interface ExactReference {
  readonly digits: bigint
  readonly scale: number
}

export class InvalidReferenceValueError extends Error {
  constructor(value: string) {
    super(`Invalid reference decimal: "${value}"`)
    this.name = 'InvalidReferenceValueError'
  }
}

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/

/** Parses a plain decimal string. No exponential notation — none is needed here. */
export function reference(value: string): ExactReference {
  if (!DECIMAL_STRING.test(value)) {
    throw new InvalidReferenceValueError(value)
  }
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const [integerPart, fractionPart = ''] = body.split('.')
  const digits = BigInt(`${integerPart!}${fractionPart}`)
  return { digits: negative ? -digits : digits, scale: fractionPart.length }
}

/**
 * Canonical string, with trailing fractional zeros removed so it can be
 * compared directly against `Money#toDecimalString()` (decimal.js normalises
 * the same way).
 */
export function referenceToString(value: ExactReference): string {
  const negative = value.digits < 0n
  const magnitude = (negative ? -value.digits : value.digits)
    .toString()
    .padStart(value.scale + 1, '0')
  const split = magnitude.length - value.scale
  let text =
    value.scale === 0 ? magnitude : `${magnitude.slice(0, split)}.${magnitude.slice(split)}`
  if (text.includes('.')) {
    text = text.replace(/0+$/, '').replace(/\.$/, '')
  }
  return negative && /[1-9]/.test(text) ? `-${text}` : text
}

function toCommonScale(
  a: ExactReference,
  b: ExactReference,
): { left: bigint; right: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale)
  return {
    left: a.digits * 10n ** BigInt(scale - a.scale),
    right: b.digits * 10n ** BigInt(scale - b.scale),
    scale,
  }
}

export function referenceMultiply(a: ExactReference, b: ExactReference): ExactReference {
  return { digits: a.digits * b.digits, scale: a.scale + b.scale }
}

export function referenceAdd(a: ExactReference, b: ExactReference): ExactReference {
  const { left, right, scale } = toCommonScale(a, b)
  return { digits: left + right, scale }
}

export function referenceSubtract(a: ExactReference, b: ExactReference): ExactReference {
  const { left, right, scale } = toCommonScale(a, b)
  return { digits: left - right, scale }
}

/** `value / 10^exponent` — a decimal-point shift, so exact with no division. */
export function referenceShiftRight(value: ExactReference, exponent: number): ExactReference {
  return { digits: value.digits, scale: value.scale + exponent }
}

/**
 * Half-up at `decimalPlaces`, matching the engine's settlement convention:
 * exactly half rounds away from zero. Done on integers, so "exactly half" is
 * decided by comparing `remainder * 2` against the divisor rather than by
 * inspecting a rounded quotient.
 */
export function referenceRoundHalfUp(
  value: ExactReference,
  decimalPlaces: number,
): ExactReference {
  if (value.scale <= decimalPlaces) {
    return {
      digits: value.digits * 10n ** BigInt(decimalPlaces - value.scale),
      scale: decimalPlaces,
    }
  }
  const divisor = 10n ** BigInt(value.scale - decimalPlaces)
  const negative = value.digits < 0n
  const magnitude = negative ? -value.digits : value.digits
  const quotient = magnitude / divisor
  const remainder = magnitude % divisor
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient
  return { digits: negative ? -rounded : rounded, scale: decimalPlaces }
}

/** `percentage%` of `base`, exact: `base × rate / 100`. */
export function referencePercentageOf(base: ExactReference, rate: ExactReference): ExactReference {
  return referenceShiftRight(referenceMultiply(base, rate), 2)
}
