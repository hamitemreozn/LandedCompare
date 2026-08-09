import { describe, expect, it } from 'vitest'
import {
  InvalidMoqError,
  InvalidPackSizeError,
  resolveOrderQuantity,
  type QuantityResolutionInput,
} from './QuantityResolution'
import { calculateLineSubtotal, type MerchandiseLine } from './MerchandiseCalculation'
import { Quantity, InvalidQuantityError } from '../domain/quantity/Quantity'
import { InvalidDecimalError } from '../domain/monetary/decimal'
import { Money } from '../domain/monetary/Money'

function resolve(requiredQuantity: string, moq?: string, unitsPerQuotedUnit?: string) {
  const input: QuantityResolutionInput = {
    requiredQuantity: Quantity.fromString(requiredQuantity),
    moq: moq === undefined ? undefined : Quantity.fromString(moq),
    unitsPerQuotedUnit:
      unitsPerQuotedUnit === undefined ? undefined : Quantity.fromString(unitsPerQuotedUnit),
  }
  return resolveOrderQuantity(input)
}

describe('resolveOrderQuantity', () => {
  it('resolves to the required quantity when there is no MOQ or pack', () => {
    const result = resolve('100')
    expect(result.resolvedQuantity.toDecimalString()).toBe('100')
    expect(result.quotedUnitQuantity.toDecimalString()).toBe('100')
    expect(result.excessQuantity.toDecimalString()).toBe('0')
    expect(result.moqApplied).toBe(false)
    expect(result.packApplied).toBe(false)
  })

  it('keeps the required quantity when MOQ is below it', () => {
    const result = resolve('100', '50')
    expect(result.resolvedQuantity.toDecimalString()).toBe('100')
    expect(result.moqApplied).toBe(false)
    expect(result.excessQuantity.toDecimalString()).toBe('0')
  })

  it('raises the resolved quantity to MOQ when MOQ exceeds the requirement', () => {
    const result = resolve('100', '150')
    expect(result.resolvedQuantity.toDecimalString()).toBe('150')
    expect(result.moqApplied).toBe(true)
    expect(result.excessQuantity.toDecimalString()).toBe('50')
  })

  it('resolves an exact pack with no rounding (100 pcs, 10 pcs/box)', () => {
    const result = resolve('100', undefined, '10')
    expect(result.quotedUnitQuantity.toDecimalString()).toBe('10')
    expect(result.resolvedQuantity.toDecimalString()).toBe('100')
    expect(result.excessQuantity.toDecimalString()).toBe('0')
    expect(result.packApplied).toBe(true)
  })

  it('rounds a fractional pack up to the next whole quoted unit (105 pcs, 10 pcs/box)', () => {
    const result = resolve('105', undefined, '10')
    expect(result.quotedUnitQuantity.toDecimalString()).toBe('11')
    expect(result.resolvedQuantity.toDecimalString()).toBe('110')
    expect(result.excessQuantity.toDecimalString()).toBe('5')
  })

  it('applies MOQ before an exact pack (105 required, MOQ 120, 10 pcs/box -> 120)', () => {
    const result = resolve('105', '120', '10')
    expect(result.quotedUnitQuantity.toDecimalString()).toBe('12')
    expect(result.resolvedQuantity.toDecimalString()).toBe('120')
    expect(result.moqApplied).toBe(true)
    expect(result.excessQuantity.toDecimalString()).toBe('15')
  })

  it('applies MOQ before pack rounding (105 required, MOQ 123, 10 pcs/box -> 130)', () => {
    const result = resolve('105', '123', '10')
    expect(result.quotedUnitQuantity.toDecimalString()).toBe('13')
    expect(result.resolvedQuantity.toDecimalString()).toBe('130')
    expect(result.moqApplied).toBe(true)
    expect(result.excessQuantity.toDecimalString()).toBe('25')
  })

  it('preserves a decimal required quantity when there is no pack (2.5 kg)', () => {
    const result = resolve('2.5')
    expect(result.resolvedQuantity.toDecimalString()).toBe('2.5')
    expect(result.quotedUnitQuantity.toDecimalString()).toBe('2.5')
    expect(result.excessQuantity.toDecimalString()).toBe('0')
  })

  it('rejects a zero MOQ - "no MOQ" must be expressed as undefined, not zero', () => {
    expect(() =>
      resolveOrderQuantity({
        requiredQuantity: Quantity.fromString('100'),
        moq: Quantity.fromString('0'),
      }),
    ).toThrow(InvalidMoqError)
  })

  it('rejects a negative MOQ at Quantity construction, before resolution ever runs', () => {
    expect(() => Quantity.fromString('-1')).toThrow(InvalidQuantityError)
  })

  it('rejects a zero units-per-quoted-unit - "no pack" must be expressed as undefined, not zero', () => {
    expect(() =>
      resolveOrderQuantity({
        requiredQuantity: Quantity.fromString('100'),
        unitsPerQuotedUnit: Quantity.fromString('0'),
      }),
    ).toThrow(InvalidPackSizeError)
  })

  it('rejects a negative units-per-quoted-unit at Quantity construction', () => {
    expect(() => Quantity.fromString('-10')).toThrow(InvalidQuantityError)
  })

  it('rejects a malformed units-per-quoted-unit at Quantity construction', () => {
    expect(() => Quantity.fromString('not-a-number')).toThrow(InvalidDecimalError)
  })

  it('computes excess quantity as resolved minus required, never negative', () => {
    const noExcess = resolve('100', '50')
    expect(noExcess.excessQuantity.isZero()).toBe(true)

    const withExcess = resolve('100', '150')
    expect(withExcess.excessQuantity.toDecimalString()).toBe('50')
  })

  it('keeps pack multiplication exact where native floating point would drift (3 x 0.1)', () => {
    const result = resolve('0.3', undefined, '0.1')
    expect(result.quotedUnitQuantity.toDecimalString()).toBe('3')
    expect(result.resolvedQuantity.toDecimalString()).toBe('0.3')
    expect(result.excessQuantity.toDecimalString()).toBe('0')
  })

  it('preserves precision for large quantities without overflow', () => {
    const result = resolve('123456789123456789.123456789', '200000000000000000')
    expect(result.moqApplied).toBe(true)
    expect(result.resolvedQuantity.toDecimalString()).toBe('200000000000000000')
    expect(result.excessQuantity.toDecimalString()).toBe('76543210876543210.876543211')
  })
})

