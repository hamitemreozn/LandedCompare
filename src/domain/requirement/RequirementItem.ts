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
  /**
   * Optional link to a `Product` in the catalog master (Data Model §4, "The
   * RequirementItem → Product link"; the additive Phase 9 change listed in
   * §12).
   *
   * **Nothing in `src/calculation` or `src/comparison` reads it.** Those
   * modules consume `id`, `requiredQuantity` and `comparisonUnit` only, so this
   * field changes no monetary behaviour — it exists so that a requirement which
   * *does* name a catalog product can carry a stable reference instead of a
   * retyped name, which is what a purchase-order line will need in Phase 14.
   *
   * It stays optional on a requirement on purpose: a quick comparison of
   * something the company has never bought must not force catalog entry. The
   * link becomes mandatory only where an operational document depends on it.
   */
  readonly productId?: string
  readonly requiredQuantity: Quantity
  readonly comparisonUnit: string
}

export interface CreateRequirementItemInput {
  id: string
  productName: string
  sku?: string
  productId?: string
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
    productId: input.productId,
    requiredQuantity: Quantity.fromString(input.requiredQuantity),
    comparisonUnit: input.comparisonUnit,
  }
}
