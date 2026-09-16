import type { CurrencyCode } from '../domain/monetary/CurrencyCode'
import { Money } from '../domain/monetary/Money'
import {
  allocateAmount,
  AllocationInvariantError,
  exactAllocationShares,
  IncompatibleAllocationUnitsError,
  InvalidAllocationBaseError,
  settleTotalAcrossParts,
  type Allocation,
  type AllocationMethod,
  type AllocationTarget,
  type ExactAllocationShare,
} from './Allocation'
import {
  assertValidAdditionalCost,
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
import { assertSettleableAtMinorUnit } from './CurrencyMinorUnit'
import type { ExchangeRateTable } from './ExchangeRateTable'

export type CostBasisType = 'FIXED' | 'PERCENTAGE'

/**
 * An internal assertion: the displayed components failed to add back up to
 * the authoritative settled total. That would mean the user could be shown a
 * header and a breakdown that disagree, which is exactly what anchoring the
 * total and reconciling the parts exists to prevent — so it is loud, not
 * silently absorbed into whichever component happens to be last.
 *
 * It is deliberately **not** on `EXPECTED_CALCULATION_ERRORS` in
 * `SupplierEvaluation.ts`: an engine-correctness bug must never be relabelled
 * as "this supplier's data is invalid".
 */
export class SettlementReconciliationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementReconciliationError'
  }
}

/**
 * A discount's per-line financial validity could not be **established** —
 * distinct from `InvalidDiscountError`, which says it was established and the
 * discount failed it.
 *
 * It is raised when a non-zero discount's own weighting is unusable (mixed
 * comparison units under `BY_QUANTITY`, a zero base), so no share can be
 * computed and "does this discount exceed a line's merchandise value?" has no
 * answer. An unanswerable financial check is not a passing one, so the
 * supplier is `INVALID`.
 *
 * The same underlying weighting failure means something entirely different
 * for an ordinary freight cost, where it only costs the user a per-line
 * *explanation* and leaves the landed total intact. Wrapping it in a distinct
 * error at the discount-validation boundary is what keeps the two apart: it
 * can no longer be mistaken for `ALLOCATION_UNAVAILABLE` by the explanatory
 * pass's warning path, because it never travels that path. See
 * `validateDiscountLineAllocations`.
 */
export class DiscountAllocationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscountAllocationValidationError'
  }
}

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
  /**
   * This entry's share of the settled cost effects, at the base currency's
   * minor unit. Summing it over every entry and adding
   * `settledMerchandiseTotal` reproduces `settledLandedTotal` exactly — that
   * reconciliation is what this field is *for*, and it is why the value is
   * not simply `roundHalfUp(signedEffect)`: separately rounded components do
   * not add up to the rounded total, and it is the total that is
   * authoritative.
   *
   * It stays within a minor unit of the entry's own rounded effect, never
   * crosses zero (a cost cannot settle negative, a discount cannot settle
   * positive), and is exactly zero for an entry that does not contribute. The
   * allocator settles each entry to this same figure, so an entry's per-line
   * allocations always sum to it. See "Authoritative commercial total" in
   * docs/CALCULATION_RULES.md.
   */
  readonly settledEffect: Money
  readonly contributes: boolean
  readonly exclusionReason?: CostExclusionReason
  /**
   * Whether this entry's amount is part of the economic reality the
   * percentage bases are built from — `true` unless the quoted price already
   * contains it.
   *
   * This is deliberately *not* the same question as `contributes`.
   * `includeInComparison: false` says "don't add this to the total I am
   * comparing"; it does not say the money stopped existing, so a freight cost
   * the user excluded still belongs in a CIF-like duty base, and a discount
   * the user excluded still lowers the base a duty is taken on.
   * `alreadyIncludedInQuote: true` is the opposite kind of statement — the
   * amount is already inside the merchandise price, so counting it again in a
   * base derived from that price would double it.
   */
  readonly affectsPercentageBases: boolean
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
  /**
   * The base currency's minor-unit scale, resolved by the caller
   * (`resolveMinorUnit`). Required, not optional: the settled commercial
   * total this engine publishes is what the user is shown and what ranking
   * uses, so there is exactly one place the scale is decided and every
   * settled figure in the result derives from it.
   */
  readonly minorUnit: number
}

