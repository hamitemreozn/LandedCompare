import { describe, expect, it } from 'vitest'
import { createQuote, InvalidQuoteError } from './Quote'
import { createQuoteItem } from './QuoteItem'
import { Money } from '../monetary/Money'

describe('createQuote', () => {
  it('accepts items priced in the quote currency', () => {
    const item = createQuoteItem({
      id: 'item-1',
      requirementId: 'req-1',
      quotedUnitPrice: Money.fromString('4.50', 'USD'),
      quotedUnit: 'pcs',
    })
    const quote = createQuote({ id: 'q-1', supplierId: 'sup-1', currency: 'USD', items: [item] })
    expect(quote.items).toHaveLength(1)
  })

  it('rejects a quote item priced in a different currency than the quote', () => {
    const item = createQuoteItem({
      id: 'item-1',
      requirementId: 'req-1',
      quotedUnitPrice: Money.fromString('4.50', 'EUR'),
      quotedUnit: 'pcs',
    })
    expect(() =>
      createQuote({ id: 'q-1', supplierId: 'sup-1', currency: 'USD', items: [item] }),
    ).toThrow(InvalidQuoteError)
  })
})
