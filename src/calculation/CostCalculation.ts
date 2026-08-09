import type { CurrencyCode } from '../domain/monetary/CurrencyCode'
import { Money } from '../domain/monetary/Money'
import {
  allocateAmount,
  type Allocation,
  type AllocationMethod,
  type AllocationTarget,
} from './Allocation'
import {
  evaluationStageOf,
  InvalidCostDefinitionError,
  InvalidDiscountError,
  InvalidPercentageBaseError,
  type AdditionalCost,
  type CostCategory,
  type CostEvaluationStage,
  type CostKind,
  type PercentageBase,
} from './AdditionalCost'
import { convertToBaseCurrency } from './CurrencyConversion'
import { resolveMinorUnit, type MinorUnitOverrides } from './CurrencyMinorUnit'
import type { ExchangeRateTable } from './ExchangeRateTable'

export type CostBasisType = 'FIXED' | 'PERCENTAGE'

/**
 * Why an entry did not reach the landed total. The two reasons are
 * independent and are checked in a fixed order: `alreadyIncludedInQuote` is
 * a statement about where the money already is, `includeInComparison` is a
 * user preference about what to compare, so the structural fact is reported
 * first when both apply.
 */
export type CostExclusionReason = 'ALREADY_INCLUDED_IN_QUOTE' | 'EXCLUDED_FROM_COMPARISON'

/**
 * One evaluated cost/discount/surcharge, carrying everything needed to
 * explain the number without recomputing it. This is structured data, not
 * display text — no strings are formatted for a UI anywhere in this engine.
 */
export interface AppliedCostEntry {
  readonly id: string
  readonly kind: CostKind
  readonly category: CostCategory
  readonly label?: string
  readonly stage: CostEvaluationStage
  readonly basis: CostBasisType
  /** For a fixed entry: the amount exactly as entered, in its own currency. */
  readonly originalAmount?: Money
  /** For a percentage entry: the rate as entered, e.g. "5" for 5%. */
  readonly percentageRate?: string
  readonly percentageBase?: PercentageBase
  /** For a percentage entry: the resolved base amount the rate was applied to. */
  readonly percentageBaseAmount?: Money
  /** Magnitude in base currency, never negative, regardless of kind. */
  readonly baseCurrencyAmount: Money
  /**
   * What this entry actually contributed to the landed total: positive for a
   * cost or surcharge, negative for a discount, and exactly zero when the
   * entry does not contribute. Summing this field over every entry and adding
   * the merchandise total reproduces `calculatedLandedTotal`.
   */
  readonly signedEffect: Money
  readonly contributes: boolean
  readonly exclusionReason?: CostExclusionReason
  readonly allocationMethod: AllocationMethod
}

/**
 * The three approved percentage bases, all resolved. Exposed in full even
 * when no entry uses one, so a breakdown can show what a rate was taken on.
 */
export interface PercentageBaseAmounts {
  readonly merchandise: Money
  readonly merchandiseAfterDiscount: Money
  readonly merchandisePlusFreightInsurance: Money
}

export interface SupplierCostCalculationInput {
  /**
   * The quote's merchandise total (Phase 2/3 output). Converted into the rate
   * table's base currency if it is not already in it — the whole cost engine
   * works in base currency.
   */
  readonly merchandiseTotal: Money
  readonly costs: readonly AdditionalCost[]
  readonly exchangeRateTable: ExchangeRateTable
}

export interface SupplierCostCalculationResult {
  readonly baseCurrency: CurrencyCode
  readonly merchandiseTotal: Money
  readonly percentageBases: PercentageBaseAmounts
  /** Every entry, in the order the costs were supplied. */
  readonly entries: readonly AppliedCostEntry[]
  readonly appliedEntries: readonly AppliedCostEntry[]
  readonly alreadyIncludedEntries: readonly AppliedCostEntry[]
  readonly excludedEntries: readonly AppliedCostEntry[]
  /** Magnitudes of the contributing entries of each kind. */
  readonly totalDiscounts: Money
  readonly totalSurcharges: Money
  readonly totalAdditionalCosts: Money
  readonly calculatedLandedTotal: Money
}

