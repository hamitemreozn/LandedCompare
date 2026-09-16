import { CurrencyMismatchError, Money } from '../domain/monetary/Money'
import { InvalidQuantityError, type Quantity } from '../domain/quantity/Quantity'
import type { RequirementItem } from '../domain/requirement/RequirementItem'
import type { Supplier } from '../domain/supplier/Supplier'
import type { Quote } from '../domain/quote/Quote'
import type { QuoteItem } from '../domain/quote/QuoteItem'
import {
  InvalidCostAmountError,
  InvalidCostDefinitionError,
  InvalidDiscountError,
  InvalidPercentageBaseError,
  type AdditionalCost,
} from '../calculation/AdditionalCost'
import {
  IncompatibleAllocationUnitsError,
  InvalidAllocationBaseError,
  type AllocationTarget,
} from '../calculation/Allocation'
import {
  allocateSupplierCosts,
  calculateSupplierCosts,
  DiscountAllocationValidationError,
  SettlementReconciliationError,
  settleLineMerchandise,
  validateDiscountLineAllocations,
  type SupplierCostAllocationResult,
  type SupplierCostCalculationResult,
} from '../calculation/CostCalculation'
import { calculateQuoteMerchandise, type MerchandiseLine } from '../calculation/MerchandiseCalculation'
import { MissingExchangeRateError, type ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { InvalidMoqError, InvalidPackSizeError, resolveOrderQuantity } from '../calculation/QuantityResolution'
import { PrecisionEnvelopeExceededError } from '../calculation/CurrencyMinorUnit'

/**
 * Only `COMPLETE` suppliers participate in ranking. `INCOMPLETE` and
 * `INVALID` are both excluded from ranking, but for different reasons — see
 * docs/CALCULATION_RULES.md, "Supplier status model".
 */
export type SupplierStatus = 'COMPLETE' | 'INCOMPLETE' | 'INVALID'

export type SupplierIssueCode =
  | 'MISSING_QUOTE'
  | 'EMPTY_QUOTE'
  | 'MISSING_REQUIRED_ITEMS'
  | 'DUPLICATE_QUOTE_ITEM'
  | 'UNKNOWN_REQUIREMENT_REFERENCE'
  | 'CALCULATION_ERROR'

export interface SupplierIssue {
  readonly code: SupplierIssueCode
  readonly message: string
}

/**
 * Why a per-line allocation could not be produced. Both are properties of the
 * *weighting*, not of the landed total — see `SupplierWarning`.
 */
export type AllocationUnavailableReason =
  | 'INVALID_ALLOCATION_BASE'
  | 'INCOMPATIBLE_ALLOCATION_UNITS'

export type SupplierWarningCode = 'ALLOCATION_UNAVAILABLE'

/**
 * Something the user should know about a supplier whose landed total is still
 * trustworthy. Deliberately a separate list from `issues`: an issue explains
 * why a supplier could not be compared, a warning travels *with* a supplier
 * that is being compared, and a consumer that renders "this quote is invalid
 * because…" must not be able to pick one up by mistake.
 */
export interface SupplierWarning {
  readonly code: SupplierWarningCode
  readonly reason: AllocationUnavailableReason
  readonly message: string
}

/**
 * One requirement's full trace through the pipeline, so a results view can
 * explain *why* a line costs what it costs — "you asked for 105, the MOQ
 * forced 200" — without recomputing anything.
 *
 * Every field is derived output. None of it is a persisted source of truth,
 * and nothing here is recalculated: the quantities come straight from
 * Phase 3's resolution and the values from Phase 2's line subtotals.
 */
export interface SupplierLineResult {
  readonly requirementId: string
  readonly quoteItemId: string
  /** The unit the requirement is expressed in (`requiredQuantity`, `resolvedQuantity`). */
  readonly comparisonUnit: string
  /** The unit the supplier prices in. Differs from `comparisonUnit` when a pack applies. */
  readonly quotedUnit: string
  readonly requiredQuantity: Quantity
  /** What will actually be purchased, after MOQ and whole-pack rounding. */
  readonly resolvedQuantity: Quantity
  /** How many quoted units (e.g. boxes) that is — the quantity the price multiplies. */
  readonly quotedUnitQuantity: Quantity
  /** `resolvedQuantity - requiredQuantity`. Non-negative. */
  readonly excessQuantity: Quantity
  readonly moq?: Quantity
  /** True only if a MOQ existed and raised the effective minimum above what was required. */
  readonly moqApplied: boolean
  readonly unitsPerQuotedUnit?: Quantity
  readonly packApplied: boolean
  readonly quotedUnitPrice: Money
  /** `quotedUnitPrice × quotedUnitQuantity`, exact, in the quote's currency. */
  readonly exactMerchandiseValue: Money
  /** The same value in the base currency, at the quote's single conversion rate. */
  readonly exactBaseCurrencyMerchandiseValue: Money
  /**
   * The line's share of `settledMerchandiseTotal`. These sum to exactly that
   * total — the same largest-remainder settlement allocation uses, so the
   * displayed per-line merchandise figures always add up to the displayed
   * merchandise total.
   */
  readonly settledMerchandiseValue: Money
  /** Signed total of every cost allocated to this line. Absent when allocation was unavailable. */
  readonly allocatedCostTotal?: Money
  /**
   * `settledMerchandiseValue + allocatedCostTotal`. Absent when allocation was
   * unavailable. When present for every line, these sum to exactly
   * `rankingAmount`.
   */
  readonly settledLandedValue?: Money
}

export interface SupplierEvaluationResult {
  readonly supplierId: string
  readonly status: SupplierStatus
  readonly issues: readonly SupplierIssue[]
  /** Non-blocking. A `COMPLETE` supplier may carry warnings and still be ranked. */
  readonly warnings: readonly SupplierWarning[]
  readonly quoteId?: string
  /** Present whenever `status` is `INCOMPLETE`: the requirement ids the quote does not cover. */
  readonly missingRequirementIds?: readonly string[]
  /** Exact, unrounded base-currency merchandise total. Present only when `status` is `COMPLETE`. */
  readonly merchandiseTotal?: Money
  /**
   * `merchandiseTotal` settled to the project's base-currency minor unit —
   * `costResult.settledMerchandiseTotal`. It is both the merchandise figure
   * the user is shown and the one the merchandise-vs-landed-cost insight
   * compares, so that insight never measures an exact decimal against a
   * settled one.
   */
  readonly merchandiseRankingAmount?: Money
  /** Exact, unrounded landed total (Phase 4 output). Kept for audit/traceability. Present only when `status` is `COMPLETE`. */
  readonly exactCalculatedLandedTotal?: Money
  /**
   * The authoritative commercial total — `costResult.settledLandedTotal`,
   * i.e. `exactCalculatedLandedTotal` rounded once to the base currency's
   * minor unit. Ranking, tie detection, the displayed total, the displayed
   * difference and the per-line breakdown are all this one number, and the
   * displayed components are reconciled to it rather than summed into it.
   * See docs/CALCULATION_RULES.md, "Authoritative commercial total".
   */
  readonly rankingAmount?: Money
  readonly costResult?: SupplierCostCalculationResult
  /** Absent when the weighting was unusable — see `warnings`. Never a reason to distrust the total. */
  readonly costAllocation?: SupplierCostAllocationResult
  /** Per-requirement trace. Present only when `status` is `COMPLETE`. */
  readonly lines?: readonly SupplierLineResult[]
}

/**
 * Re-exported where the settlement it guards is defined. The per-line
 * reconciliation asserted at the bottom of this file and the supplier-level
 * one asserted in `CostCalculation.ts` are the same guarantee seen from two
 * heights, so they raise the same error.
 */
export { SettlementReconciliationError }

/**
 * Expected user/domain calculation errors, mapped explicitly to an `INVALID`
 * supplier result. The list is deliberately closed — not a blanket "every
 * domain error class" catch-all — and every entry corresponds to a throw site
 * this pipeline actually executes:
 *
 * - `InvalidMoqError`, `InvalidPackSizeError` — a bad MOQ or pack size on one
 *   quote item.
 * - `MissingExchangeRateError` — a quote or cost currency with no configured
 *   rate.
 * - `InvalidDiscountError` — discounts exceeding the merchandise total (for
 *   the comparison total or for the percentage bases), or a per-line
 *   allocated discount exceeding that line's own merchandise value.
 * - `DiscountAllocationValidationError` — a non-zero discount whose own
 *   weighting cannot be established, so the per-line rule above cannot be
 *   evaluated for it. An unprovable financial check is not a passed one. Note
 *   this is the *same underlying weighting failure* that becomes a warning
 *   further down the list; what differs is that it is a discount's, and a
 *   discount's per-line effect is a matter of validity rather than of
 *   presentation. It is raised only by `validateDiscountLineAllocations`,
 *   which runs before — and outside — the explanatory allocation's `try`.
 * - `InvalidCostDefinitionError`, `InvalidCostAmountError` — a cost that does
 *   not satisfy `assertValidAdditionalCost`: a duplicate id, a malformed or
 *   negative amount, both a fixed amount and a percentage, an unknown kind /
 *   category / allocation method. These are reachable because
 *   `AdditionalCost` is a plain interface: costs arrive here as data, and the
 *   engine validates them rather than trusting that they met the factory.
 * - `InvalidPercentageBaseError` — an unknown percentage base, or one not
 *   resolved at its stage.
 * - `PrecisionEnvelopeExceededError` — this supplier's own amounts are too
 *   large to settle exactly at the base currency's minor unit. It is that
 *   supplier's monetary input that is out of range, so it invalidates that
 *   supplier; it is explicitly *not* an internal-arithmetic failure.
 * - `InvalidQuantityError`, `CurrencyMismatchError` — kept as defense in
 *   depth. Both correspond to real call sites here (the excess-quantity
 *   subtraction; the single-currency checks in `Money`/`Allocation`), and
 *   both are currently guarded upstream: `resolveOrderQuantity` asserts its
 *   own post-condition before subtracting, and `Quote` guarantees at
 *   construction that its items share its currency. They stay on the list
 *   because their *meaning* is "the data doesn't add up", which is the safer
 *   classification if one of those upstream guarantees is ever weakened —
 *   not because they are claimed to be unreachable today.
 *
 * **Not on the list, on purpose:**
 *
 * - `InvalidAllocationBaseError` and `IncompatibleAllocationUnitsError`.
 *   These say a per-line *explanation* cannot be produced (no defensible
 *   weighting), not that the landed total is wrong. They are caught in a
 *   narrow `try` around the allocation call itself and become a non-blocking
 *   `ALLOCATION_UNAVAILABLE` warning on a supplier that stays `COMPLETE`.
 *   Treating them as invalid data is what previously dropped a genuinely
 *   cheaper supplier out of the ranking entirely. They can only reach that
 *   `try` from the explanatory pass: raised while validating a non-zero
 *   discount, they are translated into the
 *   `DiscountAllocationValidationError` above before the pass is even
 *   reached.
 * - `InvalidPercentageError`. `Percentage.fromString` is not called anywhere
 *   in this pipeline — a `Percentage` only ever arrives pre-built inside an
 *   `AdditionalCost`. (It *is* called in `Ranking.ts`, outside this
 *   boundary; ranking guards its own inputs rather than relying on this
 *   list.)
 * - `InvalidMinorUnitError`. An unresolvable base-currency minor unit is a
 *   comparison-wide configuration problem — every supplier shares one project
 *   base currency — so `SupplierComparison.ts` resolves it once, before any
 *   supplier is evaluated, and lets it propagate out of the whole comparison.
 *   Mapping it here would let one supplier's data mask a project-level gap.
 * - Internal assertions — `AllocationInvariantError`,
 *   `QuantityResolutionInvariantError`, `SettlementReconciliationError` — and
 *   anything else unexpected. An engine-correctness bug must never be
 *   relabelled as "this supplier's data is invalid". See
 *   docs/CALCULATION_RULES.md, "Error capture boundary".
 */
const EXPECTED_CALCULATION_ERRORS = [
  InvalidMoqError,
  InvalidPackSizeError,
  InvalidQuantityError,
  MissingExchangeRateError,
  CurrencyMismatchError,
  InvalidPercentageBaseError,
  InvalidDiscountError,
  DiscountAllocationValidationError,
  InvalidCostDefinitionError,
  InvalidCostAmountError,
  PrecisionEnvelopeExceededError,
] as const

export interface EvaluateSupplierInput {
  readonly supplier: Supplier
  /** 0 or 1 quote — comparison-level structural validation guarantees at most one. */
  readonly quotesForSupplier: readonly Quote[]
  /** Project requirements, in project order. Drives deterministic line/missing-id ordering. */
  readonly requirements: readonly RequirementItem[]
  readonly costs: readonly AdditionalCost[]
  readonly exchangeRateTable: ExchangeRateTable
  /**
   * The base currency's minor-unit scale, resolved once at the comparison
   * level. Every settlement in this pipeline — the commercial total, the
   * allocation, the per-line merchandise split — uses this one value, so
   * they cannot disagree.
   */
  readonly minorUnit: number
}

/**
 * Evaluates one supplier's completeness and, if complete enough, runs it
 * through the existing Phase 2–4 engines (quantity resolution, merchandise,
 * cost calculation, allocation) to produce a calculated landed total.
 *
 * This function does not rank suppliers against each other — see
 * `Ranking.ts`. It only decides, for one supplier in isolation, whether a
 * landed total can be trusted at all.
 */
export function evaluateSupplier(input: EvaluateSupplierInput): SupplierEvaluationResult {
  const { supplier, quotesForSupplier, requirements, costs, exchangeRateTable, minorUnit } = input

  const quote = quotesForSupplier[0]
  if (quote === undefined) {
    return {
      supplierId: supplier.id,
      status: 'INCOMPLETE',
      issues: [{ code: 'MISSING_QUOTE', message: `No quote exists for supplier "${supplier.id}"` }],
      warnings: [],
      missingRequirementIds: requirements.map((requirement) => requirement.id),
    }
  }

  const structuralIssues = findQuoteStructuralIssues(quote, requirements)
  if (structuralIssues.length > 0) {
    return {
      supplierId: supplier.id,
      status: 'INVALID',
      issues: structuralIssues,
      warnings: [],
      quoteId: quote.id,
    }
  }

  if (quote.items.length === 0) {
    return {
      supplierId: supplier.id,
      status: 'INCOMPLETE',
      issues: [{ code: 'EMPTY_QUOTE', message: `Quote "${quote.id}" has no items` }],
      warnings: [],
      quoteId: quote.id,
      missingRequirementIds: requirements.map((requirement) => requirement.id),
    }
  }

  const itemsByRequirementId = new Map(quote.items.map((item) => [item.requirementId, item]))
  const missingRequirementIds = requirements
    .filter((requirement) => !itemsByRequirementId.has(requirement.id))
    .map((requirement) => requirement.id)

  if (missingRequirementIds.length > 0) {
    return {
      supplierId: supplier.id,
      status: 'INCOMPLETE',
      issues: [
        {
          code: 'MISSING_REQUIRED_ITEMS',
          message: `Quote "${quote.id}" is missing item(s) for requirement(s): ${missingRequirementIds.join(', ')}`,
        },
      ],
      warnings: [],
      quoteId: quote.id,
      missingRequirementIds,
    }
  }

  try {
    return runCalculationPipeline({
      supplier,
      quote,
      requirements,
      itemsByRequirementId,
      costs,
      exchangeRateTable,
      minorUnit,
    })
  } catch (error) {
    if (isExpectedCalculationError(error)) {
      return {
        supplierId: supplier.id,
        status: 'INVALID',
        issues: [{ code: 'CALCULATION_ERROR', message: `${error.name}: ${error.message}` }],
        warnings: [],
        quoteId: quote.id,
      }
    }
    throw error
  }
}

function isExpectedCalculationError(error: unknown): error is Error {
  return EXPECTED_CALCULATION_ERRORS.some((errorConstructor) => error instanceof errorConstructor)
}

/**
 * Maps the two "the weighting is unusable" errors onto a warning reason.
 * Anything else — including a discount that does not fit a line, or an
 * internal allocator assertion — is not an allocation-availability problem
 * and must keep its own meaning, so it returns `undefined` and is rethrown.
 *
 * Only the *explanatory* pass is read through this function. A discount whose
 * weighting could not be established never gets here: it has already been
 * rejected as a `DiscountAllocationValidationError` by the validation pass.
 */
function allocationUnavailableReasonOf(error: unknown): AllocationUnavailableReason | undefined {
  if (error instanceof InvalidAllocationBaseError) {
    return 'INVALID_ALLOCATION_BASE'
  }
  if (error instanceof IncompatibleAllocationUnitsError) {
    return 'INCOMPATIBLE_ALLOCATION_UNITS'
  }
  return undefined
}

/** Duplicate and unknown-requirement quote items — malformed data, not missing data. Both are `INVALID`. */
function findQuoteStructuralIssues(
  quote: Quote,
  requirements: readonly RequirementItem[],
): SupplierIssue[] {
  const issues: SupplierIssue[] = []
  const knownRequirementIds = new Set(requirements.map((requirement) => requirement.id))

  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const item of quote.items) {
    if (seen.has(item.requirementId)) {
      duplicated.add(item.requirementId)
    }
    seen.add(item.requirementId)
  }
  if (duplicated.size > 0) {
    issues.push({
      code: 'DUPLICATE_QUOTE_ITEM',
      message: `Quote "${quote.id}" has more than one item for requirement(s): ${[...duplicated].join(', ')}`,
    })
  }

  const uniqueUnknown = [
    ...new Set(
      quote.items
        .map((item) => item.requirementId)
        .filter((requirementId) => !knownRequirementIds.has(requirementId)),
    ),
  ]
  if (uniqueUnknown.length > 0) {
    issues.push({
      code: 'UNKNOWN_REQUIREMENT_REFERENCE',
      message: `Quote "${quote.id}" prices requirement(s) not in the project: ${uniqueUnknown.join(', ')}`,
    })
  }

  return issues
}

