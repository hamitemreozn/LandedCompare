# Implementation Plan

Planned development order. Each phase builds on the previous one; later phases
are not started until the current phase is accepted.

- **Phase 0 — Foundation** (done): React + TypeScript + Vite project,
  test/lint/typecheck/build tooling, placeholder UI, base documentation.
- **Phase 1 — Domain & Monetary Foundation** (done): exact-decimal `Money`/
  `Quantity` value types backed by decimal.js (see
  [Calculation Rules](CALCULATION_RULES.md)), branded `CurrencyCode`, and core
  domain entities (`Project`, `RequirementItem`, `Supplier`, `Quote`,
  `QuoteItem`) under `src/domain/`, independent of React/UI/persistence/i18n.
  No landed-cost formula, exchange-rate conversion, MOQ logic, or persistence
  implemented — those remain scoped to later phases below.
- **Phase 2 — Core Calculation Engine** (done): manual exchange rate
  representation (`ExchangeRate`, `ExchangeRateTable`) and validation,
  exact-decimal currency conversion into the project base currency
  (`convertToBaseCurrency`), and merchandise line/quote total calculation
  (`calculateLineSubtotal`, `calculateMerchandiseTotal`,
  `calculateQuoteMerchandise`) under `src/calculation/`, independent of
  React/UI/persistence/i18n. No MOQ/pack/order-quantity resolution,
  additional costs, allocation, discounts, or supplier ranking implemented —
  those remain scoped to later phases below.
- **Phase 3 — MOQ / Quantity / Pack** (done): SKU-level MOQ resolution
  (`max(requiredQuantity, moq)`), user-defined pack/quoted-unit conversion
  with decimal-safe whole-pack ceiling (`Quantity.ceilDivide`, never native
  `Math.ceil()`), MOQ-then-pack operation order, and excess-quantity
  tracing, in `resolveOrderQuantity` (`src/calculation/QuantityResolution.ts`).
  `QuoteItem.orderQuantity` was removed (see
  [Calculation Rules](CALCULATION_RULES.md)) since a derived quantity has no
  business being a persisted field. Order multiple was scoped out as a
  `LATER` item (see Calculation Rules). No additional costs, allocation, or
  supplier ranking implemented — those remain scoped to later phases below.
- **Phase 4 — Additional Cost Engine** (done): supplier-level fixed and
  percentage costs across the nine preset categories (freight, insurance,
  duty/customs, brokerage, bank fee, local transport, packaging, tax, other),
  semantically distinct discounts and surcharges, three approved percentage
  bases evaluated in fixed acyclic stages, `alreadyIncludedInQuote` /
  `includeInComparison` handling, a traceable landed-total breakdown, and
  deterministic shared-cost allocation with largest-remainder minor-unit
  settlement (`Percentage`, `CurrencyMinorUnit`, `AdditionalCost`,
  `Allocation`, `CostCalculation` under `src/calculation/`). Fixed-cost FX
  reuses Phase 2's exchange-rate engine unchanged; `Money` gained sign and
  explicit minor-unit settlement operations (see
  [Calculation Rules](CALCULATION_RULES.md)). Item-level costs, weight/volume
  allocation, automatic Incoterm inference and any tax-law logic were
  deliberately scoped out (see [Architecture](ARCHITECTURE.md)). No supplier
  ranking, completeness, comparison or insights implemented — those remain
  scoped to later phases below.
