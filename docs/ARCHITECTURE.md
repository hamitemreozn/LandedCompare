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

**Configured once is not the whole story.** decimal.js rounds *every*
operation — including `plus` — to the configured significant-digit budget, so
a single global precision is a ceiling on intermediate arithmetic, not a
guarantee about it: a cent added to a thirty-digit total used to disappear.
`domain/monetary/decimal.ts` therefore exposes a small derived-precision layer
(`addExact`, `subtractExact`, `multiplyExact`, `divideByPowerOfTenExact`,
`divideCeil`, `proportionalShare`), each evaluated on a constructor whose
precision is computed from its own operands, and `Money`/`Quantity` route
their arithmetic through it rather than calling decimal.js operators directly.
The global `DECIMAL_PRECISION` keeps a different job: it defines the
**settlement envelope**, the range of amounts this engine promises to settle
exactly at a currency's minor unit (`exceedsSettlementPrecision`). Derived
precision makes the arithmetic inside that envelope truthful; it does not
widen it. See [Calculation Rules](CALCULATION_RULES.md), "Precision envelope".

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
    CostCalculation.ts    # staged evaluation -> landed total; discount validation; cost allocation
```

The pipeline this completes:

```text
resolved quantity (Phase 3)
  -> merchandise calculation (Phase 2)
  -> discounts -> fixed costs -> percentage costs -> surcharges
  -> discount line validation (mandatory)
  -> shared-cost allocation (explanatory)
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

### One settlement stage

Every intermediate value — bases, percentage results, the exact landed total —
stays at full exact-decimal precision, continuing the Phase 1/2 rule.

Settlement then happens at exactly **one stage**, once every cost effect is
known, and produces the whole set of commercial figures from a single
`minorUnit` decision: the settled landed total, the settled merchandise total,
each entry's settled effect, and the per-line allocations. Allocation reads
that scale from the cost result rather than resolving its own — two
independently resolved scales are how a header and a breakdown drift apart.

`settledLandedTotal = roundHalfUp(calculatedLandedTotal, minorUnit)` is the
authoritative commercial total: **anchor the total, reconcile the parts.** The
components are then distributed to add back up to it, rather than the total
being assembled from separately rounded components. That direction matters
because `round(a) + round(b)` is not `round(a + b)`, so summing rounded parts
made the answer depend on how a user split the same money across rows —
`20.008` ranked differently from `10.004 + 10.004`, and a supplier that was
genuinely more expensive could win. Reconciliation runs per sign (costs on one
side, discounts on the other) so no entry can be pushed across zero, and
remainders break on the semantic `cost.id` so input ordering changes nothing.
See [Calculation Rules](CALCULATION_RULES.md), "Authoritative commercial
total".

The allocator uses largest-remainder distribution on the amount's *magnitude*
and re-applies the sign afterwards, so a discount and a freight cost travel
the same code path, and `sum(allocations) === settledAmount` holds exactly for
both signs — for amounts inside the settlement precision envelope, which is
checked explicitly rather than assumed.

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
table. Four decisions are worth calling out architecturally:

- **No new rounding system.** `rankingAmount` *is* Phase 4's
  `settledLandedTotal`, built from `Money.roundToMinorUnit` and
  `CurrencyMinorUnit.resolveMinorUnit` unchanged. The exact
  `calculatedLandedTotal` is preserved alongside it on every `COMPLETE`
  supplier result, so nothing about the "no premature rounding" principle is
  walked back — settlement is one named stage, not rounding sprinkled through
  the arithmetic.
- **Error mapping is a closed allow-list, not a catch-all.** Expected
  Phase 1–4 domain errors are mapped to an `INVALID` supplier result by an
  explicit list of error classes in `SupplierEvaluation.ts`; anything not on
  that list — in particular the internal assertions
  (`AllocationInvariantError`, `SettlementReconciliationError`,
  `RankingInvariantError`, `QuantityResolutionInvariantError`) — propagates
  unchanged. This is a deliberate architectural boundary: a per-supplier
  result must never be able to hide an engine-correctness bug behind a
  plausible business explanation.
- **Allocation failure is not supplier failure.** Per-line allocation
  explains a landed total; it does not produce one. An unusable weighting
  leaves the supplier `COMPLETE` with its total and rank intact and publishes
  a non-blocking `ALLOCATION_UNAVAILABLE` warning, on a list kept separate
  from `issues` so a consumer cannot mistake one for the other. The previous
  coupling dropped a genuinely cheaper supplier out of the ranking because its
  freight could not be split across lines measured in different units.
