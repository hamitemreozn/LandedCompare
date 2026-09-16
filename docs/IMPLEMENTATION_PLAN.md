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
