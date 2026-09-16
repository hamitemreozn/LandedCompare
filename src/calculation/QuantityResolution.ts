import { Quantity } from '../domain/quantity/Quantity'

export class InvalidMoqError extends Error {
  constructor(moq: string) {
    super(`Invalid MOQ: "${moq}" (must be a positive quantity; represent "no MOQ" with undefined, not zero)`)
    this.name = 'InvalidMoqError'
  }
}

export class InvalidPackSizeError extends Error {
  constructor(unitsPerQuotedUnit: string) {
    super(
      `Invalid units per quoted unit: "${unitsPerQuotedUnit}" (must be a positive quantity; represent "no pack" with undefined, not zero)`,
    )
    this.name = 'InvalidPackSizeError'
  }
}

/**
 * An internal assertion, not a user-input error: MOQ and whole-pack rounding
 * can only ever *raise* the quantity, so a resolved quantity below the
 * effective minimum means this function's own arithmetic is wrong. It exists
 * so that failure is loud and named, instead of surfacing indirectly as a
 * negative excess quantity from `Quantity.subtract`.
 */
export class QuantityResolutionInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuantityResolutionInvariantError'
  }
}

/**
 * Inputs to quantity resolution, all already-parsed `Quantity` values in the
 * requirement's comparison unit (except `unitsPerQuotedUnit`, which is a
 * conversion factor: how many comparison units make up one quoted unit).
 *
 * `moq` is interpreted as a SKU-level minimum comparison-unit quantity only
 * — there is no supplier-wide, invoice-value, product-family, container, or
 * pallet MOQ in this MVP. Likewise `moq` is not an arbitrary-unit MOQ (e.g.
 * "10 boxes"); it is always expressed in the same comparison unit as
 * `requiredQuantity`.
 */
export interface QuantityResolutionInput {
  readonly requiredQuantity: Quantity
  readonly moq?: Quantity
  readonly unitsPerQuotedUnit?: Quantity
}

/**
 * Traceable result of resolving how much must actually be ordered. Every
 * field needed to explain *why* `resolvedQuantity` differs from
 * `requiredQuantity` is present, so a later phase (Results UI) can render
 * that explanation without recomputing anything.
 */
export interface QuantityResolution {
  /** What the user actually needs, in the comparison unit. Never changed by this function. */
  readonly requiredQuantity: Quantity
  readonly moq?: Quantity
  /** True only if `moq` was defined and raised the effective minimum above `requiredQuantity`. */
  readonly moqApplied: boolean
  readonly unitsPerQuotedUnit?: Quantity
  /** True if a pack conversion was configured and used to derive `quotedUnitQuantity`. */
  readonly packApplied: boolean
  /** The comparison-unit quantity that will actually be purchased, after MOQ and whole-pack rounding. */
  readonly resolvedQuantity: Quantity
  /**
   * The whole number of quoted units (e.g. boxes) actually purchased, and
   * the correct pricing quantity for Phase 2's merchandise engine — a
   * supplier's `quotedUnitPrice` is per quoted unit, and this is how many of
   * those are bought. Equal to `resolvedQuantity` when no pack applies.
   */
  readonly quotedUnitQuantity: Quantity
  /**
   * `resolvedQuantity - requiredQuantity`. Non-negative — enforced by an
   * explicit post-condition in `resolveOrderQuantity`, not assumed.
   */
  readonly excessQuantity: Quantity
}

/**
 * Resolves the required quantity plus supplier MOQ/pack constraints into the
 * actual order quantity. Order of operations is fixed: MOQ is applied first
 * (raising the effective minimum, if needed), then whole-pack rounding is
 * applied to that post-MOQ minimum (see docs/CALCULATION_RULES.md).
 *
 * This function does not touch currency, freight, or any other cost — it
 * only resolves quantity semantics for Phase 2's merchandise engine to price.
 */
export function resolveOrderQuantity(input: QuantityResolutionInput): QuantityResolution {
  const { requiredQuantity, moq, unitsPerQuotedUnit } = input

  if (moq !== undefined && moq.isZero()) {
    throw new InvalidMoqError(moq.toDecimalString())
  }
  if (unitsPerQuotedUnit !== undefined && unitsPerQuotedUnit.isZero()) {
    throw new InvalidPackSizeError(unitsPerQuotedUnit.toDecimalString())
  }

  const moqApplied = moq !== undefined && moq.compareTo(requiredQuantity) > 0
  const minimumQuantity = moq !== undefined ? requiredQuantity.max(moq) : requiredQuantity

  const packApplied = unitsPerQuotedUnit !== undefined
  let quotedUnitQuantity: Quantity
  let resolvedQuantity: Quantity
  if (unitsPerQuotedUnit !== undefined) {
    quotedUnitQuantity = minimumQuantity.ceilDivide(unitsPerQuotedUnit)
    resolvedQuantity = quotedUnitQuantity.multiply(unitsPerQuotedUnit)
  } else {
    quotedUnitQuantity = minimumQuantity
    resolvedQuantity = minimumQuantity
  }

  // Post-condition rather than a comment claiming non-negativity: both steps
  // above (MOQ, whole-pack ceiling) can only raise the quantity, so this can
  // only fire if the underlying decimal arithmetic misbehaved. Checking it
  // here keeps that failure named and loud instead of letting it reappear as
  // an `InvalidQuantityError` from the excess subtraction below.
  if (resolvedQuantity.compareTo(minimumQuantity) < 0) {
    throw new QuantityResolutionInvariantError(
      `Resolved quantity ${resolvedQuantity.toDecimalString()} is below the effective minimum ${minimumQuantity.toDecimalString()}; MOQ and pack rounding can only raise a quantity`,
    )
  }

  const excessQuantity = resolvedQuantity.subtract(requiredQuantity)

  return {
    requiredQuantity,
    moq,
    moqApplied,
    unitsPerQuotedUnit,
    packApplied,
    resolvedQuantity,
    quotedUnitQuantity,
    excessQuantity,
  }
}
