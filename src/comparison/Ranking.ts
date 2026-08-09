import { parseExactDecimal } from '../domain/monetary/decimal'
import { Money } from '../domain/monetary/Money'
import { Percentage } from '../calculation/Percentage'

/** The minimal input ranking needs: a `COMPLETE` supplier's id and its already-settled `rankingAmount`. */
export interface RankableSupplier {
  readonly supplierId: string
  readonly rankingAmount: Money
}

export interface RankedSupplier {
  readonly supplierId: string
  readonly rankingAmount: Money
  /** Dense rank (1, 1, 2 — never 1, 1, 3). Ties share the same rank. */
  readonly rank: number
  /** `rankingAmount - lowestRankingAmount`. Zero for the lowest rank group. */
  readonly differenceAmount: Money
  /**
   * `differenceAmount / lowestRankingAmount x 100`. `undefined` when the
   * lowest ranking amount is zero and this supplier's is not — the
   * percentage is mathematically undefined there, never `Infinity`/`NaN`/an
   * invented figure. See docs/CALCULATION_RULES.md, "Zero best total".
   */
  readonly percentageDifference?: Percentage
}

export interface RankingResult {
  /** Ascending by `rankingAmount`; ties keep the original (input) supplier order. */
  readonly ranked: readonly RankedSupplier[]
  /** Every supplier sharing dense rank 1. Empty if `ranked` is empty. */
  readonly lowestSupplierIds: readonly string[]
  readonly lowestRankingAmount?: Money
}

/**
 * Ranks `COMPLETE` suppliers by `rankingAmount` — never by the exact,
 * unrounded landed total. Dense ranking; ties are broken by input order only
 * (no hidden alphabetic/name tie-break). See docs/CALCULATION_RULES.md,
 * "Ranking boundary" and "Tie semantics".
 */
export function rankCompleteSuppliers(suppliers: readonly RankableSupplier[]): RankingResult {
  if (suppliers.length === 0) {
    return { ranked: [], lowestSupplierIds: [] }
  }

  const withOrder = suppliers.map((supplier, order) => ({ ...supplier, order }))
  const sorted = [...withOrder].sort((a, b) => {
    const byAmount = a.rankingAmount.compareTo(b.rankingAmount)
    return byAmount !== 0 ? byAmount : a.order - b.order
  })

  let rank = 0
  let previousAmount: Money | undefined
  const denseRanked = sorted.map((entry) => {
    if (previousAmount === undefined || !entry.rankingAmount.equals(previousAmount)) {
      rank += 1
      previousAmount = entry.rankingAmount
    }
    return { ...entry, rank }
  })

  const lowestRankingAmount = denseRanked[0]!.rankingAmount
  const lowestSupplierIds = denseRanked
    .filter((entry) => entry.rank === 1)
    .map((entry) => entry.supplierId)

  const ranked: RankedSupplier[] = denseRanked.map((entry) => {
    const differenceAmount = entry.rankingAmount.subtract(lowestRankingAmount)
    return {
      supplierId: entry.supplierId,
      rankingAmount: entry.rankingAmount,
      rank: entry.rank,
      differenceAmount,
      percentageDifference: computePercentageDifference(differenceAmount, lowestRankingAmount),
    }
  })

  return { ranked, lowestSupplierIds, lowestRankingAmount }
}

function computePercentageDifference(
  differenceAmount: Money,
  lowestRankingAmount: Money,
): Percentage | undefined {
  if (lowestRankingAmount.isZero()) {
    return differenceAmount.isZero() ? Percentage.fromString('0') : undefined
  }
  const ratio = parseExactDecimal(differenceAmount.toDecimalString())
    .dividedBy(parseExactDecimal(lowestRankingAmount.toDecimalString()))
    .times(100)
  return Percentage.fromString(ratio.toFixed())
}
