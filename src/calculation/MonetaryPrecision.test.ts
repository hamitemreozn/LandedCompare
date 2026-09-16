import { describe, expect, it } from 'vitest'
import { allocateAmount, type AllocationTarget } from './Allocation'
import { createAdditionalCost } from './AdditionalCost'
import { calculateSupplierCosts } from './CostCalculation'
import { convertToBaseCurrency } from './CurrencyConversion'
import { PrecisionEnvelopeExceededError } from './CurrencyMinorUnit'
import { ExchangeRate } from './ExchangeRate'
import { ExchangeRateTable } from './ExchangeRateTable'
import { Percentage } from './Percentage'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'
import {
  reference,
  referenceAdd,
  referenceMultiply,
  referencePercentageOf,
  referenceRoundHalfUp,
  referenceSubtract,
  referenceToString,
} from '../domain/monetary/exactReference.testSupport'
import { compareSuppliers } from '../comparison/SupplierComparison'
import {
  baseRateTable,
  project,
  quote,
  quoteItem,
  requirement,
  supplier,
} from '../comparison/testSupport'

/**
 * Monetary precision hardening.
 *
 * decimal.js evaluates *every* arithmetic operation at the configured
 * significant-digit budget — `times`, `plus` and `minus` included — while
 * parsing keeps all the digits a string carries. A valid amount could
 * therefore enter the engine exactly and lose digits on its first
 * multiplication, and the loss surfaced as a settled figure one minor unit
 * away from the truth, with nothing to indicate it.
 *
 * The reproduction that drove this: 12345678901234567890123456789012.34 at
 * 10.005% settled to a cent ending .69 where the mathematics says .68.
 *
 * Every expectation below is checked against `exactReference.testSupport`, a
 * BigInt implementation that shares no code with the engine — see that file
 * for why verifying decimal.js with decimal.js would prove nothing.
 */

const AUDITOR_PRICE = '12345678901234567890123456789012.34'
const AUDITOR_RATE = '10.005'

/** The mathematically exact duty, computed independently of the engine. */
const auditorDuty = referencePercentageOf(reference(AUDITOR_PRICE), reference(AUDITOR_RATE))

function ratesToTRY(rate: string): ExchangeRateTable {
  return ExchangeRateTable.create('TRY', [ExchangeRate.fromString('USD', 'TRY', rate)])
}

function percentageCost(id: string, rate: string) {
  return createAdditionalCost({
    id,
    kind: 'COST',
    category: 'DUTY',
    percentage: { rate: Percentage.fromString(rate), base: 'MERCHANDISE' },
  })
}

describe('the auditor reproduction: a large amount at a fractional percentage', () => {
  it('produces the exact product, not one truncated at the digit budget', () => {
    const duty = Percentage.fromString(AUDITOR_RATE).applyTo(Money.fromString(AUDITOR_PRICE, 'TRY'))

    // Independent reference, and the literal it evaluates to. Before the fix
    // the engine returned ...740.685 — the product had been rounded to 34
    // significant digits before anyone asked for a settlement.
    expect(referenceToString(auditorDuty)).toBe('1235185174068518517406851851740.684617')
    expect(duty.toDecimalString()).toBe(referenceToString(auditorDuty))
  })

  it('settles that product to the correct cent', () => {
    const duty = Percentage.fromString(AUDITOR_RATE).applyTo(Money.fromString(AUDITOR_PRICE, 'TRY'))

    // The whole point of the checkpoint: ...740.68, not ...740.69.
    expect(duty.roundToMinorUnit(2).toDecimalString()).toBe('1235185174068518517406851851740.68')
    expect(duty.roundToMinorUnit(2).toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(auditorDuty, 2)),
    )
  })

  it('carries the correct cent all the way through the cost engine', () => {
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString(AUDITOR_PRICE, 'TRY'),
      costs: [percentageCost('duty', AUDITOR_RATE)],
      exchangeRateTable: ExchangeRateTable.create('TRY'),
      minorUnit: 2,
    })

    const exactTotal = referenceAdd(reference(AUDITOR_PRICE), auditorDuty)
    expect(result.calculatedLandedTotal.toDecimalString()).toBe(referenceToString(exactTotal))
    expect(result.settledLandedTotal.toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(exactTotal, 2)),
    )
    expect(result.settledLandedTotal.toDecimalString()).toBe('13580864075303086407530308640753.02')
    expect(result.entries[0]!.settledEffect.toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(auditorDuty, 2)),
    )
  })
})

