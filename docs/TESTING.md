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

## Future priority

Once supplier comparison exists (Phase 5 onward, see
[Implementation Plan](IMPLEMENTATION_PLAN.md)), the highest testing priority
remains financial calculation correctness and business-risk scenarios — since
errors there directly affect the numbers users rely on to make purchasing
decisions.