- **…but one use of allocation is validation, and it runs on its own.**
  Whether a discount takes more off a line than that line is worth is a
  financial rule, not a presentation detail. `validateDiscountLineAllocations`
  therefore runs *before* the explanatory pass and outside its warning-
  producing `try`, reusing the allocator's own weighting via
  `exactAllocationShares` rather than duplicating it. When both jobs shared
  one pass, an unrelated cost's unusable weighting threw first and the
  discount rule was silently skipped — so which cost failed first decided
  whether a financial rule was enforced. See "Discount validation vs
  explanatory allocation" in docs/CALCULATION_RULES.md.
- **Settlement order is not display order.** The per-line split has one
  constraint the supplier-level split does not: a line the user can see must
  not be shown below zero. Cents are therefore distributed in *capacity order*
  — settled merchandise, then positive effects, then discounts — with each
  line carrying a running capacity that a discount may not exceed, and a
  minor unit a line cannot take moving to the next line in the same
  largest-remainder order. Nothing is clamped, so the allocations still sum to
  the settled effect the authoritative total counted. `byEntry` and `byLine`
  still come back in the order the costs and lines were supplied: the
  calculation order is internal. Two assertions in `SupplierEvaluation.ts`
  guard the result rather than assume it — the lines reconcile to the total,
  and none of them is negative. See "Non-negative per-line settlement" in
  docs/CALCULATION_RULES.md.
- **Inputs to `compareSuppliers` are validated, not trusted.** Supplier ids
  are user-typed text used as object keys, so lookups never resolve through
  the prototype chain; `AdditionalCost` is a plain interface that anything
  structurally similar satisfies, so the engine runs the same validation the
  factory does. Both gaps were whole-comparison crashes, not edge cases.

### Domain model — unchanged

No domain entity (`Project`, `RequirementItem`, `Supplier`, `Quote`,
`QuoteItem`) gained a field. A `SupplierComparisonResult` (and everything
inside it — status, issues, `rankingAmount`, ranks, insights) is entirely
derived output, computed on demand from existing domain objects plus the
exchange-rate table and per-supplier cost lists already defined by Phase 2–4,
exactly like every calculated value before it in this codebase.

### Effective landed unit cost — still not implemented

Phase 4 left this metric to the results phase, and it is still **not**
implemented. What changed is that the obstacle is no longer structural: the
per-line trace now carries both quantities, the settled per-line merchandise
value in the base currency, and the allocated cost share, so the inputs exist.

What remains open is the part that was never a plumbing problem — whether the
denominator is the quantity the buyer *needed* or the quantity a MOQ forced
them to *buy*. Those are different business questions with different answers.
See [Calculation Rules](CALCULATION_RULES.md). It is a deferred, open product
decision, and not something a future UI layer should compute silently on its
own.

## Phase 6 state — internationalization

`src/i18n/` holds locale detection/preference, i18next wiring, the `en`/`tr`
catalogs typed against a shared shape, `Intl`-based presentation formatting, and
`engineText.ts` — the single place the engine's machine-readable codes are
mapped to translation keys. The engine layers (`domain`, `calculation`,
`comparison`) stay language-agnostic and produce no natural-language text; the
formatters are presentation only and never feed back into a calculation.

## Phase 6.5 — product & data architecture checkpoint

Phase 6.5 changed no production code. It expanded the product from a quotation
comparison tool into a local operational pilot (purchasing, inbound logistics,
inventory, reservations, outbound) and recorded the architecture that expansion
requires. The canonical documents are:

- [Product Scope](PRODUCT_SCOPE.md) — product definition, pilot operating model,
  MVP scope, out-of-scope list, open product decisions.
- [Data Model](DATA_MODEL.md) — entities, relationships, lifecycles, the
  inventory ledger, invariants.
- [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) — IndexedDB,
  schema versioning and migrations, autosave, snapshots, backup format, restore.

Only the architectural consequences are recorded here.

### Bounded modules after the expansion

The existing three engine modules are joined by operational modules and a
platform layer. The planned source layout:

```text
src/
  domain/        # value objects + procurement-analysis entities   (unchanged)
  calculation/   # landed-cost engine                              (unchanged)
  comparison/    # supplier comparison engine                      (unchanged)
  i18n/          #                                                 (unchanged)
  operations/    # NEW — catalog, parties, purchasing, logistics, inventory
  persistence/   # NEW — IndexedDB access, schema version, migrations, snapshots
  backup/        # NEW — portable backup format, export, validation, restore
  features/      # NEW — React screens; the only layer that knows about React
```

`operations/` follows the same constraints the engine layers already meet: plain
TypeScript, no React, no DOM, no direct storage access, no i18n. Stock
arithmetic, lifecycle transition rules and document invariants are pure
functions over data, and `persistence/` is what turns them into IndexedDB
writes. `persistence/` is the single module that knows IndexedDB exists.

### The engine stays a reusable bounded module