function runCalculationPipeline(params: {
  supplier: Supplier
  quote: Quote
  requirements: readonly RequirementItem[]
  itemsByRequirementId: ReadonlyMap<string, QuoteItem>
  costs: readonly AdditionalCost[]
  exchangeRateTable: ExchangeRateTable
  minorUnit: number
}): SupplierEvaluationResult {
  const { supplier, quote, requirements, itemsByRequirementId, costs, exchangeRateTable, minorUnit } =
    params

  const items = requirements.map((requirement) =>
    requireItem(itemsByRequirementId, requirement.id, quote.id),
  )

  const resolutions = requirements.map((requirement, index) =>
    resolveOrderQuantity({
      requiredQuantity: requirement.requiredQuantity,
      moq: items[index]!.moq,
      unitsPerQuotedUnit: items[index]!.unitsPerQuotedUnit,
    }),
  )

  const lines: MerchandiseLine[] = requirements.map((_, index) => ({
    unitPrice: items[index]!.quotedUnitPrice,
    calculationQuantity: resolutions[index]!.quotedUnitQuantity,
  }))

  const merchandise = calculateQuoteMerchandise(lines, quote.currency, exchangeRateTable)

  const costResult = calculateSupplierCosts({
    merchandiseTotal: merchandise.baseCurrencyMerchandiseTotal,
    costs,
    exchangeRateTable,
    minorUnit,
  })

  const targets: AllocationTarget[] = requirements.map((requirement, index) => ({
    id: requirement.id,
    merchandiseValue: merchandise.lineSubtotals[index]!,
    quantity: resolutions[index]!.resolvedQuantity,
    comparisonUnit: requirement.comparisonUnit,
  }))

  // Allocation does two unrelated jobs, and they are run in two passes
  // because only one of them is allowed to fail quietly.
  //
  // First, the financially binding one: a discount must not take more off a
  // line than that line is worth. It is mandatory, it runs *outside* the
  // warning-producing `try` below, and it runs before the explanatory pass so
  // that no other cost's weighting problem can pre-empt it. When both passes
  // shared one call, an incompatible freight allocation threw first and this
  // check was skipped — a supplier whose discount overdrew a line came out
  // `COMPLETE` with a warning, purely because of which cost failed first.
  validateDiscountLineAllocations({ costResult, targets, exchangeRateTable })

  // Then the explanatory one. It explains the total; it does not decide
  // whether the total is right. An unusable weighting (mixed comparison
  // units, an all-zero base) therefore costs the supplier its per-line
  // breakdown, not its place in the ranking. The `try` stays deliberately
  // narrow — a discount that does not fit a line, or an internal allocator
  // assertion, must keep its own meaning.
  const warnings: SupplierWarning[] = []
  let costAllocation: SupplierCostAllocationResult | undefined
  try {
    costAllocation = allocateSupplierCosts({ costResult, targets, exchangeRateTable })
  } catch (error) {
    const reason = allocationUnavailableReasonOf(error)
    if (reason === undefined) {
      throw error
    }
    costAllocation = undefined
    warnings.push({
      code: 'ALLOCATION_UNAVAILABLE',
      reason,
      message: (error as Error).message,
    })
  }

  const lineResults = buildLineResults({
    requirements,
    items,
    resolutions,
    targets,
    settledMerchandiseTotal: costResult.settledMerchandiseTotal,
    costAllocation,
    exchangeRateTable,
    minorUnit,
  })

  assertLinesReconcileToTotal(supplier.id, lineResults, costResult.settledLandedTotal)
  assertNoLineSettlesNegative(supplier.id, lineResults)

  return {
    supplierId: supplier.id,
    status: 'COMPLETE',
    issues: [],
    warnings,
    quoteId: quote.id,
    merchandiseTotal: costResult.merchandiseTotal,
    merchandiseRankingAmount: costResult.settledMerchandiseTotal,
    exactCalculatedLandedTotal: costResult.calculatedLandedTotal,
    rankingAmount: costResult.settledLandedTotal,
    costResult,
    costAllocation,
    lines: lineResults,
  }
}

