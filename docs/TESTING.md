# Testing

## Phase 0 tooling

- Test runner: [Vitest](https://vitest.dev/), configured in `vite.config.ts`
  (`test` block), environment `jsdom`.
- Component testing: React Testing Library, with `@testing-library/jest-dom`
  matchers loaded via `src/test/setup.ts`.
- Run the suite: `npm run test`.

Phase 0 includes exactly one smoke test (`src/App.test.tsx`) that proves the
test runner, jsdom environment, and React Testing Library are wired up
correctly. It is not a business-logic test — there is no business logic yet.

## Phase 1 — monetary & domain coverage

Tests are colocated with the code they cover (`Foo.ts` next to `Foo.test.ts`),
matching the Phase 0 convention. Coverage is business-risk-driven, not
completeness-driven — trivial type-shape tests were deliberately skipped.

- `src/domain/monetary/Money.test.ts` — the core monetary-exactness risks:
  `0.1 + 0.2` behaves exactly (not the native floating-point result),
  sub-cent precision (`0.0047`) survives round-tripping, large values don't
  lose precision, cross-currency `add`/`compareTo` throw
  `CurrencyMismatchError`, malformed decimal strings throw
  `InvalidDecimalError`, and JSON serialize → deserialize reproduces the
  exact original value.
- `src/domain/monetary/CurrencyCode.test.ts` — valid/invalid ISO-style code
  shapes.
- `src/domain/quantity/Quantity.test.ts` — decimal precision, negative
  rejection, malformed input rejection, serialization round-trip.
- `src/domain/quote/Quote.test.ts` — the one cross-entity invariant that
  exists in Phase 1: a `QuoteItem` priced in a different currency than its
  parent `Quote` is rejected at construction.

## Phase 2 — exchange rate & merchandise calculation coverage

Tests are colocated with the code they cover, same convention as Phase 1.
Coverage is business-risk-driven: the matrix below is the set of scenarios
that would produce a silently wrong financial number if broken, not a
completeness/coverage-percentage target.

- `src/calculation/ExchangeRate.test.ts` — rate direction/getters, zero and
  negative rates rejected (`InvalidExchangeRateError`), malformed decimal
  rejected with Phase 1's `InvalidDecimalError`, a very small positive rate
  accepted without an invented minimum, JSON round-trip.
- `src/calculation/ExchangeRateTable.test.ts` — rate lookup by currency,
  `MissingExchangeRateError` when a currency has no configured rate, multiple
  currencies converting into the same base, a rate whose `toCurrency` doesn't
  match the table's base currency rejected (`CurrencyMismatchError`), and the
  documented last-one-wins behavior for a duplicate `fromCurrency`.
- `src/calculation/CurrencyConversion.test.ts` — same-currency conversion
  needs no rate, a basic FX conversion (100 USD @ 43.50 → 4350 TRY), a
  decimal-rate conversion asserted to **not** be rounded to 2 decimals
  (12.3456 USD @ 43.5187 → 537.26446272 TRY exactly), missing-rate failure
  instead of a silent `0`/`1` fallback, and large-value precision
  preservation.
- `src/calculation/MerchandiseCalculation.test.ts` — basic line subtotal,
  sub-cent price precision (0.0047 × 1000), decimal quantity (4.25 × 2.5),
  explicit proof that `0.1 + 0.2` style native floating-point error does not
  leak in, large-value precision, multi-line merchandise total, empty-line
  merchandise total (defined as zero — see
  [Calculation Rules](CALCULATION_RULES.md)), a currency-mismatched subtotal
  rejected (`CurrencyMismatchError`), a full quote-to-base-currency
  calculation, the same-currency-as-base case, a missing-rate failure at the
  quote level, and an integration test that builds real `Quote`/`QuoteItem`
  domain objects (confirming Phase 1's currency-mismatch invariant still
  blocks construction) and feeds them through the calculation engine with
  externally-resolved quantities.
- `src/calculation/GoldenScenario.test.ts` — the Phase 2 golden scenario: TRY
  base currency, USD quote at 43.50, two lines (12.50 USD × 100, 3.75 USD ×
  40) pinned to a quote total of 1400 USD and a base total of 60900 TRY.

## Phase 3 — quantity, MOQ & pack resolution coverage

Tests are colocated with the code they cover, same convention as Phase 1/2.
Coverage is business-risk-driven: every scenario below would silently change
what a user actually ends up ordering (and paying) if it broke.

- `src/domain/quantity/Quantity.test.ts` — new arithmetic added for Phase 3:
  `max` (MOQ resolution), `multiply`/`subtract` exactness, `ceilDivide`
  rounding up on a fractional division and leaving an exact division
  unchanged, and a pack round-trip (`0.3 / 0.1` then `x 0.1`) chosen because
  it is a case where native binary floating point would drift.
- `src/calculation/QuantityResolution.test.ts` — `resolveOrderQuantity`:
  - no MOQ / no pack (resolved equals required);
  - MOQ below the requirement (no effect) and MOQ above it (raises the
    resolved quantity, `moqApplied` true);
  - an exact pack (no rounding) and a fractional pack (rounds up to the next
    whole quoted unit);
  - MOQ combined with an exact pack, and MOQ combined with a pack that
    requires rounding — proving MOQ is applied *before* pack, not after;
  - a decimal required quantity with no pack staying decimal (no forced
    whole-number rounding when pack semantics don't apply);
  - a zero MOQ and a zero pack size rejected (`InvalidMoqError` /
    `InvalidPackSizeError` — "no MOQ"/"no pack" must be `undefined`, not
    zero), and negative/malformed MOQ or pack size rejected earlier, at
    `Quantity` construction;
  - excess quantity computed correctly and never negative;
  - large-quantity precision preserved without overflow;
  - a **Phase 2 integration** section: a pack-resolved `quotedUnitQuantity`
    fed into `calculateLineSubtotal` (105 pcs, 10 pcs/box, 70 USD/box → 11
    boxes → 770 USD), and the no-pack case feeding `quotedUnitQuantity`
    straight through unchanged;
  - the **MOQ trap golden scenario**: a supplier at 11 USD/pcs with no
    binding MOQ (100 pcs → 1100 USD) costs less in total than a supplier at
    9 USD/pcs whose MOQ of 150 forces a larger order (150 pcs → 1350 USD) —
    proving a lower quoted unit price does not always mean a lower purchase
    cost. This test only pins the two totals; it does not rank suppliers.

## Phase 4 — additional cost, adjustment & allocation coverage

Tests are colocated with the code they cover, same convention as Phase 1–3.
Phase 4 is the first phase that produces the number a user actually acts on
(the calculated landed total), so coverage here is weighted toward the
scenarios where a wrong result would be *plausible-looking* rather than
obviously broken: a lost kuruş in an allocation, a percentage taken on the
wrong intermediate subtotal, a cost counted twice, a discount applied with
the wrong sign.

Alongside example-based assertions, several tests assert **invariants**
rather than single expected values:

- `sum(allocations) === settledAmount` — swept across three methods, seven
  amounts, six line counts, and separately across negative amounts;
- the landed total is reproducible from the published breakdown, both by
  summing every entry's `signedEffect` and by the
  `merchandise − discounts + surcharges + costs` formulation;
- identical input produces byte-identical output on repeated runs.

These are plain parameterised loops — no property-testing dependency was
added for them.

- `src/domain/monetary/Money.test.ts` — the settlement primitives Phase 4
  added: sign classification with zero counting as neither positive nor
  negative, a signed zero not reported as negative, `abs`/`negate`,
  half-up minor-unit rounding (including the banker's-rounding
  counter-example 33.345 → 33.35), a 0-decimal scale, truncation toward zero,
  and proof that ordinary arithmetic still does not round.
- `src/calculation/Percentage.test.ts` — the `"5"` = 5% convention and the
  explicit counter-test that `"0.05"` is 0.05% and not 5%, fractional rates
  left unrounded, zero accepted, negative rejected, malformed input
  surfacing Phase 1's `InvalidDecimalError`, and no invented upper bound.
- `src/calculation/CurrencyMinorUnit.test.ts` — TRY/USD/EUR known, an unknown
  currency **blocking** instead of defaulting to 2, JPY supported at 0
  decimals through an explicit override, overrides beating the built-in
  table, malformed overrides rejected.
- `src/calculation/AdditionalCost.test.ts` — construction-time validation:
  documented defaults, exactly-one-of fixed/percentage, negative amounts
  rejected for all three kinds with the same reduction accepted as a positive
  discount, percentage discount >100% rejected while exactly 100% is allowed,
  stage derivation, and the full percentage-base availability matrix
  (discount limited to `MERCHANDISE`; freight/insurance refused the base they
  help build — the circular case; every base allowed for later stages).
- `src/calculation/Allocation.test.ts` — all three methods; mixed
  comparison units rejected for `BY_QUANTITY`; zero merchandise base, zero
  quantity base, empty line list (for every method), negative weight and
  mixed-currency weights all rejected; an unusable base rejected **even when
  the amount is zero** (the base is validated independently of the amount),
  contrasted with a zero amount allocating cleanly over a usable base; the
  100.00/3 split; the leftover
  minor unit going to the largest remainder rather than the first line
  (a case constructed so the winner is the *last* line); stable tie-breaking;
  repeated-run determinism; a sub-minor-unit amount settling with its
  residual exposed; a very small allocation (0.01 over 3 lines); a large
  amount (1,000,000,000,000.01); a 0-decimal currency; and the sign-safety
  set — a negative allocation as the exact mirror of its positive twin, the
  invariant held across negative amounts, and no negative zero emitted.
- `src/calculation/CostCalculation.test.ts` — the engine end to end: fixed
  costs in base and foreign currency, a missing rate blocking (for a
  contributing cost, for one excluded from the comparison, and for one
  already inside the quote), the pay-off for that strictness — a
  non-contributing foreign-currency cost still converted into the base
  currency so the breakdown stays comparable, `alreadyIncludedInQuote` and
  `includeInComparison` each keeping an amount out of the total while
  remaining traceable in the breakdown with `signedEffect` of zero, the
  documented precedence when both apply, fixed and percentage discounts and
  surcharges kept as separate totals, a discount exceeding the merchandise
  total rejected, two individually-legal 60% discounts rejected together, an
  excluded discount not counting toward the ceiling, all three percentage
  bases, an already-in-quote freight and an excluded insurance staying out of
  the CIF-like base, a freight-categorised *surcharge* staying out of it, an
  insurance percentage chaining into the base a duty percentage then uses,
  a no-premature-rounding test carried through to `1089.005445`, per-cost
  allocation methods, discount allocation as negative per-line amounts,
  excluded entries not allocated, a flat discount split that would push a
  small line negative rejected (and the same discount accepted
  proportionally), and Phase 2 / Phase 3 integration.
- `src/calculation/CostCalculation.test.ts`, multiple-discount set — that
  discounts are **parallel, not sequential**, and that input order is
  irrelevant: 10% + 10% pinned to an effective 20% with an explicit
  `not.toBe('81')` against the sequential result; all six orderings of a
  mixed percentage/fixed/percentage set producing identical totals; the same
  order-independence held at sub-minor-unit precision (`44.405222` /
  `955.599778`); two 50% discounts consuming the total exactly (sequential
  stacking would have left 25); three 50% discounts rejected even though
  sequential stacking would have fitted at 87.5; and an over-large set
  rejected in every one of its orderings. The last two double as proof of
  which stacking model the engine implements — the rejection itself is the
  evidence.
- `src/calculation/CostGoldenScenario.test.ts` — the two Phase 4 golden
  scenarios:
  - **Integrated landed total.** TRY base, USD quote at 40, two 1,000 USD
    lines → 80,000 TRY merchandise; 5% discount → 76,000; freight 10,000;
    insurance 2,000; duty 10% of 88,000 → 8,800; brokerage 1,500;
    **98,300 TRY**. Every component of the breakdown is pinned individually,
    the total is rebuilt from the breakdown, every shared amount is allocated
    across the two lines summing back to the original, and the whole run is
    repeated to prove determinism.
  - **Allocation rounding.** Three equal lines, one shared cost of 100.00
    TRY: **33.34 / 33.33 / 33.33**, summing to exactly 100.00 — the same
    result whichever equal-weight method is used, byte-identical across ten
    runs.

Both golden scenarios run through the same generic
`calculateSupplierCosts` / `allocateSupplierCosts` used everywhere else;
nothing is special-cased to reach the expected figures.

## Phase 5 — supplier comparison engine coverage

Tests are colocated with the code they cover (`src/comparison/`), same
convention as Phase 1–4, plus a shared `testSupport.ts` (not a test file
itself) with minimal object builders for `Project`/`RequirementItem`/
`Supplier`/`Quote`/`QuoteItem`, since comparison scenarios need more setup
than a single calculation call. Coverage is business-risk-driven: every
scenario below would either let an incomparable supplier win, produce a
false tie/non-tie at the minor-unit boundary, or hide an internal engine bug
behind a plausible-looking "invalid supplier" result.

- `ComparisonStructuralValidation.test.ts` — every project-wide structural
  block: empty requirements, duplicate requirement id, zero required
  quantity, duplicate supplier id, an orphaned quote (unknown supplierId), a
  duplicate quote for one supplier, a base-currency/rate-table mismatch; and
  the explicit negative case proving an *unknown-requirement* quote item is
  **not** flagged here (it is supplier-level `INVALID`, tested separately).
- `SupplierEvaluation.test.ts` — the full completeness matrix: fully
  complete, one missing item, several missing items (with the exact missing
  id list), an empty quote (not a zero-cost `COMPLETE` result), a missing
  quote, optional metadata (`quoteDate`/`incoterm`/etc.) absent but still
  `COMPLETE`, a duplicate quote item, an unknown-requirement quote item, a
  missing exchange rate, an invalid MOQ (zero), and discounts exceeding the
  merchandise total — each mapped to the right status and issue code.
- `SupplierEvaluation.errorPropagation.test.ts` — isolated in its own file
  because it mocks the allocation step (an internal
  `AllocationInvariantError` cannot be triggered through the public API with
  valid data — that is the point of it being an assertion) to prove
  `evaluateSupplier` really does let an unmapped internal error propagate
  rather than silently becoming `INVALID`, without that mock leaking into the
  real-calculation assertions in the main file.
- `Ranking.test.ts` — basic ascending ranking, dense ranking across a tie
  (`1, 1, 2`), a single complete supplier still ranked 1, stable input-order
  tie-breaking (deliberately using ids that would sort differently
  alphabetically), empty input, the sub-minor-unit tie
  (`100.004`/`100.001` → both `100.00`) and the half-up boundary that
  separates `100.005` from `100.004`, amount/percentage difference from the
  lowest, a tie's `0%` difference, and the zero-best-total cases (tied zero
  → `0%`; zero vs. positive → `percentageDifference` is `undefined`, never
  `Infinity`/`NaN`).
- `ComparisonInsights.test.ts` — every insight code in isolation
  (`NO_COMPARABLE_SUPPLIERS`, `ONLY_COMPARABLE_SUPPLIER` never doubling as a
  landed-cost winner, `LOWEST_CALCULATED_LANDED_COST`,
  `TIED_LOWEST_CALCULATED_LANDED_COST`), the merchandise-vs-landed flip
  firing only when the merchandise leader is unique and not the landed
  winner, the false-positive case suppressed when merchandise itself ties,
  per-supplier `INCOMPLETE_QUOTE`/`INVALID_QUOTE` insights in project input
  order, and repeated-run determinism.
- `SupplierComparison.test.ts` — orchestration: the comparison-level
  structural error surfaces before any supplier is evaluated, a supplier
  with no cost entry defaults to `[]` rather than inheriting some other
  supplier's costs, a supplier-specific cost applies only to that supplier,
  an unknown base currency blocks ranking unless a minor-unit override is
  supplied, and `INCOMPLETE`/`INVALID` suppliers are excluded from
  `rankedCompleteSuppliers` and `lowestSupplierIds`.
- `ComparisonGoldenScenario.test.ts` — the required golden scenarios, run
  through the real generic engines end to end, nothing special-cased:
  - **Golden Scenario 1 — incomplete supplier trap.** A complete supplier at
    2,000 TRY ranked 1; a supplier missing one required item never ranks,
    regardless of how low its partial apparent total looks.
  - **Golden Scenario 2 — sub-minor-unit tie and half-up boundary.**
    `100.004`/`100.001` TRY tie at rank 1 once settled; `100.005`/`100.004`
    separate into ranks 1/2 at the same boundary.
  - **Golden Scenario 3 — merchandise leader flip.** A 1,000/100 merchandise/
    freight supplier beats a 950/200 one on landed cost despite the second
    having lower merchandise, with `LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST`
    asserted on the full structured payload.
  - **Three-supplier comparison golden scenario.** Two complete suppliers
    (higher merchandise/lower cost vs. lower merchandise/higher cost) and one
    incomplete supplier with a deceptively low single-item apparent total;
    asserts the incomplete supplier is excluded, the correct complete winner,
    the merchandise/landed flip insight, and the amount/percentage
    difference (100 TRY / 6.25%) together.
  - **Integration scenarios** proving Phase 3/4 outputs survive the full
    comparison pipeline unchanged: the Phase 3 MOQ-trap supplier still beats
    the lower-unit-price/MOQ-bound one after ranking; a pack-resolved,
    cost-allocated supplier (105 pcs → 11 boxes → 770 USD + 30 USD freight)
    ranks correctly against a plain one; and a multi-currency comparison
    (USD + EUR quotes into a TRY base) ranks on the converted base-currency
    totals.

  - **Golden Scenario 6 — settlement with a real remainder.** Deliberately
    built so both settlement boundaries leave something to distribute, because
    a suite of cleanly-dividing scenarios is exactly how a settlement bug
    hides. Three USD lines at 40.55 TRY, a percentage discount, an
    equal-per-line freight and a CIF-base duty; the merchandise settlement
    distributes two spare kuruş and the freight distributes one. The
    authoritative total is the exact 881.1357005 rounded once, 881.14; summing
    separately rounded parts would have published 881.13, a kuruş short. Every
    figure is hand-computed in the test's header comment, including which
    entry the reconciliation residual lands on, and the per-line landed values
    are asserted to reproduce the header exactly.

## Checkpoint 1 remediation coverage

Added after the independent adversarial audit. Each of these started as a
reproduction of a defect that was live in the engine, not as a hypothetical:

- `comparison/AllocationUnavailable.test.ts` — **the winner regression.** A
  supplier landing at 6,800 TRY versus one at 10,200 TRY, where the cheaper
  one's freight cannot be split across pcs and kg lines: it stays `COMPLETE`,
  keeps rank 1, and carries an `ALLOCATION_UNAVAILABLE` warning instead of
  being dropped. Plus the free-sample case (zero merchandise, real freight),
  a zero-amount cost over an unusable base, proof that no `INVALID_QUOTE`
  insight is emitted for a warned supplier, and proof the catch is narrow —
  a discount that genuinely does not fit a line still invalidates.
- `comparison/SettlementReconciliation.test.ts` — header equals breakdown, on
  four scenarios including a percentage tail and a multi-currency mix, each
  asserting every reconciliation identity at once. Plus the two cases that
  pin the ranking boundary: two suppliers whose exact totals settle to the
  same figure genuinely tie, and two straddling the half-up boundary separate
  by one kuruş.
- `comparison/ComparisonInputHardening.test.ts` — the five prototype-chain
  supplier ids (`constructor`, `__proto__`, `toString`, `valueOf`,
  `hasOwnProperty`), each proven both to not crash *and* to still read that
  supplier's real costs; malformed cost-list containers blocked at comparison
  level; eleven shapes of factory-bypassing `AdditionalCost` each marking one
  supplier `INVALID` while the rest are still ranked; and ranking's own
  negative-amount guard.
- `comparison/SupplierLineTrace.test.ts` — MOQ, pack, MOQ-then-pack and
  unconstrained quantities all surviving into the comparison result, both
  currencies of a line value with its allocated share, the trace surviving
  even when allocation is unavailable, and an explicit assertion that no
  effective landed unit cost is produced.
- `calculation/PrecisionBoundary.test.ts` — the whole-pack ceiling at the
  34-digit boundary (including the case that used to resolve *below* what was
  required and surface as a negative excess), large and high-minor-unit
  allocations that now reconcile, and out-of-range amounts rejected as
  `PrecisionEnvelopeExceededError` — including an assertion on the message
  itself, that it names a precision limit and not a maximum amount.
- `calculation/AdditionalCost.test.ts` — the shared validator applied to
  objects that bypassed the factory entirely: negative amounts, both/neither
  calculation basis, wrong runtime types, unknown enum values, non-boolean
  flags, and the discount/percentage-base rules.
- `calculation/CostCalculation.test.ts` — the exact-vs-settled discount check
  (a discount exactly equal to its line is legal; one that genuinely exceeds a
  line is not), exact shares published alongside settled ones, and the
  inclusion-flag semantics in all four combinations.
- `comparison/Ranking.test.ts` — percentage difference published at two
  decimals half-up, with the exact ratio kept for audit and the monetary
  values untouched by the rounding.

## Round 2, Checkpoint 1 — authoritative total coverage

`comparison/AuthoritativeTotal.test.ts` covers the rule that the commercial
total is the exact total rounded once, and the invariance that depends on it.
Every case below failed before the fix:

- **Decomposition invariance.** `20.008` versus `10.004 + 10.004` as a cost,
  as a surcharge, and as a discount; and `20%` versus `10% + 10%` as a cost
  and as a discount, the latter also asserting the parallel (never sequential
  19%) reading. Each pair must tie, not merely land close.
- **Winner inversion.** Sixteen costs of `1.004` (exact 1,016.064) against one
  cost of `16.02` (exact 1,016.02). The genuinely cheaper supplier wins;
  before the fix the more expensive one did, because sixteen sub-kuruş tails
  each rounded away.
- **Order invariance.** The same five mixed entries — discount, two fixed
  costs, a percentage duty, a surcharge — in forward and reverse order. Same
  total, same rank, same winner, and the stronger claim that *every individual
  component* settles to the same figure, because remainders break on `cost.id`
  rather than array position.
- **The identities, on every scenario.** `rankingAmount == settledLandedTotal
  == roundHalfUp(exactCalculatedLandedTotal, minorUnit)`, the supplier-level
  breakdown, the per-line breakdown across a three-line allocated supplier,
  and sign safety: no entry crosses zero and a non-contributing entry settles
  to exactly zero.
- **Minor units of 0, 2 and 3 digits.** A 0-decimal currency where `0.5 + 0.5`
  used to cost two whole units instead of one, half-up on the total at 0
  digits, and a 3-decimal currency splitting `20.0008`.

## Round 2, Checkpoint 2 — discount validation vs explanatory allocation

`comparison/DiscountLineValidation.test.ts` covers the split between the
mandatory per-line discount check and the optional per-line explanation. The
first two groups failed before the fix — the supplier came out `COMPLETE` with
a warning in both:

- **An unrelated failure cannot mask a bad discount.** 900 TRY on a `pcs`
  line and 100 TRY on a `kg` line, a 600 TRY `EQUAL_PER_LINE` discount (300
  onto a 100 TRY line) and a `BY_QUANTITY` freight that cannot be weighted
  across those units. `INVALID`, with no warning and no rank — whichever cost
  is listed first, and whether the discount is fixed or a percentage.
- **A discount whose own weighting cannot be established.** A non-zero
  discount set to `BY_QUANTITY` across mixed units: `INVALID` with a
  `DiscountAllocationValidationError`, explicitly *not* an
  `ALLOCATION_UNAVAILABLE` warning. Its share of each line is unknowable, so
  the per-line rule cannot be proven.
- **A zero-value discount is not a financial problem.** `0` TRY and `0%`
  discounts with the same unusable method: still `COMPLETE`, still ranked,
  warning only — and a real discount on the same quote is still fully checked.
- **A discount excluded from the compared total is still checked.** The same
  600 TRY overdrawing discount with `includeInComparison: false`
  (`alreadyIncludedInQuote: false`) reaches byte-for-byte the same `INVALID`
  verdict as the included variant — it still lowers `merchandiseAfterDiscount`,
  so it is real money at line level too. A discount with
  `alreadyIncludedInQuote: true` is still skipped (it is already in the line
  prices), and an excluded discount that fits every line stays `COMPLETE` with
  its ranking amount untouched.
- **A discount that fits stays valid.** Discount plus freight plus duty, fully
  allocated, per-line values reconciling to the header; a discount exactly
  equal to the line it sits on still legal; a discount that overdraws a line
  with nothing else going wrong still `INVALID`.
- **Order invariance of the verdict.** All six orderings of
  discount/freight/duty, for both a bad discount (always `INVALID`) and a good
  one (always the same ranking amount and rank). A bad discount cannot become
  valid by moving a row.
- **Explanatory allocation still fails softly.** The winner regression from
  Checkpoint 1 re-asserted with the new pass in place — `COMPLETE`, rank 1,
  `costAllocation` undefined, `ALLOCATION_UNAVAILABLE` — including the variant
  where a well-formed discount is present, and the free-sample case.

Supporting unit coverage: `calculation/Allocation.test.ts` for
`exactAllocationShares` (unsettled shares, agreement with the exact shares
`allocateAmount` publishes, sign propagation, identical unusable-weighting
errors), and `calculation/CostCalculation.test.ts` for
`validateDiscountLineAllocations` called directly — including that it ignores
ordinary costs and non-contributing discounts, and reaches the same verdict in
every cost ordering.

## Round 2, Checkpoint 3 — monetary precision hardening

`calculation/MonetaryPrecision.test.ts` covers the rule that an input the
engine *accepts* settles to the mathematically correct minor unit. Eleven of
its eighteen cases failed before the fix, each as a silently wrong cent rather
than as an error.

Every expectation is checked against `domain/monetary/exactReference.testSupport.ts`,
a `BigInt` implementation that shares no code with the engine. That is the
point of the file: verifying decimal.js arithmetic with decimal.js arithmetic
would have reproduced the same premature rounding on both sides of the
assertion and passed while the money was wrong.

- **The auditor reproduction.** `12345678901234567890123456789012.34` at
  `10.005%`. Exact duty `1235185174068518517406851851740.684617`, settling to
  `...740.68`; the engine used to compute `...740.685` (the product rounded to
  34 significant digits) and settle it to `...740.69`. Asserted on the
  percentage alone, and carried through `calculateSupplierCosts` where the
  landed total used to come out `...753.03` instead of `...753.02`.
- **Large merchandise x percentage**, with the merchandise total itself built
  from `unitPrice x quantity` rather than typed in.
- **FX conversion.** A 32-significant-digit amount times a 17-digit rate — a
  48-digit product, kept in full and settled correctly.
- **FX and percentage together.** Quote currency converted to base, then
  charged a duty; exact and settled figures both pinned.
- **Addition and subtraction at the edge.** A cent-scale amount added to and
  subtracted from a 34-digit one (both used to return the large amount
  unchanged), and a five-term sum spanning 33 orders of magnitude.
- **Minor units of 0, 2 and 3 digits**, including a 0-decimal currency whose
  settled total must carry no decimal point at all.
- **The envelope, pinned on both sides.** `integerDigits + minorUnit == 34`
  accepted *and correct*; `== 35` rejected as `PrecisionEnvelopeExceededError`;
  and the same amount accepted at 2 minor-unit digits but rejected at 3, to
  show the boundary is about digits rather than about how much money it is.
- **`exactCalculatedLandedTotal` really is exact.** Compared digit for digit
  against the independent reference through the public `compareSuppliers` API,
  together with the identity `rankingAmount == roundHalfUp(exact, minorUnit)`.

## Round 2, Checkpoint 4 — non-negative per-line settlement

`comparison/NonNegativeLineSettlement.test.ts` covers the rule that a line
whose exact landed value is non-negative is never *displayed* negative. Six of
its thirteen cases failed before the fix — as a `-0.01` on a valid product
line, while the supplier total reconciled perfectly:

- **The two reproductions.** `0.005 / 0.005 / 100` with a `0.015` discount,
  and the stronger `0.004 / 10 / 10` with a `0.012` discount, both
  `EQUAL_PER_LINE`. In the second the discount is valid at exact precision
  (`0.004` per line, exactly the tiny line's worth) and the leftover kuruş
  used to land on the line with no settled capacity. Per-line values are
  pinned, not just the sign.
- **Every allocation method.** `BY_QUANTITY` and `BY_MERCHANDISE_VALUE` over a
  tiny line, and several valid discounts on one supplier — two fixed plus a
  percentage — settling together.
- **Positive effects create capacity.** Freight and a surcharge settled onto a
  line before a discount is placed on it, so the line can absorb a kuruş it
  could not have absorbed on merchandise alone.
- **Minor units of 0, 2 and 3 digits**, including a 0-decimal currency where
  the leftover yen skips the line that settled to zero (`0 / 99 / 100`).
- **Order invariance.** Four mixed entries — two discounts, a cost, a
  surcharge — forward, reversed and shuffled: same total, same *per-line*
  values, because settlement breaks on `cost.id` rather than array position.
  Plus two suppliers with identical costs entered in opposite orders, which
  must tie at rank 1. And the complement: the breakdown still reads in the
  order the costs were supplied, even though discounts are settled last.
- **A 200-scenario seeded sweep.** Two to five lines drawn from a price pool
  that includes sub-kuruş values, up to two positive effects and up to three
  discounts across all three methods. Every completed settlement must satisfy
  *both* invariants at once — no negative line, and lines summing to
  `settledLandedTotal` — with the authoritative-total identity re-checked on
  each. A generated discount may genuinely overdraw a line; that is Checkpoint
  2's refusal, so those are skipped, and a floor on the number of completed
  scenarios keeps the sweep from quietly becoming vacuous.

## Round 2, Checkpoint 5 — integration coverage

Checkpoints 1–4 each prove one rule against a deliberately minimal quote,
which is the right shape for a regression test and the wrong shape for
confidence that the four hold *together*. A supplier a user actually enters
carries a MOQ and a pack and a foreign currency and a fixed freight and a
percentage duty and a discount at once.

`comparison/IntegratedScenarios.test.ts` exercises exactly that overlap, and
only that — where a scenario would restate what a focused suite already pins,
it asserts the combined behaviour instead. Expected totals are checked against
`domain/monetary/exactReference.testSupport.ts`, the `BigInt` reference that
shares no code with `decimal.ts`, so an integrated expectation cannot be
satisfied by the implementation agreeing with itself.

- **A — every feature at once, on two competing suppliers.** MOQ (105 → 200),
  pack (30 → 32 in whole packs of 4), a USD quote against an EUR one, a fixed
  freight, a percentage duty on the CIF-like base, a percentage discount,
  per-line allocation and a ranking. The twice-constrained supplier still
  wins. All four invariants — authoritative total, breakdown reconciliation,
  per-line reconciliation, non-negative lines — are asserted on both suppliers
  in one helper.
- **B — a seven-decimal rate under a discount and a per-line split.** Line A
  is worth `0.2838760533` TRY, and the `0.8516` discount's equal shares each
  truncate to `0.28` with an identical remainder, so the leftover kuruş is
  offered to line A first. Two variants pin both outcomes of the capacity
  rule: with a duty settled onto the line first, the line *can* take it
  (`0.28 + 0.03 − 0.29 = 0.02`); with the duty removed, it cannot and the
  kuruş moves on. The exact total is matched digit for digit against the
  reference.
- **C — the two input orderings nothing else covered.** The cost-row ordering
  is already pinned by `AuthoritativeTotal.test.ts` and
  `NonNegativeLineSettlement.test.ts`. Quote-item order is proven to change
  literally nothing (items match requirements by id). Requirement order is
  proven to leave the exact total, the ranking amount, every settled cost
  effect and the winner identical, while only the placement of a leftover
  minor unit may move — and that movement is bounded at one minor unit per
  line, asserted rather than described.
- **D and E — the same quote, one field apart.** An unusable `BY_QUANTITY`
  weighting is present in both, so the only thing deciding `COMPLETE` from
  `INVALID` is whether the discount is legal — now with a foreign currency, a
  MOQ and a percentage duty layered on, and a rival supplier whose rank moves
  with the verdict. D: warned, ranked first, per-line shares absent and
  nothing pretending otherwise. E: `INVALID`, unranked, `warnings` empty, in
  all three cost orderings.

`comparison/SettlementAssertionPropagation.test.ts` covers the fourth error
category for Checkpoint 4's guards. By design no ordinary input can reach
`assertNoLineSettlesNegative` — that is what makes it an assertion — so the
allocation step is mocked to return a breakdown that still reconciles to the
authoritative total but puts one line below zero. The subject is the
*classification*: it must throw `SettlementReconciliationError` out of the
pipeline, not return an `INVALID` supplier, because a broken engine must never
look like a broken quote. The mock is isolated in its own file, like
`SupplierEvaluation.errorPropagation.test.ts`.

## Future priority

Phases 0–5 form Checkpoint 1 — the calculation and comparison engine is
functionally complete and UI-independent. Phases 0–5 have been through one
independent adversarial audit and this remediation; the next step is a
re-audit before Phase 6+ (UI) work begins. Beyond that, the highest testing
priority remains financial calculation correctness and business-risk
scenarios — since errors there directly affect the numbers users rely on to
make purchasing decisions.

---

## Phase 10 — the two database suites

The application suite (`npm run test`) is unchanged and still runs with no
container runtime: 75 files, 1121 assertions, none of which know the cloud
exists. Two new suites sit beside it, and the split between them is not
organisational — each one is blind to something the other sees.

### `npm run db:test` — pgTAP, 105 assertions in six files

Runs inside the database, in a transaction that is rolled back.

| File | What it establishes |
| --- | --- |
| `010_schema_posture` | P0–P17 over the **catalogue**: RLS enabled *and* forced, a policy per granted command, `with_check` on every UPDATE policy, no `delete` anywhere, `anon` holding nothing including schema `USAGE`, `security_invoker=on` on every `api` view, `EXECUTE` revoked from `PUBLIC` on every function, `search_path` pinned on every function, the RLS helpers granted to `authenticated` and the trigger helpers to nobody, `api` holding no base table, and the decimal forward guard |
| `020_policy_pattern` | The four-policy pattern, exercised by a real `authenticated` session against a probe table built and rolled back inside the test. Cross-tenant INSERT refused, tenant-move refused, forged audit fields overwritten, DELETE refused at the privilege level |
| `030_tenant_isolation` | Two organisations, four users, every read taken through an `api` view — including an account with no membership at all, and a JWT that *claims* an organisation and a role |
| `040_membership_lifecycle` | Disabling a membership takes effect on the next statement with the session untouched; a member cannot promote themselves |
| `050_provisioning` | The five failure cases A–E at the transactional level, plus the authority checks the database re-proves rather than trusting the Edge Function for |
| `060_integrity_and_write_gate` | The restore write gate including threat 22 (the lock holder's *own* second session is refused), append-only enforcement against the table owner, tenant immutability, and the stale-write predicate in `api.update_own_profile` |

Every assertion is expressed over the catalogue rather than over a list of
names, so an object added by a later phase is inside its scope automatically. An
assertion phrased as "`app_data.products` has RLS" would pass forever while
`app_data.quotes` did not.

### `npm run test:security` — HTTP, 37 assertions in four files

Runs `supabase db reset` first, so **the migration chain is replayed from an
empty database on every run** rather than on the days somebody remembers. Then
it makes real requests.

These exist because of one sentence: *pgTAP runs inside the database and
therefore cannot see PostgREST's exposed-schema configuration at all.* The
control that makes the exact-decimal contract and the stale-write guarantee
invariants — that `app_data` has no route — is a property of a server setting a
dashboard edit can change, and no in-database assertion can see it.

| File | What only HTTP can show |
| --- | --- |
| `routeIsolation` | B4, B5, B8, B9. `app_data` and `app_private` answer `PGRST106` with the exposed-schema list quoted back, so widening `[api] schemas` fails here immediately. The RLS helper is **executable and simultaneously uncallable** — the pair that makes "a privilege is not a route" an observed state. A crafted `PATCH` reaches nothing. `anon` is refused at the schema, before any object is consulted |
| `tenantIsolation` | B1, B2, B6/B7 with two real access tokens. A wrong tenant and a nonexistent uuid return **identical** responses, which is what closes the enumeration oracle. The version predicate cannot be omitted, because there is no overload without it |
| `membershipDisable` | Threat 3, with the **same** token across the change. The in-database version of this test never involves a token, a signature or an expiry — and the tempting implementation that reads the organisation from a JWT claim passes it and fails here, silently, for as long as the token lives |
| `provisioning` | The Edge Functions against the real Auth Admin API: that authorisation happens *before* an account is created, that a retry returns the stored outcome and no second password, that an existing account is linked rather than re-credentialled, and that a stuck attempt is refused rather than raced |

The suite is excluded from `npm run test` by filename, so a developer without
Docker keeps the whole of Phases 0–9.

### `npm run verify:hosted` — twelve checks against a deployed project

Unauthenticated, and creates nothing — which is what makes it safe to point at
production before anybody exists on it. It asks the server what it is actually
serving, because the exposed-schema list lives on the `authenticator` role and a
dashboard edit changes it out from under the repository.

It is itself tested the only way a guard can be: by running it against a
deliberately broken local configuration. With `public` added to `[api] schemas`
it fails and quotes the wrong allow-list back; with `[auth] enable_signup = true`
it fails on sign-up. That second run also created a real auth row, which is why
the sign-up probe now sends a one-character password — GoTrue evaluates
`DISABLE_SIGNUP` before password strength, so a correct project still answers
`signup_disabled` and a broken one refuses the password before writing anything.

The script refuses to run if handed a secret key: `service_role` bypasses the
posture every check exists to confirm, so all twelve would pass while proving
nothing.

### `npm run db:advisors` — Supabase's own security advisor

Against the local database it reports exactly two INFO findings, both of them
intentional: `app_data.counters` and `app_private.managed_table` have RLS enabled
with no policy, which for a SERVER_ONLY table is the configuration rather than an
oversight. At `--level warn --fail-on warn` the result is "No issues found", so
the hosted step is an enforceable gate rather than a report somebody reads.

### The guard on the build

`npm run build` scans the production bundle for secret key material and fails
on a hit: `sb_secret_…`, and any JWT-shaped string whose DECODED role is not
`anon`. The original version searched for the text `service_role`, which a
JWT-form legacy key never contains; Audit A (A-M4) planted a synthetic
service-role JWT and watched it pass. The rule now lives in
`src/cloud/credentialPolicy.mjs`, shared with the runtime configuration check
and `verify:hosted`, and `src/cloud/credentialPolicy.test.ts` runs the real
script against synthetic bundles. It prints the kind and never the value,
because moving a key from a build artefact into a CI log is not an
improvement.

---

## Phase 11 — catalogue cloud cutover

The application suite now runs the cloud-backed UI against an in-memory gateway
at the React boundary while keeping the real cross-device and security claims in
the HTTP suite. Current result: **77 files, 1,139 tests, all passing**. Phase 11
adds login/logout and boot-state coverage; product create/update/stale/deactivate;
opaque supplier and customer codes; configurable and inactive customer-status
behaviour; Turkish comma and English dot decimal input; and four one-time
migration cases in `src/cloud/legacyMigration.test.ts` (success, confirmed
retirement, lost-response retry, and corrupt-row refusal).

`npm run db:reset` replays **all eleven migrations** from empty before synthetic
seed data. `npm run db:test` now runs **139 pgTAP assertions in seven files**;
`070_catalog_cloud.test.sql` covers the four tables/views, RLS and grants,
tenant-safe status FK, exact numeric storage/text projection, versioned
mutations, SKU uniqueness, an empty initial status list and explicit user-created
status examples. `npm run db:lint` reports no
schema errors.

`npm run test:security` now runs **52 tests in five files** against real GoTrue
and PostgREST. `catalog.security.test.ts` proves all four catalogue views are
tenant-isolated; canonical tables and writable views have no bypass; typed
mutations require current versions; independent sessions share committed state;
and the OWNER import is idempotent. Its release-blocking fixture creates and
reads `12345678901234567890.0047`, asserts exact raw and parsed string equality
plus `typeof === "string"`, and proves the numeric canonical route is absent.

The hosted gate is also executable: local/remote migration history matches
11/11, the Supabase security advisor reports no WARN findings, and the eighteen
anonymous HTTP posture checks pass. Functional browser smoke covered Turkish
and English boot/login/logout, products create/edit/deactivate, opaque external
codes, user-created customer statuses, an inactive status retained on its customer,
and a real stopped-server `SERVER_UNAVAILABLE` state.

## Audit A remediation, pass 1

Current result: **79 files, 1,174 unit tests**; **174 pgTAP assertions in eight
files**; **77 HTTP tests in ten files**; lint, typecheck, build and `db:lint`
clean. `npm run db:reset` replays **twelve migrations** from empty — the twelfth,
`20260924120000_audit_a_remediation.sql`, is local only until it is deployed.

What each finding's tests prove, against the real stack where it matters:

| Finding | Tests |
| --- | --- |
| A-H1 complete reads | `security/catalogPagination.security.test.ts` puts 1001 and 1500 rows of every catalogue entity behind real PostgREST (whose raw response is shown to stop at 1000) and requires all of them back in id order, with page sizes 333, 1000, 1200 and 5000; `gateway.test.ts` drives the real supabase-js client over a capped stub and requires a refusal, never a partial list, when the server's count and rows disagree |
| A-M1 legacy cutover | `security/legacyMigration.security.test.ts`: 1200 legacy products; a colleague's record during and after the import; a second device converging on a catalogue the cloud already holds; a different catalogue meeting a cloud in use; a genuine conflict; a server-limit violation named before sending; a lost response after commit. `legacyMigration.test.ts` covers the same states against a server-faithful double |
| A-M2 identity freshness | `app/authFreshness.security.test.ts` renders the real App over the real gateway: a membership disabled mid-session, another tab signing in as someone else, another tab signing out, a revoked refresh token. A MutationObserver fails the test if an "empty catalogue" message ever appears |
| A-M3 offline sign-out | `security/offlineLogout.security.test.ts` (real GoTrue) and `gateway.test.ts`: expired token, no network, sign-out → no credential stored → network back → still signed out; online sign-out also revokes the refresh token server-side |
| A-M4 credential guards | `credentialPolicy.test.ts`, `config.test.ts`: legacy anon JWT allowed only where explicitly supported, legacy service_role JWT and `sb_secret_` refused by the runtime check, the build scanner and `verify:hosted`, `sb_publishable_` allowed |
| A-M5 regression guards | pgTAP P18 (read views are read-only for every Data API role), P19 (no overloads in `api`), P20 (`p_expected_version`, without default, on every update/lifecycle RPC), a narrowed P12, the repaired `070` isolation assertion, and `080_audit_a_regressions.test.sql`; over HTTP, `security/catalogIntegrity.security.test.ts` (stale update and stale lifecycle on every entity, status assignability, writable-view PATCH of a genuinely updatable column) and exact status codes in place of `>= 400` |

**Proof that the new guards can fail.** Each regression Audit A reproduced was
re-applied temporarily — to the local database, or to a throwaway copy of the
source outside the repository — and each turned the suites red: an UPDATE grant
on the `api` views (pgTAP P18 and four HTTP tests); the version predicate and
status assignability removed from `update_supplier` / `update_customer` (eight
pgTAP and three HTTP tests); a weaker overload without `p_expected_version`
(P19, P20 and an HTTP test); an unpaginated catalogue read; a plain
`auth.signOut()`; an undecoded JWT role; an unguarded runtime without auth
events; an empty list not checked against membership; the organisation-wide
count comparison; invented zero counts after an inspection failure; and a
classifier without the transport status. The database was reset to its clean
migration state afterwards.

## Audit A remediation, correction pass 2

A source review of pass 1 found five places where the code promised more than
it did (R-1 to R-5, and N-1). Current result: **81 files, 1,203 unit tests**;
**175 pgTAP assertions in eight files**; **84 HTTP tests in ten files**; lint,
typecheck, build and `db:lint` clean; `db:reset` replays the same **twelve
migrations** — no schema change was needed.

| ID | Tests |
| --- | --- |
| R-1 / R-2 reconciled reads | `security/catalogPagination.security.test.ts` changes the REAL database between two pages of a 1200-row read (the fixture's `afterResponse` hook): a membership disabled after page 1 must fail as `NO_MEMBERSHIP`; a row committed behind the cursor must be in the result after exactly two traversals; one committed ahead must appear once in one traversal; rows committed behind the cursor on every traversal must end in `UNEXPECTED` after exactly `MAX_CATALOG_TRAVERSALS`. `gateway.test.ts` proves the same four over the real supabase-js client and a stub |
| R-3 exact decimal equality | `catalogRules.test.ts` (canonical form, 2^53 + 1 vs 2^53, 30-digit fractions, absent vs present, invalid text equal to nothing, server rules unchanged); `legacyMigration.test.ts` (`1.2`/`1.20`, `1.200`/`1.2`, a 24-digit value with trailing zeros converge; different values and absent-vs-present conflict; post-import verification uses the same equality; zero, negative and non-canonical factors still refused); `security/legacyMigration.security.test.ts` — PostgreSQL keeps `1.20`, the app writes `1.2`, and a second device still converges |
| R-4 action generation | `app/migrationAuthRace.test.tsx` pauses the real App's migrate and retire actions inside the backup delivery, then signs out, signs in as another user, or replaces the session with no event at all; the previous user's screen must not return, the legacy database must not be deleted and the cutover must not be marked. A control test proves the same paused retire does complete when nothing changed |
| N-1 boot identity | `boot.test.ts` (A → B between two reads restarts as B; a session changing under every attempt stops after `BOOT_IDENTITY_ATTEMPTS`); `app/authFreshness.security.test.ts` — a second tab signs in as B through real GoTrue right after the first boot request |
| R-5 column privileges | pgTAP P18 now fails for a column grant as well as a table grant (`has_any_column_privilege`, and the view and column ACLs for any grantee); P18b keeps SELECT in place |

**Proof that the new guards can fail**, each applied temporarily to a copy of
the source outside the repository or to the local database, and reverted:
reconciliation removed (3 unit and 3 HTTP tests red); raw text comparison of
decimals restored (5 unit and 1 HTTP); the action generation guard removed (3
of the 4 race tests; with only the pre-deletion check removed, 2); the final
boot identity check removed (2 unit and 1 HTTP); `grant update (note) on
api.customers to authenticated` and `grant insert (sort_order) on
api.customer_statuses to public` (P18 red, naming the view, role and column).

## Audit A remediation, correction pass 3

Current result: **81 files, 1,206 unit tests**; **175 pgTAP assertions**;
**87 HTTP tests in eleven files**; lint, typecheck, build and `db:lint` clean;
twelve migrations from empty, unchanged.

`app/retireAuthority.security.test.ts` drives the real App over the real
local stack: an OWNER starts "back up and remove", the action is paused in the
backup delivery, and the membership is changed in the database — OWNER →
MEMBER, and ACTIVE → DISABLED. The local database must survive, no completion
marker may be written, and the application must reboot to the MEMBER's
migration screen (no retire action) or the deactivated screen. A control test
proves the unchanged OWNER's retire completes. `app/migrationAuthRace.test.tsx`
adds the same downgrade deterministically, and proves the automatic retirement
of an EMPTY legacy database is not performed for a boot whose user no longer
holds the session (with a control: it still happens, for any role, when the
user does). Removing the live membership re-read turned both real-stack
downgrade tests and the deterministic one red; removing the empty-database
check turned its test red.
