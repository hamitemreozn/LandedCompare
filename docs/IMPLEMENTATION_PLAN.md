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

- **Phase 7 — Local Persistence & Schema Foundation** (difficulty 8).
  *Objective:* a durable, versioned local database that everything else is built
  on.
  *Deliverables:* `src/persistence/` — the IndexedDB connection, the store
  layout from [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) §2,
  `schemaVersion` and the numbered migration runner with its
  higher-version-refusal rule, aggregate read/write with explicit multi-store
  transaction boundaries, the persisted-record ↔ runtime-domain mapping
  (including `Money`/`Quantity` via their existing `toJSON`/`fromJSON`), the
  autosave engine and save-state model (§5), stale-write detection on
  `updatedAt`, multi-tab advisory, quota handling, and `navigator.storage`
  persistence/estimate wiring.
  *Dependencies:* Phases 0–6.
  *Risk:* transaction-boundary correctness and the migration runner. Both are
  things later phases cannot fix cheaply.

- **Phase 8 — Backup, Snapshots & Restore** (difficulty 8).
  *Objective:* the pilot cannot lose its data.
  *Deliverables:* `src/backup/` — internal snapshots with the retention policy
  (§6), the portable JSON backup envelope with manifest, entity counts and
  SHA-256 over a canonical serialisation (§7), download export plus the optional
  File System Access directory handle with the download path always available as
  fallback, the full 15-step validated restore (§8) with the pre-restore
  snapshot committed before the restore transaction, backup-freshness reminder,
  and the security rules of §9 (prototype-safe parsing, factory-based
  validation, size/depth limits, whole-file rejection).
  *Dependencies:* Phase 7.
  *Risk:* restore is the only operation that can destroy everything; the
  pre-restore snapshot ordering and the atomicity of the restore transaction are
  the two things that must not be wrong.

- **Phase 9 — Catalog & Parties** (difficulty 4).
  *Objective:* stable master records for products, suppliers and customers.
  *Deliverables:* `Product` with its immutable-once-used `stockUnit`, SKU
  uniqueness, active/inactive deactivation instead of deletion; supplier master
  normalisation (the `suppliers` store + `supplierIds` on project records, with
  the migration); minimal `Customer`; the additive optional
  `RequirementItem.productId`; CRUD screens.
  *Dependencies:* Phase 7.
  *Risk:* low. The supplier normalisation migration is the only sharp edge.

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
production code. Phase 7 onward is not started.
