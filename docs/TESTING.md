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

## Future priority

Once MOQ/pack/order-quantity resolution and additional-cost logic exist
(Phase 3 onward, see [Implementation Plan](IMPLEMENTATION_PLAN.md)), the
highest testing priority remains financial calculation correctness and
business-risk scenarios — since errors there directly affect the numbers
users rely on to make purchasing decisions.
