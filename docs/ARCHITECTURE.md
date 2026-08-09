# Architecture

## Phase 0 state

- React + TypeScript, built and served by Vite.
- Static, local-first, browser-executed application — no backend, no server
  component, no network calls at runtime.
- Single entry point (`src/main.tsx`) rendering a placeholder `App` component.

## Phase 1 state — domain & monetary foundation

`src/domain/` now exists and holds the domain model and monetary primitives
used by future calculation phases. It is a plain TypeScript layer with **no
dependency on React, the DOM, browser storage, or i18n** — it imports nothing
from `src/App.tsx` or any UI code, and nothing in it renders anything. This is
enforced by convention (no framework imports appear anywhere under
`src/domain/`), not by a build-time boundary rule; a lint/dependency-boundary
rule can be added in a later phase if the codebase grows enough for the
convention to be at risk.

The intended data flow for later phases is:

```text
domain/input → calculation engine → semantic result → UI
```

React components are not the source of truth for financial arithmetic; they
will only ever render values the domain/calculation layer already computed.

### Source layout

```text
src/
  App.tsx        # root component (currently a placeholder screen)
  App.test.tsx   # smoke test proving the test setup works
  main.tsx       # React entry point
  index.css      # global baseline styles
  test/setup.ts  # Vitest + jest-dom setup
  domain/
    monetary/
      decimal.ts       # single point of decimal.js configuration + exact parsing
      CurrencyCode.ts  # branded ISO-style 3-letter currency code
      Money.ts          # immutable exact-decimal amount tied to a currency
    quantity/
      Quantity.ts       # immutable exact-decimal, non-negative quantity
    project/
      Project.ts         # top-level container: requirements + suppliers + quotes
    requirement/
      RequirementItem.ts # a purchasing need to compare quotations against
    supplier/
      Supplier.ts         # minimal supplier identity (not a CRM record)
    quote/
      Quote.ts            # a supplier's quotation (conceptually separate from Supplier)
      QuoteItem.ts         # one priced line within a Quote
```

`features/`, `infrastructure/`, and `i18n/` directories still do not exist —
they will be added in later phases when there is real code to put in them.

## Phase 2 state — core calculation engine

`src/calculation/` now exists alongside `src/domain/` and holds the first
slice of the calculation engine: exchange rate representation, currency
conversion, and merchandise (line/quote) totals. It has the same constraints
as `src/domain/` — no React, DOM, browser storage, or i18n dependency — and
is built entirely out of pure functions and immutable value objects on top
of the Phase 1 `Money`/`Quantity` foundation; there is no hidden mutable
calculation state.

```text
src/
  calculation/
    ExchangeRate.ts             # value object: "1 fromCurrency = rate toCurrency"
    ExchangeRateTable.ts        # per-project rates, all converting into one base currency
    CurrencyConversion.ts       # convertToBaseCurrency(amount, rateTable)
    MerchandiseCalculation.ts   # line subtotal, merchandise total, quote-level result
```

This engine deliberately does not depend on `QuoteItem`'s `moq` /
`unitsPerQuotedUnit` fields. It consumes a plain
`{ unitPrice, calculationQuantity }` pair per line — `calculationQuantity` is
treated as an already-resolved input. *Why* that quantity has the value it
has (required quantity vs. MOQ vs. pack-rounded order quantity) was Phase 3
scope; the arithmetic engine stayed decoupled from quantity resolution so
Phase 3 could plug its resolved quantity in without reworking this engine —
see the Phase 3 section below.

### Monetary representation

See [Calculation Rules](CALCULATION_RULES.md) for the precision/rounding
rationale. In short: `Money` and `Quantity` wrap [decimal.js](https://github.com/MikeMcl/decimal.js)
internally (configured once, in `domain/monetary/decimal.ts`) instead of
native JavaScript `number`, because native floating-point cannot represent
values like `0.1 + 0.2` or `0.0047` exactly, and financial totals compound
that error. Both types are immutable and currency-unsafe operations
(combining `Money` in two different currencies) throw
`CurrencyMismatchError` rather than silently producing a wrong number.

### Serialization

`Money` and `Quantity` are never persisted or passed around as decimal.js
instances directly — decimal.js internals are not treated as a persistence
contract. Each type exposes `.toJSON()` returning a plain, deterministic
shape (`{ amount: string, currency: string }` for `Money`, `{ value: string }`
for `Quantity`) built from `.toFixed()` (canonical decimal string, never
exponential notation), and a matching `.fromJSON()` to restore the exact
same value. This shape is what IndexedDB persistence (Phase 7) will store.

### Domain entities

`Project`, `RequirementItem`, `Supplier`, `Quote`, and `QuoteItem` are plain
readonly TypeScript interfaces (data shapes), each with a small `createX()`
factory that enforces primitive structural invariants (non-empty id/name,
valid currency code, non-negative decimal quantity, a quote item's price
currency matching its quote's currency). They carry no calculated fields —
landed totals, rankings, and effective unit costs are derived output from a
calculation engine that does not exist yet, not persisted domain state.

## Phase 3 state — quantity, MOQ & pack resolution

`src/calculation/QuantityResolution.ts` adds `resolveOrderQuantity`, which
turns a `RequirementItem.requiredQuantity` plus a `QuoteItem`'s `moq` /
`unitsPerQuotedUnit` into the quantity that must actually be ordered. It has
the same constraints as the rest of `src/calculation/` (no React/DOM/storage/
i18n) and is built on Phase 1's `Quantity` type — it introduces no currency,
freight, or landed-cost logic and does not rewrite Phase 2's arithmetic.

```text
src/
  calculation/
    QuantityResolution.ts   # resolveOrderQuantity(required, moq?, unitsPerQuotedUnit?)
```

`Quantity` (Phase 1) gained the small set of exact-decimal operations this
required: `max` (MOQ), `multiply`/`subtract` (pack conversion, excess), and
`ceilDivide` (whole-pack rounding, built on decimal.js's `.ceil()` rather
than native `Math.ceil()`). See [Calculation Rules](CALCULATION_RULES.md)
for the full MOQ/pack rule set, including why MOQ is applied before pack
rounding and why order multiple was deferred.

### Domain model change

`QuoteItem.orderQuantity` (an optional field Phase 1 left for "Phase 3 to
read from and write to") was removed. Its semantics were ambiguous — nothing
distinguished a persisted user override from a Phase-3-calculated result —
and the project's stated principle is that a derived/calculated value must
never become a persisted source of truth. `resolveOrderQuantity` computes
the resolved quantity on demand from `QuoteItem.moq` /
`QuoteItem.unitsPerQuotedUnit` (which remain as genuine supplier-provided
inputs) every time it is needed, instead of caching it on the entity.

## Forward-looking principles (not yet implemented)

These are constraints for future phases, recorded here so early architectural
decisions don't accidentally violate them:

- Phase 3 implements only SKU-level MOQ and user-defined pack/quoted-unit
  resolution. Additional costs and allocation (Phase 4) and supplier
  ranking/completeness (Phase 5) are not implemented and are not derivable
  from Phase 3's API. Order multiple (a Phase 3 "should have") was also
  deferred — see [Calculation Rules](CALCULATION_RULES.md).
- Persistence (planned: IndexedDB, Phase 7) will be kept behind an interface
  separate from domain logic, using each type's `toJSON()`/`fromJSON()`
  contract, so the domain layer does not depend on browser storage APIs.
- The MVP has no backend. All computation and storage happens client-side.