/**
 * Applies a supplier's additional costs and adjustments to its merchandise
 * total and produces a traceable landed total.
 *
 * Evaluation runs in fixed stages, and a stage may only reference amounts
 * that earlier stages finalised. That ordering — not a dependency graph — is
 * what makes circular percentage bases impossible:
 *
 * 1. merchandise total (input, converted to base currency);
 * 2. discounts, then `merchandiseAfterDiscount`;
 * 3. freight and insurance costs, then `merchandisePlusFreightInsurance`;
 * 4. all other costs;
 * 5. surcharges;
 * 6. `landedTotal = merchandiseTotal + sum of every contributing signed effect`.
 *
 * Fixed costs depend on nothing, so their position among stages 3–5 cannot
 * change any result; they are grouped by category only so that freight and
 * insurance are final before the CIF-like base is assembled.
 *
 * Nothing here rounds. The landed total keeps full calculation precision —
 * allocation (`allocateSupplierCosts`) is the only settlement boundary in
 * this phase.
 */
export function calculateSupplierCosts(
  input: SupplierCostCalculationInput,
): SupplierCostCalculationResult {
  const { costs, exchangeRateTable } = input
  const baseCurrency = exchangeRateTable.baseCurrency
  const zero = Money.zero(baseCurrency)

  assertUniqueCostIds(costs)

  const merchandiseTotal = convertToBaseCurrency(input.merchandiseTotal, exchangeRateTable)
  if (merchandiseTotal.isNegative()) {
    throw new InvalidPercentageBaseError(
      `Merchandise total ${merchandiseTotal.toDecimalString()} ${baseCurrency} is negative; every percentage base derived from it would be negative`,
    )
  }

  const staged = groupByStage(costs)
  const entries = new Array<AppliedCostEntry>(costs.length)

  const evaluateStage = (
    stage: CostEvaluationStage,
    bases: AvailableBases,
  ): readonly AppliedCostEntry[] =>
    staged[stage].map(({ cost, index }) => {
      const entry = evaluateEntry(cost, stage, bases, exchangeRateTable, baseCurrency)
      entries[index] = entry
      return entry
    })

  // Stage 2 — discounts. Only the merchandise total exists yet.
  const discountEntries = evaluateStage('DISCOUNT', { MERCHANDISE: merchandiseTotal })
  const totalDiscounts = sumMagnitudes(discountEntries, zero)
  if (totalDiscounts.isGreaterThan(merchandiseTotal)) {
    throw new InvalidDiscountError(
      `Discounts totalling ${totalDiscounts.toDecimalString()} ${baseCurrency} exceed the merchandise total of ${merchandiseTotal.toDecimalString()} ${baseCurrency}; the discounted merchandise base would be negative`,
    )
  }
  const merchandiseAfterDiscount = merchandiseTotal.subtract(totalDiscounts)

  // Stage 3 — freight and insurance, the components of the CIF-like base.
  const freightInsuranceEntries = evaluateStage('FREIGHT_INSURANCE', {
    MERCHANDISE: merchandiseTotal,
    MERCHANDISE_AFTER_DISCOUNT: merchandiseAfterDiscount,
  })
  const merchandisePlusFreightInsurance = merchandiseAfterDiscount.add(
    sumMagnitudes(freightInsuranceEntries, zero),
  )

  const allBases: AvailableBases = {
    MERCHANDISE: merchandiseTotal,
    MERCHANDISE_AFTER_DISCOUNT: merchandiseAfterDiscount,
    MERCHANDISE_PLUS_FREIGHT_INSURANCE: merchandisePlusFreightInsurance,
  }

  // Stages 4 and 5 — every remaining cost, then surcharges.
  const otherCostEntries = evaluateStage('OTHER_COST', allBases)
  const surchargeEntries = evaluateStage('SURCHARGE', allBases)

  const calculatedLandedTotal = entries.reduce(
    (total, entry) => total.add(entry.signedEffect),
    merchandiseTotal,
  )

  return {
    baseCurrency,
    merchandiseTotal,
    percentageBases: {
      merchandise: merchandiseTotal,
      merchandiseAfterDiscount,
      merchandisePlusFreightInsurance,
    },
    entries,
    appliedEntries: entries.filter((entry) => entry.contributes),
    alreadyIncludedEntries: entries.filter(
      (entry) => entry.exclusionReason === 'ALREADY_INCLUDED_IN_QUOTE',
    ),
    excludedEntries: entries.filter(
      (entry) => entry.exclusionReason === 'EXCLUDED_FROM_COMPARISON',
    ),
    totalDiscounts,
    totalSurcharges: sumMagnitudes(surchargeEntries, zero),
    totalAdditionalCosts: sumMagnitudes([...freightInsuranceEntries, ...otherCostEntries], zero),
    calculatedLandedTotal,
  }
}

