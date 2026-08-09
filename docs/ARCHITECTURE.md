# Architecture

## Phase 0 state

- React + TypeScript, built and served by Vite.
- Static, local-first, browser-executed application — no backend, no server
  component, no network calls at runtime.
- Single entry point (`src/main.tsx`) rendering a placeholder `App` component.

## Source layout

```text
src/
  App.tsx        # root component (currently a placeholder screen)
  App.test.tsx   # smoke test proving the test setup works
  main.tsx       # React entry point
  index.css      # global baseline styles
  test/setup.ts  # Vitest + jest-dom setup
```

No `domain/`, `features/`, `infrastructure/`, or `i18n/` directories exist yet.
They will be added in later phases when there is real code to put in them —
creating them now would be empty-folder theater with nothing to enforce their
boundaries.

## Forward-looking principles (not yet implemented)

These are constraints for future phases, recorded here so early architectural
decisions don't accidentally violate them:

- Business logic (domain model, calculation engine) will be kept independent of
  the React UI layer, so it can be unit-tested without rendering components.
  Confirmed rules will live in [Calculation Rules](CALCULATION_RULES.md).
- Persistence (planned: IndexedDB) will be kept behind an interface separate from
  domain logic, so the domain layer does not depend on browser storage APIs.
- The MVP has no backend. All computation and storage happens client-side.

No class/type structures for the above are defined yet — those are Phase 1+
decisions.
