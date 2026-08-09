import { Quantity } from '../quantity/Quantity'

/**
 * A line of purchasing need to be satisfied by comparing supplier quotations
 * against it. `comparisonUnit` is an opaque label (e.g. "pcs", "kg") at this
 * phase — unit conversion/normalization logic is Phase 3 scope.
 */
export interface RequirementItem {
  readonly id: string
  readonly productName: string
  readonly sku?: string
  readonly requiredQuantity: Quantity
  readonly comparisonUnit: string
}

export interface CreateRequirementItemInput {
  id: string
  productName: string
  sku?: string
  requiredQuantity: string
  comparisonUnit: string
}

export class InvalidRequirementItemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequirementItemError'
  }
}

export function createRequirementItem(input: CreateRequirementItemInput): RequirementItem {
  if (input.id.trim() === '') {
    throw new InvalidRequirementItemError('RequirementItem id must not be empty')
  }
  if (input.productName.trim() === '') {
    throw new InvalidRequirementItemError('RequirementItem productName must not be empty')
  }
  if (input.comparisonUnit.trim() === '') {
    throw new InvalidRequirementItemError('RequirementItem comparisonUnit must not be empty')
  }
  return {
    id: input.id,
    productName: input.productName,
    sku: input.sku,
    requiredQuantity: Quantity.fromString(input.requiredQuantity),
    comparisonUnit: input.comparisonUnit,
  }
}