- **Phase 5 — Comparison Engine** (done): supplier completeness detection
  (`COMPLETE` / `INCOMPLETE` / `INVALID`), a closed-allow-list error-capture
  boundary that maps expected Phase 1–4 domain errors to `INVALID` while
  letting internal engine bugs (`AllocationInvariantError`, anything
  unexpected) propagate, the ranking-boundary decision carried in from
  Phase 4 (`rankingAmount` — Phase 4's exact `calculatedLandedTotal` rounded
  to the base currency's minor unit, half-up, reusing
  `Money.roundToMinorUnit`/`resolveMinorUnit` unchanged), dense ranking with
  stable input-order tie-breaking, amount/percentage difference from the
  lowest `rankingAmount` with a safe zero-denominator case (never
  `Infinity`/`NaN`), and deterministic semantic insight codes (no
  natural-language text, no AI) including the
  `LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST` flip insight
  (`Percentage`, `CurrencyMinorUnit`, `Allocation`, `CostCalculation`,
  `MerchandiseCalculation`, `QuantityResolution` reused unchanged under
  `src/comparison/`). The product never selects a "best supplier" — only the
  lowest calculated landed cost among comparable suppliers. The effective
  landed *unit* cost metric remains explicitly deferred (see
  [Calculation Rules](CALCULATION_RULES.md)) — implementing it correctly
  needs a business decision this phase was not authorized to make. No UI,
  i18n, or persistence implemented — those remain scoped to later phases
  below.

  **ENGINE COMPLETE — CHECKPOINT 1.** Phases 0–5 form one reviewable unit:
  domain/monetary foundation, merchandise calculation, quantity/MOQ/pack
  resolution, additional costs and allocation, and supplier comparison —
  the full calculation and comparison engine, independent of any UI. This is
  the natural point for an end-to-end engine review before UI work (Phase 6+)
  begins.
- **Checkpoint 1 remediation** (done): hardening in response to an independent
  adversarial audit of Phases 0–5. No phase was redesigned and no new feature
  was added; the engine was corrected where it could have chosen the wrong
  supplier or shown a user two monetary figures that disagreed. In summary:
  allocation became an explanation layer that can be unavailable without
  invalidating a supplier (previously a genuinely cheaper supplier was dropped
  from the ranking); a single authoritative settled commercial total replaced
  two competing settlement models, so the header, the ranking and the
  breakdown are the same number; supplier-id lookups stopped resolving through
  the prototype chain; additional costs are validated at the engine boundary
  rather than trusted to have met the factory; `includeInComparison` and
  `alreadyIncludedInQuote` were separated into the two different questions
  they actually answer; the per-line MOQ/pack/excess trace now survives into
  the comparison result; the per-line discount check compares like precision
  with like; percentage differences are published at two decimals; and the two
  precision cliffs (whole-pack ceiling, allocation shares) were fixed with
  derived-precision arithmetic, with out-of-range amounts rejected by name
  instead of surfacing as an internal assertion. Documentation was corrected
  where it claimed guarantees the code did not provide. See
  [Calculation Rules](CALCULATION_RULES.md) and [Testing](TESTING.md).
- **Round 2, Checkpoint 1 — authoritative commercial total** (done): the
  remediation above made the header and the breakdown agree, but it did so by
  making the *sum of separately rounded components* authoritative. That was
  the wrong direction: it let the way a user split the same money across rows
  decide the answer — `20.008` ranked differently from `10.004 + 10.004`, and
  a supplier that was genuinely more expensive could win. The rule is now
  `settledLandedTotal = roundHalfUp(calculatedLandedTotal, minorUnit)`: the
  exact total is rounded once and the displayed components are reconciled to
  it, per sign so no entry crosses zero, with remainders broken on `cost.id`
  so input ordering is irrelevant. Header, ranking and breakdown still agree.
  Golden Scenario 6 now publishes 881.14, not 881.13. See
  [Calculation Rules](CALCULATION_RULES.md), "Authoritative commercial total".
- **Round 2, Checkpoint 2 — discount validation vs explanatory allocation**
  (done): allocation was doing two unrelated jobs in one pass — proving a
  discount does not overdraw a line (a financial rule) and producing a
  per-line breakdown (an explanation). Because the financial check sat at the
  *end* of that pass, an unrelated cost with an unusable weighting threw
  first, the caller correctly read it as "no breakdown available", and the
  discount was never checked: the supplier came out `COMPLETE` with a warning.
  `validateDiscountLineAllocations` now runs first, on its own, outside the
  warning-producing `try`, and a discount whose own weighting cannot be
  established is a `DiscountAllocationValidationError` rather than a warning —
  an unprovable financial check is not a passed one. See
  [Calculation Rules](CALCULATION_RULES.md), "Discount validation vs
  explanatory allocation".
