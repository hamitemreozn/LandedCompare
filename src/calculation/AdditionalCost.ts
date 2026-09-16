import { Money } from '../domain/monetary/Money'
import { ALLOCATION_METHODS, DEFAULT_ALLOCATION_METHOD, type AllocationMethod } from './Allocation'
import { Percentage } from './Percentage'

/**
 * Whether an entry adds to, or subtracts from, the landed total. Discount and
 * surcharge are separate semantic concepts rather than a signed cost: a user
 * enters `Discount = 500`, never `Freight = -500`, and the engine decides the
 * sign. That separation is what makes "how much discount did I get?" an
 * answerable question instead of something buried in a negative freight line.
 *
 * The runtime tuple is the source of truth: the type is derived from it, so
 * the engine can check a value that arrived without passing through
 * TypeScript against exactly the same closed set.
 */
export const COST_KINDS = ['COST', 'DISCOUNT', 'SURCHARGE'] as const

export type CostKind = (typeof COST_KINDS)[number]

/**
 * Controlled semantic identifiers for the preset categories the MVP supports.
 * A plain union, not a class hierarchy — only `FREIGHT` and `INSURANCE` carry
 * any calculation meaning at all (they are the components of the CIF-like
 * percentage base); every other value is a label the engine treats
 * identically. `label` on the cost itself carries any custom display name.
 */
export const COST_CATEGORIES = [
  'FREIGHT',
  'INSURANCE',
  'DUTY',
  'BROKERAGE',
  'BANK_FEE',
  'LOCAL_TRANSPORT',
  'PACKAGING',
  'TAX',
  'OTHER',
] as const

export type CostCategory = (typeof COST_CATEGORIES)[number]

/**
 * The approved bases a percentage may be taken on. Closed and acyclic by
 * construction — there is no dependency-graph engine and no way to express a
 * base that includes the cost being calculated.
 */
export const PERCENTAGE_BASES = [
  'MERCHANDISE',
  'MERCHANDISE_AFTER_DISCOUNT',
  'MERCHANDISE_PLUS_FREIGHT_INSURANCE',
] as const

export type PercentageBase = (typeof PERCENTAGE_BASES)[number]

/**
 * The fixed stage an entry is evaluated in. This is the mechanism that makes
 * circular percentage bases structurally impossible: an entry may only
 * reference bases that are fully resolved by the time its stage runs, and the
 * stage is derived from the entry itself, never chosen by the user.
 */
export type CostEvaluationStage = 'DISCOUNT' | 'FREIGHT_INSURANCE' | 'OTHER_COST' | 'SURCHARGE'

/**
 * Which bases each stage can legally reference. Read this table together with
 * the evaluation order in docs/CALCULATION_RULES.md:
 *
 * - Discounts run before anything else exists, so they can only reference the
 *   merchandise total. A discount taken on "merchandise after discount" would
 *   be self-referential.
 * - Freight and insurance costs run before the CIF-like base is assembled —
 *   they *are* its components — so referencing it would be circular. They may
 *   still be a percentage of merchandise (e.g. insurance at 0.5% of goods
 *   value), which is resolved earlier.
 * - Everything after that may use any base, because all three are final by
 *   then.
 */
const ALLOWED_PERCENTAGE_BASES: Readonly<Record<CostEvaluationStage, readonly PercentageBase[]>> = {
  DISCOUNT: ['MERCHANDISE'],
  FREIGHT_INSURANCE: ['MERCHANDISE', 'MERCHANDISE_AFTER_DISCOUNT'],
  OTHER_COST: ['MERCHANDISE', 'MERCHANDISE_AFTER_DISCOUNT', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'],
  SURCHARGE: ['MERCHANDISE', 'MERCHANDISE_AFTER_DISCOUNT', 'MERCHANDISE_PLUS_FREIGHT_INSURANCE'],
}

export class InvalidCostDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCostDefinitionError'
  }
}

export class InvalidCostAmountError extends Error {
  constructor(id: string, amount: string) {
    super(
      `Invalid amount "${amount}" on cost "${id}": a cost amount must not be negative. Enter a reduction as a discount instead.`,
    )
    this.name = 'InvalidCostAmountError'
  }
}

export class InvalidPercentageBaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPercentageBaseError'
  }
}

export class InvalidDiscountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDiscountError'
  }
}

export interface PercentageBasis {
  readonly rate: Percentage
  readonly base: PercentageBase
}

