import { Money } from '../monetary/Money'
import { Quantity } from '../quantity/Quantity'

/**
 * One priced line within a supplier's Quote, pointing back at the
 * RequirementItem it prices. `unitsPerQuotedUnit` and `moq` are supplier-
 * provided constraints (SKU-level pack size and minimum order quantity) for
 * Phase 3's quantity resolution (`src/calculation/QuantityResolution.ts`) to
 * read. This entity does not carry a derived/resolved order quantity field —
 * that value is always calculated on demand, never stored here, so there is
 * no risk of a stale persisted quantity drifting from what MOQ/pack
 * resolution would actually produce.
 *
 * `quotedUnitPrice` must be **`>= 0`**. A negative price is rejected here, at
 * construction — the earliest possible domain boundary — so it can never
 * reach Phase 2's merchandise engine or any later calculation. `0` is
 * explicitly **allowed**: a free/sample/included item is a real quotation
 * scenario the MVP does not forbid. This mirrors `Quantity`'s "negative
 * rejected, zero allowed" stance; `Money` itself stays general-purpose and
 * sign-unrestricted (Phase 4 discounts and signed cost effects rely on a
 * negative `Money`), so this is a `QuoteItem`-specific rule, not a global
 * `Money` constraint.
 */
export interface QuoteItem {
  readonly id: string
  readonly requirementId: string
  readonly quotedUnitPrice: Money
  readonly quotedUnit: string
  readonly unitsPerQuotedUnit?: Quantity
  readonly moq?: Quantity
}

export interface CreateQuoteItemInput {
  id: string
  requirementId: string
  quotedUnitPrice: Money
  quotedUnit: string
  unitsPerQuotedUnit?: Quantity
  moq?: Quantity
}

export class InvalidQuoteItemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidQuoteItemError'
  }
}

export function createQuoteItem(input: CreateQuoteItemInput): QuoteItem {
  if (input.id.trim() === '') {
    throw new InvalidQuoteItemError('QuoteItem id must not be empty')
  }
  if (input.requirementId.trim() === '') {
    throw new InvalidQuoteItemError('QuoteItem requirementId must not be empty')
  }
  if (input.quotedUnit.trim() === '') {
    throw new InvalidQuoteItemError('QuoteItem quotedUnit must not be empty')
  }
  if (input.quotedUnitPrice.isNegative()) {
    throw new InvalidQuoteItemError(
      `QuoteItem "${input.id}" quotedUnitPrice must not be negative (got ${input.quotedUnitPrice.toDecimalString()} ${input.quotedUnitPrice.currency}); zero is allowed for a free/sample/included item`,
    )
  }
  return {
    id: input.id,
    requirementId: input.requirementId,
    quotedUnitPrice: input.quotedUnitPrice,
    quotedUnit: input.quotedUnit,
    unitsPerQuotedUnit: input.unitsPerQuotedUnit,
    moq: input.moq,
  }
}