- **Round 2, Checkpoint 3 — monetary precision hardening** (done): the
  settlement envelope promised that an accepted amount settles to the correct
  minor unit, and it did not. decimal.js rounds every operation — `plus`
  included — to the configured digit budget, so an accepted input could settle
  to the wrong cent (`12345678901234567890123456789012.34` at `10.005%`
  settled `.69` where the mathematics says `.68`), and a small amount added to
  a large one could vanish. Every monetary operation now runs at a precision
  derived from its own operands (`addExact`, `multiplyExact`,
  `proportionalShare`, …). The envelope boundary is unchanged; what changed is
  that it is now truthful inside it. See
  [Calculation Rules](CALCULATION_RULES.md), "Precision envelope".
- **Round 2, Checkpoint 4 — non-negative per-line settlement** (done): a line
  whose exact landed value was non-negative could still be *displayed*
  negative. Merchandise cents and discount cents were distributed
  independently, so a line worth `0.004` settled its merchandise to `0.00`,
  received the discount's leftover `0.01`, and showed `-0.01` while the
  supplier total reconciled perfectly. Cents are now distributed in capacity
  order — merchandise, then positive effects, then discounts — and a minor
  unit a line cannot absorb moves to the next line that can. Nothing is
  clamped. See [Calculation Rules](CALCULATION_RULES.md), "Non-negative
  per-line settlement".
- **Round 2, Checkpoint 5 — integration, documentation, full validation**
  (done): no new product behaviour. Checkpoints 1–4 were re-verified
  independently and then exercised *together*, because each had been proven
  only against a deliberately minimal quote
  (`comparison/IntegratedScenarios.test.ts`). Two coverage gaps were closed:
  the input orderings a user controls other than the cost rows (requirement
  order, quote-item order), and the classification of the per-line settlement
  assertions as engine failures rather than supplier verdicts
  (`comparison/SettlementAssertionPropagation.test.ts`). Documentation was
  corrected where it had fallen behind the code. Effective landed unit cost
  remains **not implemented**.
- **Phase 6 — Internationalization** (done): Turkish and English foundation
  under `src/i18n/` — locale detection and the `landedcompare.locale`
  preference, i18next wiring, `en`/`tr` catalogs typed against a shared shape
  so a missing key is a compile error, `Intl`-based number/currency/percentage
  formatting (presentation only, never fed back into a calculation), and
  `engineText.ts` as the single mapping from the engine's machine-readable
  codes to translation keys. The engine layers stay language-agnostic.
- **Phase 6.5 — Product & Data Architecture Checkpoint** (done):
  **documentation only — no production code changed.** The product was expanded
  from a quotation comparison tool into a local operational pilot for a real
  company running in parallel with Logo Tiger, and the architecture that
  expansion needs was defined before any of it is built: MVP scope and
  out-of-scope boundaries, five bounded domain areas, the catalog/purchasing/
  logistics/inventory/outbound entity model, an append-only inventory movement
  ledger with physical/reserved/available/on-order/in-transit separated, the
  lifecycle-vs-derived-progress rule, twenty-one numbered invariants, the
  IndexedDB/snapshot/external-backup recovery layering, `schemaVersion` versus
  `backupFormatVersion`, migration and restore safety rules, autosave
  behaviour, and fifteen open product decisions each carrying a recommended MVP
  default. The financial engine was not touched. See
  [Product Scope](PRODUCT_SCOPE.md), [Data Model](DATA_MODEL.md),
  [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md).

## Revised roadmap — Phase 7 onward

The original Phase 7–14 plan (persistence, five UI phases, data exchange,
hardening) was written for the comparison-only product and no longer covers the
work. It is replaced by the phases below. Phases 0–6 above are complete and are
not revisited.

Difficulty is a 1–10 estimate of implementation risk, not of hours.

### Ordering rationale

Persistence and backup come first because nothing else is safe to enter real
data into, and retrofitting a schema-versioned store under existing screens is
strictly worse than building on one. Catalog follows because both the analysis
screens and every operational document reference products. The analysis UI comes
next because it is the product that already exists in the engine and it produces
the purchase decisions the operational chain consumes. The inventory ledger is
built **before** purchasing and receiving, standalone, with only opening
balances and manual adjustments as inputs — the most correctness-critical module
in the system gets built and tested against the simplest possible inputs, before
documents start posting into it.