`domain`, `calculation` and `comparison` are untouched by the expansion, and the
dependency runs one way only: `operations` may read a snapshot of a comparison
result, and nothing in the engine may reference an operational entity. A
purchase order never calls `compareSuppliers()`.

Exactly one additive change to an engine-adjacent entity is planned in the whole
revised roadmap — an optional `productId?: string` on `RequirementItem`
(Phase 9). It is read by no code in `src/calculation` or `src/comparison`, which
consume `id`, `requiredQuantity` and `comparisonUnit` only, and it changes no
monetary behaviour.

### Persisted record shape vs runtime domain shape

The persistence layer is allowed to store a different shape from the one the
domain works with, and converts on the boundary. This is what lets the
operational model normalise data the engine holds denormalised, without editing
audited code.

The case that forced the rule: `Project` holds `readonly suppliers: readonly
Supplier[]`, so suppliers are effectively project-scoped — but a purchase order
must reference one company-wide supplier record. The resolution is to persist a
`suppliers` store plus `supplierIds` on the project record, and to hydrate
`Project.suppliers` on load into exactly the shape `compareSuppliers()` already
expects. The engine sees no difference. Same mechanism, same reason, for
`Money`/`Quantity`: stored as their existing `toJSON()` decimal-string shapes and
rebuilt through `fromJSON()`, never as class instances.

### Derived state is not stored

The rule Phase 3 established for `QuoteItem.orderQuantity` — a calculated value
has no business being a persisted field — now governs the operational model too.
Physical stock, reserved stock, available stock, on-order and in-transit
quantities, purchase-order shipment/receipt progress and reservation remainders
are all computed from the inventory ledger and the open documents. There is no
`product.stockQuantity`.

The one apparent exception is a genuine one: a purchase order snapshots the
commercial facts of the decision it came from (prices, quantities, the exchange
rates used, the settled landed total at decision time). That is a record of a
past event which cannot be re-derived once a quotation is edited — evidence, not
cache — and it is never recomputed or compared against a live calculation.

### Backup is architecture, not a feature

Because the pilot is single-machine with no server, the storage design carries
the durability responsibility an operations team would otherwise hold. The
layering is working data (IndexedDB) → internal snapshots (undo, lost with the
disk) → external portable backup files (the only disaster recovery), with an
explicit `schemaVersion` separate from `backupFormatVersion`, migrations that
snapshot before they run, and a restore that validates fully before it writes
anything and applies atomically when it does.

## Phase 7 state — local persistence & schema foundation

`src/persistence/` is now the **only module in the application that knows
IndexedDB exists**. The dependency runs one way:

```text
features / operations / domain
          ↓
      persistence
          ↓
       IndexedDB
```

`domain`, `calculation` and `comparison` gained no import, no field and no
behavioural change; the engine remains storage-agnostic and is proven so by
`persistence/engineIsolation.test.ts`, which runs `compareSuppliers()` on a
project and on the same project after a full save/load round trip and requires
the two results to be identical.

```text
src/
  persistence/
    schema.ts          # database name, SCHEMA_VERSION, the store/index layout
    database.ts        # open/upgrade/close, version refusal, meta validation
    migrations.ts      # the numbered migration runner
    idb.ts             # the thin native IndexedDB wrapper + transaction scope
    validation.ts      # structural validators for untrusted stored data
    staleWrite.ts      # updatedAt conflict detection
    autosave.ts        # debounce/retry/save-state engine (no React, no globals)
    storage.ts         # navigator.storage persistence + quota estimate
    tabAdvisory.ts     # BroadcastChannel multi-tab advisory
    records/           # persisted record shapes, validators, runtime mapping
    stores/            # typed read/write operations per store
```

### Native IndexedDB, not a wrapper library

No storage dependency was added. What this layer actually needs is "promisify a
request" and "run a callback inside one transaction, settling on
`complete`/`abort`" — about eighty lines in `idb.ts`, and tested directly. A
library would have added a proxy layer over the one property of IndexedDB that
most needs to stay visible: when a transaction is still alive. The single new
dependency is `fake-indexeddb`, and it is a devDependency used so the tests run
against a real implementation rather than a mock of this code.

### One database, one schema version

The database is named `landedcompare` — fixed, never derived from a route, a
project or a user. IndexedDB is already scoped to the browser origin, and this
layer does not pretend otherwise: a different browser or a cleared profile is a
different (or empty) database, which is precisely why external backup files
exist.

`schemaVersion` and the IndexedDB database version are kept numerically equal
but remain distinct concepts, because a Phase 8 backup payload carries a
`schemaVersion` and has no IndexedDB version at all. The application-level
version is stamped into the `meta` store inside the upgrade transaction and is
re-validated on every open; a database whose version — at either level — exceeds
what the build supports is **refused rather than opened**, since IndexedDB
cannot downgrade and an older build writing into a newer schema corrupts it
silently.

