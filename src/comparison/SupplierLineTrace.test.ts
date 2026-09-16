import { describe, expect, it } from 'vitest'
import { compareSuppliers } from './SupplierComparison'
import { createAdditionalCost } from '../calculation/AdditionalCost'
import { ExchangeRate } from '../calculation/ExchangeRate'
import { ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { Money } from '../domain/monetary/Money'
import { project, quote, quoteItem, requirement, supplier, baseRateTable } from './testSupport'

/**
 * Quantity resolution has always computed why a supplier will ship more than
 * was asked for — the MOQ that bit, the pack that rounded up, the excess that
 * results. The comparison result used to throw all of it away, so a results
 * view could not say "you asked for 105, the MOQ forced 200" without redoing
 * the calculation itself. These lock the trace into the output.
 */
describe('per-line trace survives into the comparison result', () => {
  function comparisonFor(item: Parameters<typeof quoteItem>[0], requiredQuantity: string) {
    return compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [requirement('r1', { requiredQuantity, comparisonUnit: 'pcs' })],
        suppliers: [supplier('s1')],
        quotes: [quote({ id: 'q1', supplierId: 's1', currency: 'TRY', items: [quoteItem(item)] })],
      }),
      exchangeRateTable: baseRateTable('TRY'),
    })
  }

  it('carries the MOQ that raised the order quantity', () => {
    const result = comparisonFor(
      { id: 'i1', requirementId: 'r1', price: '2', currency: 'TRY', moq: '200' },
      '105',
    )
    const line = result.supplierResults[0]!.lines![0]!

    expect(line.requirementId).toBe('r1')
    expect(line.quoteItemId).toBe('i1')
    expect(line.requiredQuantity.toDecimalString()).toBe('105')
    expect(line.resolvedQuantity.toDecimalString()).toBe('200')
    expect(line.excessQuantity.toDecimalString()).toBe('95')
    expect(line.moqApplied).toBe(true)
    expect(line.moq?.toDecimalString()).toBe('200')
    expect(line.packApplied).toBe(false)
    // Priced on what is actually bought, not on what was asked for.
    expect(line.exactMerchandiseValue.toDecimalString()).toBe('400')
  })

  it('carries the pack rounding and keeps quoted units distinct from comparison units', () => {
    const result = comparisonFor(
      { id: 'i1', requirementId: 'r1', price: '30', currency: 'TRY', unitsPerQuotedUnit: '10' },
      '105',
    )
    const line = result.supplierResults[0]!.lines![0]!

    expect(line.packApplied).toBe(true)
    expect(line.unitsPerQuotedUnit?.toDecimalString()).toBe('10')
    // 105 pcs -> 10.5 boxes -> 11 boxes -> 110 pcs
    expect(line.quotedUnitQuantity.toDecimalString()).toBe('11')
    expect(line.resolvedQuantity.toDecimalString()).toBe('110')
    expect(line.excessQuantity.toDecimalString()).toBe('5')
    expect(line.comparisonUnit).toBe('pcs')
    expect(line.quotedUnit).toBe('unit')
    // 11 boxes x 30, not 110 x 30.
    expect(line.exactMerchandiseValue.toDecimalString()).toBe('330')
  })

  it('carries MOQ-then-pack ordering', () => {
    const result = comparisonFor(
      { id: 'i1', requirementId: 'r1', price: '5', currency: 'TRY', moq: '123', unitsPerQuotedUnit: '10' },
      '105',
    )
    const line = result.supplierResults[0]!.lines![0]!

    // MOQ raises the minimum to 123, then packs round that up: 13 boxes, 130 pcs.
    expect(line.moqApplied).toBe(true)
    expect(line.quotedUnitQuantity.toDecimalString()).toBe('13')
    expect(line.resolvedQuantity.toDecimalString()).toBe('130')
    expect(line.excessQuantity.toDecimalString()).toBe('25')
  })

  it('reports no excess when nothing constrained the quantity', () => {
    const result = comparisonFor({ id: 'i1', requirementId: 'r1', price: '4', currency: 'TRY' }, '105')
    const line = result.supplierResults[0]!.lines![0]!

    expect(line.moqApplied).toBe(false)
    expect(line.packApplied).toBe(false)
    expect(line.excessQuantity.toDecimalString()).toBe('0')
    expect(line.resolvedQuantity.toDecimalString()).toBe('105')
  })

  it('publishes both currencies of a line value plus its allocated cost share', () => {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [
          requirement('a', { requiredQuantity: '10' }),
          requirement('b', { requiredQuantity: '10' }),
        ],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'USD',
            items: [
              quoteItem({ id: 'i1', requirementId: 'a', price: '3', currency: 'USD' }),
              quoteItem({ id: 'i2', requirementId: 'b', price: '1', currency: 'USD' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', '40')]),
      costsBySupplierId: {
        s1: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('400', 'TRY'),
          }),
        ],
      },
    })

    const [first, second] = result.supplierResults[0]!.lines!

    expect(first!.exactMerchandiseValue.toDecimalString()).toBe('30')
    expect(first!.exactMerchandiseValue.currency).toBe('USD')
    expect(first!.exactBaseCurrencyMerchandiseValue.toDecimalString()).toBe('1200')
    expect(first!.settledMerchandiseValue.toDecimalString()).toBe('1200')
    // 400 TRY freight split 3:1 by merchandise value.
    expect(first!.allocatedCostTotal?.toDecimalString()).toBe('300')
    expect(first!.settledLandedValue?.toDecimalString()).toBe('1500')

    expect(second!.allocatedCostTotal?.toDecimalString()).toBe('100')
    expect(second!.settledLandedValue?.toDecimalString()).toBe('500')
  })

  it('keeps the quantity trace even when the allocation is unavailable', () => {
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [
          requirement('a', { requiredQuantity: '10', comparisonUnit: 'pcs' }),
          requirement('b', { requiredQuantity: '5', comparisonUnit: 'kg' }),
        ],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [
              quoteItem({ id: 'i1', requirementId: 'a', price: '10', currency: 'TRY', moq: '30' }),
              quoteItem({ id: 'i2', requirementId: 'b', price: '20', currency: 'TRY' }),
            ],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: {
        s1: [
          createAdditionalCost({
            id: 'freight',
            kind: 'COST',
            category: 'FREIGHT',
            fixedAmount: Money.fromString('60', 'TRY'),
            allocationMethod: 'BY_QUANTITY',
          }),
        ],
      },
    })

    const entry = result.supplierResults[0]!
    expect(entry.warnings[0]?.code).toBe('ALLOCATION_UNAVAILABLE')

    const line = entry.lines![0]!
    expect(line.moqApplied).toBe(true)
    expect(line.resolvedQuantity.toDecimalString()).toBe('30')
    expect(line.excessQuantity.toDecimalString()).toBe('20')
    expect(line.settledMerchandiseValue.toDecimalString()).toBe('300')
    // No cost breakdown without a usable weighting — and no invented one.
    expect(line.allocatedCostTotal).toBeUndefined()
    expect(line.settledLandedValue).toBeUndefined()
  })

  it('does not compute an effective landed unit cost', () => {
    // Deliberately absent: the denominator (required vs resolved quantity) is
    // an open product decision. The plumbing above is here so it can be added
    // later without recomputing anything — but nothing derives it silently,
    // and a UI must not either. See docs/CALCULATION_RULES.md.
    const result = comparisonFor(
      { id: 'i1', requirementId: 'r1', price: '2', currency: 'TRY', moq: '200' },
      '105',
    )
    const line = result.supplierResults[0]!.lines![0]!
    expect(Object.keys(line)).not.toContain('effectiveLandedUnitCost')
  })
})
