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
- **Phase 6 — i18n**: Turkish and English UI support.
- **Phase 7 — Local Persistence**: IndexedDB, autosave.
- **Phase 8 — Projects & Requirements UI**.
- **Phase 9 — Suppliers & Quotes UI**.
- **Phase 10 — Quote Matrix**.
- **Phase 11 — Costs & FX UI**.
- **Phase 12 — Results**.
- **Phase 13 — Data Exchange & Security**: JSON backup/import, clipboard paste,
  controlled CSV/XLSX support.
- **Phase 14 — Public MVP Hardening**.

Phases 0–5 are implemented — **Checkpoint 1: engine complete.** Phase 6
onward (UI, i18n, persistence) is not started.