/**
 * Assembles the per-line trace from what the pipeline already produced —
 * Phase 3's quantity resolutions and Phase 2's line subtotals. Nothing is
 * recalculated here.
 *
 * The one derived value is the per-line *settled* merchandise figure, and it
 * is not computed here: `settleLineMerchandise` owns it, because the
 * allocator needs exactly the same number as each line's discount capacity.
 * If the two were computed separately they could drift, and a line could be
 * shown a capacity it does not have.
 */
function buildLineResults(params: {
  requirements: readonly RequirementItem[]
  items: readonly QuoteItem[]
  resolutions: readonly ReturnType<typeof resolveOrderQuantity>[]
  targets: readonly AllocationTarget[]
  settledMerchandiseTotal: Money
  costAllocation?: SupplierCostAllocationResult
  exchangeRateTable: ExchangeRateTable
  minorUnit: number
}): readonly SupplierLineResult[] {
  const {
    requirements,
    items,
    resolutions,
    targets,
    settledMerchandiseTotal,
    costAllocation,
    exchangeRateTable,
    minorUnit,
  } = params

  const { baseCurrencyValues, settledValues: settledLineValues } = settleLineMerchandise(
    targets,
    settledMerchandiseTotal,
    exchangeRateTable,
    minorUnit,
  )
  const allocatedByTargetId = new Map(
    (costAllocation?.byLine ?? []).map((line) => [line.targetId, line.allocatedCostTotal]),
  )

  return requirements.map((requirement, index) => {
    const item = items[index]!
    const resolution = resolutions[index]!
    const settledMerchandiseValue = settledLineValues[index]!
    const allocatedCostTotal = allocatedByTargetId.get(requirement.id)

    return {
      requirementId: requirement.id,
      quoteItemId: item.id,
      comparisonUnit: requirement.comparisonUnit,
      quotedUnit: item.quotedUnit,
      requiredQuantity: resolution.requiredQuantity,
      resolvedQuantity: resolution.resolvedQuantity,
      quotedUnitQuantity: resolution.quotedUnitQuantity,
      excessQuantity: resolution.excessQuantity,
      moq: resolution.moq,
      moqApplied: resolution.moqApplied,
      unitsPerQuotedUnit: resolution.unitsPerQuotedUnit,
      packApplied: resolution.packApplied,
      quotedUnitPrice: item.quotedUnitPrice,
      exactMerchandiseValue: targets[index]!.merchandiseValue,
      exactBaseCurrencyMerchandiseValue: baseCurrencyValues[index]!,
      settledMerchandiseValue,
      allocatedCostTotal,
      settledLandedValue:
        allocatedCostTotal === undefined
          ? undefined
          : settledMerchandiseValue.add(allocatedCostTotal),
    }
  })
}