describe('large merchandise times a percentage', () => {
  it('matches the reference for a merchandise total built from price x quantity', () => {
    const unitPrice = '1234567890123456789012345678901.234'
    const quantity = '10'
    const merchandiseTotal = Money.fromString(unitPrice, 'TRY').multiply(quantity)

    const exactMerchandise = referenceMultiply(reference(unitPrice), reference(quantity))
    expect(merchandiseTotal.toDecimalString()).toBe(referenceToString(exactMerchandise))

    const result = calculateSupplierCosts({
      merchandiseTotal,
      costs: [percentageCost('duty', AUDITOR_RATE)],
      exchangeRateTable: ExchangeRateTable.create('TRY'),
      minorUnit: 2,
    })

    const exactDuty = referencePercentageOf(exactMerchandise, reference(AUDITOR_RATE))
    const exactTotal = referenceAdd(exactMerchandise, exactDuty)
    expect(result.calculatedLandedTotal.toDecimalString()).toBe(referenceToString(exactTotal))
    expect(result.settledLandedTotal.toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(exactTotal, 2)),
    )
  })
})

describe('currency conversion at full precision', () => {
  it('multiplies a long amount by a long rate exactly', () => {
    const amount = '12345678901234567890.123456789012'
    const rate = '43.567890123456789'

    const converted = convertToBaseCurrency(Money.fromString(amount, 'USD'), ratesToTRY(rate))
    const exact = referenceMultiply(reference(amount), reference(rate))

    // 48 significant digits — far past the 34-digit budget the plain `times`
    // would have rounded the product to.
    expect(converted.toDecimalString()).toBe(referenceToString(exact))
    expect(converted.roundToMinorUnit(2).toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(exact, 2)),
    )
  })

  it('leaves an amount already in the base currency untouched', () => {
    const amount = Money.fromString(AUDITOR_PRICE, 'TRY')
    expect(convertToBaseCurrency(amount, ratesToTRY('43.5')).toDecimalString()).toBe(AUDITOR_PRICE)
  })
})

describe('conversion and percentage together', () => {
  it('settles a quote-currency total converted then charged a duty', () => {
    const amount = '12345678901234567890.123456789012'
    const rate = '43.567890123456789'
    const dutyRate = '7.125'

    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString(amount, 'USD'),
      costs: [percentageCost('duty', dutyRate)],
      exchangeRateTable: ratesToTRY(rate),
      minorUnit: 2,
    })

    const exactBase = referenceMultiply(reference(amount), reference(rate))
    const exactDuty = referencePercentageOf(exactBase, reference(dutyRate))
    const exactTotal = referenceAdd(exactBase, exactDuty)

    expect(result.merchandiseTotal.toDecimalString()).toBe(referenceToString(exactBase))
    expect(result.entries[0]!.baseCurrencyAmount.toDecimalString()).toBe(
      referenceToString(exactDuty),
    )
    expect(result.calculatedLandedTotal.toDecimalString()).toBe(referenceToString(exactTotal))
    expect(result.settledLandedTotal.toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(exactTotal, 2)),
    )
    expect(result.settledLandedTotal.toDecimalString()).toBe('576198788576594623721.82')
  })
})