export interface SupplierCostCalculationResult {
  readonly baseCurrency: CurrencyCode
  readonly minorUnit: number
  readonly merchandiseTotal: Money
  /** `merchandiseTotal` settled to the base currency's minor unit. */
  readonly settledMerchandiseTotal: Money
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
  /**
   * Magnitude of every discount that lowers the percentage bases — i.e. every
   * discount not already inside the quoted price, whether or not the user
   * excluded it from the comparison total. Equals `totalDiscounts` unless a
   * discount is marked `includeInComparison: false`.
   */
  readonly baseAffectingDiscounts: Money
  /** Exact, unrounded. The economic truth, and the value the settled total is derived from. */
  readonly calculatedLandedTotal: Money
  /**
   * The authoritative commercial total:
   * `roundHalfUp(calculatedLandedTotal, minorUnit)`.
   *
   * The exact total is calculated first and rounded **once**; the components
   * are then reconciled to it, so `settledMerchandiseTotal + Σ settledEffect`
   * equals this figure as well. The authority runs in that direction on
   * purpose. Summing separately rounded components instead made the answer
   * depend on how a user split the same money across rows — `20.008` and
   * `10.004 + 10.004` produced different totals, and a genuinely more
   * expensive supplier could win — because `round(a) + round(b)` is not
   * `round(a + b)`.
   *
   * This is what a user is shown, what ranking and tie detection use, and
   * what every breakdown adds back up to.
   */
  readonly settledLandedTotal: Money
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
 * Every intermediate value — bases, percentage results, the landed total —
 * stays exact. Settlement happens once, at the end: the exact landed total is
 * rounded to the currency's minor unit, and *that* is `settledLandedTotal`,
 * the commercial figure the rest of the application shows, ranks and
 * reconciles against. The displayed components are then reconciled to it
 * (`reconcileSettledEffects`), never summed into it.
 *
 * The costs are validated here as well as in `createAdditionalCost`. This is
 * an engine boundary, not a trusted internal call: `AdditionalCost` is a
 * plain interface, so anything structurally shaped like one can arrive here
 * without ever having met the factory's rules.
 */
export function calculateSupplierCosts(
  input: SupplierCostCalculationInput,
): SupplierCostCalculationResult {
  const { costs, exchangeRateTable, minorUnit } = input
  const baseCurrency = exchangeRateTable.baseCurrency
  const zero = Money.zero(baseCurrency)

  for (const cost of costs) {
    assertValidAdditionalCost(cost)
  }
  assertUniqueCostIds(costs)

  const merchandiseTotal = convertToBaseCurrency(input.merchandiseTotal, exchangeRateTable)
  if (merchandiseTotal.isNegative()) {
    throw new InvalidPercentageBaseError(
      `Merchandise total ${merchandiseTotal.toDecimalString()} ${baseCurrency} is negative; every percentage base derived from it would be negative`,
    )
  }

  const staged = groupByStage(costs)
  const evaluated = new Array<EvaluatedEntry>(costs.length)

  const evaluateStage = (
    stage: CostEvaluationStage,
    bases: AvailableBases,
  ): readonly EvaluatedEntry[] =>
    staged[stage].map(({ cost, index }) => {
      const entry = evaluateEntry(cost, stage, bases, exchangeRateTable, baseCurrency)
      evaluated[index] = entry
      return entry
    })

  // Stage 2 — discounts. Only the merchandise total exists yet.
  //
  // Two ceilings, because two different sets of discounts are in play: the
  // ones that reach the comparison total, and the (super)set that lowers the
  // percentage bases. The base-affecting sum is the binding one — it is the
  // subtraction that could drive a base negative — and it is never smaller
  // than the contributing sum, so checking it also covers the classic
  // "discounts exceed the merchandise total" case.
  const discountEntries = evaluateStage('DISCOUNT', { MERCHANDISE: merchandiseTotal })
  const totalDiscounts = sumMagnitudes(discountEntries, zero, contributesToTotal)
  const baseAffectingDiscounts = sumMagnitudes(discountEntries, zero, affectsPercentageBases)
  if (baseAffectingDiscounts.isGreaterThan(merchandiseTotal)) {
    throw new InvalidDiscountError(
      totalDiscounts.isGreaterThan(merchandiseTotal)
        ? `Discounts totalling ${totalDiscounts.toDecimalString()} ${baseCurrency} exceed the merchandise total of ${merchandiseTotal.toDecimalString()} ${baseCurrency}; the discounted merchandise base would be negative`
        : `Discounts affecting the merchandise base total ${baseAffectingDiscounts.toDecimalString()} ${baseCurrency} and exceed the merchandise total of ${merchandiseTotal.toDecimalString()} ${baseCurrency}; the discounted merchandise base would be negative. A discount excluded from the comparison total still lowers that base.`,
    )
  }
  const merchandiseAfterDiscount = merchandiseTotal.subtract(baseAffectingDiscounts)

  // Stage 3 — freight and insurance, the components of the CIF-like base.
  const freightInsuranceEntries = evaluateStage('FREIGHT_INSURANCE', {
    MERCHANDISE: merchandiseTotal,
    MERCHANDISE_AFTER_DISCOUNT: merchandiseAfterDiscount,
  })
  const merchandisePlusFreightInsurance = merchandiseAfterDiscount.add(
    sumMagnitudes(freightInsuranceEntries, zero, affectsPercentageBases),
  )

  const allBases: AvailableBases = {
    MERCHANDISE: merchandiseTotal,
    MERCHANDISE_AFTER_DISCOUNT: merchandiseAfterDiscount,
    MERCHANDISE_PLUS_FREIGHT_INSURANCE: merchandisePlusFreightInsurance,
  }

  // Stages 4 and 5 — every remaining cost, then surcharges.
  const otherCostEntries = evaluateStage('OTHER_COST', allBases)
  const surchargeEntries = evaluateStage('SURCHARGE', allBases)

  const calculatedLandedTotal = evaluated.reduce(
    (total, entry) => total.add(entry.signedEffect),
    merchandiseTotal,
  )

  // One precision check covers the whole settlement: no partial sum along the
  // way can be larger in magnitude than the merchandise total plus every cost
  // magnitude, so if that ceiling settles exactly, so does everything derived
  // from it.
  assertSettleableAtMinorUnit(
    evaluated.reduce((total, entry) => total.add(entry.signedEffect.abs()), merchandiseTotal),
    minorUnit,
    'Merchandise total plus every cost magnitude',
  )

  // Anchor the total, then reconcile the parts. The exact total is rounded
  // once; the merchandise total keeps its own settlement (cost residue is
  // never hidden inside it); the cost effects absorb what is left.
  const settledMerchandiseTotal = merchandiseTotal.roundToMinorUnit(minorUnit)
  const settledLandedTotal = calculatedLandedTotal.roundToMinorUnit(minorUnit)
  const settledEffects = reconcileSettledEffects(
    evaluated,
    settledLandedTotal.subtract(settledMerchandiseTotal),
    minorUnit,
    zero,
  )

  const entries: readonly AppliedCostEntry[] = evaluated.map((entry, index) => ({
    ...entry,
    settledEffect: settledEffects[index]!,
  }))

  assertBreakdownReconciles(entries, settledMerchandiseTotal, settledLandedTotal)

  return {
    baseCurrency,
    minorUnit,
    merchandiseTotal,
    settledMerchandiseTotal,
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
    totalSurcharges: sumMagnitudes(surchargeEntries, zero, contributesToTotal),
    totalAdditionalCosts: sumMagnitudes(
      [...freightInsuranceEntries, ...otherCostEntries],
      zero,
      contributesToTotal,
    ),
    baseAffectingDiscounts,
    calculatedLandedTotal,
    settledLandedTotal,
  }
}

export interface DiscountLineValidationInput {
  readonly costResult: SupplierCostCalculationResult
  /** The lines a discount is spread over. Same targets the explanatory pass uses. */
  readonly targets: readonly AllocationTarget[]
  readonly exchangeRateTable: ExchangeRateTable
}

/**
 * Proves that no contributing discount takes more off a line than that line is
 * worth. **Validation, not presentation** — the one part of allocation that
 * decides whether a supplier's quote is economically valid at all.
 *
 * It runs on its own, before `allocateSupplierCosts`, and that separation is
 * the whole point. Both jobs used to share one pass: the discount check sat at
 * the *end* of the explanatory allocation, so an unrelated cost with an
 * unusable weighting — freight by quantity across `pcs` and `kg`, say — threw
 * first, the caller correctly read that as "no breakdown available", and a
 * discount that overdrew a line was never checked. The supplier came out
 * `COMPLETE` with a warning. Which cost happened to fail first decided whether
 * a financial rule was enforced.
 *
 * So the two questions are now asked separately:
 *
 * - *Is this supplier's discount configuration legal?* — here, mandatory, and
 *   a failure invalidates the supplier.
 * - *Can we show the user which line each cost landed on?* — the explanatory
 *   pass, optional, and a failure is only a warning.
 *
 * Nothing is recalculated to do it. The entries, their exact signed effects
 * and their allocation methods all come from the `costResult` the caller
 * already has, and the shares come from `exactAllocationShares`, the same
 * weighting arithmetic the explanatory pass runs.
 *
 * **Zero-value discounts are skipped.** A discount whose exact economic amount
 * is zero takes nothing off any line, so there is no per-line rule for it to
 * break and no reason to establish a weighting for it. Invalidating a supplier
 * because a 0 TRY discount could not be allocated would be inventing a
 * financial error where there is no money. If its method is also unusable, the
 * explanatory pass will still say so, as a warning.
 *
 * **The scope is every *base-affecting* discount, not every contributing
 * one** — the same set `baseAffectingDiscounts` is built from, and deliberately
 * not the set `allocateSupplierCosts` allocates. The two answer different
 * questions:
 *
 * - `includeInComparison: false` keeps a discount out of the compared total,
 *   but the money did not stop existing: it still lowers
 *   `merchandiseAfterDiscount` and every percentage taken on that base, and
 *   the supplier-level ceiling already refuses it when it exceeds the
 *   merchandise total. Its `signedEffect` is zero, so this check reads
 *   `baseCurrencyAmount` instead — otherwise the same 600 TRY would be real
 *   money at supplier level and absent at line level.
 * - `alreadyIncludedInQuote: true` *is* a statement that the money is
 *   somewhere else — inside the quoted line prices. It affects no base, and
 *   validating it against a line would count it twice.
 *
 * The allocator's narrower scope stays right for the allocator: putting an
 * excluded discount on a line would show money the compared total never
 * counted. Presentation and validity are separate questions here too.
 */
export function validateDiscountLineAllocations(input: DiscountLineValidationInput): void {
  const { costResult, targets, exchangeRateTable } = input
  const baseCurrency = costResult.baseCurrency
  const zero = Money.zero(baseCurrency)

  assertUniqueTargetIds(targets)

  const exactLineDiscounts = new Map<string, Money>(targets.map((target) => [target.id, zero]))

  for (const entry of costResult.entries) {
    if (entry.kind !== 'DISCOUNT' || !entry.affectsPercentageBases || entry.baseCurrencyAmount.isZero()) {
      continue
    }

    // The entry's economic effect, which is not the same as its contribution
    // to the compared total: a discount kept out of the comparison has a
    // `signedEffect` of zero and still lowers every percentage base. For a
    // contributing discount the two are identical by construction, so this
    // one expression covers both.
    const economicEffect = entry.baseCurrencyAmount.negate()

    for (const share of discountSharesOf(entry, economicEffect, targets, costResult.minorUnit, baseCurrency)) {
      const previous = exactLineDiscounts.get(share.targetId) ?? zero
      exactLineDiscounts.set(share.targetId, previous.add(share.exactAmount))
    }
  }

  assertDiscountsFitEachLine(targets, exactLineDiscounts, exchangeRateTable, baseCurrency)
}

/**
 * One discount's exact per-line shares, with an unusable weighting restated as
 * the discount-validation failure it is at this boundary.
 *
 * The translation is deliberate and narrow. `InvalidAllocationBaseError` and
 * `IncompatibleAllocationUnitsError` normally mean "this cost has no per-line
 * explanation", which is survivable. For a discount carrying real money they
 * mean "this discount's effect on each line is unknowable", and an unprovable
 * financial rule must not read as a passed one. Anything else — an internal
 * assertion, a precision failure — keeps its own meaning and propagates.
 */
function discountSharesOf(
  entry: AppliedCostEntry,
  economicEffect: Money,
  targets: readonly AllocationTarget[],
  minorUnit: number,
  baseCurrency: CurrencyCode,
): readonly ExactAllocationShare[] {
  try {
    return exactAllocationShares(economicEffect, targets, entry.allocationMethod, minorUnit)
  } catch (error) {
    if (
      error instanceof InvalidAllocationBaseError ||
      error instanceof IncompatibleAllocationUnitsError
    ) {
      throw new DiscountAllocationValidationError(
        `Discount "${entry.id}" of ${entry.baseCurrencyAmount.toDecimalString()} ${baseCurrency} cannot be allocated by ${entry.allocationMethod}, so there is no way to prove its share of each line stays within that line's merchandise value: ${error.message}`,
      )
    }
    throw error
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
}

export interface SupplierCostAllocationResult {
  readonly baseCurrency: CurrencyCode
  readonly minorUnit: number
  readonly byEntry: readonly CostAllocationBreakdown[]
  readonly byLine: readonly LineAllocatedCost[]
}

export interface LineMerchandiseSettlement {
  /** Each line's exact merchandise value in the base currency, in `targets` order. */
  readonly baseCurrencyValues: readonly Money[]
  /** Each line's share of `settledMerchandiseTotal`. These sum to it exactly. */
  readonly settledValues: readonly Money[]
}

/**
 * Each line's merchandise value in the base currency, and its share of the
 * settled merchandise total.
 *
 * One function, two callers, on purpose. The per-line settled merchandise
 * figure is both what the user is shown (`SupplierLineResult`) and the
 * capacity a discount is allowed to eat into (`allocateSupplierCosts`), and
 * those two have to be the *same number*: a discount placed against a
 * capacity the line turns out not to have would put that line below zero on
 * the very screen the capacity was calculated to protect.
 *
 * Line subtotals are exact and in the quote's currency; the base-currency
 * total is converted once for the whole quote (Phase 2's rule, unchanged).
 * Converting each line at that same rate is a proportional restatement of the
 * same conversion, not a second rate, and settling those with largest
 * remainder makes the displayed lines add up to the displayed merchandise
 * total.
 */
export function settleLineMerchandise(
  targets: readonly AllocationTarget[],
  settledMerchandiseTotal: Money,
  exchangeRateTable: ExchangeRateTable,
  minorUnit: number,
): LineMerchandiseSettlement {
  const baseCurrencyValues = targets.map((target) =>
    convertToBaseCurrency(target.merchandiseValue, exchangeRateTable),
  )
  return {
    baseCurrencyValues,
    settledValues: settleTotalAcrossParts(settledMerchandiseTotal, baseCurrencyValues, minorUnit),
  }
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
 *
 * Allocation is an **explanation** layer. It can fail for reasons that say
 * nothing about whether the landed total is right (mixed comparison units
 * under `BY_QUANTITY`, an all-zero weighting base), so the caller decides
 * what an unusable weighting means for the supplier — see
 * `SupplierEvaluation.ts`. What it must never do is disagree with the total:
 * every entry is allocated to the settled amount the cost engine already
 * published.
 *
 * The one financially binding question allocation used to answer here —
 * whether a discount overdraws a line — is **not** this function's job any
 * more. It moved to `validateDiscountLineAllocations`, which the supplier
 * pipeline runs first, precisely so that an unrelated cost's unusable
 * weighting can no longer stop it from being asked.
 *
 * **A valid line never settles negative.** That is a separate protection from
 * the one above, and it is this function's job. The discount check asks
 * whether a discount is economically legal, at exact precision, against the
 * line's exact merchandise value. This asks a rounding question: once cents
 * are settled, where does a remainder minor unit go? A line economically
 * worth `0.004` settles its merchandise to `0.00`, and a `0.004` discount
 * share that settled independently to `0.01` displayed that line at `-0.01`.
 * The money was right — the supplier total still reconciled — and the line
 * was nonsense.
 *
 * So the entries are settled in **capacity order**: merchandise first (it is
 * already settled), then the positive effects, then the discounts. Each line
 * carries a running capacity — its settled merchandise plus every positive
 * effect settled onto it, less the discounts already placed — and a discount
 * may only be given a minor unit by a line that still has room for it. A unit
 * a line cannot take moves to the next line in the same largest-remainder
 * order; it is never dropped, and nothing is clamped, so the allocations
 * still sum to the settled effect the authoritative total counted.
 *
 * This is always feasible: every line's capacity sums to
 * `settledMerchandiseTotal + Σ positive settledEffect`, and the settled
 * discounts sum to that figure minus `settledLandedTotal`, which is
 * non-negative because discounts are capped at the merchandise total. If it
 * ever is not, `AllocationCapacityError` says so rather than a cent being
 * quietly invented.
 *
 * Settlement order is not display order: `byEntry` comes back in
 * `appliedEntries` order, exactly as before.
 */
export function allocateSupplierCosts(
  input: SupplierCostAllocationInput,
): SupplierCostAllocationResult {
  const { costResult, targets, exchangeRateTable } = input
  const baseCurrency = costResult.baseCurrency
  const minorUnit = costResult.minorUnit
  const zero = Money.zero(baseCurrency)

  assertUniqueTargetIds(targets)

  const entries = costResult.appliedEntries
  const lineTotals = new Map<string, Money>(targets.map((target) => [target.id, zero]))
  const exactLineDiscounts = new Map<string, Money>(targets.map((target) => [target.id, zero]))
  const remainingCapacity = openLineCapacity(entries, targets, costResult, exchangeRateTable)

  const byEntry = new Array<CostAllocationBreakdown>(entries.length)
  for (const index of settlementOrderOf(entries)) {
    const entry = entries[index]!
    const isDiscount = entry.kind === 'DISCOUNT'

    // The shares are weighted by the exact economic amount, but they add up
    // to the entry's *reconciled* settled effect — the figure the
    // authoritative total already counted. Re-rounding the exact amount here
    // instead would put the per-line breakdown a minor unit away from the
    // header whenever reconciliation moved the entry.
    const allocated = allocateAmount(
      entry.signedEffect,
      targets,
      entry.allocationMethod,
      minorUnit,
      entry.settledEffect,
      isDiscount ? remainingCapacity : undefined,
    )

    // Tautological while the target above is passed, and kept for exactly
    // that reason: if the allocator ever stops honouring it, the breakdown
    // silently stops adding up to the total, and this says so instead.
    if (!allocated.settledAmount.equals(entry.settledEffect)) {
      throw new AllocationInvariantError(
        `Allocation of cost "${entry.id}" settled to ${allocated.settledAmount.toDecimalString()} ${baseCurrency}, but the landed total counted it as ${entry.settledEffect.toDecimalString()} ${baseCurrency}`,
      )
    }

    for (const allocation of allocated.allocations) {
      const previousTotal = lineTotals.get(allocation.targetId) ?? zero
      lineTotals.set(allocation.targetId, previousTotal.add(allocation.amount))

      // Signed, so one expression covers both directions: a cost settled onto
      // a line is capacity a later discount may use, and a discount placed on
      // it spends that capacity.
      if (remainingCapacity !== undefined) {
        const previousCapacity = remainingCapacity.get(allocation.targetId) ?? zero
        remainingCapacity.set(allocation.targetId, previousCapacity.add(allocation.amount))
      }

      if (isDiscount) {
        const previousDiscount = exactLineDiscounts.get(allocation.targetId) ?? zero
        exactLineDiscounts.set(allocation.targetId, previousDiscount.add(allocation.exactAmount))
      }
    }

    byEntry[index] = {
      entryId: entry.id,
      kind: entry.kind,
      category: entry.category,
      method: allocated.method,
      exactAmount: allocated.exactAmount,
      settledAmount: entry.settledEffect,
      allocations: allocated.allocations,
    }
  }

  // Kept although `validateDiscountLineAllocations` has already proven this
  // for every caller that runs the supplier pipeline. It is the allocation
  // layer's own invariant — `allocateSupplierCosts` is public and can be
  // called directly — and it must never publish a breakdown that puts a line
  // below zero. It cannot fire after the validation pass has passed: the
  // discounts allocated here are a subset of the ones validated there (every
  // contributing discount is base-affecting), and all their shares share a
  // sign, so each line's allocated discount here is no larger than the figure
  // already checked against that line.
  assertDiscountsFitEachLine(targets, exactLineDiscounts, exchangeRateTable, baseCurrency)

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

/**
 * Each line's starting capacity — its share of the settled merchandise total —
 * or `undefined` when no discount will be placed at all.
 *
 * Skipping the work when there is nothing to constrain is not just an
 * optimisation: settling the merchandise total across the lines is its own
 * arithmetic with its own failure modes, and a supplier with only costs and
 * surcharges has no reason to run it or to be exposed to them.
 */
function openLineCapacity(
  entries: readonly AppliedCostEntry[],
  targets: readonly AllocationTarget[],
  costResult: SupplierCostCalculationResult,
  exchangeRateTable: ExchangeRateTable,
): Map<string, Money> | undefined {
  const placesDiscount = entries.some(
    (entry) => entry.kind === 'DISCOUNT' && !entry.settledEffect.isZero(),
  )
  if (!placesDiscount) {
    return undefined
  }

  const { settledValues } = settleLineMerchandise(
    targets,
    costResult.settledMerchandiseTotal,
    exchangeRateTable,
    costResult.minorUnit,
  )
  return new Map(targets.map((target, index) => [target.id, settledValues[index]!]))
}

/**
 * The order entries are **settled** in, which is deliberately not the order
 * they are shown in. Two rules:
 *
 * 1. Positive effects before discounts. A discount may only be placed on a
 *    line once that line's capacity is known, and a cost or surcharge settled
 *    onto the line is part of that capacity — freight on a line is money the
 *    line can give back.
 * 2. Within each group, ascending by cost id. Which line absorbs a remainder
 *    minor unit must not depend on where a row happened to sit in the input,
 *    and the id is the entry's semantic identity; this is the same ordering
 *    `EffectPool` settles on, for the same reason.
 *
 * Positive effects do not interact with each other at all — each is
 * distributed independently — so rule 2 changes nothing for them. It is
 * applied to both groups anyway so that "settlement order" means one thing.
 */
function settlementOrderOf(entries: readonly AppliedCostEntry[]): readonly number[] {
  return entries
    .map((_, index) => index)
    .sort((a, b) => {
      const byGroup = discountRank(entries[a]!) - discountRank(entries[b]!)
      return byGroup !== 0 ? byGroup : compareCostIds(entries[a]!.id, entries[b]!.id)
    })
}

function discountRank(entry: AppliedCostEntry): number {
  return entry.kind === 'DISCOUNT' ? 1 : 0
}

type AvailableBases = Partial<Record<PercentageBase, Money>>

/** An entry before settlement. Settlement needs every entry's effect first. */
type EvaluatedEntry = Omit<AppliedCostEntry, 'settledEffect'>

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
): EvaluatedEntry {
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
    affectsPercentageBases: !cost.alreadyIncludedInQuote,
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

/**
 * One side of the cost ledger: every entry whose effect shares a sign, its
 * exact magnitudes, and their exact sum.
 *
 * Members are held in `cost.id` order, not array order. The remainder
 * distribution below breaks ties on that order, so settling on the semantic
 * id rather than on where a row happened to sit in the input makes every
 * component figure — not just the total — independent of input ordering.
 */
interface EffectPool {
  /** Indices into the evaluated entries, ascending by cost id. */
  readonly indices: readonly number[]
  /** Each member's exact magnitude, in `indices` order. */
  readonly magnitudes: readonly Money[]
  /** Their exact sum. Strictly positive whenever the pool is non-empty. */
  readonly total: Money
}

/**
 * Splits the authoritative total's cost side across the individual entries.
 *
 * `settledEffectTotal` is `settledLandedTotal - settledMerchandiseTotal`: the
 * amount the cost effects must add up to, fixed before any component is
 * looked at. Reaching it is a two-step problem, because the entries do not
 * share a sign:
 *
 * 1. Decide what each *side* of the ledger settles to (`resolvePoolTargets`),
 *    so the two targets differ by exactly `settledEffectTotal` and neither is
 *    negative.
 * 2. Distribute each side's target across its own members by largest
 *    remainder — the same distribution allocation and the per-line
 *    merchandise split already use.
 *
 * Running the two sides separately, on magnitudes, is what makes the result
 * sign-safe: a positive cost is only ever handed a non-negative share, and a
 * discount's share is negated after the fact. No entry can be pushed across
 * zero by a remainder adjustment, and an entry that contributes nothing keeps
 * an effect of exactly zero because it belongs to neither pool.
 */
function reconcileSettledEffects(
  evaluated: readonly EvaluatedEntry[],
  settledEffectTotal: Money,
  minorUnit: number,
  zero: Money,
): readonly Money[] {
  const positive = effectPool(evaluated, (effect) => effect.isPositive(), zero)
  const negative = effectPool(evaluated, (effect) => effect.isNegative(), zero)
  const { positiveTarget, negativeTarget } = resolvePoolTargets(
    settledEffectTotal,
    positive,
    negative,
    minorUnit,
  )

  const settled = new Array<Money>(evaluated.length).fill(zero)
  settleTotalAcrossParts(positiveTarget, positive.magnitudes, minorUnit).forEach((share, slot) => {
    settled[positive.indices[slot]!] = share
  })
  settleTotalAcrossParts(negativeTarget, negative.magnitudes, minorUnit).forEach((share, slot) => {
    settled[negative.indices[slot]!] = share.isZero() ? share : share.negate()
  })
  return settled
}

function effectPool(
  evaluated: readonly EvaluatedEntry[],
  selects: (effect: Money) => boolean,
  zero: Money,
): EffectPool {
  const indices = evaluated
    .map((_, index) => index)
    .filter((index) => selects(evaluated[index]!.signedEffect))
    .sort((a, b) => compareCostIds(evaluated[a]!.id, evaluated[b]!.id))
  const magnitudes = indices.map((index) => evaluated[index]!.signedEffect.abs())
  return {
    indices,
    magnitudes,
    total: magnitudes.reduce((sum, magnitude) => sum.add(magnitude), zero),
  }
}

/**
 * What each side of the ledger settles to, given that their difference is
 * already fixed by the authoritative total.
 *
 * Each side starts at its own settled sum — the figure it would have had if
 * nothing else existed — and the leftover between those two and the total is
 * a *residual* of at most one minor unit (each of the four roundings
 * involved moves a value by less than half a unit, and the residual is a
 * whole number of units). It is applied to the side whose sign matches it:
 * a shortfall belongs to the costs, a surplus to the discounts. That keeps
 * both targets non-negative, so neither side can be handed an amount that
 * would force one of its members across zero.
 *
 * When the matching side is empty there is nowhere to put the residual but
 * the other side, and that direction is safe for the same reason: with no
 * costs the exact total cannot exceed the merchandise total, and with no
 * discounts it cannot fall below it, so the reduced target stays
 * non-negative. The assertions below check that rather than trusting it.
 */
function resolvePoolTargets(
  settledEffectTotal: Money,
  positive: EffectPool,
  negative: EffectPool,
  minorUnit: number,
): { positiveTarget: Money; negativeTarget: Money } {
  const settledPositive = positive.total.roundToMinorUnit(minorUnit)
  const settledNegative = negative.total.roundToMinorUnit(minorUnit)
  const residual = settledEffectTotal.subtract(settledPositive.subtract(settledNegative))

  const targets = resolveResidual(residual, settledPositive, settledNegative, positive, negative)
  assertPoolTarget(targets.positiveTarget, 'cost and surcharge')
  assertPoolTarget(targets.negativeTarget, 'discount')
  return targets
}

function resolveResidual(
  residual: Money,
  settledPositive: Money,
  settledNegative: Money,
  positive: EffectPool,
  negative: EffectPool,
): { positiveTarget: Money; negativeTarget: Money } {
  if (residual.isZero()) {
    return { positiveTarget: settledPositive, negativeTarget: settledNegative }
  }
  if (residual.isPositive()) {
    return positive.indices.length > 0
      ? { positiveTarget: settledPositive.add(residual), negativeTarget: settledNegative }
      : { positiveTarget: settledPositive, negativeTarget: settledNegative.subtract(residual) }
  }
  return negative.indices.length > 0
    ? { positiveTarget: settledPositive, negativeTarget: settledNegative.subtract(residual) }
    : { positiveTarget: settledPositive.add(residual), negativeTarget: settledNegative }
}

function assertPoolTarget(target: Money, side: string): void {
  if (target.isNegative()) {
    throw new SettlementReconciliationError(
      `Settlement produced a negative ${side} target (${target.toDecimalString()} ${target.currency}); reconciling to it would flip an entry's sign`,
    )
  }
}

/** Lexicographic, locale-independent — determinism here is a financial guarantee. */
function compareCostIds(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  return a > b ? 1 : 0
}

/**
 * The guarantee the whole settlement model exists for, at supplier level:
 * what the breakdown adds up to is the total in the header. Checked, not
 * assumed, because a silent one-minor-unit gap is exactly the failure mode
 * that is impossible to notice and impossible to defend.
 */
function assertBreakdownReconciles(
  entries: readonly AppliedCostEntry[],
  settledMerchandiseTotal: Money,
  settledLandedTotal: Money,
): void {
  const fromComponents = entries.reduce(
    (total, entry) => total.add(entry.settledEffect),
    settledMerchandiseTotal,
  )
  if (!fromComponents.equals(settledLandedTotal)) {
    throw new SettlementReconciliationError(
      `Settled merchandise plus settled cost effects come to ${fromComponents.toDecimalString()} ${fromComponents.currency}, but the authoritative settled landed total is ${settledLandedTotal.toDecimalString()} ${settledLandedTotal.currency}`,
    )
  }
}

function contributesToTotal(entry: EvaluatedEntry): boolean {
  return entry.contributes
}

function affectsPercentageBases(entry: EvaluatedEntry): boolean {
  return entry.affectsPercentageBases
}

/** Sums the magnitudes of the entries the predicate selects. */
function sumMagnitudes(
  entries: readonly EvaluatedEntry[],
  zero: Money,
  selects: (entry: EvaluatedEntry) => boolean,
): Money {
  return entries.reduce(
    (total, entry) => (selects(entry) ? total.add(entry.baseCurrencyAmount) : total),
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
 *
 * Both sides are compared **before settlement**. Comparing a settled discount
 * share against an exact line value measures two different precisions against
 * each other, and a share rounded up by half a minor unit would reject a
 * discount that exactly equals the line it sits on. Settlement is a
 * presentation boundary; it must not decide whether a configuration is legal.
 *
 * Called from both `validateDiscountLineAllocations` (the mandatory check)
 * and `allocateSupplierCosts` (the same invariant, guarding its own output).
 * Both hand it exact, unsettled shares of the same entries, so the two can
 * only ever agree.
 */
function assertDiscountsFitEachLine(
  targets: readonly AllocationTarget[],
  exactLineDiscounts: ReadonlyMap<string, Money>,
  exchangeRateTable: ExchangeRateTable,
  baseCurrency: CurrencyCode,
): void {
  for (const target of targets) {
    const discount = exactLineDiscounts.get(target.id)
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