| # | Phase | Difficulty |
| --- | --- | --- |
| 7 | Local Persistence & Schema Foundation | 8 |
| 8 | Backup, Snapshots & Restore | 8 |
| 9 | Catalog & Parties | 4 |
| 10 | Projects, Requirements, Suppliers & Quotes UI | 7 |
| 11 | Quote Matrix, Costs & FX UI | 7 |
| 12 | Comparison Results UI | 6 |
| 13 | Inventory Ledger Core | 9 |
| 14 | Purchasing | 6 |
| 15 | Inbound Logistics & Receiving | 8 |
| 16 | Reservations & Outbound | 7 |
| 17 | Reconciliation, Reporting & Data Exchange | 6 |
| 18 | Pilot Hardening & Final QA | 7 |

---

- **Phase 7 — Local Persistence & Schema Foundation** (done, difficulty 8).
  *Objective:* a durable, versioned local database that everything else is built
  on.
  *Delivered:* `src/persistence/` — the `landedcompare` IndexedDB connection
  behind a thin native wrapper (no storage library; `fake-indexeddb` is a
  devDependency so the tests run against a real implementation), the full store
  layout from [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) §2,
  `schemaVersion` stamped into `meta` and re-validated on every open, the
  numbered migration runner with sequential steps and the
  higher-version-refusal rule checked both before and after `open()`, aggregate
  read/write where every operation names its stores and runs in one transaction
  that resolves on commit, the persisted-record ↔ runtime-domain mapping
  (`supplierIds` → `Project.suppliers`; `Money`/`Quantity` via their existing
  `toJSON`/`fromJSON`), explicit structural validation of untrusted stored
  data, the append-only write path for `inventoryMovements` with no update or
  delete operation at all, the autosave engine and save-state model (§5) with
  an injected clock, stale-write detection on `updatedAt`, the `BroadcastChannel`
  multi-tab advisory, typed quota handling, and `navigator.storage`
  persistence/estimate wiring. The financial engine was not touched, and a test
  runs `compareSuppliers()` before and after a save/load round trip to keep it
  that way.
  *Not delivered, by design:* snapshots, backup and restore (Phase 8); any
  entity behaviour for catalog, purchasing, logistics or inventory (Phases 9,
  13–16); any UI (Phase 9+). The canonical `PRE_MIGRATION` snapshot rule
  therefore cannot hold yet — see the honest limitation recorded in
  [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) §4, rule 3.
  *Dependencies:* Phases 0–6.
  *Risk (realised):* the migration runner was the sharp edge, exactly as
  predicted — two defects found by its own tests, both silent-corruption class:
  concurrent steps overwriting each other's output, and a failure captured
  after the result had already been reported.