/**
 * A supplier-level cost, discount or surcharge.
 *
 * Exactly one of `fixedAmount` / `percentage` is set — those are the only two
 * calculation types in the MVP, and there is no formula engine behind them.
 * A fixed amount carries its own currency and is converted with Phase 2's
 * exchange-rate engine; a percentage has no currency of its own because its
 * base is already a base-currency amount.
 *
 * Costs are supplier-level (shared across the quote's lines) — see
 * docs/ARCHITECTURE.md for why item-level costs were left out of Phase 4.
 */
export interface AdditionalCost {
  readonly id: string
  readonly kind: CostKind
  readonly category: CostCategory
  /** Optional custom display name. Carried through untouched; no label is generated. */
  readonly label?: string
  readonly fixedAmount?: Money
  readonly percentage?: PercentageBasis
  /**
   * `false` keeps the entry in the breakdown but out of the comparison total.
   * A user preference, not a statement about the quote.
   */
  readonly includeInComparison: boolean
  /**
   * `true` means the supplier's quoted prices already contain this amount, so
   * adding it again would double-count it. A statement about the quote's
   * structure, set by the user — never inferred from the Incoterm.
   */
  readonly alreadyIncludedInQuote: boolean
  readonly allocationMethod: AllocationMethod
}

export interface CreateAdditionalCostInput {
  id: string
  kind: CostKind
  category: CostCategory
  label?: string
  fixedAmount?: Money
  percentage?: PercentageBasis
  /** Defaults to `true`. */
  includeInComparison?: boolean
  /** Defaults to `false`. */
  alreadyIncludedInQuote?: boolean
  /** Defaults to `BY_MERCHANDISE_VALUE`. */
  allocationMethod?: AllocationMethod
}

/** The stage an entry is evaluated in. Derived from the entry, never user-chosen. */
export function evaluationStageOf(cost: Pick<AdditionalCost, 'kind' | 'category'>): CostEvaluationStage {
  if (cost.kind === 'DISCOUNT') {
    return 'DISCOUNT'
  }
  if (cost.kind === 'SURCHARGE') {
    return 'SURCHARGE'
  }
  return isFreightOrInsurance(cost.category) ? 'FREIGHT_INSURANCE' : 'OTHER_COST'
}

export function isFreightOrInsurance(category: CostCategory): boolean {
  return category === 'FREIGHT' || category === 'INSURANCE'
}

export function createAdditionalCost(input: CreateAdditionalCostInput): AdditionalCost {
  const cost: AdditionalCost = {
    id: typeof input.id === 'string' ? input.id.trim() : input.id,
    kind: input.kind,
    category: input.category,
    label: input.label,
    fixedAmount: input.fixedAmount,
    percentage: input.percentage,
    includeInComparison: input.includeInComparison ?? true,
    alreadyIncludedInQuote: input.alreadyIncludedInQuote ?? false,
    allocationMethod: input.allocationMethod ?? DEFAULT_ALLOCATION_METHOD,
  }
  assertValidAdditionalCost(cost)
  return cost
}

/**
 * Every invariant an `AdditionalCost` must satisfy, checked at runtime.
 *
 * This exists as a separate function because `createAdditionalCost` is not a
 * boundary the calculation engine can rely on: `AdditionalCost` is a plain
 * readonly interface, so an object literal (or a JSON payload, or a mutated
 * copy) that never went through the factory is structurally acceptable to
 * TypeScript and reaches `calculateSupplierCosts` unchecked. A negative
 * "cost" arriving that way used to drive the landed total below zero and
 * then crash ranking from inside a percentage calculation.
 *
 * The factory and the engine boundary therefore call **this** — the rules are
 * not duplicated in two places that could drift apart. Checks that inspect a
 * value's runtime type (rather than just its business meaning) are here for
 * the same reason: at this boundary the `AdditionalCost` type is a claim, not
 * a guarantee.
 */
