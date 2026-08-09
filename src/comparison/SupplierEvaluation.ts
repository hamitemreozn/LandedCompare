import { CurrencyMismatchError, Money } from '../domain/monetary/Money'
import { InvalidQuantityError } from '../domain/quantity/Quantity'
import type { RequirementItem } from '../domain/requirement/RequirementItem'
import type { Supplier } from '../domain/supplier/Supplier'
import type { Quote } from '../domain/quote/Quote'
import type { QuoteItem } from '../domain/quote/QuoteItem'
import {
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
  type SupplierCostAllocationResult,
  type SupplierCostCalculationResult,
} from '../calculation/CostCalculation'
import { calculateQuoteMerchandise, type MerchandiseLine } from '../calculation/MerchandiseCalculation'
import { MissingExchangeRateError, type ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { InvalidMoqError, InvalidPackSizeError, resolveOrderQuantity } from '../calculation/QuantityResolution'
import type { MinorUnitOverrides } from '../calculation/CurrencyMinorUnit'

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

export interface SupplierEvaluationResult {
  readonly supplierId: string
  readonly status: SupplierStatus
  readonly issues: readonly SupplierIssue[]
  readonly quoteId?: string
  /** Present whenever `status` is `INCOMPLETE`: the requirement ids the quote does not cover. */
  readonly missingRequirementIds?: readonly string[]
  /** Base-currency merchandise total. Present only when `status` is `COMPLETE`. */
  readonly merchandiseTotal?: Money
  /**
   * `merchandiseTotal` rounded to the project's base-currency minor unit,
   * using the same half-up settlement as `rankingAmount`. Exists purely so
   * the merchandise-vs-landed-cost insight compares like-for-like instead of
   * an unrounded exact decimal against a settled one.
   */
  readonly merchandiseRankingAmount?: Money
  /** Exact, unrounded landed total (Phase 4 output). Kept for audit/traceability. Present only when `status` is `COMPLETE`. */
  readonly exactCalculatedLandedTotal?: Money
  /** `exactCalculatedLandedTotal` rounded to the base-currency minor unit. This is what ranking, tie detection and display are based on. */
  readonly rankingAmount?: Money
  readonly costResult?: SupplierCostCalculationResult
  readonly costAllocation?: SupplierCostAllocationResult
}

/**
 * Expected user/domain calculation errors, mapped explicitly to an `INVALID`
 * supplier result. This list is deliberately closed and was audited call
 * site by call site against Phase 2–4's actual throw sites (Checkpoint 1
 * hardening review) — it is not a blanket "every domain error class"
 * catch-all. Two reachability categories are represented here on purpose:
 *
 * - **Live-reachable with valid, well-typed data**: `InvalidMoqError`,
 *   `InvalidPackSizeError` (bad MOQ/pack on one quote item),
 *   `MissingExchangeRateError` (a quote/cost currency with no configured
 *   rate), `InvalidDiscountError` (discounts exceeding the merchandise
 *   total, or a per-line allocated discount exceeding that line's value),
 *   `InvalidCostDefinitionError` (a duplicate cost id within one supplier's
 *   cost list), `InvalidAllocationBaseError` (a zero allocation weight —
 *   reachable via an all-zero-priced set of lines with a shared cost to
 *   allocate), `IncompatibleAllocationUnitsError` (`BY_QUANTITY` allocation
 *   across requirements with different `comparisonUnit`s).
 * - **Structurally guarded, kept as defense in depth**: `InvalidQuantityError`
 *   (`Quantity.subtract` inside `resolveOrderQuantity`'s excess-quantity
 *   calculation — provably never negative, since `resolvedQuantity` only
 *   ever grows relative to `requiredQuantity`), `CurrencyMismatchError`
 *   (`Money.add`/`Allocation`'s single-currency check — provably unreachable
 *   given `Quote`'s construction-time invariant that every item shares the
 *   quote's currency), and `InvalidPercentageBaseError` (a negative
 *   merchandise total, or a percentage base unresolved at its stage — both
 *   throw sites are real code this pipeline executes, but are now provably
 *   unreachable: `QuoteItem.quotedUnitPrice` is rejected as negative at
 *   construction, so a line subtotal — non-negative price times a
 *   non-negative `Quantity` — can never sum negative; the percentage-base
 *   check is guarded by `AdditionalCost`'s own construction-time stage
 *   validation). All three correspond to real call sites this pipeline
 *   executes; they are kept because, unlike an internal assertion, their
 *   *meaning* is "the data doesn't add up" — the safer classification if an
 *   upstream invariant were ever weakened by a future change. (Before the
 *   `QuoteItem` unit-price hardening, `InvalidPercentageBaseError`'s
 *   negative-merchandise-total branch *was* live-reachable — see
 *   docs/CALCULATION_RULES.md, "Error capture boundary", for that history.)
 *
 * Deliberately **excluded**, because neither has any call site at all inside
 * this pipeline (their throwing functions are never invoked here — the
 * objects that could trigger them always arrive already validated):
 * `InvalidPercentageError` (`Percentage.fromString` — never called; a
 * `Percentage` only ever arrives pre-built inside an `AdditionalCost`) and
 * `InvalidCostAmountError` (`createAdditionalCost` — never called; costs
 * arrive pre-built via `costsBySupplierId`, not reconstructed here).
 * Including either would misrepresent this list as covering code that
 * doesn't run.
 *
 * Also deliberately excluded: `InvalidMinorUnitError`. An unresolvable
 * base-currency minor unit is a **comparison-level** configuration problem
 * (every supplier shares one project base currency), not a single
 * supplier's fault — `SupplierComparison.ts` resolves it once, before any
 * supplier is evaluated, and lets it propagate out of `compareSuppliers`
 * rather than becoming a per-supplier `INVALID` result. Mapping it here
 * would let one supplier's data ambiguously mask a comparison-wide
 * configuration gap.
 *
 * And, as always: `AllocationInvariantError` — Phase 4's own internal
 * engine-correctness assertion — or any other unexpected exception is left
 * to propagate rather than being relabelled as "bad supplier data". See
 * docs/CALCULATION_RULES.md, "Error capture boundary".
 */
const EXPECTED_CALCULATION_ERRORS = [
  InvalidMoqError,
  InvalidPackSizeError,
  InvalidQuantityError,
  MissingExchangeRateError,
  CurrencyMismatchError,
  InvalidPercentageBaseError,
  InvalidDiscountError,
  InvalidCostDefinitionError,
  InvalidAllocationBaseError,
  IncompatibleAllocationUnitsError,
] as const

export interface EvaluateSupplierInput {
  readonly supplier: Supplier
  /** 0 or 1 quote — comparison-level structural validation guarantees at most one. */
  readonly quotesForSupplier: readonly Quote[]
  /** Project requirements, in project order. Drives deterministic line/missing-id ordering. */
  readonly requirements: readonly RequirementItem[]
  readonly costs: readonly AdditionalCost[]
  readonly exchangeRateTable: ExchangeRateTable
  readonly minorUnit: number
  readonly minorUnitOverrides?: MinorUnitOverrides
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
  const { supplier, quotesForSupplier, requirements, costs, exchangeRateTable, minorUnit, minorUnitOverrides } =
    input

  const quote = quotesForSupplier[0]
  if (quote === undefined) {
    return {
      supplierId: supplier.id,
      status: 'INCOMPLETE',
      issues: [{ code: 'MISSING_QUOTE', message: `No quote exists for supplier "${supplier.id}"` }],
      missingRequirementIds: requirements.map((requirement) => requirement.id),
    }
  }

  const structuralIssues = findQuoteStructuralIssues(quote, requirements)
  if (structuralIssues.length > 0) {
    return { supplierId: supplier.id, status: 'INVALID', issues: structuralIssues, quoteId: quote.id }
  }

  if (quote.items.length === 0) {
    return {
      supplierId: supplier.id,
      status: 'INCOMPLETE',
      issues: [{ code: 'EMPTY_QUOTE', message: `Quote "${quote.id}" has no items` }],
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
      minorUnitOverrides,
    })
  } catch (error) {
    if (isExpectedCalculationError(error)) {
      return {
        supplierId: supplier.id,
        status: 'INVALID',
        issues: [{ code: 'CALCULATION_ERROR', message: `${error.name}: ${error.message}` }],
        quoteId: quote.id,
      }
    }
    throw error
  }
}