The current version is **2**. Version 1 declared an index on a boolean
`active` keyPath for `products`, `suppliers` and `customers`; a boolean is not
a valid IndexedDB key, so those indexes silently contained nothing at all over
populated stores. Version 2 deletes them and keeps `active: boolean` as the
canonical record field, filtered on read rather than mirrored into a second,
index-friendly copy that two writers could disagree about. The set of indexes
is part of the stored schema, so this is a genuine numbered migration — and
because `schemaVersion` also describes exported payloads, the backup migration
chain carries a matching, explicitly-tested, structurally-empty step.
`backupFormatVersion` is unaffected, which is the distinction those two numbers
exist to preserve.

### Transactions are the unit of correctness

`Database` exposes only `read(stores, …)` and `write(stores, …)`, so an
operation cannot run outside a transaction, and any set of stores can
participate in one. A write resolves on `oncomplete`, never on the individual
request — which is what lets the UI say "Saved" truthfully. Anything thrown
inside the callback, including a validation failure between two writes, aborts
the whole transaction; a typed `PersistenceError` keeps its own code rather than
being flattened into a generic abort.

Validation, mapping and id generation happen **before** the transaction opens,
because an IndexedDB transaction closes on the first turn of the event loop
with no pending request.

### Persisted shape vs runtime shape, made concrete

The rule Phase 6.5 wrote down now has an implementation. A project is *stored*
with `supplierIds` plus embedded requirements and quotes, and *loaded* as a
`Project` holding full `Supplier` objects — exactly the shape
`compareSuppliers()` already expects. Every `Money` and `Quantity` is stored as
its `toJSON()` decimal string and rebuilt through `fromJSON()` and the domain
factories; no class instance is written and nothing is hydrated by casting.

Data read back is treated as untrusted — it may be old, half-migrated or
hand-edited — so every record passes explicit structural validators that reject
unknown fields, unknown enum values, non-canonical decimals, non-UUID ids and
prototype-polluting keys.

### What Phase 7 deliberately did not build

No snapshots, no backup file, no restore (Phase 8); no catalog, purchasing,
logistics or inventory behaviour (Phase 9, and Phases 16–19 under the roadmap as
revised by Phase 9.5); no UI (Phase 9+). The `inventoryMovements` store exists
with its append-only write path and no update or delete operation at all, but no
stock arithmetic — the ledger phase owns that, and it is now built against
PostgreSQL rather than this store.

**The limitation Phase 7 recorded here — that the `PRE_MIGRATION` snapshot rule
could not hold — is resolved by Phase 8 below.**

## Phase 8 state — backup, snapshots & restore

