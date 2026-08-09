import { describe, expect, it } from 'vitest'
import { createQuoteItem, InvalidQuoteItemError } from './QuoteItem'
import { Money } from '../monetary/Money'

describe('createQuoteItem — quotedUnitPrice sign', () => {
  it('rejects a negative quotedUnitPrice at construction — the earliest domain boundary', () => {
    // There is no construction path for QuoteItem other than createQuoteItem
    // (no fromJSON/deserialization exists yet — see docs/ARCHITECTURE.md,
    // Phase 7). Rejecting here means Phase 2's calculateLineSubtotal,
    // calculateMerchandiseTotal, and everything built on them can never
    // observe a negative unit price at all.
    expect(() =>
      createQuoteItem({
        id: 'item-1',
        requirementId: 'req-1',
        quotedUnitPrice: Money.fromString('-0.01', 'USD'),
        quotedUnit: 'pcs',
      }),
    ).toThrow(InvalidQuoteItemError)
  })

  it('accepts a zero quotedUnitPrice — a free/sample/included item is a real scenario', () => {
    const item = createQuoteItem({
      id: 'item-1',
      requirementId: 'req-1',
      quotedUnitPrice: Money.fromString('0', 'USD'),
      quotedUnit: 'pcs',
    })
    expect(item.quotedUnitPrice.isZero()).toBe(true)
  })

  it('accepts a positive quotedUnitPrice', () => {
    const item = createQuoteItem({
      id: 'item-1',
      requirementId: 'req-1',
      quotedUnitPrice: Money.fromString('4.50', 'USD'),
      quotedUnit: 'pcs',
    })
    expect(item.quotedUnitPrice.toDecimalString()).toBe('4.5')
  })
})
