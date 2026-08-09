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

## Future priority

Once calculation logic exists (Phase 2 onward, see
[Implementation Plan](IMPLEMENTATION_PLAN.md)), the highest testing priority
will be financial calculation correctness and business-risk scenarios: currency
conversion, MOQ/pack normalization, additional cost application, allocation, and
comparison ranking — since errors there directly affect the numbers users rely on
to make purchasing decisions.