`src/backup/` is the recovery layer. It sits **above** `src/persistence` and
depends on it one way; persistence knows nothing about backups, which is what
forced one structural decision worth recording (see "the pre-migration
sequence" below).

```text
features / operations
          ↓
       backup            ← here
          ↓
      persistence
          ↓
       IndexedDB
```

```text
src/
  backup/
    canonicalJson.ts     # deterministic serialisation + prototype-safe parsing
    checksum.ts          # SHA-256 via Web Crypto; scope and honest limits
    limits.ts            # size, depth and record bounds on untrusted input
    businessData.ts      # what a backup covers; per-store record validators
    envelope.ts          # the versioned file format, filename, strict parser
    payloadMigrations.ts # migrating a payload in memory, never the live DB
    snapshots.ts         # internal recovery snapshots (undo)
    retention.ts         # the retention policy, as a pure function
    maintenance.ts       # daily snapshot + retention, driven by app lifecycle
    preMigration.ts      # the PRE_MIGRATION snapshot and its open/close dance
    externalBackup.ts    # export, lastExternalBackupAt, staleness, origin info
    download.ts          # the one DOM-aware function in the module
    restore.ts           # prepare (read-only) and apply (destructive)
```

### Three layers, and the difference is the architecture

Working data in IndexedDB; internal snapshots as **undo**, which die with the
disk; external backup files as **the only disaster recovery**. The API keeps
the two recovery layers lexically apart — nothing in `snapshots.ts` is called a
backup and nothing in `externalBackup.ts` is called a snapshot — because the
one mistake this design cannot survive is a user believing a snapshot protects
them from a dead drive.

### Everything decidable is decided before anything is written

Restore is split into `prepareRestore()` (parse, verify, migrate in memory,
preview — writes nothing) and `applyRestore()` (snapshot, then replace **and
verify** inside one transaction). The split is what makes a confirmation screen
possible at all, and it is what lets every rejection path be tested by
asserting the database did not move.

The second half has a subtlety worth recording, because the obvious
implementation is wrong. `Database.write` resolves on the transaction's
`complete` event, so a verification step written *after* it inspects a database
whose old contents are already gone — a failure there reports "the restore
failed" over data that is neither the old state nor a valid new one, and the
pre-restore snapshot downgrades from a safety net to the only way back. So
counting and re-validating happen **inside** the replace-all transaction,
against its own uncommitted writes, and a failure aborts it. A post-commit read
still runs as a durability confirmation, under a different error code, because
once the transaction has committed the no-op guarantee no longer applies and
must not be implied.

That code covers the *whole* post-commit phase, not just the count comparison.
The confirmation read needs a connection and a transaction, and both can fail
on their own — most plausibly when `versionchange` closes the handle because
another tab started an upgrade. Letting that surface as a generic aborted
transaction would describe the confirmation's failure while implying the
restore's had rolled back, so a caller would report "nothing happened" over a
database that had already been replaced. Every exit past the commit therefore
carries `RESTORE_COMMITTED_BUT_UNVERIFIABLE` with `workingDatabaseReplaced:
true` and the pre-restore snapshot id, and names the cause in a
machine-readable `reason`. The two outcomes a caller must distinguish — *old
data intact* and *working database replaced* — are the one thing this layer
never leaves to inference.

### The read boundary refuses what it cannot represent

`Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer` and the typed arrays are all
valid IndexedDB values: the store accepts them and reads them back intact. None
of them has a canonical JSON form. A normaliser that walked stored objects by
their own enumerable properties would therefore convert each of them into
something harmless-looking — `{}`, or numeric keys — *before* the canonical
serialiser could object, producing a checksummed backup file that had silently
thrown data away.

So `normaliseStoredValue` enforces the canonical serialiser's own table, with
its own predicates and its own failure, and is permitted exactly one
normalisation: omitting a plain-object property whose value is `undefined`
(the absent-optional rule Phase 7 honours on write but not on read). Arrays are
not normalised at all — order and length are data. Everything else fails loudly
at a named path, which is the only acceptable outcome when the alternative is a
verified artifact that quietly means less than it says.

### The pre-migration sequence, and why it is not in `openDatabase()`

Two independent reasons, both of which look like they should not apply.
`upgradeneeded` runs inside the version-change transaction, so a snapshot
written there rolls back with a failed migration — it vanishes in the case it
exists for. And `openDatabase()` cannot call the backup module without
inverting the dependency direction this whole layering is built on. So the
sequence — read the stored version, open *at that version*, snapshot, close,
then open normally — belongs to whoever starts the application.
`ensurePreMigrationSnapshot()` implements it and reports; the startup wiring
and the screen that explains a `VERSION_UNKNOWN` are Phase 9's — **built, in
`src/app/bootstrap.ts`; see the Phase 9 section below.**

### No React, no i18n, one DOM function

The module produces machine-readable `BackupError` codes and state objects and
contains no user-facing string in any language. `downloadBackup()` is the only
function that touches `document`, isolated so that everything deciding *what a
backup is* remains testable without a browser — and so a missing API can never
cost the product its backup capability.

### What Phase 8 deliberately did not build

No Settings screen, no file picker, no restore wizard, no notification UI
(Phase 9+). No File System Access directory handle: a handle can only come from
a user gesture in a picker, which is the UI this phase must not build, and the
download path is required to remain the fallback in every case regardless. No
backup encryption (Product Scope, Open Decision 9 — post-pilot).

## Phase 9 state — application boot, catalog & parties

The first phase with a user in it. Two things arrive together, and they are
related: the startup sequence that connects Phases 7 and 8 to a running
application, and the first three screens with real records behind them.

```text
src/
  app/
    bootstrap.ts          # the startup sequence; no React, no strings
    useApplicationBoot.ts # drives it from React; owns the connection + advisory
    runtime.ts            # the AppRuntime context: the one thing screens get
    routes.ts             # four route ids and a hash
    useRoute.ts           # keeps the route and the address bar in step
  features/
    shell/                # navigation rail, boot screens, advisory banners
    dashboard/            # counts, local-data facts, backup freshness
    catalog/              # product service, screen, form
    parties/              # supplier + customer services, screens, forms
    shared/               # list mechanics, error translation, form errors
  ui/                     # tokens.css, components.css, fields, feedback, dialog
```

### The boot gate is a safety mechanism, not a loading spinner

`App.tsx` renders exactly one of four things — initialising, failed, migration
blocked, or the application — and the first three render **no business data at
all**. That is the point. An application that drops a user into an empty
product list because the database would not open has told them their catalogue
is gone, and the natural response is to start re-entering it over data that was
never lost. `AppRuntimeProvider` is mounted only inside the `READY` branch, so
`useAppRuntime()` cannot be reached without an open database and throws if it
is; a screen is structurally incapable of rendering over a failed boot.

The order inside `bootstrapApplication()` is fixed by IndexedDB's semantics,
not by preference: the `PRE_MIGRATION` snapshot has to commit **before** the
connection that triggers the upgrade is opened, for the reason in the Phase 8
section above. Snapshot maintenance and backup freshness come after the open
because both need the connection, and neither is allowed to stop the
application — a daily snapshot that will not fit is a warning, not a reason to
refuse to start over data that is perfectly intact.

Two failures *do* stop it, and both stop it before anything has been written:

- **the stored version cannot be established** (`VERSION_UNKNOWN` — a browser
  without `indexedDB.databases()`). "No database" and "a database one version
  behind" are the same answer there, and picking the harmless reading is the
  guess that silently migrates real data with no way back;
- **the protective snapshot could not be written.** The upgrade is not
  attempted. There is deliberately no override: a button labelled "upgrade
  anyway" is a button that destroys data.

Neither screen offers to delete the database. `deleteDatabase()` already
refuses the production name without an explicit token, and a test asserts that
the failure screen's only control is "try again".

### Screens do not know that IndexedDB exists

```text
screen → feature service → typed persistence store → IndexedDB
```

No component imports `src/persistence/idb`, opens a transaction, or calls
`TransactionScope.put`. That boundary is the one an independent audit warned
about: a raw low-level write bypasses the record validators, and a record that
never met them can be written today and refuse to restore from a backup
tomorrow. The services are where identity and time are decided — `id` is
generated once on create and reused on edit, `createdAt` survives every edit,
and `updatedAt` is restamped by the service rather than by the store, because
that value is what the stale-write check compares against.

### Active/inactive is a filtered read, and stays one

`schemaVersion` 2 removed the three boolean `active` indexes because a boolean
is not a valid IndexedDB key and the indexes were therefore always empty.
Phase 9 owns the surface they were meant to serve and does **not** reintroduce
them in any form — no `activeFlag`, no `activeKey`. `matchesActiveFilter` in
`features/shared/masterData.ts` decides it over records already read, which at
pilot volume is a scan of data that is about to be rendered anyway.

The same file carries the two Turkish text rules the rest of the UI depends on:
search folds case with `toLocaleLowerCase(locale)` (so "istanbul" finds
"İSTANBUL"), and sorting uses `Intl.Collator` (so `Ç` lands between C and D
rather than after Z). The deliberate exception is `normaliseSku`, which folds
case **without** a locale — whether two SKUs collide is a question about
identity and must not depend on the selected language.

### Stored values are locale-independent; only labels are translated

Two places in Phase 9 where the interface language could have leaked into the
data, and neither does.

**Units.** The predefined units are stored as codes (`PIECE`, `BOX`, …) and
labelled at render time, so the same choice made in Turkish and in English
persists the same value. A unit the company typed itself is stored and shown
verbatim and is never translated. One field carries both cases — membership in
the canonical vocabulary distinguishes them — because a `unitCode` beside a
`unitLabel` is duplicated state of exactly the kind `active` already refuses.
See `features/shared/units.ts` and [Data Model](DATA_MODEL.md) §4.

**Decimals.** A Turkish user types `12,5` and an English user types `12.5`;
both store `"12.5"`. `features/shared/decimalInput.ts` rewrites separator
characters for the current locale and does nothing else — no `parseFloat`, no
arithmetic — and hands the result to `Quantity.fromString`, which remains the
authority on whether it is a quantity at all. Thousands separators are not
accepted, which is what keeps the conversion free of magnitude guessing: the
one genuinely two-way shape (a locale grouping character followed by exactly
three digits, as in a Turkish `1.500`) is refused by name with a message
offering both unambiguous spellings, rather than resolved by a convention the
user did not know they were relying on.

`schemaVersion` does not move for either. The record shapes are unchanged, and
the only stored units are development records holding label-shaped strings,
which degrade gracefully into custom units — they remain valid, display exactly
as they were typed, and nothing rewrites them.

### Explicit Save, not autosave

Phase 7's autosave engine exists and these forms do not use it. Autosave is
right for a long-lived working document; a master record is a handful of fields
entered once, and its SKU is unique — autosaving would race the uniqueness
check against the user's typing. Explicit Save is also the shape the
stale-write contract wants: one save, one `previousUpdatedAt`, one answer. A
refused save surfaces as a banner with a reload action, never as a silent
merge.

### `schemaVersion` 3

Adding record types for `products` and `customers`, plus the optional
`RequirementItem.productId` the Data Model has had planned since §12, is a
record-shape change. Both database and payload migration chains gain a step
that rewrites nothing — the two stores are provably empty at version 2 and the
new field is optional-absent — declared for the reason rule 5 makes
non-negotiable: without the bump, a Phase 8 build would open a database full of
products it has no validator for, and export a backup it could never restore.

### What Phase 9 deliberately did not build

No backup export or restore UI — the dashboard states backup freshness
truthfully and says the export screen arrives later, which is a smaller claim
than a button that does not exist. No enforcement of Data Model I11
(`stockUnit` immutable once movements exist): at Phase 9 no movement can exist,
the ledger has no producer, and widening every product save into a cross-store
transaction against a provably empty store belongs to the phase that can prove
the precondition. No hard delete anywhere. No project, requirement, quote or
comparison screens.

*A note on the phase numbers in this section and in the source comments.*
Phase 9 was written against the roadmap current at the time, in which the ledger
was Phase 13 and the analysis screens were Phases 10–12. Phase 9.5 renumbered
everything from 10 onward (see [Implementation Plan](IMPLEMENTATION_PLAN.md)):
the ledger is now Phase 16 and the analysis screens are Phases 13–15. Comments
inside `src/` still carry the old numbers, deliberately — Phase 9.5 changed no
production code — and are corrected by whichever phase next edits the file. Where
a number and a description disagree, **the description is the intent**: "the
phase that builds the ledger" is unambiguous in a way "Phase 13" no longer is.

## Phase 9.5 — cloud & multi-user architecture checkpoint

Phase 9.5 changed no production code. It replaced the pilot's central platform
assumption — *one computer, no server, IndexedDB is the truth* — after the
company's real requirement became clear: the owner working from more than one
machine, office personnel on the same company data, and eventually Windows and
macOS desktop clients.

**The canonical document is
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md).** Only the
architectural consequences are recorded here; the detail — tenancy, RLS policy
patterns, the client/server classification, concurrency, cloud backup, the
threat model — lives there and is not duplicated.

