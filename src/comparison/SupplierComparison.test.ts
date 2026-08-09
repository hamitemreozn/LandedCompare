import { describe, expect, it } from 'vitest'
import { compareSuppliers } from './SupplierComparison'
import { InvalidComparisonInputError } from './ComparisonStructuralValidation'
import { createAdditionalCost } from '../calculation/AdditionalCost'
import { InvalidMinorUnitError } from '../calculation/CurrencyMinorUnit'
import { Money } from '../domain/monetary/Money'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

describe('compareSuppliers — orchestration', () => {
  it('throws the comparison-level structural error before evaluating any supplier', () => {
    const p = project({ baseCurrency: 'TRY' }) // no requirements
    expect(() => compareSuppliers({ project: p, exchangeRateTable: baseRateTable('TRY') })).toThrow(
      InvalidComparisonInputError,
    )
  })

  it('defaults a supplier with no cost entry to an empty cost list, not a copied project-level default', () => {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1', { requiredQuantity: '1' })],
      suppliers: [supplier('s1')],
      quotes: [
        quote({
          id: 'q1',
          supplierId: 's1',
          currency: 'TRY',
          items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '100', currency: 'TRY' })],
        }),
      ],
    })
    const result = compareSuppliers({ project: p, exchangeRateTable: baseRateTable('TRY') })
    const s1Result = result.supplierResults.find((r) => r.supplierId === 's1')!
    expect(s1Result.status).toBe('COMPLETE')
    expect(s1Result.exactCalculatedLandedTotal?.toDecimalString()).toBe('100')
  })

  it('applies a supplier-specific cost only to that supplier', () => {
    const requirements = [requirement('r1', { requiredQuantity: '1' })]
    const suppliers = [supplier('sA'), supplier('sB')]
    const quotes = [
      quote({
        id: 'qA',
        supplierId: 'sA',
        currency: 'TRY',
        items: [quoteItem({ id: 'iA', requirementId: 'r1', price: '100', currency: 'TRY' })],
      }),
      quote({
        id: 'qB',
        supplierId: 'sB',
        currency: 'TRY',
        items: [quoteItem({ id: 'iB', requirementId: 'r1', price: '100', currency: 'TRY' })],
      }),
    ]
    const p = project({ baseCurrency: 'TRY', requirements, suppliers, quotes })
    const result = compareSuppliers({
      project: p,
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        sA: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('20', 'TRY'),
          }),
        ],
      },
    })
    const a = result.supplierResults.find((r) => r.supplierId === 'sA')!
    const b = result.supplierResults.find((r) => r.supplierId === 'sB')!
    expect(a.exactCalculatedLandedTotal?.toDecimalString()).toBe('120')
    expect(b.exactCalculatedLandedTotal?.toDecimalString()).toBe('100')
  })

  it('blocks the whole comparison for an unresolvable base-currency minor unit — never a per-supplier INVALID', () => {
    // Two suppliers, both otherwise perfectly COMPLETE, to prove this is a
    // comparison-wide configuration problem, not something that could ever
    // be pinned on one supplier's data.
    const p = project({
      baseCurrency: 'JPY',
      requirements: [requirement('r1', { requiredQuantity: '1' })],
      suppliers: [supplier('s1'), supplier('s2')],
      quotes: [
        quote({
          id: 'q1',
          supplierId: 's1',
          currency: 'JPY',
          items: [quoteItem({ id: 'i1', requirementId: 'r1', price: '100', currency: 'JPY' })],
        }),
        quote({
          id: 'q2',
          supplierId: 's2',
          currency: 'JPY',
          items: [quoteItem({ id: 'i2', requirementId: 'r1', price: '90', currency: 'JPY' })],
        }),
      ],
    })

    expect(() => compareSuppliers({ project: p, exchangeRateTable: baseRateTable('JPY') })).toThrow(
      InvalidMinorUnitError,
    )

    const result = compareSuppliers({
      project: p,
      exchangeRateTable: baseRateTable('JPY'),
      minorUnitOverrides: { JPY: 0 },
    })
    expect(result.minorUnit).toBe(0)
    expect(result.supplierResults.every((r) => r.status === 'COMPLETE')).toBe(true)
  })

  it('excludes INCOMPLETE and INVALID suppliers from rankedCompleteSuppliers and lowestSupplierIds', () => {
    const requirements = [requirement('r1', { requiredQuantity: '1' }), requirement('r2', { requiredQuantity: '1' })]
    const suppliers = [supplier('complete'), supplier('incomplete'), supplier('invalid')]
    const quotes = [
      quote({
        id: 'q-complete',
        supplierId: 'complete',
        currency: 'TRY',
        items: [
          quoteItem({ id: 'i1', requirementId: 'r1', price: '10', currency: 'TRY' }),
          quoteItem({ id: 'i2', requirementId: 'r2', price: '10', currency: 'TRY' }),
        ],
      }),
      quote({
        id: 'q-incomplete',
        supplierId: 'incomplete',
        currency: 'TRY',
        items: [quoteItem({ id: 'i3', requirementId: 'r1', price: '1', currency: 'TRY' })],
      }),
      quote({
        id: 'q-invalid',
        supplierId: 'invalid',
        currency: 'TRY',
        items: [
          quoteItem({ id: 'i4', requirementId: 'r1', price: '1', currency: 'TRY' }),
          quoteItem({ id: 'i5', requirementId: 'r1', price: '2', currency: 'TRY' }),
          quoteItem({ id: 'i6', requirementId: 'r2', price: '1', currency: 'TRY' }),
        ],
      }),
    ]
    const p = project({ baseCurrency: 'TRY', requirements, suppliers, quotes })
    const result = compareSuppliers({ project: p, exchangeRateTable: baseRateTable('TRY') })

    expect(result.rankedCompleteSuppliers.map((r) => r.supplierId)).toEqual(['complete'])
    expect(result.lowestSupplierIds).toEqual(['complete'])
    expect(result.supplierResults.find((r) => r.supplierId === 'incomplete')?.status).toBe('INCOMPLETE')
    expect(result.supplierResults.find((r) => r.supplierId === 'invalid')?.status).toBe('INVALID')
  })
})
