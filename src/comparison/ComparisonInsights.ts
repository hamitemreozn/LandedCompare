import type { Money } from '../domain/monetary/Money'
import type { RankingResult } from './Ranking'
import type { SupplierEvaluationResult, SupplierIssueCode } from './SupplierEvaluation'

/**
 * Deterministic, machine-readable comparison outcomes. No natural-language
 * text is produced here — a later i18n phase turns these codes and
 * parameters into user-facing strings. See docs/CALCULATION_RULES.md,
 * "Deterministic insights".
 */
export type ComparisonInsight =
  | { readonly code: 'NO_COMPARABLE_SUPPLIERS' }
  | { readonly code: 'ONLY_COMPARABLE_SUPPLIER'; readonly supplierId: string; readonly rankingAmount: Money }
  | {
      readonly code: 'LOWEST_CALCULATED_LANDED_COST'
      readonly supplierId: string
      readonly rankingAmount: Money
    }
  | {
      readonly code: 'TIED_LOWEST_CALCULATED_LANDED_COST'
      readonly supplierIds: readonly string[]
      readonly rankingAmount: Money
    }
  | {
      readonly code: 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST'
      readonly lowestMerchandiseSupplierIds: readonly string[]
      readonly lowestLandedSupplierIds: readonly string[]
      readonly lowestMerchandiseAmount: Money
      readonly lowestLandedRankingAmount: Money
    }
  | {
      readonly code: 'INCOMPLETE_QUOTE'
      readonly supplierId: string
      readonly missingRequirementIds: readonly string[]
    }
  | {
      readonly code: 'INVALID_QUOTE'
      readonly supplierId: string
      readonly issueCodes: readonly SupplierIssueCode[]
    }

export interface BuildComparisonInsightsInput {
  /** Every supplier id, in the project's original input order — drives deterministic per-supplier insight ordering. */
  readonly suppliersInOrder: readonly string[]
  readonly evaluations: ReadonlyMap<string, SupplierEvaluationResult>
  readonly ranking: RankingResult
}

/**
 * Builds the full set of deterministic insights for one comparison.
 *
 * Ordering is fixed and explicit, not incidental: the single comparability/
 * winner insight first (exactly one of NO_COMPARABLE_SUPPLIERS /
 * ONLY_COMPARABLE_SUPPLIER / LOWEST_CALCULATED_LANDED_COST /
 * TIED_LOWEST_CALCULATED_LANDED_COST always applies), then the merchandise-
 * vs-landed flip (if any), then per-supplier INCOMPLETE_QUOTE insights and
 * INVALID_QUOTE insights, each group walked in the project's supplier order.
 */
export function buildComparisonInsights(input: BuildComparisonInsightsInput): readonly ComparisonInsight[] {
  const { suppliersInOrder, evaluations, ranking } = input
  const insights: ComparisonInsight[] = []
  const completeCount = ranking.ranked.length

  if (completeCount === 0) {
    insights.push({ code: 'NO_COMPARABLE_SUPPLIERS' })
  } else if (completeCount === 1) {
    const only = ranking.ranked[0]!
    insights.push({
      code: 'ONLY_COMPARABLE_SUPPLIER',
      supplierId: only.supplierId,
      rankingAmount: only.rankingAmount,
    })
  } else if (ranking.lowestSupplierIds.length === 1) {
    insights.push({
      code: 'LOWEST_CALCULATED_LANDED_COST',
      supplierId: ranking.lowestSupplierIds[0]!,
      rankingAmount: ranking.lowestRankingAmount!,
    })
  } else {
    insights.push({
      code: 'TIED_LOWEST_CALCULATED_LANDED_COST',
      supplierIds: ranking.lowestSupplierIds,
      rankingAmount: ranking.lowestRankingAmount!,
    })
  }

  if (completeCount >= 2) {
    const merchandiseLeader = findUniqueMerchandiseLeader(ranking, evaluations)
    if (merchandiseLeader && !ranking.lowestSupplierIds.includes(merchandiseLeader.supplierId)) {
      insights.push({
        code: 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST',
        lowestMerchandiseSupplierIds: [merchandiseLeader.supplierId],
        lowestLandedSupplierIds: ranking.lowestSupplierIds,
        lowestMerchandiseAmount: merchandiseLeader.amount,
        lowestLandedRankingAmount: ranking.lowestRankingAmount!,
      })
    }
  }

  for (const supplierId of suppliersInOrder) {
    const evaluation = evaluations.get(supplierId)
    if (evaluation?.status === 'INCOMPLETE') {
      insights.push({
        code: 'INCOMPLETE_QUOTE',
        supplierId,
        missingRequirementIds: evaluation.missingRequirementIds ?? [],
      })
    }
  }

  for (const supplierId of suppliersInOrder) {
    const evaluation = evaluations.get(supplierId)
    if (evaluation?.status === 'INVALID') {
      insights.push({
        code: 'INVALID_QUOTE',
        supplierId,
        issueCodes: evaluation.issues.map((issue) => issue.code),
      })
    }
  }

  return insights
}

/**
 * The unique `COMPLETE` supplier with the lowest `merchandiseRankingAmount`,
 * or `undefined` if there is a tie for lowest merchandise. A tie must never
 * be reported as a single "merchandise leader" — see
 * docs/CALCULATION_RULES.md, "Merchandise-vs-landed insight".
 */
function findUniqueMerchandiseLeader(
  ranking: RankingResult,
  evaluations: ReadonlyMap<string, SupplierEvaluationResult>,
): { readonly supplierId: string; readonly amount: Money } | undefined {
  let lowestAmount: Money | undefined
  let leaders: string[] = []

  for (const entry of ranking.ranked) {
    const amount = evaluations.get(entry.supplierId)?.merchandiseRankingAmount
    if (amount === undefined) {
      continue
    }
    if (lowestAmount === undefined || amount.isLessThan(lowestAmount)) {
      lowestAmount = amount
      leaders = [entry.supplierId]
    } else if (amount.equals(lowestAmount)) {
      leaders.push(entry.supplierId)
    }
  }

  if (leaders.length === 1 && lowestAmount !== undefined) {
    return { supplierId: leaders[0]!, amount: lowestAmount }
  }
  return undefined
}