### The authority model changed; the layering did not

```text
   features / operations
            ↓
     data gateway            ← NEW: the one module that knows Supabase exists
            ↓                        and the only one that names a schema
   Supabase → PostgreSQL     ← the single source of truth
```

That is the same shape as `features → persistence → IndexedDB`, with one module
replaced. The rule it enforces is also the same one: **exactly one module knows
what the storage technology is**, and screens reach it through feature services.
Phase 7 named this "the one real coupling to accept and watch"; it is now being
exchanged, and the exchange is contained because the coupling stayed where it
was put.

### The server-side layering is three schemas, and only one is an API

```text
   api          ← the ONLY schema the Data API serves.
                  security_invoker read views + typed RPCs. Nothing else.
        ↓
   app_data     ← canonical business tables. No route. RLS enabled and forced.
        ↓
   app_private  ← security and trigger helpers. No route.
```

This is the database's equivalent of the module boundary above, and it exists for
a reason the local architecture never had to face: **a client can address
anything the Data API exposes.** Putting canonical tables in `public` — which
Supabase exposes by default — would mean `GET /rest/v1/products` returning
`numeric` columns as JSON numbers, past every projection the exact-decimal
contract depends on. Two invariants follow, and both are enforced by routing
rather than by convention:

- no canonical business table is directly addressable;
- every client-visible exact decimal is returned only through an `api`
  projection that serialises it as canonical text.