export interface CostAllocationBreakdown {
  readonly entryId: string
  readonly kind: CostKind
  readonly category: CostCategory
  readonly method: AllocationMethod
  /** The entry's signed effect at full precision. */
  readonly exactAmount: Money
  /** The same amount settled to the base currency's minor unit. `allocations` sum to exactly this. */
  readonly settledAmount: Money
  readonly allocations: readonly Allocation[]
}

export interface LineAllocatedCost {
  readonly targetId: string
  /** Signed sum of every allocated entry on this line: costs positive, discounts negative. */
  readonly allocatedCostTotal: Money
}

export interface SupplierCostAllocationInput {
  readonly costResult: SupplierCostCalculationResult
  /** The lines to spread shared amounts over. Array order is the tie-break order. */
  readonly targets: readonly AllocationTarget[]
  readonly exchangeRateTable: ExchangeRateTable
  readonly minorUnitOverrides?: MinorUnitOverrides
}

export interface SupplierCostAllocationResult {
  readonly baseCurrency: CurrencyCode
  readonly minorUnit: number
  readonly byEntry: readonly CostAllocationBreakdown[]
  readonly byLine: readonly LineAllocatedCost[]
}

/**
 * Spreads a supplier's contributing costs and adjustments across its lines,
 * one entry at a time, using each entry's own allocation method.
 *
 * Only contributing entries are allocated. An entry excluded from the landed
 * total contributes nothing, so giving lines a share of it would put money on
 * a line that the total never counted.
 *
 * This produces the item-level *allocated amount* foundation only. The
 * effective landed unit cost metric built on top of it belongs to the results
 * phase, not here.
 */
export function allocateSupplierCosts(
  input: SupplierCostAllocationInput,
): SupplierCostAllocationResult {
  const { costResult, targets, exchangeRateTable, minorUnitOverrides } = input
  const baseCurrency = costResult.baseCurrency
  const zero = Money.zero(baseCurrency)

  assertUniqueTargetIds(targets)
  const minorUnit = resolveMinorUnit(baseCurrency, minorUnitOverrides)

  const lineTotals = new Map<string, Money>(targets.map((target) => [target.id, zero]))
  const lineDiscounts = new Map<string, Money>(targets.map((target) => [target.id, zero]))

  const byEntry = costResult.appliedEntries.map<CostAllocationBreakdown>((entry) => {
    const allocated = allocateAmount(entry.signedEffect, targets, entry.allocationMethod, minorUnit)

    for (const allocation of allocated.allocations) {
      const previousTotal = lineTotals.get(allocation.targetId) ?? zero
      lineTotals.set(allocation.targetId, previousTotal.add(allocation.amount))
      if (entry.kind === 'DISCOUNT') {
        const previousDiscount = lineDiscounts.get(allocation.targetId) ?? zero
        lineDiscounts.set(allocation.targetId, previousDiscount.add(allocation.amount))
      }
    }

    return {
      entryId: entry.id,
      kind: entry.kind,
      category: entry.category,
      method: allocated.method,
      exactAmount: allocated.exactAmount,
      settledAmount: allocated.settledAmount,
      allocations: allocated.allocations,
    }
  })

  assertDiscountsFitEachLine(targets, lineDiscounts, exchangeRateTable, baseCurrency)

  return {
    baseCurrency,
    minorUnit,
    byEntry,
    byLine: targets.map((target) => ({
      targetId: target.id,
      allocatedCostTotal: lineTotals.get(target.id) ?? zero,
    })),
  }
}

type AvailableBases = Partial<Record<PercentageBase, Money>>

interface StagedCost {
  readonly cost: AdditionalCost
  readonly index: number
}

function groupByStage(
  costs: readonly AdditionalCost[],
): Readonly<Record<CostEvaluationStage, readonly StagedCost[]>> {
  const staged: Record<CostEvaluationStage, StagedCost[]> = {
    DISCOUNT: [],
    FREIGHT_INSURANCE: [],
    OTHER_COST: [],
    SURCHARGE: [],
  }
  costs.forEach((cost, index) => {
    staged[evaluationStageOf(cost)].push({ cost, index })
  })
  return staged
}

