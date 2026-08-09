import { describe, expect, it } from 'vitest'
import {
  calculateLineSubtotal,
  calculateMerchandiseTotal,
  calculateQuoteMerchandise,
  type MerchandiseLine,
} from './MerchandiseCalculation'
import { ExchangeRateTable, MissingExchangeRateError } from './ExchangeRateTable'
import { ExchangeRate } from './ExchangeRate'
import { Money, CurrencyMismatchError } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'
import { createQuote } from '../domain/quote/Quote'
import { createQuoteItem } from '../domain/quote/QuoteItem'

function line(unitPrice: string, currency: string, quantity: string): MerchandiseLine {
  return {
    unitPrice: Money.fromString(unitPrice, currency),
    calculationQuantity: Quantity.fromString(quantity),
  }
}

describe('calculateLineSubtotal', () => {
  it('multiplies unit price by calculation quantity', () => {
    expect(calculateLineSubtotal(line('10', 'USD', '100')).toDecimalString()).toBe('1000')
  })

  it('preserves sub-cent precision (0.0047 x 1000)', () => {
    expect(calculateLineSubtotal(line('0.0047', 'USD', '1000')).toDecimalString()).toBe('4.7')
  })

  it('supports a decimal calculation quantity (4.25 x 2.5)', () => {
    expect(calculateLineSubtotal(line('4.25', 'USD', '2.5')).toDecimalString()).toBe('10.625')
  })

  it('never routes through native binary floating-point', () => {
    // 0.1 + 0.2 !== 0.3 natively; this line subtotal must still be exact.
    const subtotal = calculateLineSubtotal(line('0.1', 'USD', '1')).add(
      calculateLineSubtotal(line('0.2', 'USD', '1')),
    )
    expect(subtotal.toDecimalString()).toBe('0.3')
  })

  it('preserves precision for large monetary values', () => {
    const subtotal = calculateLineSubtotal(line('123456789123456789.123456789', 'USD', '2'))
    expect(subtotal.toDecimalString()).toBe('246913578246913578.246913578')
  })
})

describe('calculateMerchandiseTotal', () => {
  it('sums multiple line subtotals', () => {
    const subtotals = [
      calculateLineSubtotal(line('10', 'USD', '100')),
      calculateLineSubtotal(line('2.5', 'USD', '20')),
    ]
    expect(calculateMerchandiseTotal(subtotals, 'USD').toDecimalString()).toBe('1050')
  })

  it('yields zero for an empty line list', () => {
    const total = calculateMerchandiseTotal([], 'USD')
    expect(total.toDecimalString()).toBe('0')
    expect(total.currency).toBe('USD')
  })

  it('throws CurrencyMismatchError instead of silently mixing currencies', () => {
    const subtotals = [Money.fromString('10', 'USD'), Money.fromString('5', 'EUR')]
    expect(() => calculateMerchandiseTotal(subtotals, 'USD')).toThrow(CurrencyMismatchError)
  })
})

describe('calculateQuoteMerchandise', () => {
  it('computes the quote-currency total and converts it once into the base currency', () => {
    const table = ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', '43.50')])
    const result = calculateQuoteMerchandise(
      [line('12.50', 'USD', '100'), line('3.75', 'USD', '40')],
      'USD',
      table,
    )
    expect(result.lineSubtotals.map((m) => m.toDecimalString())).toEqual(['1250', '150'])
    expect(result.quoteCurrencyMerchandiseTotal.toDecimalString()).toBe('1400')
    expect(result.baseCurrencyMerchandiseTotal.toDecimalString()).toBe('60900')
    expect(result.baseCurrencyMerchandiseTotal.currency).toBe('TRY')
  })

  it('requires no rate when the quote currency equals the base currency', () => {
    const table = ExchangeRateTable.create('TRY', [])
    const result = calculateQuoteMerchandise([line('100', 'TRY', '5')], 'TRY', table)
    expect(result.quoteCurrencyMerchandiseTotal.toDecimalString()).toBe('500')
    expect(result.baseCurrencyMerchandiseTotal.toDecimalString()).toBe('500')
  })

  it('fails on a missing exchange rate instead of silently continuing', () => {
    const table = ExchangeRateTable.create('TRY', [])
    expect(() => calculateQuoteMerchandise([line('100', 'USD', '1')], 'USD', table)).toThrow(
      MissingExchangeRateError,
    )
  })

  it('yields a zero merchandise total for a quote with no lines', () => {
    const table = ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', '43.50')])
    const result = calculateQuoteMerchandise([], 'USD', table)
    expect(result.quoteCurrencyMerchandiseTotal.toDecimalString()).toBe('0')
    expect(result.baseCurrencyMerchandiseTotal.toDecimalString()).toBe('0')
    expect(result.baseCurrencyMerchandiseTotal.currency).toBe('TRY')
  })
})

describe('integration with the domain Quote/QuoteItem model', () => {
  it('rejects building a Quote whose item currency mismatches before calculation ever runs', () => {
    const mismatchedItem = createQuoteItem({
      id: 'item-1',
      requirementId: 'req-1',
      quotedUnitPrice: Money.fromString('12.50', 'EUR'),
      quotedUnit: 'pcs',
    })
    expect(() =>
      createQuote({ id: 'q-1', supplierId: 'sup-1', currency: 'USD', items: [mismatchedItem] }),
    ).toThrow()
  })

  it('calculates merchandise totals from a valid Quote plus externally-resolved quantities', () => {
    const itemA = createQuoteItem({
      id: 'item-a',
      requirementId: 'req-a',
      quotedUnitPrice: Money.fromString('12.50', 'USD'),
      quotedUnit: 'pcs',
    })
    const itemB = createQuoteItem({
      id: 'item-b',
      requirementId: 'req-b',
      quotedUnitPrice: Money.fromString('3.75', 'USD'),
      quotedUnit: 'pcs',
    })
    const quote = createQuote({ id: 'q-1', supplierId: 'sup-1', currency: 'USD', items: [itemA, itemB] })

    // Phase 2 does not derive these quantities (no MOQ/pack logic) - they are
    // supplied here exactly as a later phase would resolve and hand them in.
    const resolvedQuantities = new Map([
      ['item-a', Quantity.fromString('100')],
      ['item-b', Quantity.fromString('40')],
    ])
    const lines: MerchandiseLine[] = quote.items.map((item) => ({
      unitPrice: item.quotedUnitPrice,
      calculationQuantity: resolvedQuantities.get(item.id)!,
    }))

    const table = ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', '43.50')])
    const result = calculateQuoteMerchandise(lines, quote.currency, table)

    expect(result.quoteCurrencyMerchandiseTotal.toDecimalString()).toBe('1400')
    expect(result.baseCurrencyMerchandiseTotal.toDecimalString()).toBe('60900')
  })
})