The distinction that makes it work, and that is easy to get backwards:
**a database privilege is not an API route.** `authenticated` holds `SELECT` on
`app_data` tables (a `security_invoker` view needs it) and `EXECUTE` on the RLS
helpers (policy evaluation needs it), and neither grants any reachability,
because reachability is decided by the exposed-schema list. See
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §7.

### Why it had to happen before Phase 16

The product's central invariant — Data Model I4, *a reservation may not push
available stock below zero* — is a statement about the whole company, not about
one record. Two disconnected databases can each satisfy it and jointly violate
it, and no merge performed afterwards can un-promise stock to a customer. A
single serialisation point is therefore a **functional requirement of the
inventory model**, not an infrastructure preference, and a database transaction
is the only mechanism that provides one. Deciding this after the ledger,
receipts and reservations were built would have meant rewriting them.

### What this does not touch

- **The engine.** `domain`, `calculation` and `comparison` gain no import, no
  field and no behavioural change. They were storage-agnostic before and remain
  so, which is the entire reason the port is a port. The settlement model, the
  precision envelope and the authoritative-total rule are unchanged.
- **The Logo Tiger boundary.** Logo Tiger remains the system of record for
  accounting, valuation and official stock; no integration enters scope
  ([Product Scope](PRODUCT_SCOPE.md) §3).
- **The inventory model.** Physical / reserved / available, magnitude plus
  direction, append-only with reversal corrections, and invariants I1–I13 are
  unchanged in meaning. What changes is *where* they are enforced: the ledger
  becomes a table that `authenticated` has no insert grant on, writable only by
  three posting functions, so I7 and I9 become permissions rather than
  conventions.