describe('addition and subtraction near the precision edge', () => {
  it('does not swallow a small amount added to a large one', () => {
    const large = Money.fromString(AUDITOR_PRICE, 'TRY')
    const small = Money.fromString('0.001', 'TRY')

    // Before the fix both of these returned the large amount unchanged: the
    // result needed 35 significant digits and `plus`/`minus` were evaluated
    // at 34.
    expect(large.add(small).toDecimalString()).toBe(
      referenceToString(referenceAdd(reference(AUDITOR_PRICE), reference('0.001'))),
    )
    expect(large.subtract(small).toDecimalString()).toBe(
      referenceToString(referenceSubtract(reference(AUDITOR_PRICE), reference('0.001'))),
    )
    expect(large.add(small).toDecimalString()).toBe('12345678901234567890123456789012.341')
  })

  it('keeps every cent when amounts of very different sizes are summed', () => {
    const parts = ['9999999999999999999999999999999.99', '0.01', '0.01', '0.01', '0.01']
    const summed = parts.reduce(
      (total, part) => total.add(Money.fromString(part, 'TRY')),
      Money.zero('TRY'),
    )
    const exact = parts.reduce((total, part) => referenceAdd(total, reference(part)), reference('0'))
    expect(summed.toDecimalString()).toBe(referenceToString(exact))
    expect(summed.toDecimalString()).toBe('10000000000000000000000000000000.03')
  })
})

describe('minor-unit variants', () => {
  it.each([0, 2, 3])('settles the auditor duty correctly at %i minor-unit digit(s)', (minorUnit) => {
    const duty = Percentage.fromString(AUDITOR_RATE).applyTo(Money.fromString(AUDITOR_PRICE, 'TRY'))
    expect(duty.roundToMinorUnit(minorUnit).toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(auditorDuty, minorUnit)),
    )
  })

  it('settles a 0-decimal currency without inventing a fractional unit', () => {
    const merchandise = '12345678901234567890123456789012'
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString(merchandise, 'JPY'),
      costs: [percentageCost('duty', AUDITOR_RATE)],
      exchangeRateTable: ExchangeRateTable.create('JPY'),
      minorUnit: 0,
    })

    const exactTotal = referenceAdd(
      reference(merchandise),
      referencePercentageOf(reference(merchandise), reference(AUDITOR_RATE)),
    )
    expect(result.settledLandedTotal.toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(exactTotal, 0)),
    )
    expect(result.settledLandedTotal.toDecimalString()).not.toContain('.')
  })

  it('settles a 3-decimal currency at its own scale', () => {
    const merchandise = '1234567890123456789012345678.905'
    const result = calculateSupplierCosts({
      merchandiseTotal: Money.fromString(merchandise, 'BHD'),
      costs: [percentageCost('duty', AUDITOR_RATE)],
      exchangeRateTable: ExchangeRateTable.create('BHD'),
      minorUnit: 3,
    })

    const exactTotal = referenceAdd(
      reference(merchandise),
      referencePercentageOf(reference(merchandise), reference(AUDITOR_RATE)),
    )
    expect(result.calculatedLandedTotal.toDecimalString()).toBe(referenceToString(exactTotal))
    expect(result.settledLandedTotal.toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(exactTotal, 3)),
    )
  })
})

/**
 * The supported settlement domain is unchanged by this checkpoint:
 * `integerDigits + minorUnit <= DECIMAL_PRECISION (34)`. What changed is that
 * it is now a *truthful* promise — everything inside it settles to the
 * mathematically correct minor unit, where before an accepted input could
 * still come out a cent wrong.
 */
