import { describe, expect, it, vi } from 'vitest'
import { AllocationInvariantError } from '../calculation/Allocation'
import { baseRateTable, quote, quoteItem, requirement, supplier } from './testSupport'

/**
 * `AllocationInvariantError` is an internal engine-correctness assertion (see
 * Allocation.ts). No test can produce it from ordinary input on purpose —
 * that is what makes it an assertion rather than a validation — so this file
 * mocks the allocation step to simulate an internal bug and prove
 * `evaluateSupplier` lets it (and, by the same closed-list logic, any other
 * unmapped exception) propagate instead of quietly becoming an `INVALID`
 * supplier. The mock is isolated in its own file so it never leaks into
 * `SupplierEvaluation.test.ts`'s real-calculation assertions.
 *
 * This matters more since allocation failures became non-blocking: the narrow
 * `try` around the allocation call must catch *only* the two unusable-base
 * errors. An internal assertion travelling the same code path must still come
 * out the other side.
 *
 * An out-of-range amount used to reach this error too. It no longer does —
 * it is rejected up front as `PrecisionEnvelopeExceededError` — see
 * `PrecisionBoundary.test.ts`.
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
