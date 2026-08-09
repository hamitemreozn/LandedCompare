import { describe, expect, it } from 'vitest'
import {
  InvalidComparisonInputError,
  validateComparisonStructure,
} from './ComparisonStructuralValidation'
import { baseRateTable, project, quote, quoteItem, requirement, supplier } from './testSupport'

describe('validateComparisonStructure', () => {
  it('accepts a well-formed project', () => {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1')],
      suppliers: [supplier('s1')],
      quotes: [quote({ id: 'q1', supplierId: 's1', currency: 'TRY' })],
    })
    expect(() => validateComparisonStructure(p, baseRateTable('TRY'))).not.toThrow()
  })

  it('rejects a base-currency mismatch between the project and the rate table', () => {
    const p = project({ baseCurrency: 'TRY', requirements: [requirement('r1')] })
    expect(() => validateComparisonStructure(p, baseRateTable('USD'))).toThrow(InvalidComparisonInputError)
    try {
      validateComparisonStructure(p, baseRateTable('USD'))
    } catch (error) {
      expect((error as InvalidComparisonInputError).code).toBe('BASE_CURRENCY_MISMATCH')
    }
  })

  it('rejects an empty requirements list', () => {
    const p = project({ baseCurrency: 'TRY' })
    expect(() => validateComparisonStructure(p, baseRateTable('TRY'))).toThrow(InvalidComparisonInputError)
    try {
      validateComparisonStructure(p, baseRateTable('TRY'))
    } catch (error) {
      expect((error as InvalidComparisonInputError).code).toBe('EMPTY_REQUIREMENTS')
    }
  })

  it('rejects a duplicate requirement id', () => {
    const p = project({ baseCurrency: 'TRY', requirements: [requirement('r1'), requirement('r1')] })
    try {
      validateComparisonStructure(p, baseRateTable('TRY'))
      expect.fail('expected InvalidComparisonInputError')
    } catch (error) {
      expect((error as InvalidComparisonInputError).code).toBe('DUPLICATE_REQUIREMENT_ID')
    }
  })

  it('rejects a zero required quantity', () => {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1', { requiredQuantity: '0' })],
    })
    try {
      validateComparisonStructure(p, baseRateTable('TRY'))
      expect.fail('expected InvalidComparisonInputError')
    } catch (error) {
      expect((error as InvalidComparisonInputError).code).toBe('ZERO_REQUIRED_QUANTITY')
    }
  })

  it('rejects a duplicate supplier id', () => {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1')],
      suppliers: [supplier('s1'), supplier('s1')],
    })
    try {
      validateComparisonStructure(p, baseRateTable('TRY'))
      expect.fail('expected InvalidComparisonInputError')
    } catch (error) {
      expect((error as InvalidComparisonInputError).code).toBe('DUPLICATE_SUPPLIER_ID')
    }
  })

  it('rejects a quote whose supplierId does not match any supplier', () => {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1')],
      suppliers: [supplier('s1')],
      quotes: [quote({ id: 'q1', supplierId: 'ghost', currency: 'TRY' })],
    })
    try {
      validateComparisonStructure(p, baseRateTable('TRY'))
      expect.fail('expected InvalidComparisonInputError')
    } catch (error) {
      expect((error as InvalidComparisonInputError).code).toBe('ORPHAN_QUOTE')
    }
  })

  it('rejects more than one quote for the same supplier', () => {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1')],
      suppliers: [supplier('s1')],
      quotes: [
        quote({ id: 'q1', supplierId: 's1', currency: 'TRY' }),
        quote({ id: 'q2', supplierId: 's1', currency: 'TRY' }),
      ],
    })
    try {
      validateComparisonStructure(p, baseRateTable('TRY'))
      expect.fail('expected InvalidComparisonInputError')
    } catch (error) {
      expect((error as InvalidComparisonInputError).code).toBe('DUPLICATE_QUOTE_FOR_SUPPLIER')
    }
  })

  it('does not flag a quote item referencing an unknown requirement — that is supplier-level, not structural', () => {
    const p = project({
      baseCurrency: 'TRY',
      requirements: [requirement('r1')],
      suppliers: [supplier('s1')],
      quotes: [
        quote({
          id: 'q1',
          supplierId: 's1',
          currency: 'TRY',
          items: [quoteItem({ id: 'i1', requirementId: 'unknown-requirement', price: '1', currency: 'TRY' })],
        }),
      ],
    })
    expect(() => validateComparisonStructure(p, baseRateTable('TRY'))).not.toThrow()
  })
})