- **Phase 8 — Backup, Snapshots & Restore** (done, difficulty 8).
  *Objective:* the pilot cannot lose its data.
  *Delivered:* `src/backup/` — internal snapshots taken in one transaction so
  they are coherent, with the full retention policy as a pure, deterministic
  function (§6); the versioned portable JSON envelope with manifest, per-store
  entity counts and SHA-256 over a canonical serialisation (§7); download
  export with `lastExternalBackupAt` stamped only after generation *and*
  delivery succeed, and the 7-day staleness rule as machine-readable state; the
  two-part restore — `prepareRestore()` read-only, `applyRestore()` destructive
  — with the `PRE_RESTORE` snapshot committed before a single atomic
  replace-all transaction over the business stores, **whose read-back
  verification runs inside that same transaction** so a refused restore aborts
  rather than replaces (§8); the payload migration runner that transforms a backup in
  memory and never uses the working database as a scratchpad; and the security
  rules of §9 (prototype-polluting keys reject the whole file, every record
  re-proven by the runtime validators, size/depth/record limits checked before
  the work they bound, whole-file rejection with a specific code).
  *Resolved from Phase 7:* the `PRE_MIGRATION` snapshot rule now has a working
  mechanism (`ensurePreMigrationSnapshot()`), which opens the database at its
  stored version, snapshots, and closes — because a snapshot written inside
  `upgradeneeded` rolls back with the migration it exists to survive. Tested
  against exactly that case.
  *Not delivered, by design:* any UI — Settings screen, file picker, restore
  wizard, notification (Phase 9+); the optional File System Access directory
  handle, which needs a picker and therefore that UI, and which the canonical
  design already requires the download path to stand in for; backup encryption
  (Product Scope, Open Decision 9 — post-pilot). Wiring
  `ensurePreMigrationSnapshot()` and `runSnapshotMaintenance()` into
  application startup is Phase 9's, because the decision on failure is
  user-facing.
  *Dependencies:* Phase 7.
  *Risk (realised):* the round-trip property test found a defect the unit tests
  could not. Phase 7's record parsers re-add absent optional fields as an
  explicit `undefined`, and the store helpers write that straight back — so a
  real database contains `note: undefined`, which has no canonical JSON form
  and which would have made a restored record differ from the one it came from.
  Normalising at the payload boundary fixes it; the underlying inconsistency is
  recorded below. The two things predicted to be dangerous — the pre-restore
  snapshot ordering and the atomicity of the restore transaction — were built
  as designed and are each proven by a test that injects the corresponding
  failure.

  **Correction made during review.** Post-restore verification originally ran
  on a *separate* transaction opened after the replace-all had committed, so a
  verification failure reported "the restore failed" over a database whose old
  contents were already gone — measured at the time as 2 suppliers / 1 project
  / 2 movements becoming 1 / 0 / 0. That is recoverable through the
  `PRE_RESTORE` snapshot, but it is not *failed restore = no-op*, which is what
  Phase 6.5 and Data Model I20 require. Verification now runs inside the
  replace-all transaction against its own uncommitted writes, and a failure
  aborts it; the same injected fault now leaves the database at 2 / 1 / 2. A
  post-commit read remains as a durability confirmation under a separate code,
  `RESTORE_COMMITTED_BUT_UNVERIFIABLE`, so a destructive outcome can never be
  reported with a no-op's error. Validation was not weakened: the same counts
  and the same sampled re-validation run, one step earlier.

  **Three corrections made during independent audit remediation.** An
  adversarial review of Phase 8 returned three findings of medium severity.
  Each is fixed here, with a regression test that fails without the fix.

  1. *The `active` indexes were always empty — now removed, at
     `schemaVersion` 2.* `products`, `suppliers` and `customers` each declared
     an index on a **boolean** `active` keyPath, and a boolean is not a valid
     IndexedDB key: a record carrying one is skipped by the index entirely.
     Reproduced: three products, two suppliers and three customers in the
     stores, **zero** entries reachable through any of the three `active`
     indexes, with no error anywhere. Phase 9 owns the active/inactive surface
     and would have met this as a catalogue screen that silently shows nothing
     over a populated database.

     The fix removes the indexes rather than replacing them with a stored
     `activeFlag: 0 | 1`. A mirrored copy of a boolean is duplicated state that
     every writer has to keep in step, and the day one forgets, the index and
     the record disagree with nothing to detect it. `active: boolean` stays the
     canonical field and "only the active ones" is a filtered read, which at
     pilot volume is the same reasoning §2 "No stored balances" already
     applies. This is the first real entry in both migration chains: a database
     step that deletes the three indexes and a payload step that is
     structurally a no-op and explicitly tested as one. See [Local Persistence
     & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) §2 and §4.
  2. *The payload normaliser silently destroyed values it did not
     understand.* `Date`, `Map`, `Set`, `RegExp` and `ArrayBuffer` were
     flattened to `{}` and a `Uint8Array` to an object with numeric keys —
     **before** canonical serialisation could reject them, so the payload
     checksummed cleanly and the loss was invisible. All of those are valid
     IndexedDB values that read back intact; the damage was at the backup
     boundary. That boundary now normalises exactly one thing (a plain-object
     property whose value is `undefined` may be omitted) and refuses everything
     else through the same rules and the same failure `canonicalize()` uses.
     Array order and length are data: an `undefined` element is rejected, never
     dropped.
  3. *A post-commit confirmation failure was reported as a no-op.* Once the
     replace-all transaction has committed, "the restore failed" can only mean
     "…and your data has already been replaced". A confirmation *read* that
     could not be performed — a connection closed by `versionchange`, for
     instance — surfaced as a bare `TRANSACTION_ABORTED`, which is
     indistinguishable from the pre-commit abort that leaves the old data in
     place. The whole post-commit phase now reports
     `RESTORE_COMMITTED_BUT_UNVERIFIABLE` with `workingDatabaseReplaced: true`
     and the `PRE_RESTORE` snapshot id, whether the read disagreed
     (`reason: COUNT_MISMATCH`) or could not happen at all
     (`CONFIRMATION_UNREADABLE`).

  **One Phase 7 observation recorded during Phase 8.** It does not block the
  pilot and belongs to the phase that owns the surface.

  1. *Absent optionals are written as explicit `undefined`.*
     [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) §3's rule —
     an absent optional field is stored by the key *not existing* — is
     documented and enforced in `records/project.ts` on the write path. The
     read path does not honour it: `optional()` returns `undefined`, so
     `parseSupplierRecord()` yields `{ …, note: undefined }`, and
     `putSupplierRecord` stores the parsed record verbatim. Phase 8 normalises
     every payload, so backup, snapshot and restore are correct regardless —
     and this is the *only* normalisation that boundary is permitted to
     perform (see correction 2 above). The tidy fix is the same
     `withoutUndefined` in the store helpers; there is no stored pilot data to
     migrate.

