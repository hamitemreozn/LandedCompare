import { parseCurrencyCode, type CurrencyCode } from '../monetary/CurrencyCode'
import type { QuoteItem } from './QuoteItem'

/**
 * A supplier's quotation, conceptually separate from the Supplier itself.
 * No quotation-history/versioning concept exists in the MVP.
 */
export interface Quote {
  readonly id: string
  readonly supplierId: string
  readonly currency: CurrencyCode
  readonly quoteDate?: string
  readonly incoterm?: string
  readonly paymentTerms?: string
  readonly leadTime?: string
  readonly warranty?: string
  readonly notes?: string
  readonly items: readonly QuoteItem[]
}

export interface CreateQuoteInput {
  id: string
  supplierId: string
  currency: string
  quoteDate?: string
  incoterm?: string
  paymentTerms?: string
  leadTime?: string
  warranty?: string
  notes?: string
  items?: readonly QuoteItem[]
}

export class InvalidQuoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidQuoteError'
  }
}

export function createQuote(input: CreateQuoteInput): Quote {
  if (input.id.trim() === '') {
    throw new InvalidQuoteError('Quote id must not be empty')
  }
  if (input.supplierId.trim() === '') {
    throw new InvalidQuoteError('Quote supplierId must not be empty')
  }

  const currency = parseCurrencyCode(input.currency)
  const items = input.items ?? []

  for (const item of items) {
    if (item.quotedUnitPrice.currency !== currency) {
      throw new InvalidQuoteError(
        `QuoteItem "${item.id}" price currency "${item.quotedUnitPrice.currency}" does not match quote currency "${currency}"`,
      )
    }
  }

  return {
    id: input.id,
    supplierId: input.supplierId,
    currency,
    quoteDate: input.quoteDate,
    incoterm: input.incoterm,
    paymentTerms: input.paymentTerms,
    leadTime: input.leadTime,
    warranty: input.warranty,
    notes: input.notes,
    items,
  }
}
