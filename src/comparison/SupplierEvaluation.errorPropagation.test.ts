import { describe, expect, it, vi } from 'vitest'
import { AllocationInvariantError } from '../calculation/Allocation'
import { baseRateTable, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * `AllocationInvariantError` is an internal engine-correctness assertion
 * (see Allocation.ts) that cannot be triggered through the public API with
 * valid supplier data — that is the point of it existing. To prove
 * `evaluateSupplier` really does let it (and, by the same closed-list logic,
 * any other unmapped exception) propagate instead of silently becoming an
 * `INVALID` supplier, this file mocks the allocation step to simulate an
 * internal engine bug, isolated in its own file so the mock never leaks into
 * `SupplierEvaluation.test.ts`'s real-calculation assertions.
 */
vi.mock('../calculation/CostCalculation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../calculation/CostCalculation')>()
  return {
    ...actual,
    allocateSupplierCosts: () => {
      throw new AllocationInvariantError('simulated internal allocator bug')
    },
  }
})

describe('evaluateSupplier — internal engine errors are not swallowed', () => {
  it('lets AllocationInvariantError propagate instead of mapping the supplier to INVALID', async () => {
    const { evaluateSupplier } = await import('./SupplierEvaluation')
    const requirements = [requirement('r1', { requiredQuantity: '1' })]
    const q = quote({
      id: 'q1',
      supplierId: 's1',
      currency: 'TRY',
      items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '100', currency: 'TRY' })],
    })

    expect(() =>
      evaluateSupplier({
        supplier: supplier('s1'),
        quotesForSupplier: [q],
        requirements,
        costs: [],
        exchangeRateTable: baseRateTable('TRY'),
        minorUnit: 2,
      }),
    ).toThrow(AllocationInvariantError)
  })
})
