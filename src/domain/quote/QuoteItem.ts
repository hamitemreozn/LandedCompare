import { Money } from '../monetary/Money'
import { Quantity } from '../quantity/Quantity'

/**
 * One priced line within a supplier's Quote, pointing back at the
 * RequirementItem it prices. `unitsPerQuotedUnit`, `moq`, and `orderQuantity`
 * are carried as optional data slots so Phase 3 (MOQ / pack normalization)
 * has somewhere to read from and write to — no MOQ satisfaction, pack
 * rounding, or order-quantity derivation logic is implemented here.
 */
export interface QuoteItem {
  readonly id: string
  readonly requirementId: string
  readonly quotedUnitPrice: Money
  readonly quotedUnit: string
  readonly unitsPerQuotedUnit?: Quantity
  readonly moq?: Quantity
  readonly orderQuantity?: Quantity
}

export interface CreateQuoteItemInput {
  id: string
  requirementId: string
  quotedUnitPrice: Money
  quotedUnit: string
  unitsPerQuotedUnit?: Quantity
  moq?: Quantity
  orderQuantity?: Quantity
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
  return {
    id: input.id,
    requirementId: input.requirementId,
    quotedUnitPrice: input.quotedUnitPrice,
    quotedUnit: input.quotedUnit,
    unitsPerQuotedUnit: input.unitsPerQuotedUnit,
    moq: input.moq,
    orderQuantity: input.orderQuantity,
  }
}