describe('the precision envelope, pinned on both sides', () => {
  const targets: AllocationTarget[] = ['a', 'b', 'c'].map((id) => ({
    id,
    merchandiseValue: Money.fromString('1', 'TRY'),
    quantity: Quantity.fromString('1'),
    comparisonUnit: 'pcs',
  }))

  it('accepts and settles correctly at exactly 34 (32 integer digits + 2)', () => {
    const atEdge = '12345678901234567890123456789012.34'
    const result = allocateAmount(Money.fromString(atEdge, 'TRY'), targets, 'EQUAL_PER_LINE', 2)
    const sum = result.allocations.reduce((total, a) => total.add(a.amount), Money.zero('TRY'))
    expect(sum.toDecimalString()).toBe(result.settledAmount.toDecimalString())
    expect(result.settledAmount.toDecimalString()).toBe(atEdge)

    // The same boundary through the cost engine: merchandise plus every cost
    // magnitude still lands on 32 integer digits here.
    const costed = calculateSupplierCosts({
      merchandiseTotal: Money.fromString(atEdge, 'TRY'),
      costs: [percentageCost('duty', AUDITOR_RATE)],
      exchangeRateTable: ExchangeRateTable.create('TRY'),
      minorUnit: 2,
    })
    expect(costed.settledLandedTotal.toDecimalString()).toBe('13580864075303086407530308640753.02')
  })

  it('rejects the very next digit — 35 (33 integer digits + 2) — by name', () => {
    const pastEdge = '123456789012345678901234567890123.45'
    expect(() =>
      allocateAmount(Money.fromString(pastEdge, 'TRY'), targets, 'EQUAL_PER_LINE', 2),
    ).toThrow(PrecisionEnvelopeExceededError)

    expect(() =>
      calculateSupplierCosts({
        merchandiseTotal: Money.fromString(pastEdge, 'TRY'),
        costs: [],
        exchangeRateTable: ExchangeRateTable.create('TRY'),
        minorUnit: 2,
      }),
    ).toThrow(PrecisionEnvelopeExceededError)
  })

  it('moves the boundary with the minor unit, not with the amount alone', () => {
    // 32 integer digits is inside the envelope at 2 minor-unit digits and
    // outside it at 3 — the boundary is about digits, not about how much
    // money it is.
    const amount = Money.fromString('12345678901234567890123456789012.345', 'TRY')
    expect(() => allocateAmount(amount, targets, 'EQUAL_PER_LINE', 3)).toThrow(
      PrecisionEnvelopeExceededError,
    )
  })
})

describe('exactCalculatedLandedTotal is the exact economic total', () => {
  it('matches an independently computed exact total, digit for digit', () => {
    const unitPrice = '1234567890123456789012345678901.234'
    const result = compareSuppliers({
      project: project({
        baseCurrency: 'TRY',
        requirements: [requirement('r1', { requiredQuantity: '10' })],
        suppliers: [supplier('s1')],
        quotes: [
          quote({
            id: 'q1',
            supplierId: 's1',
            currency: 'TRY',
            items: [quoteItem({ id: 'i1', requirementId: 'r1', price: unitPrice, currency: 'TRY' })],
          }),
        ],
      }),
      exchangeRateTable: baseRateTable('TRY'),
      costsBySupplierId: { s1: [percentageCost('duty', AUDITOR_RATE)] },
    })

    const only = result.supplierResults[0]!
    expect(only.status).toBe('COMPLETE')

    const exactMerchandise = referenceMultiply(reference(unitPrice), reference('10'))
    const exactTotal = referenceAdd(
      exactMerchandise,
      referencePercentageOf(exactMerchandise, reference(AUDITOR_RATE)),
    )

    // "Exact" means exact: the full economic decimal, not a 34-digit
    // approximation of it that happens to be labelled exact.
    expect(only.exactCalculatedLandedTotal!.toDecimalString()).toBe(referenceToString(exactTotal))
    expect(only.rankingAmount!.toDecimalString()).toBe(
      referenceToString(referenceRoundHalfUp(exactTotal, 2)),
    )
    expect(only.rankingAmount!.toDecimalString()).toBe(
      only.exactCalculatedLandedTotal!.roundToMinorUnit(2).toDecimalString(),
    )
  })
})
