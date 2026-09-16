import { parseExactDecimal, roundHalfUp } from '../domain/monetary/decimal'
import { Money } from '../domain/monetary/Money'
import { Percentage } from '../calculation/Percentage'

/**
 * Decimal places a user-facing percentage difference is published at. A ratio
 * like 1/3 is an endless decimal; publishing all 30-odd digits of it as a
 * commercial figure ("33.33333333333333333333333333333333% more expensive")
 * is not a number anyone can act on. Two places, half-up — the same rounding
 * convention the rest of the engine settles money with.
 */
const PERCENTAGE_DIFFERENCE_DECIMALS = 2

/**
 * An internal assertion: ranking was handed a negative amount. No valid
 * engine state produces one — merchandise totals are non-negative, cost
 * amounts are validated non-negative, and discounts cannot exceed the
 * merchandise total — so this means something upstream let unvalidated data
 * through.
 *
 * It is loud on purpose. The alternatives are worse: presenting a negative
 * total as the cheapest supplier, or quietly reporting "percentage
 * unavailable" and carrying on with a ranking built on a number that cannot
 * be a landed cost. Before this guard, such an amount surfaced as an
 * `InvalidPercentageError` thrown from inside a percentage constructor —
 * technically an error, but one that named neither the cause nor the
 * supplier.
 */
export class RankingInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RankingInvariantError'
  }
}

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
   * `differenceAmount / lowestRankingAmount x 100`, published at two decimal
   * places, half-up — the commercial figure. `undefined` when the lowest
   * ranking amount is zero and this supplier's is not: the percentage is
   * mathematically undefined there, never `Infinity`/`NaN`/an invented
   * figure. See docs/CALCULATION_RULES.md, "Zero best total".
   */
  readonly percentageDifference?: Percentage
  /**
   * The same ratio at full precision, for audit. Rounding decides what is
   * *shown*; it does not decide anything monetary — no ranking, tie or
   * difference amount is derived from either form of this percentage.
   */
  readonly exactPercentageDifference?: Percentage
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

  for (const supplier of suppliers) {
    if (supplier.rankingAmount.isNegative()) {
      throw new RankingInvariantError(
        `Supplier "${supplier.supplierId}" has a negative ranking amount (${supplier.rankingAmount.toDecimalString()} ${supplier.rankingAmount.currency}); a calculated landed total cannot be negative`,
      )
    }
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
    const { published, exact } = computePercentageDifference(differenceAmount, lowestRankingAmount)
    return {
      supplierId: entry.supplierId,
      rankingAmount: entry.rankingAmount,
      rank: entry.rank,
      differenceAmount,
      percentageDifference: published,
      exactPercentageDifference: exact,
    }
  })

  return { ranked, lowestSupplierIds, lowestRankingAmount }
}

function computePercentageDifference(
  differenceAmount: Money,
  lowestRankingAmount: Money,
): { published?: Percentage; exact?: Percentage } {
  if (lowestRankingAmount.isZero()) {
    // Zero against zero is a real 0%; a positive amount against zero has no
    // percentage at all, and inventing one would be worse than saying so.
    if (!differenceAmount.isZero()) {
      return {}
    }
    const zero = Percentage.fromString('0.00')
    return { published: zero, exact: Percentage.fromString('0') }
  }

  const ratio = parseExactDecimal(differenceAmount.toDecimalString())
    .dividedBy(parseExactDecimal(lowestRankingAmount.toDecimalString()))
    .times(100)

  return {
    published: Percentage.fromString(
      roundHalfUp(ratio, PERCENTAGE_DIFFERENCE_DECIMALS).toFixed(PERCENTAGE_DIFFERENCE_DECIMALS),
    ),
    exact: Percentage.fromString(ratio.toFixed()),
  }
}
