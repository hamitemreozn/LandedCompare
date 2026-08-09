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
currency matching its quote's currency, **a quote item's `quotedUnitPrice`
not negative — zero is allowed, added during Phase 5 hardening, see
[Calculation Rules](CALCULATION_RULES.md)**). They carry no calculated
fields — landed totals, rankings, and effective unit costs are derived
output from a calculation engine that does not exist yet, not persisted
domain state.

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

## Phase 4 state — additional cost engine & allocation

`src/calculation/` gains the cost engine: fixed and percentage costs,
discounts and surcharges, and deterministic shared-cost allocation. Same
constraints as the rest of the layer (no React/DOM/storage/i18n), pure
functions and immutable values, built on Phase 1's `Money`/`Quantity` and
reusing Phase 2's exchange-rate engine unchanged.

```text
src/
  calculation/
    Percentage.ts         # exact-decimal percentage; "5" means 5%
    CurrencyMinorUnit.ts  # minimal, explicit minor-unit resolution
    AdditionalCost.ts     # cost/discount/surcharge model + construction-time validation
    Allocation.ts         # sign-safe largest-remainder allocator
    CostCalculation.ts    # staged evaluation -> landed total; cost allocation
```

The pipeline this completes:

```text
resolved quantity (Phase 3)
  -> merchandise calculation (Phase 2)
  -> discounts -> fixed costs -> percentage costs -> surcharges
  -> shared-cost allocation
  -> supplier cost breakdown + calculated landed total
```

Supplier ranking, completeness and comparison insights are **not** here and
are not derivable from this API — that is Phase 5.

### Staged evaluation instead of a dependency graph

Costs are evaluated in fixed stages (discounts → freight/insurance → other
costs → surcharges), and each stage may only reference percentage bases that
earlier stages finalised. This is deliberately *not* a configurable
dependency graph: a closed set of three bases plus a static stage table makes
a circular base (`Duty = 5% of Merchandise + Freight + Duty`) impossible to
express, and is validated at construction rather than discovered at
calculation time. See [Calculation Rules](CALCULATION_RULES.md) for the
stage/base table.

### One settlement boundary

Everything up to and including the landed total stays at full exact-decimal
precision, continuing the Phase 1/2 rule. Minor-unit rounding happens at
exactly one place — splitting a shared amount across lines — because a
per-line share of 33.3333… is not a payable figure. The allocator uses
largest-remainder distribution on the amount's *magnitude* and re-applies the
sign afterwards, so a discount and a freight cost travel the same code path,
and `sum(allocations) === settledAmount` holds exactly for both signs.

### Domain model change

`Money` (Phase 1) gained the operations this required: sign inspection
(`isZero`/`isNegative`/`isPositive`), `abs`/`negate`, and the two explicit
settlement operations `roundToMinorUnit`/`truncateToMinorUnit`. The rounding
*modes* live in `domain/monetary/decimal.ts` alongside the rest of the
decimal configuration, so the application's settlement behaviour is decided
in one place rather than per call site. Phase 1's rule that `add`/`subtract`/
`multiply` never round is unchanged — settlement is opt-in and named.

No entity gained a calculated field. Landed totals, allocated amounts and
percentage bases are all derived output, computed on demand.

### Item-level costs — deliberately out of scope

Phase 4 implements **supplier-level shared costs only**. An item-level cost
model would need its own currency conversion, its own inclusion flags, and —
the real problem — its own answers to questions this phase has no approved
rule for: does an item-level packaging cost enter the CIF-like duty base, and
does it participate in allocation at all? Rather than guess, the phase stops
at the foundation an item-level model would build on: allocation already
produces per-line amounts, and an item-level cost is structurally a shared
cost allocated entirely to one line.

## Phase 5 state — supplier comparison engine