function isExpectedCalculationError(error: unknown): error is Error {
  return EXPECTED_CALCULATION_ERRORS.some((errorConstructor) => error instanceof errorConstructor)
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
  minorUnitOverrides?: MinorUnitOverrides
}): SupplierEvaluationResult {
  const { supplier, quote, requirements, itemsByRequirementId, costs, exchangeRateTable, minorUnit, minorUnitOverrides } =
    params

  const resolutions = requirements.map((requirement) => {
    const item = requireItem(itemsByRequirementId, requirement.id, quote.id)
    return resolveOrderQuantity({
      requiredQuantity: requirement.requiredQuantity,
      moq: item.moq,
      unitsPerQuotedUnit: item.unitsPerQuotedUnit,
    })
  })

  const lines: MerchandiseLine[] = requirements.map((requirement, index) => ({
    unitPrice: requireItem(itemsByRequirementId, requirement.id, quote.id).quotedUnitPrice,
    calculationQuantity: resolutions[index]!.quotedUnitQuantity,
  }))

  const merchandise = calculateQuoteMerchandise(lines, quote.currency, exchangeRateTable)

  const costResult = calculateSupplierCosts({
    merchandiseTotal: merchandise.baseCurrencyMerchandiseTotal,
    costs,
    exchangeRateTable,
  })

  const targets: AllocationTarget[] = requirements.map((requirement, index) => ({
    id: requirement.id,
    merchandiseValue: merchandise.lineSubtotals[index]!,
    quantity: resolutions[index]!.resolvedQuantity,
    comparisonUnit: requirement.comparisonUnit,
  }))

  const costAllocation = allocateSupplierCosts({
    costResult,
    targets,
    exchangeRateTable,
    minorUnitOverrides,
  })

  const exactCalculatedLandedTotal = costResult.calculatedLandedTotal
  const rankingAmount = exactCalculatedLandedTotal.roundToMinorUnit(minorUnit)
  const merchandiseRankingAmount = merchandise.baseCurrencyMerchandiseTotal.roundToMinorUnit(minorUnit)

  return {
    supplierId: supplier.id,
    status: 'COMPLETE',
    issues: [],
    quoteId: quote.id,
    merchandiseTotal: merchandise.baseCurrencyMerchandiseTotal,
    merchandiseRankingAmount,
    exactCalculatedLandedTotal,
    rankingAmount,
    costResult,
    costAllocation,
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