- **Phase 9 — Application Boot, Catalog & Parties** (done, difficulty 4).
  *Objective:* stable master records for products, suppliers and customers —
  and, because nothing can be entered into them until the application starts,
  the startup sequence that connects Phases 7 and 8 to a running product.
  *Delivered, part A — startup:* `src/app/bootstrap.ts` is the production
  caller the Phase 8 audit found missing. It asks for durable storage (best
  effort), calls `ensurePreMigrationSnapshot()` **before** opening — the order
  IndexedDB forces, since a snapshot written inside `upgradeneeded` rolls back
  with the migration it protects — opens (which is where a migration actually
  runs), runs `runSnapshotMaintenance()`, and reads `externalBackupStatus()`.
  Four explicit boot states (`INITIALIZING`, `READY`, `MIGRATION_BLOCKED`,
  `FAILED`); **no business data renders in any of them but `READY`**, so an
  empty product list can never stand in for a database that did not open.
  `VERSION_UNKNOWN` and a failed protective snapshot both block rather than
  migrate, with no override; the failure screen's only control is "try again",
  asserted by a test. The multi-tab `BroadcastChannel` advisory is connected
  and surfaces as a banner. Every failure crosses into the UI as a code and is
  translated by `src/i18n/persistenceText.ts`; no `DOMException` text reaches a
  screen.
  *Delivered, part B — product:* the application shell (navigation rail with
  the future modules shown as explicitly unavailable, language switch,
  app-level advisories), a hash router with no dependency, a dashboard of
  counts and local-data facts, and CRUD for `Product`, `Supplier` and
  `Customer` — list with search/status-filter/sort, form with validation,
  explicit Save under the stale-write contract, and deactivation instead of
  deletion. `products` and `customers` gain record types, typed stores and
  backup validators; `RequirementItem.productId` is added (Data Model §12).
  All three land at `schemaVersion` 3, with a database and a payload migration
  step that rewrite nothing and are declared and tested as no-ops.
  Case-insensitive SKU uniqueness is enforced inside the write transaction,
  because the unique index compares by code unit and cannot express it.
  *Dependencies:* Phases 7, 8.
  *Risk (realised):* low, as predicted. The sharp edges were Turkish text
  handling — `toLowerCase()` mangles `İ`, and code-unit sorting puts every
  Turkish letter after Z — and the fact that CSS `text-transform: uppercase` is
  language-sensitive, so `document.documentElement.lang` has to follow the
  selected locale or a heading loses its dotted capital `İ`.

  **Two canonical rules Phase 9 was careful not to break.** The three boolean
  `active` indexes removed at `schemaVersion` 2 are **not** reintroduced in any
  form — no `activeFlag`, no `activeKey`; "only the active ones" is a filtered
  read in the application layer. And no React component reaches past the typed
  stores: nothing imports `src/persistence/idb`, opens a transaction or calls
  `TransactionScope.put`, because a raw low-level write bypasses the record
  validators and can produce a record that will not restore.

  **One rule deliberately left to the phase that can prove it.** Data Model
  I11 — `product.stockUnit` is immutable once any movement exists — is not
  enforced here. At Phase 9 no movement can exist: `inventoryMovements` has no
  producer until Phase 13 builds the ledger. Implementing it now would mean
  widening every product save into a cross-store transaction against a store
  that is provably empty, which is Phase 13 logic wearing a Phase 9 label. The
  form tells the user the field becomes fixed once stock movements exist.

  **Scope correction made during Phase 7.** This phase was written to include a
  *supplier normalisation migration* — moving project-embedded suppliers into a
  `suppliers` store and replacing them with `supplierIds`. That migration is no
  longer needed and is not part of Phase 9. [Local Persistence &
  Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) §2 defines the schema as already
  normalised, and Phase 7's deliverable was that layout, so `suppliers` and
  `supplierIds` ship in `schemaVersion` 1. There is also nothing to migrate: no
  UI exists before Phase 10, so no persisted project data can predate the
  normalised shape. The corresponding row in [Data Model](DATA_MODEL.md) §12 is
  annotated with the same correction. What remains in Phase 9 is the supplier
  master's product surface — CRUD, deactivation, and the `active` flag — not a
  schema move.

