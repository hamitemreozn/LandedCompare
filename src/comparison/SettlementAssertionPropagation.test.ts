import { describe, expect, it, vi } from 'vitest'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * `SettlementReconciliationError` is an engine-correctness assertion, not a
 * statement about a supplier's data, so it belongs in the fourth error
 * category: it must travel all the way out of the pipeline rather than being
 * relabelled as an `INVALID` supplier or absorbed into the allocation warning.
 *
 * Two of the three places it is raised guard the per-line view
 * (`assertLinesReconcileToTotal`, `assertNoLineSettlesNegative` in
 * `SupplierEvaluation.ts`), and by design **no ordinary input can reach
 * them** — a discount that would overdraw a line is refused first, and cent
 * distribution is capacity-limited so a valid line cannot settle below zero.
 * That is what makes them assertions, and it is also why the wiring around
 * them is otherwise untested: there is no input to test it with.
 *
 * So the allocation step is mocked to return a breakdown that is internally
 * consistent — the per-line totals still add up to the authoritative total —
 * but puts one line below zero. That is precisely the corruption these guards
 * exist to catch, and the test's subject is the *classification*: a broken
 * engine must not look like a broken quote. The mock lives in its own file,
 * like `SupplierEvaluation.errorPropagation.test.ts`, so it never reaches the
 * suites that assert real arithmetic.
 */
vi.mock('../calculation/CostCalculation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../calculation/CostCalculation')>()
  return {
    ...actual,
    allocateSupplierCosts: (input: Parameters<typeof actual.allocateSupplierCosts>[0]) => ({
      baseCurrency: input.costResult.baseCurrency,
      minorUnit: input.costResult.minorUnit,
      byEntry: [],
      // Sums to zero, so the lines still reconcile to the settled landed
      // total — only their distribution is nonsense.
      byLine: [
        { targetId: input.targets[0]!.id, allocatedCostTotal: Money.fromString('-150', 'TRY') },
        { targetId: input.targets[1]!.id, allocatedCostTotal: Money.fromString('150', 'TRY') },
      ],
    }),
  }
})

describe('evaluateSupplier — a corrupted per-line settlement is an engine failure, not a supplier verdict', () => {
  async function evaluate() {
    const { evaluateSupplier } = await import('./SupplierEvaluation')
    return evaluateSupplier({
      supplier: supplier('s1'),
      quotesForSupplier: [
        quote({
          id: 'q1',
          supplierId: 's1',
          currency: 'TRY',
          items: [
            quoteItem({ id: 'i1', requirementId: 'r1', price: '100', currency: 'TRY' }),
            quoteItem({ id: 'i2', requirementId: 'r2', price: '100', currency: 'TRY' }),
          ],
        }),
      ],
      requirements: [
        requirement('r1', { requiredQuantity: '1' }),
        requirement('r2', { requiredQuantity: '1' }),
      ],
      costs: [],
      exchangeRateTable: baseRateTable('TRY'),
      minorUnit: 2,
    })
  }

  it('throws instead of returning an INVALID supplier', async () => {
    const { SettlementReconciliationError } = await import('../calculation/CostCalculation')
    await expect(evaluate()).rejects.toThrow(SettlementReconciliationError)
  })

  it('names the line and says cent distribution put it there', async () => {
    await expect(evaluate()).rejects.toThrow(/line "r1" settled to -50/)
  })
})