export function assertValidAdditionalCost(cost: AdditionalCost): void {
  const value: unknown = cost
  if (value === null || typeof value !== 'object') {
    throw new InvalidCostDefinitionError(`A cost entry must be an object (got ${describeValue(value)})`)
  }
  const raw = value as Record<string, unknown>

  const rawId = raw['id']
  if (typeof rawId !== 'string' || rawId.trim() === '') {
    throw new InvalidCostDefinitionError('Cost id must not be empty')
  }
  const id = rawId

  const label = raw['label']
  if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
    throw new InvalidCostDefinitionError(`Cost "${id}" has an empty label; omit it instead`)
  }

  const kind = raw['kind']
  if (!isOneOf(kind, COST_KINDS)) {
    throw new InvalidCostDefinitionError(
      `Cost "${id}" has an unknown kind ${describeValue(kind)}; expected one of ${COST_KINDS.join(', ')}`,
    )
  }

  const category = raw['category']
  if (!isOneOf(category, COST_CATEGORIES)) {
    throw new InvalidCostDefinitionError(
      `Cost "${id}" has an unknown category ${describeValue(category)}; expected one of ${COST_CATEGORIES.join(', ')}`,
    )
  }

  const fixedAmount = raw['fixedAmount']
  const percentage = raw['percentage']
  const hasFixed = fixedAmount !== undefined
  const hasPercentage = percentage !== undefined
  if (hasFixed === hasPercentage) {
    throw new InvalidCostDefinitionError(
      `Cost "${id}" must define exactly one of a fixed amount or a percentage (got ${hasFixed ? 'both' : 'neither'})`,
    )
  }

  if (hasFixed) {
    if (!(fixedAmount instanceof Money)) {
      throw new InvalidCostDefinitionError(
        `Cost "${id}" has a fixed amount that is not a Money value (got ${describeValue(fixedAmount)})`,
      )
    }
    if (fixedAmount.isNegative()) {
      throw new InvalidCostAmountError(id, fixedAmount.toDecimalString())
    }
  }

  if (!isBoolean(raw['includeInComparison'])) {
    throw new InvalidCostDefinitionError(
      `Cost "${id}" must state includeInComparison as a boolean (got ${describeValue(raw['includeInComparison'])})`,
    )
  }
  if (!isBoolean(raw['alreadyIncludedInQuote'])) {
    throw new InvalidCostDefinitionError(
      `Cost "${id}" must state alreadyIncludedInQuote as a boolean (got ${describeValue(raw['alreadyIncludedInQuote'])})`,
    )
  }

  const allocationMethod = raw['allocationMethod']
  if (!isOneOf(allocationMethod, ALLOCATION_METHODS)) {
    throw new InvalidCostDefinitionError(
      `Cost "${id}" has an unknown allocation method ${describeValue(allocationMethod)}; expected one of ${ALLOCATION_METHODS.join(', ')}`,
    )
  }

  if (hasPercentage) {
    const basis: unknown = percentage
    const rate = isRecord(basis) ? basis['rate'] : undefined
    if (!(rate instanceof Percentage)) {
      throw new InvalidCostDefinitionError(
        `Cost "${id}" has a percentage without a valid rate (got ${describeValue(percentage)})`,
      )
    }
    const base = (basis as Record<string, unknown>)['base']
    if (!isOneOf(base, PERCENTAGE_BASES)) {
      throw new InvalidPercentageBaseError(
        `Cost "${id}" has an unknown percentage base ${describeValue(base)}; expected one of ${PERCENTAGE_BASES.join(', ')}`,
      )
    }
    assertPercentageIsUsable(id, kind, category, { rate, base })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value}"`
  }
  if (!isRecord(value)) {
    return String(value)
  }
  const constructor: unknown = value.constructor
  return typeof constructor === 'function' ? constructor.name : 'object'
}

function assertPercentageIsUsable(
  id: string,
  kind: CostKind,
  category: CostCategory,
  percentage: PercentageBasis,
): void {
  // A discount above 100% would drive the merchandise base negative, which is
  // meaningless. A cost or surcharge above 100% is unusual but real, so no
  // upper bound is imposed there.
  if (kind === 'DISCOUNT' && percentage.rate.exceedsOneHundred()) {
    throw new InvalidDiscountError(
      `Discount "${id}" is ${percentage.rate.toDecimalString()}%, which exceeds 100% and would make the discounted merchandise total negative`,
    )
  }

  const stage = evaluationStageOf({ kind, category })
  const allowed = ALLOWED_PERCENTAGE_BASES[stage]
  if (!allowed.includes(percentage.base)) {
    throw new InvalidPercentageBaseError(
      `Percentage base "${percentage.base}" is not available to "${id}" (${kind}/${category}, evaluated at stage ${stage}); that base is not resolved yet at this point, so using it would be circular. Available: ${allowed.join(', ')}.`,
    )
  }
}
