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
- **Phase 2 — Core Calculation Engine**: landed cost calculation logic.
- **Phase 3 — MOQ / Quantity / Pack**: MOQ, order quantity, and pack/unit
  normalization rules.
- **Phase 4 — Additional Cost Engine**: fixed and percentage-based costs,
  freight, insurance, duty/customs, brokerage, fees, local transport, tax,
  discounts, surcharges, shared cost allocation.
- **Phase 5 — Comparison Engine**: ranking and deterministic comparison
  explanations across quotations.
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

Phases after Phase 0 are not implemented yet.