`src/comparison/` now exists alongside `src/domain/` and `src/calculation/`.
It composes the Phase 2–4 engines per supplier rather than reimplementing any
arithmetic, and adds exactly one new derived value (`rankingAmount`, a
minor-unit-settled view of Phase 4's exact `calculatedLandedTotal`) plus
ranking, tie and insight logic on top. Same constraints as the rest of the
calculation layer: no React/DOM/storage/i18n, pure functions and immutable
values, no natural-language text produced anywhere in it.

```text
src/
  comparison/
    ComparisonStructuralValidation.ts  # project-wide structural preconditions (throws, blocks the whole comparison)
    SupplierEvaluation.ts              # per-supplier completeness + Phase 2-4 pipeline -> COMPLETE/INCOMPLETE/INVALID
    Ranking.ts                         # dense ranking, ties, amount/percentage difference, on rankingAmount only
    ComparisonInsights.ts              # deterministic semantic insight codes + structured parameters
    SupplierComparison.ts              # orchestrator: compareSuppliers(project, exchangeRateTable, ...)
```

The pipeline this completes:

```text
Requirements + Supplier + Quote
  -> comparison-level structural validation
  -> per-supplier completeness check
  -> Phase 3 quantity resolution -> Phase 2 merchandise -> Phase 4 cost/allocation
  -> supplier status (COMPLETE / INCOMPLETE / INVALID)
  -> ranking (COMPLETE suppliers only, on rankingAmount)
  -> deterministic insights
  -> SupplierComparisonResult
```

See [Calculation Rules](CALCULATION_RULES.md) for the full status model,
ranking-boundary rationale, tie/dense-ranking rules, and the insight code
table. Two decisions are worth calling out architecturally:

- **No new rounding system.** `rankingAmount` reuses Phase 4's
  `Money.roundToMinorUnit` and `CurrencyMinorUnit.resolveMinorUnit`
  unchanged. The exact `calculatedLandedTotal` is preserved alongside it on
  every `COMPLETE` supplier result, so nothing about Phase 4's "no premature
  rounding" principle is walked back — a second, explicitly-named settlement
  point was added for comparison specifically, matching the pattern
  Phase 4 already established for allocation.
- **Error mapping is a closed allow-list, not a catch-all.** Expected
  Phase 1–4 domain errors are mapped to an `INVALID` supplier result by an
  explicit list of error classes in `SupplierEvaluation.ts`; anything not on
  that list (in particular Phase 4's `AllocationInvariantError`) propagates
  unchanged. This is a deliberate architectural boundary: a per-supplier
  result must never be able to hide an engine-correctness bug behind a
  plausible business explanation.

### Domain model — unchanged

No domain entity (`Project`, `RequirementItem`, `Supplier`, `Quote`,
`QuoteItem`) gained a field. A `SupplierComparisonResult` (and everything
inside it — status, issues, `rankingAmount`, ranks, insights) is entirely
derived output, computed on demand from existing domain objects plus the
exchange-rate table and per-supplier cost lists already defined by Phase 2–4,
exactly like every calculated value before it in this codebase.

### Effective landed unit cost — still not implemented

Phase 4 left this metric to the results phase. Phase 5 does not implement it
either: doing so correctly would require either reversing Phase 2's
once-per-quote currency conversion or inventing a new proration rule to
spread a converted total back across lines — both are business decisions
outside this phase's approved scope. See
[Calculation Rules](CALCULATION_RULES.md) for the full reasoning. It remains
a deferred, open item, not something a future UI layer should compute
silently on its own.

## Forward-looking principles (not yet implemented)

These are constraints for future phases, recorded here so early architectural
decisions don't accidentally violate them:

- Order multiple (a Phase 3 "should have"), weight/volume allocation, and
  item-level costs remain deferred — see
  [Calculation Rules](CALCULATION_RULES.md).
- Persistence (planned: IndexedDB, Phase 7) will be kept behind an interface
  separate from domain logic, using each type's `toJSON()`/`fromJSON()`
  contract, so the domain layer does not depend on browser storage APIs.
- The MVP has no backend. All computation and storage happens client-side.
- Phase 5 produces a machine-readable comparison result only. Rendering it
  (Results UI), turning insight codes into text (i18n), and any
  supplier-quality/lead-time/warranty scoring — which this product does not
  and will not compute — remain out of scope for the engine layer entirely.