- **Phase 10 — Projects, Requirements, Suppliers & Quotes UI** (difficulty 7).
  *Objective:* the existing engine becomes usable.
  *Deliverables:* project list and editor, requirement entry with optional
  product linking, supplier selection from the master, quote and quote-item
  entry with MOQ/pack fields, validation surfaced through `engineText.ts`
  translation keys, autosave integration.
  *Dependencies:* Phases 7, 9.
  *Risk:* first real UI phase — form/validation/i18n patterns get set here and
  everything later copies them.

- **Phase 11 — Quote Matrix, Costs & FX UI** (difficulty 7).
  *Objective:* enter the comparison inputs the engine already accepts.
  *Deliverables:* the side-by-side quote matrix, per-supplier additional costs
  across the nine categories with discounts and surcharges, the
  `alreadyIncludedInQuote` / `includeInComparison` distinction made
  comprehensible, manual exchange-rate table entry, minor-unit overrides.
  *Dependencies:* Phase 10.
  *Risk:* this is where a UI can quietly misrepresent an engine concept. The
  cost model's stage/base rules must be expressed, not simplified.

- **Phase 12 — Comparison Results UI** (difficulty 6).
  *Objective:* render the comparison result faithfully.
  *Deliverables:* ranking, the authoritative settled total, cost breakdown, the
  per-line trace with MOQ/pack/excess, allocation display with the
  `ALLOCATION_UNAVAILABLE` warning shown as non-blocking, `INCOMPLETE`/`INVALID`
  supplier states, insight codes rendered through i18n, and the "select this
  supplier" action that feeds Phase 14.
  *Dependencies:* Phase 11.
  *Risk:* the product never names a "best supplier"; the UI must not imply one.

- **Phase 13 — Inventory Ledger Core** (difficulty 9).
  *Objective:* the stock truth, built and proven in isolation.
  *Deliverables:* `InventoryMovement` append-only store, the seven movement
  types, magnitude+direction, reversal rules (I9, I10), opening balances,
  manual adjustments with reasons, the derived stock functions
  (physical/reserved/available and the overlap-aware incoming buckets), the
  per-product movement ledger view, and invariants I1–I13 under test.
  *Dependencies:* Phases 7, 9.
  *Risk:* the highest in the roadmap. Every later operational phase writes into
  this ledger, and a wrong rule here is discovered late and corrected
  expensively. It is deliberately built with no document dependencies so it can
  be tested exhaustively.

- **Phase 14 — Purchasing** (difficulty 6).
  *Objective:* a decision becomes an order.
  *Deliverables:* `PurchaseOrder` + lines, the `DRAFT → ORDERED → CLOSED |
  CANCELLED` lifecycle with code allocation, the `analysisRef` snapshot taken
  from the Phase 12 selection, manual (non-analysis) orders, derived
  shipment/receipt progress, the on-order quantity, and invariants I5, I14, I17.
  *Dependencies:* Phases 12, 13.
  *Risk:* the snapshot boundary. Nothing in this phase may read live quote data.

