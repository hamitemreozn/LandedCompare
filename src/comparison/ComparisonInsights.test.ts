import { describe, expect, it } from 'vitest'
import { buildComparisonInsights } from './ComparisonInsights'
import { rankCompleteSuppliers } from './Ranking'
import type { SupplierEvaluationResult } from './SupplierEvaluation'
import { Money } from '../domain/monetary/Money'

function ry(amount: string) {
  return Money.fromString(amount, 'TRY')
}

function complete(
  supplierId: string,
  rankingAmount: string,
  merchandiseRankingAmount: string,
): SupplierEvaluationResult {
  return {
    supplierId,
    status: 'COMPLETE',
    issues: [],
    exactCalculatedLandedTotal: ry(rankingAmount),
    rankingAmount: ry(rankingAmount),
    merchandiseTotal: ry(merchandiseRankingAmount),
    merchandiseRankingAmount: ry(merchandiseRankingAmount),
  }
}

function incomplete(supplierId: string, missingRequirementIds: readonly string[]): SupplierEvaluationResult {
  return {
    supplierId,
    status: 'INCOMPLETE',
    issues: [{ code: 'MISSING_REQUIRED_ITEMS', message: 'missing' }],
    missingRequirementIds,
  }
}

function invalid(supplierId: string): SupplierEvaluationResult {
  return {
    supplierId,
    status: 'INVALID',
    issues: [{ code: 'DUPLICATE_QUOTE_ITEM', message: 'duplicate' }],
  }
}

function insightsFor(evaluationsInOrder: readonly SupplierEvaluationResult[]) {
  const evaluations = new Map(evaluationsInOrder.map((e) => [e.supplierId, e]))
  const completeSuppliers = evaluationsInOrder
    .filter((e) => e.status === 'COMPLETE')
    .map((e) => ({ supplierId: e.supplierId, rankingAmount: e.rankingAmount! }))
  const ranking = rankCompleteSuppliers(completeSuppliers)
  return buildComparisonInsights({
    suppliersInOrder: evaluationsInOrder.map((e) => e.supplierId),
    evaluations,
    ranking,
  })
}

describe('buildComparisonInsights', () => {
  it('reports NO_COMPARABLE_SUPPLIERS when nobody is complete', () => {
    const insights = insightsFor([incomplete('a', ['r1']), invalid('b')])
    expect(insights[0]).toEqual({ code: 'NO_COMPARABLE_SUPPLIERS' })
    expect(insights).toContainEqual({
      code: 'INCOMPLETE_QUOTE',
      supplierId: 'a',
      missingRequirementIds: ['r1'],
    })
    expect(insights).toContainEqual({
      code: 'INVALID_QUOTE',
      supplierId: 'b',
      issueCodes: ['DUPLICATE_QUOTE_ITEM'],
    })
  })

  it('reports ONLY_COMPARABLE_SUPPLIER for a single complete supplier, never as a landed-cost winner', () => {
    const insights = insightsFor([complete('a', '100', '100')])
    expect(insights[0]).toEqual({ code: 'ONLY_COMPARABLE_SUPPLIER', supplierId: 'a', rankingAmount: ry('100') })
    expect(insights.some((i) => i.code === 'LOWEST_CALCULATED_LANDED_COST')).toBe(false)
  })

  it('reports LOWEST_CALCULATED_LANDED_COST for a unique lowest landed total', () => {
    const insights = insightsFor([complete('a', '110', '110'), complete('b', '100', '100')])
    expect(insights[0]).toEqual({ code: 'LOWEST_CALCULATED_LANDED_COST', supplierId: 'b', rankingAmount: ry('100') })
  })

  it('reports TIED_LOWEST_CALCULATED_LANDED_COST when the lowest landed total is shared', () => {
    const insights = insightsFor([complete('a', '100', '100'), complete('b', '100', '100')])
    expect(insights[0]).toEqual({
      code: 'TIED_LOWEST_CALCULATED_LANDED_COST',
      supplierIds: ['a', 'b'],
      rankingAmount: ry('100'),
    })
  })

  it('reports LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST when the merchandise leader is not the landed winner', () => {
    // a: merchandise 1000, landed 1100 (low costs). b: merchandise 950, landed 1150 (high costs).
    const insights = insightsFor([complete('a', '1100', '1000'), complete('b', '1150', '950')])
    const flip = insights.find((i) => i.code === 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST')
    expect(flip).toEqual({
      code: 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST',
      lowestMerchandiseSupplierIds: ['b'],
      lowestLandedSupplierIds: ['a'],
      lowestMerchandiseAmount: ry('950'),
      lowestLandedRankingAmount: ry('1100'),
    })
  })

  it('does not claim a merchandise leader when merchandise totals are themselves tied', () => {
    const insights = insightsFor([complete('a', '1100', '900'), complete('b', '1150', '900')])
    expect(insights.some((i) => i.code === 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST')).toBe(false)
  })

  it('does not emit the merchandise-flip insight when the merchandise leader is also the landed winner', () => {
    const insights = insightsFor([complete('a', '1000', '900'), complete('b', '1100', '950')])
    expect(insights.some((i) => i.code === 'LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST')).toBe(false)
  })

  it('reports one INCOMPLETE_QUOTE insight per incomplete supplier, in project input order', () => {
    const insights = insightsFor([complete('a', '100', '100'), incomplete('c', ['r2']), incomplete('b', ['r1'])])
    const incompleteInsights = insights.filter((i) => i.code === 'INCOMPLETE_QUOTE')
    expect(incompleteInsights).toEqual([
      { code: 'INCOMPLETE_QUOTE', supplierId: 'c', missingRequirementIds: ['r2'] },
      { code: 'INCOMPLETE_QUOTE', supplierId: 'b', missingRequirementIds: ['r1'] },
    ])
  })

  it('reports one INVALID_QUOTE insight per invalid supplier with its issue codes', () => {
    const insights = insightsFor([complete('a', '100', '100'), invalid('b')])
    expect(insights.filter((i) => i.code === 'INVALID_QUOTE')).toEqual([
      { code: 'INVALID_QUOTE', supplierId: 'b', issueCodes: ['DUPLICATE_QUOTE_ITEM'] },
    ])
  })

  it('produces the same insights (deterministic) on repeated runs with the same input', () => {
    const evaluations = [complete('a', '110', '110'), complete('b', '100', '100'), incomplete('c', ['r1'])]
    const first = JSON.stringify(insightsFor(evaluations))
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(JSON.stringify(insightsFor(evaluations))).toBe(first)
    }
  })
})
