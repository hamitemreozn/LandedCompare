import type { CurrencyCode } from '../domain/monetary/CurrencyCode'
import type { Money } from '../domain/monetary/Money'
import type { Project } from '../domain/project/Project'
import type { Quote } from '../domain/quote/Quote'
import type { AdditionalCost } from '../calculation/AdditionalCost'
import { resolveMinorUnit, type MinorUnitOverrides } from '../calculation/CurrencyMinorUnit'
import type { ExchangeRateTable } from '../calculation/ExchangeRateTable'
import type { Percentage } from '../calculation/Percentage'
import { validateComparisonStructure } from './ComparisonStructuralValidation'
import { buildComparisonInsights, type ComparisonInsight } from './ComparisonInsights'
import { rankCompleteSuppliers, type RankedSupplier } from './Ranking'
import { evaluateSupplier, type SupplierEvaluationResult } from './SupplierEvaluation'

export interface SupplierComparisonInput {
  readonly project: Project
  readonly exchangeRateTable: ExchangeRateTable
  /**
   * Additional costs for a supplier's quote. A supplier with no entry is
   * treated as `[]` — not copied from any project-level default, and never
   * read off the prototype chain (see `costsForSupplier`). A present entry
   * that is not an array is a malformed input container and blocks the
   * comparison.
   */
  readonly costsBySupplierId?: Readonly<Record<string, readonly AdditionalCost[]>>
  readonly minorUnitOverrides?: MinorUnitOverrides
}

/** One supplier's evaluation, enriched with its ranking position when `COMPLETE` and part of the ranked set. */
export interface SupplierComparisonEntry extends SupplierEvaluationResult {
  readonly rank?: number
  readonly differenceFromLowest?: Money
  /** Two decimal places, half-up — the figure to show. */
  readonly percentageDifferenceFromLowest?: Percentage
  /** The same ratio unrounded, for audit only. */
  readonly exactPercentageDifferenceFromLowest?: Percentage
}

export interface SupplierComparisonResult {
  readonly baseCurrency: CurrencyCode
  readonly minorUnit: number
  /** Every supplier, in the project's original input order. */
  readonly supplierResults: readonly SupplierComparisonEntry[]
  /** Only `COMPLETE` suppliers, sorted ascending by `rankingAmount`, dense-ranked. */
  readonly rankedCompleteSuppliers: readonly RankedSupplier[]
  /** Every supplier sharing dense rank 1. Never used to imply a single "best supplier". */
  readonly lowestSupplierIds: readonly string[]
  readonly insights: readonly ComparisonInsight[]
}

/**
 * Compares a project's suppliers on calculated landed cost. This is an
 * orchestrator: it composes the existing Phase 2–4 engines per supplier
 * (`SupplierEvaluation.ts`), then ranks the `COMPLETE` ones
 * (`Ranking.ts`) and derives deterministic insights (`ComparisonInsights.ts`).
 * No arithmetic is reimplemented here.
 *
 * Throws `InvalidComparisonInputError` for project-wide structural problems
 * (empty requirements, duplicate ids, zero required quantity, an orphaned or
 * duplicated quote, a base-currency mismatch, a malformed per-supplier cost
 * list) that make the comparison itself meaningless. Internal assertions
 * (`AllocationInvariantError`, `SettlementReconciliationError`,
 * `RankingInvariantError`, `QuantityResolutionInvariantError`) and anything
 * else unexpected also propagate — see docs/CALCULATION_RULES.md, "Error
 * capture boundary".
 */
export function compareSuppliers(input: SupplierComparisonInput): SupplierComparisonResult {
  const { project, exchangeRateTable, costsBySupplierId, minorUnitOverrides } = input

  validateComparisonStructure(project, exchangeRateTable, costsBySupplierId)
  const minorUnit = resolveMinorUnit(project.baseCurrency, minorUnitOverrides)

  const quotesBySupplierId = groupQuotesBySupplierId(project.quotes)

  const evaluationList = project.suppliers.map((supplier) =>
    evaluateSupplier({
      supplier,
      quotesForSupplier: quotesBySupplierId.get(supplier.id) ?? [],
      requirements: project.requirements,
      costs: costsForSupplier(costsBySupplierId, supplier.id),
      exchangeRateTable,
      minorUnit,
    }),
  )
  const evaluations = new Map(evaluationList.map((evaluation) => [evaluation.supplierId, evaluation]))

  const completeSuppliers = evaluationList
    .filter(isRankableComplete)
    .map((evaluation) => ({ supplierId: evaluation.supplierId, rankingAmount: evaluation.rankingAmount }))

  const ranking = rankCompleteSuppliers(completeSuppliers)
  const rankBySupplierId = new Map(ranking.ranked.map((entry) => [entry.supplierId, entry]))

  const supplierResults: SupplierComparisonEntry[] = evaluationList.map((evaluation) => {
    const rankInfo = rankBySupplierId.get(evaluation.supplierId)
    return {
      ...evaluation,
      rank: rankInfo?.rank,
      differenceFromLowest: rankInfo?.differenceAmount,
      percentageDifferenceFromLowest: rankInfo?.percentageDifference,
      exactPercentageDifferenceFromLowest: rankInfo?.exactPercentageDifference,
    }
  })

  const insights = buildComparisonInsights({
    suppliersInOrder: project.suppliers.map((supplier) => supplier.id),
    evaluations,
    ranking,
  })

  return {
    baseCurrency: project.baseCurrency,
    minorUnit,
    supplierResults,
    rankedCompleteSuppliers: ranking.ranked,
    lowestSupplierIds: ranking.lowestSupplierIds,
    insights,
  }
}

/**
 * A supplier's own cost list, looked up **without** touching the prototype
 * chain. `costsBySupplierId[supplier.id]` reads inherited members for an id
 * like `constructor`, `toString` or `__proto__`, and what comes back is a
 * function or `Object.prototype` — not `undefined`, so `?? []` does not save
 * it, and the whole comparison then died on "costs is not iterable". Supplier
 * ids are user-controlled text, so a user-controlled identifier must never
 * resolve data through inheritance.
 *
 * A missing key is still an ordinary, valid "no costs for this supplier". A
 * present-but-malformed value has already been rejected by
 * `validateComparisonStructure`.
 */
function costsForSupplier(
  costsBySupplierId: Readonly<Record<string, readonly AdditionalCost[]>> | undefined,
  supplierId: string,
): readonly AdditionalCost[] {
  if (costsBySupplierId === undefined || !Object.hasOwn(costsBySupplierId, supplierId)) {
    return []
  }
  return costsBySupplierId[supplierId] ?? []
}

function isRankableComplete(
  evaluation: SupplierEvaluationResult,
): evaluation is SupplierEvaluationResult & { rankingAmount: Money } {
  return evaluation.status === 'COMPLETE' && evaluation.rankingAmount !== undefined
}

function groupQuotesBySupplierId(quotes: readonly Quote[]): Map<string, Quote[]> {
  const map = new Map<string, Quote[]>()
  for (const quote of quotes) {
    const list = map.get(quote.supplierId) ?? []
    list.push(quote)
    map.set(quote.supplierId, list)
  }
  return map
}
