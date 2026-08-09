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

## Future priority

Once calculation logic exists (Phase 2 onward, see
[Implementation Plan](IMPLEMENTATION_PLAN.md)), the highest testing priority
will be financial calculation correctness and business-risk scenarios: currency
conversion, MOQ/pack normalization, additional cost application, allocation, and
comparison ranking — since errors there directly affect the numbers users rely on
to make purchasing decisions.