- **Phase 9's screens.** Products, suppliers and customers are reused. The seam
  is the feature service, which already takes an opaque data handle from
  `AppRuntime` — see
  [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §24.

### The three ideas from Phases 7–9 that transfer, and one that does not

Transferring: **the transaction is the unit of correctness** (now a PostgreSQL
transaction rather than an IndexedDB one); **stored data is untrusted** (now
applied to imports and re-applied server-side); and **the boot gate** — no
business data renders until a working data source is confirmed, which against a
shared server matters more than it did locally.

Not transferring: **IndexedDB as the canonical business database**, and with it
the snapshot/retention/pre-migration machinery that existed to protect it. A
full classification of what is kept, adapted and retired is in
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §25.

## Forward-looking principles (not yet implemented)

These are constraints for future phases, recorded here so early architectural
decisions don't accidentally violate them:

- Order multiple (a Phase 3 "should have"), weight/volume allocation, and
  item-level costs remain deferred — see
  [Calculation Rules](CALCULATION_RULES.md).
- **The backend is now planned, not hypothetical.** Phases 0–9 ran with no
  server, and the entity boundaries and UUID identity chosen then are what make
  the move a port rather than a redesign. What is still refused is speculative
  indirection: no repository interface per entity, no unit-of-work abstraction
  and no DTO layer. One `DataGateway` type with a method per operation the
  features actually call — the same explicit-functions philosophy
  `src/persistence/index.ts` already follows. See
  [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §24.
- Phase 5 produces a machine-readable comparison result only. Rendering it
  (Results UI), turning insight codes into text (i18n), and any
  supplier-quality/lead-time/warranty scoring — which this product does not
  and will not compute — remain out of scope for the engine layer entirely.

---

## Phase 10 foundation and Phase 11 active catalogue

Canonical design: [Cloud & Multi-User
Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md), with an implementation report in
its historical §28 and Phase 11 report in §29. This section records only what
changed in the *module boundaries*.

### Two new source trees, and only one of them is TypeScript

```text
supabase/                  the server, and it is entirely declarative
  config.toml              exposed schemas, auth policy — security controls
  migrations/*.sql         the canonical schema history. Eleven files through Phase 11
  tests/*.test.sql         pgTAP: the catalogue and behavioural assertions
  functions/               two Edge Functions, the only server-side code
  seed.sql                 local development fixture. Synthetic, never pushed

src/cloud/                 the client side of the boundary
  config.ts                build-time configuration, and the key-safety check
  client.ts                the Supabase client. Schema pinned to `api`
  gateway.ts               THE ONLY MODULE THAT NAMES A DATABASE SCHEMA
  errors.ts                PostgREST/PostgreSQL failures → the existing codes
  boot.ts                  session → reachability → membership
  security/                the HTTP behavioural suite and its harness
```

The server-side deployment surface is **the migrations**. There is no
Node/Express tier: every operation this product performs is either a single-row
read under a row-level policy or a multi-row transaction, and PostgreSQL already
executes transactions. A stateless HTTP tier in front of it would add a
deployment target, a second place to get authorisation wrong, and a hosting
bill, to re-implement what `BEGIN … COMMIT` does.

### The dependency direction, extended

```text
  screens → feature services → persistence stores → IndexedDB     (Phase 9 history / cutover input only)
  screens → feature services → DataGateway → api schema → RLS     (Phase 11, live)
```

`src/cloud/gateway.ts` is the seam, and it is one type with a method per
operation — no repository interface per entity, no unit of work, no DTO layer.
It earns its place by having three jobs rather than by being an abstraction:
boundary conversions (decimals as canonical strings, timestamps normalised in
the view), hiding the read/write asymmetry (a read is a view, every write is a
typed RPC), and turning server failures into the error vocabulary
`src/i18n/persistenceText.ts` already translates.

The running application imports this boundary exclusively for catalogue data.
`AppRuntime` carries a `DataGateway`, selected organisation, membership and
profile; no IndexedDB handle crosses the boot gate. `src/cloud/legacyMigration.ts`
is the one exception to normal cloud-only operation: it opens the old database
only while the authenticated OWNER is on the cutover screen, reuses the Phase 8
validator and backup envelope, calls one idempotent server transaction, verifies
read-back counts, and retires the database. It is never a read fallback.

### What the module boundaries now forbid

- **No feature file names a schema, a table or a view.** Reorganising the API
  surface changes `gateway.ts` and nothing else.
- **No module outside `src/cloud/` imports `@supabase/supabase-js`.**
- **No raw server message reaches a screen**, the same rule that already keeps
  `DOMException` text off the UI, now covering PostgreSQL error text — which
  varies by server locale and names schemas, columns and constraints that mean
  nothing to a user and quite a lot to an attacker.
- **`src/domain`, `src/calculation` and `src/comparison` are untouched.** The
  engine was storage-agnostic by construction, which is the whole reason this
  port is a port rather than a rewrite.