- **Phase 15 — Inbound Logistics & Receiving** (difficulty 8).
  *Objective:* close the loop from order to stock.
  *Deliverables:* `InboundShipment` + lines with the six-state lifecycle and the
  same-purchase-order validation rule, transit/customs/arrival tracking,
  `WarehouseReceipt` + lines posted atomically with their `PURCHASE_RECEIPT`
  movements, partial receipt and discrepancy reasons, reversing receipts, and
  invariants I6, I7, I8, I13, I15, I16.
  *Dependencies:* Phases 13, 14.
  *Risk:* the receipt-posting transaction is the first place documents and the
  ledger must move together.

- **Phase 16 — Reservations & Outbound** (difficulty 7).
  *Objective:* committed stock and goods going out.
  *Deliverables:* `InventoryReservation` with `ACTIVE | CLOSED | CANCELLED` and
  derived remaining/fulfilment, the available-stock block (I4),
  `OutboundShipment` + lines with `DRAFT → DISPATCHED → DELIVERED | CANCELLED`,
  dispatch posting `CUSTOMER_DISPATCH` movements atomically, partial dispatch
  against a reservation, customer returns, and the negative-physical-stock
  confirmation path.
  *Dependencies:* Phases 13, 9.
  *Risk:* reserved-vs-available arithmetic is the part users get wrong if the
  UI is ambiguous.

- **Phase 17 — Reconciliation, Reporting & Data Exchange** (difficulty 6).
  *Objective:* make the parallel run with Logo Tiger workable.
  *Deliverables:* the stock-count adjustment workflow, the stock overview
  showing all buckets as a decomposition that never sums, per-product movement
  history with document drill-through, open-order and expected-incoming views,
  CSV export of stock and movements for manual comparison, and the previously
  planned quotation-entry conveniences (clipboard paste, controlled CSV/XLSX
  import) if time allows.
  *Dependencies:* Phases 15, 16.
  *Risk:* low. The import conveniences are the droppable part.

- **Phase 18 — Pilot Hardening & Final QA** (difficulty 7).
  *Objective:* hand it to the pilot user.
  *Deliverables:* end-to-end scenario tests across the whole chain
  (quote → order → shipment → receipt → reservation → dispatch) with ledger
  verification, a full backup → wipe → restore drill, migration tests against
  realistic fixtures of every earlier version, empty/error/loading states,
  Turkish copy review with the pilot user's vocabulary, accessibility and
  keyboard flow for data-entry screens, performance at realistic ledger volume,
  and the pilot operating notes (daily backup routine, what to do when something
  looks wrong).
  *Dependencies:* Phases 7–17.
  *Risk:* this is where the honest answer to "is the pilot ready?" is produced.

---

Phases 0–5 are implemented — **Checkpoint 1: engine complete.** Phase 6
(i18n) is implemented. Phase 6.5 is an architecture/product checkpoint with no
production code. Phase 7 (local persistence), Phase 8 (backup, snapshots and
restore) and Phase 9 (application boot, catalog and parties) are implemented.
Phase 10 onward is not started.

**On entering pilot data.** The wiring Phase 8 named as Phase 9's first
responsibility is done: `runSnapshotMaintenance()` runs on startup,
`ensurePreMigrationSnapshot()` is called before any upgrade and blocks the
upgrade if it fails, and the staleness state is on the first screen the user
sees. Master data — products, suppliers, customers — can now be entered through
the application, and what is entered is snapshotted daily and covered by the
backup payload.

The honest limits, which are narrower than "ready":

- **There is still no way to press "export a backup".** The freshness warning
  is truthful and will stay loud, because nothing can make it go away yet. The
  Settings screen that exports and restores is a later phase, and until it
  exists the only disaster-recovery layer is unreachable from the UI. Data
  entered now survives a browser crash and a bad migration; it does not survive
  a dead disk.
- **Nothing operational exists.** No projects, quotes, comparisons, orders,
  shipments or stock. Master data entered now is exactly that — master data.

So: entering the company's real product, supplier and customer lists is now a
reasonable thing to do. Running the pilot on it is not.