describe('Phase 2 integration', () => {
  it('feeds a pack-resolved quoted-unit quantity into the merchandise line subtotal (105 pcs, 10 pcs/box, 70 USD/box)', () => {
    const resolution = resolveOrderQuantity({
      requiredQuantity: Quantity.fromString('105'),
      unitsPerQuotedUnit: Quantity.fromString('10'),
    })
    expect(resolution.quotedUnitQuantity.toDecimalString()).toBe('11')
    expect(resolution.resolvedQuantity.toDecimalString()).toBe('110')

    const line: MerchandiseLine = {
      unitPrice: Money.fromString('70', 'USD'),
      calculationQuantity: resolution.quotedUnitQuantity,
    }
    expect(calculateLineSubtotal(line).toDecimalString()).toBe('770')
  })

  it('feeds the resolved comparison-unit quantity straight through when there is no pack', () => {
    const resolution = resolveOrderQuantity({
      requiredQuantity: Quantity.fromString('100'),
      moq: Quantity.fromString('150'),
    })
    const line: MerchandiseLine = {
      unitPrice: Money.fromString('9', 'USD'),
      calculationQuantity: resolution.quotedUnitQuantity,
    }
    expect(calculateLineSubtotal(line).toDecimalString()).toBe('1350')
  })
})

/**
 * MOQ trap golden scenario (see docs/CALCULATION_RULES.md): proves that a
 * lower quoted unit price does not always mean a lower actual purchase cost
 * once MOQ is applied. This test only pins the two merchandise totals - it
 * does not rank suppliers or decide a winner (Phase 5 scope).
 *
 * Supplier A: 100 pcs required, MOQ 100 (no excess), 11 USD/pcs -> 1100 USD
 * Supplier B: 100 pcs required, MOQ 150 (50 pcs excess), 9 USD/pcs -> 1350 USD
 */
describe('MOQ trap golden scenario', () => {
  it('matches the hand-computed reference totals exactly', () => {
    const supplierA = resolveOrderQuantity({
      requiredQuantity: Quantity.fromString('100'),
      moq: Quantity.fromString('100'),
    })
    const supplierB = resolveOrderQuantity({
      requiredQuantity: Quantity.fromString('100'),
      moq: Quantity.fromString('150'),
    })

    expect(supplierA.resolvedQuantity.toDecimalString()).toBe('100')
    expect(supplierB.resolvedQuantity.toDecimalString()).toBe('150')

    const totalA = calculateLineSubtotal({
      unitPrice: Money.fromString('11', 'USD'),
      calculationQuantity: supplierA.quotedUnitQuantity,
    })
    const totalB = calculateLineSubtotal({
      unitPrice: Money.fromString('9', 'USD'),
      calculationQuantity: supplierB.quotedUnitQuantity,
    })

    expect(totalA.toDecimalString()).toBe('1100')
    expect(totalB.toDecimalString()).toBe('1350')
    expect(totalA.isLessThan(totalB)).toBe(true)
  })
})