function evaluateEntry(
  cost: AdditionalCost,
  stage: CostEvaluationStage,
  bases: AvailableBases,
  exchangeRateTable: ExchangeRateTable,
  baseCurrency: CurrencyCode,
): AppliedCostEntry {
  const zero = Money.zero(baseCurrency)
  const { contributes, exclusionReason } = classifyContribution(cost)

  const common = {
    id: cost.id,
    kind: cost.kind,
    category: cost.category,
    label: cost.label,
    stage,
    contributes,
    exclusionReason,
    allocationMethod: cost.allocationMethod,
  }

  // Every entry is converted and evaluated, contributing or not, so the
  // breakdown can show an excluded cost in the same currency as the rest. A
  // missing exchange rate therefore blocks the calculation even for a cost
  // that would not have reached the total — the same stance Phase 2 takes.
  if (cost.fixedAmount !== undefined) {
    const baseCurrencyAmount = convertToBaseCurrency(cost.fixedAmount, exchangeRateTable)
    return {
      ...common,
      basis: 'FIXED',
      originalAmount: cost.fixedAmount,
      baseCurrencyAmount,
      signedEffect: signedEffectOf(cost.kind, baseCurrencyAmount, contributes, zero),
    }
  }

  if (cost.percentage !== undefined) {
    const percentageBaseAmount = bases[cost.percentage.base]
    if (percentageBaseAmount === undefined) {
      throw new InvalidPercentageBaseError(
        `Percentage base "${cost.percentage.base}" is not resolved at stage ${stage} for cost "${cost.id}"`,
      )
    }
    const baseCurrencyAmount = cost.percentage.rate.applyTo(percentageBaseAmount)
    return {
      ...common,
      basis: 'PERCENTAGE',
      percentageRate: cost.percentage.rate.toDecimalString(),
      percentageBase: cost.percentage.base,
      percentageBaseAmount,
      baseCurrencyAmount,
      signedEffect: signedEffectOf(cost.kind, baseCurrencyAmount, contributes, zero),
    }
  }

  throw new InvalidCostDefinitionError(
    `Cost "${cost.id}" has neither a fixed amount nor a percentage`,
  )
}

function signedEffectOf(
  kind: CostKind,
  magnitude: Money,
  contributes: boolean,
  zero: Money,
): Money {
  if (!contributes || magnitude.isZero()) {
    return zero
  }
  return kind === 'DISCOUNT' ? magnitude.negate() : magnitude
}

function classifyContribution(cost: AdditionalCost): {
  contributes: boolean
  exclusionReason?: CostExclusionReason
} {
  if (cost.alreadyIncludedInQuote) {
    return { contributes: false, exclusionReason: 'ALREADY_INCLUDED_IN_QUOTE' }
  }
  if (!cost.includeInComparison) {
    return { contributes: false, exclusionReason: 'EXCLUDED_FROM_COMPARISON' }
  }
  return { contributes: true }
}

/** Sums the magnitudes of the contributing entries only. */
function sumMagnitudes(entries: readonly AppliedCostEntry[], zero: Money): Money {
  return entries.reduce(
    (total, entry) => (entry.contributes ? total.add(entry.baseCurrencyAmount) : total),
    zero,
  )
}

/**
 * A line's allocated discount must not exceed that line's own merchandise
 * value. With `BY_MERCHANDISE_VALUE` this holds automatically once total
 * discounts fit the merchandise total, but a flat or quantity-weighted split
 * can push a small line negative. Rather than clamp that line — which would
 * break the "allocations sum to the original amount" invariant and require
 * inventing a redistribution rule — the configuration is rejected.
 */
function assertDiscountsFitEachLine(
  targets: readonly AllocationTarget[],
  lineDiscounts: ReadonlyMap<string, Money>,
  exchangeRateTable: ExchangeRateTable,
  baseCurrency: CurrencyCode,
): void {
  for (const target of targets) {
    const discount = lineDiscounts.get(target.id)
    if (discount === undefined || discount.isZero()) {
      continue
    }
    const lineMerchandiseValue = convertToBaseCurrency(target.merchandiseValue, exchangeRateTable)
    if (discount.abs().isGreaterThan(lineMerchandiseValue)) {
      throw new InvalidDiscountError(
        `Allocated discount ${discount.abs().toDecimalString()} ${baseCurrency} on line "${target.id}" exceeds that line's merchandise value ${lineMerchandiseValue.toDecimalString()} ${baseCurrency}; choose a proportional allocation method or reduce the discount`,
      )
    }
  }
}

function assertUniqueCostIds(costs: readonly AdditionalCost[]): void {
  const seen = new Set<string>()
  for (const cost of costs) {
    if (seen.has(cost.id)) {
      throw new InvalidCostDefinitionError(`Duplicate cost id "${cost.id}"`)
    }
    seen.add(cost.id)
  }
}

function assertUniqueTargetIds(targets: readonly AllocationTarget[]): void {
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.id)) {
      throw new InvalidCostDefinitionError(`Duplicate allocation target id "${target.id}"`)
    }
    seen.add(target.id)
  }
}