/**
 * The guarantee this whole settlement model exists for: what the user adds up
 * from the lines equals the total shown in the header. Checked, not assumed,
 * because a silent one-minor-unit gap is exactly the failure mode that is
 * impossible to notice and impossible to defend.
 *
 * Only meaningful when allocation succeeded — without it there are no
 * per-line cost shares to reconcile, and the supplier-level breakdown
 * (`settledMerchandiseTotal + Σ settledEffect`) is the reconciling view.
 */
function assertLinesReconcileToTotal(
  supplierId: string,
  lines: readonly SupplierLineResult[],
  settledLandedTotal: Money,
): void {
  const perLineValues = lines.map((line) => line.settledLandedValue)
  if (perLineValues.some((value) => value === undefined)) {
    return
  }
  const total = perLineValues.reduce<Money>(
    (sum, value) => sum.add(value!),
    Money.zero(settledLandedTotal.currency),
  )
  if (!total.equals(settledLandedTotal)) {
    throw new SettlementReconciliationError(
      `Supplier "${supplierId}": per-line landed values sum to ${total.toDecimalString()} ${total.currency}, but the settled landed total is ${settledLandedTotal.toDecimalString()} ${settledLandedTotal.currency}`,
    )
  }
}

/**
 * The other half of the per-line guarantee: the lines add up to the total
 * *and* none of them is negative.
 *
 * A line's exact landed value can never be below zero — a discount is refused
 * outright if it takes more off a line than that line is worth — so a
 * negative *settled* line could only ever come from cent distribution, and it
 * is exactly the presentation failure `allocateSupplierCosts` settles
 * discounts against per-line capacity to prevent. Asserted here rather than
 * assumed, because this is the height the two settlements meet at: the line's
 * merchandise share and the costs allocated to it are decided in different
 * functions, and a `-0.01` on a valid product line is the kind of number a
 * user is entitled to never see.
 *
 * Deliberately not a clamp. Raising the displayed value to zero would create
 * a minor unit out of nothing and break the reconciliation asserted above.
 */
function assertNoLineSettlesNegative(
  supplierId: string,
  lines: readonly SupplierLineResult[],
): void {
  for (const line of lines) {
    const landed = line.settledLandedValue
    if (landed !== undefined && landed.isNegative()) {
      throw new SettlementReconciliationError(
        `Supplier "${supplierId}": line "${line.requirementId}" settled to ${landed.toDecimalString()} ${landed.currency}. Its exact landed value is not negative, so cent distribution put it there; the remainder belongs on a line with the capacity to absorb it`,
      )
    }
  }
}

/**
 * The caller has already proven every requirement has a matching quote item
 * (the `MISSING_REQUIRED_ITEMS` check above). If this ever fires, it means
 * that invariant broke — an engine bug, not a supplier data problem, so it
 * is a plain `Error` left to propagate rather than an `INVALID` result.
 */
function requireItem(
  itemsByRequirementId: ReadonlyMap<string, QuoteItem>,
  requirementId: string,
  quoteId: string,
): QuoteItem {
  const item = itemsByRequirementId.get(requirementId)
  if (item === undefined) {
    throw new Error(
      `Internal error: quote "${quoteId}" has no item for requirement "${requirementId}" after completeness was confirmed`,
    )
  }
  return item
}
