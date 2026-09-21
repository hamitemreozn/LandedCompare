import { describe, expect, it } from 'vitest'
import { formatDecimalForInput, parseDecimalInput } from './decimalInput'

const canonical = (input: string, locale: 'tr' | 'en'): string | null => {
  const result = parseDecimalInput(input, locale)
  return result.ok ? result.canonical : null
}

const reason = (input: string, locale: 'tr' | 'en'): string | null => {
  const result = parseDecimalInput(input, locale)
  return result.ok ? null : result.reason
}

describe('what a Turkish user types', () => {
  it('accepts the decimal comma and stores the canonical dot form', () => {
    expect(canonical('12,5', 'tr')).toBe('12.5')
    expect(canonical('0,001', 'tr')).toBe('0.001')
    expect(canonical('1,5', 'tr')).toBe('1.5')
  })

  it('also accepts a dot, because that shape cannot be a grouped number', () => {
    // Groups are always three digits, so "12.5" is unmistakably a decimal
    // point typed in the other convention rather than a thousands separator.
    expect(canonical('12.5', 'tr')).toBe('12.5')
    expect(canonical('1.25', 'tr')).toBe('1.25')
    // Trailing zeros are kept: this rewrites separators, it does not
    // normalise a number. `Quantity` decides what the value means.
    expect(canonical('1.2500', 'tr')).toBe('1.2500')
  })

  it('reads a plain integer as itself', () => {
    expect(canonical('50', 'tr')).toBe('50')
    expect(canonical('  1500  ', 'tr')).toBe('1500')
  })
})

describe('what an English user types', () => {
  it('accepts the decimal dot', () => {
    expect(canonical('12.5', 'en')).toBe('12.5')
    expect(canonical('50', 'en')).toBe('50')
  })

  it('accepts a comma where it cannot be grouping', () => {
    expect(canonical('12,5', 'en')).toBe('12.5')
  })
})

describe('the one shape that is refused, and why', () => {
  it('refuses a locale grouping separator followed by exactly three digits', () => {
    // Turkish "1.500" is either one thousand five hundred or one and a half.
    // A thousand-fold difference is not a guess this layer is allowed to make.
    expect(reason('1.500', 'tr')).toBe('AMBIGUOUS_SEPARATOR')
    expect(reason('12.000', 'tr')).toBe('AMBIGUOUS_SEPARATOR')
    // And the mirror image in English.
    expect(reason('1,500', 'en')).toBe('AMBIGUOUS_SEPARATOR')
  })

  it('does not refuse the same digits when the separator is the decimal one', () => {
    // Turkish "1,500" can only be one and a half: the comma is the decimal
    // separator in that locale, so there is nothing to decide.
    expect(canonical('1,500', 'tr')).toBe('1.500')
    expect(canonical('1.500', 'en')).toBe('1.500')
  })

  it('never guesses a magnitude: a refused value produces no number at all', () => {
    const result = parseDecimalInput('1.500', 'tr')
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('canonical')
  })
})

describe('what is not a number', () => {
  it('rejects grouped numbers outright, because grouping is not accepted', () => {
    expect(reason('1.500,25', 'tr')).toBe('NOT_A_NUMBER')
    expect(reason('1,500.25', 'en')).toBe('NOT_A_NUMBER')
    expect(reason('1.234.567', 'tr')).toBe('NOT_A_NUMBER')
  })

  it('rejects letters, signs, spaces inside, and empty input', () => {
    for (const input of ['', '   ', 'abc', '12a', '-5', '+5', '1 5', '1e3', '12,', ',5', '.']) {
      expect(reason(input, 'tr'), input).toBe('NOT_A_NUMBER')
    }
  })

  it('leaves the decision about validity as a quantity to Quantity', () => {
    // A syntactically fine value this function is happy with may still be
    // rejected downstream — "0" parses here and fails the positive check in
    // the service. This layer rewrites separators and nothing else.
    expect(canonical('0', 'tr')).toBe('0')
    expect(canonical('0,0', 'tr')).toBe('0.0')
  })
})

describe('putting a stored value back into the box', () => {
  it('localises only the decimal separator, and inserts no grouping', () => {
    expect(formatDecimalForInput('12.5', 'tr')).toBe('12,5')
    expect(formatDecimalForInput('12.5', 'en')).toBe('12.5')
    // No thousands separator: a formatter that added one would produce text
    // its own parser then refuses.
    expect(formatDecimalForInput('1500', 'tr')).toBe('1500')
    expect(formatDecimalForInput('1500.25', 'tr')).toBe('1500,25')
  })

  it('round-trips exactly, in both locales', () => {
    for (const stored of ['50', '12.5', '0.001', '1500', '1500.25']) {
      for (const locale of ['tr', 'en'] as const) {
        expect(canonical(formatDecimalForInput(stored, locale), locale), `${stored}/${locale}`).toBe(
          stored,
        )
      }
    }
  })
})
