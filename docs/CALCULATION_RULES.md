# Calculation Rules

This document will be the source of truth for landed-cost calculation rules once
they are designed and approved.

## Phase 1 — monetary precision foundation

These rules are approved and implemented (see `src/domain/monetary/` and
`src/domain/quantity/`). They govern *how numbers are represented and
combined*, not any landed-cost formula — no such formula exists yet.

- **No native `number` for financial arithmetic.** All monetary amounts
  (`Money`) and countable quantities (`Quantity`) are backed by
  [decimal.js](https://github.com/MikeMcl/decimal.js) exact decimal values,
  parsed from strings. `number`-based binary floating-point (`0.1 + 0.2 !==
  0.3`) is never the source of truth for a financial value.
- **Precision is kept high through intermediate calculation on purpose.**
  decimal.js is configured for 34 significant digits (`src/domain/monetary/decimal.ts`),
  comparable to IEEE 754 decimal128. This is intermediate *calculation*
  precision, not *display* precision — the two are kept conceptually and
  mechanically separate.
- **No rounding happens inside `Money`/`Quantity` arithmetic.** `add`,
  `subtract`, and `multiply` never round intermediate results. Rounding to a
  currency's minor-unit precision (e.g. 2dp for USD) is a decision that
  belongs to a specific calculation boundary (e.g. "the final landed total"),
  and will be defined explicitly when that calculation phase (Phase 2+) adds
  it here — not applied ad hoc at every intermediate step.
- **Display formatting is not domain logic.** How a `Money`/`Quantity` value
  is formatted for on-screen presentation (thousands separators, locale,
  trailing-zero padding) is a UI-layer concern; the domain layer only
  produces canonical exact decimal strings (`toDecimalString()` /
  `toJSON()`), never a formatted display string.
- **Currency safety is structural.** `Money` operations across two different
  currencies throw `CurrencyMismatchError` instead of producing a number —
  there is no implicit currency coercion anywhere in the domain layer.
- **Serialization is deterministic and explicit.** `Money`/`Quantity` never
  serialize decimal.js internals directly; they expose a plain JSON shape
  (canonical decimal string, via `.toFixed()`, which never uses exponential
  notation) as their persistence contract.

## Phase 2 — exchange rate & merchandise calculation

These rules are approved and implemented (see `src/calculation/`).

- **Exchange rate direction is fixed.** An `ExchangeRate` means
  `1 fromCurrency = rate toCurrency`. Example: `ExchangeRate.fromString('USD',
  'TRY', '43.50')` means 1 USD = 43.50 TRY. There is no inverse/cross-rate
  derivation and no alternative rate convention anywhere in this engine.
- **Conversion formula:** `convertedAmount = sourceAmount × rate`, computed on
  the Phase 1 exact-decimal foundation (never native `number`).
- **Same-currency conversion needs no rate.** If a quote's currency equals
  the project's base currency, the conversion factor is implicitly 1 and no
  `ExchangeRateTable` lookup happens — the user is not asked to enter a
  same-to-same rate.
- **A missing rate is a blocking calculation error, never a silent
  fallback.** If a quote's currency differs from the base currency and no
  rate was provided for it, `ExchangeRateTable.getRate` throws
  `MissingExchangeRateError`. Calculation never substitutes `0`, `1`, or any
  other default.
- **Rate validation:** a rate must be a well-formed, finite decimal (`0`,
  negative, and malformed values are rejected) and strictly greater than
  zero. Malformed decimal strings surface Phase 1's `InvalidDecimalError`;
  zero/negative well-formed values surface `InvalidExchangeRateError`. No
  invented minimum rate (e.g. `0.0001`) is enforced — any positive exact
  decimal is accepted.
- **No cross-rate graph / FX matrix.** Every non-base quote currency needs
  its own direct rate into the project base currency; `ExchangeRateTable` is
  scoped to a single base currency and rejects a rate whose `toCurrency`
  doesn't match it (`CurrencyMismatchError`, reused from Phase 1).
- **Merchandise line subtotal:** `lineSubtotal = unitPrice × resolvedCalculationQuantity`.
  The quantity is an opaque, already-resolved input to this calculation —
  MOQ/pack/order-quantity derivation is out of scope (Phase 3). Quantity may
  be a decimal (e.g. `4.25 × 2.5 = 10.625`).
- **Merchandise total:** the sum of a quote's line subtotals, all expected in
  the quote's own currency. An empty line list yields a zero total in that
  currency (a purely arithmetic default — it does not imply the quote is
  "complete"; completeness is Phase 5 scope). A subtotal priced in a
  different currency throws `CurrencyMismatchError` (from `Money.add`)
  instead of silently mixing currencies.
- **Base-currency merchandise total:** the quote-currency merchandise total
  is computed first, in full, and converted **once** into the base currency
  — not line-by-line. This was chosen over per-line conversion for simpler
  traceability (a single total, a single rate application) and to avoid
  premature per-line currency rounding before any rounding boundary is
  defined. Phase 4 may add item-level converted values separately if
  allocation needs them; that does not change this Phase 2 default.
- **No premature minor-unit rounding.** Neither currency conversion nor
  merchandise-total calculation rounds to a currency's minor unit (e.g. 2dp).
  Intermediate and final Phase 2 results keep full calculation precision;
  display formatting and business rounding boundaries remain later-phase
  decisions (see the Phase 1 rounding principle above).

## Phase 3 — quantity, MOQ & pack resolution

These rules are approved and implemented (see
`src/calculation/QuantityResolution.ts`). They govern *how many units are
actually ordered*, not price or currency — Phase 3 introduces no exchange
rate, freight, or landed-cost logic, and does not rewrite Phase 2 arithmetic.

- **Required quantity vs. resolved order quantity are distinct.** A
  `RequirementItem.requiredQuantity` (what the user needs) is never mutated
  by MOQ or pack constraints. Quantity resolution produces a separate,
  derived `resolvedQuantity` (what will actually be purchased, in the
  comparison unit). Neither value is a persisted "order quantity" field on
  `QuoteItem` — `QuoteItem` carries only the supplier-provided *inputs*
  (`moq`, `unitsPerQuotedUnit`); the resolved quantity is always computed on
  demand, never stored, so it cannot drift out of sync with its inputs.
- **MOQ is SKU-level only.** `QuoteItem.moq`, when present, is a minimum
  quantity for that one SKU, expressed in the requirement's comparison unit
  (e.g. `moq = 100` means "minimum 100 pcs"). There is no supplier-wide
  minimum order/invoice value, product-family MOQ, container MOQ, or pallet
  MOQ in this MVP, and no arbitrary-unit MOQ (e.g. "10 boxes") — that would
  require a unit-conversion system not built in Phase 3.
- **MOQ formula:** if `moq` is present, the effective minimum quantity is
  `max(requiredQuantity, moq)`. A `moq` of `undefined` means "no MOQ"; `moq`
  must be a strictly positive quantity when present — a bare `0` is rejected
  (`InvalidMoqError`) rather than used to mean "no MOQ".
- **Pack conversion is optional and user-defined per quote item.**
  `QuoteItem.unitsPerQuotedUnit`, when present, states how many comparison
  units make up one quoted unit (e.g. `unitsPerQuotedUnit = 10` with
  `quotedUnit = "box"` and `comparisonUnit = "pcs"` means 1 box = 10 pcs).
  It must be a strictly positive quantity when present — `0` is rejected
  (`InvalidPackSizeError`) rather than used to mean "no pack", and a
  negative or malformed value is rejected earlier, at `Quantity` construction
  (`InvalidQuantityError` / Phase 1's `InvalidDecimalError`).
- **A pack cannot be fractional.** The number of quoted units to buy is
  computed by dividing the post-MOQ minimum quantity by
  `unitsPerQuotedUnit` and always rounding **up** to the next whole quoted
  unit (`Quantity.ceilDivide`, built on decimal.js's `.ceil()` — never native
  `Math.ceil()`). Example: 105 pcs required, 10 pcs/box → 10.5 → 11 boxes →
  110 pcs resolved.
- **Order of operations is fixed: MOQ first, then pack.** MOQ raises the
  effective minimum quantity; whole-pack rounding is then applied to that
  post-MOQ minimum, not to the original required quantity. Example: 105 pcs
  required, MOQ 123, 10 pcs/box → post-MOQ minimum is 123 → 12.3 → 13 boxes
  → 130 pcs resolved (not 11 boxes / 110 pcs, which would ignore MOQ).
- **No pack, no rounding.** When `unitsPerQuotedUnit` is absent, the resolved
  quantity is exactly the post-MOQ minimum, decimal value included — a
  requirement like `2.5 kg` with no MOQ and no pack resolves to `2.5 kg`,
  not an integer. Quantity resolution never imposes a global
  "quantities must be whole numbers" rule; whole-number rounding only
  happens because of pack semantics specifically.
- **Excess quantity:** `resolvedQuantity - requiredQuantity`, always
  non-negative by construction (MOQ and pack rounding can only raise the
  quantity, never lower it below what was required). This is the trace value
  a later phase (Results UI) can use to explain "why did I order more than I
  asked for".
- **Pricing quantity for Phase 2:** a supplier's `quotedUnitPrice` is priced
  per quoted unit, not necessarily per comparison unit. Quantity resolution
  therefore also produces `quotedUnitQuantity` — the whole number of quoted
  units actually bought. When there is no pack, `quotedUnitQuantity` equals
  `resolvedQuantity` (the quoted unit *is* the comparison unit), so no
  separate conversion is needed. Phase 2's `calculateLineSubtotal`
  (`unitPrice x calculationQuantity`) is unchanged; Phase 3 only supplies the
  correct `calculationQuantity` input (`quotedUnitQuantity`), it does not
  rewrite the multiplication itself.
- **A lower unit price does not guarantee a lower purchase cost.** Because
  MOQ can force a larger order than requested, a supplier with a higher unit
  price but no MOQ excess can cost less in total than a supplier with a
  lower unit price but a binding MOQ (see the MOQ trap golden scenario in
  `src/calculation/QuantityResolution.test.ts`). Phase 3 only exposes the
  two resulting merchandise totals; it does not rank suppliers or decide a
  "winner" (Phase 5 scope).

### Order multiple — deferred

Order multiple (rounding the resolved quantity up to the next multiple of a
supplier-defined increment, independent of MOQ/pack) was scoped as a
"should have, not must have" for Phase 3. It is **not implemented**: it
introduces a third constraint that interacts with MOQ and pack in ways this
phase does not have a reviewed rule for (e.g. whether the multiple applies to
comparison units or quoted units when a pack is also present). It is left as
a documented `LATER` item for a future phase rather than guessed at here.

## Phase 4+ (not yet defined)

No calculation rules are defined or implemented yet for additional cost
application (fixed, percentage-based, freight, insurance, duty, brokerage,
fees, local transport, tax, discounts, surcharges), shared cost allocation,
order multiple (see above), or incomplete-quote detection. This file is a
placeholder for those so future calculation-engine phases (see
[Implementation Plan](IMPLEMENTATION_PLAN.md), Phase 4 onward) have a known
place to record approved, reviewed financial rules, including the
minor-unit rounding rule for final totals referenced in the Phase 1 section
above.

Nothing beyond the Phase 1, Phase 2, and Phase 3 sections above should be
treated as an implemented or approved rule until a calculation phase
explicitly adds it here.
