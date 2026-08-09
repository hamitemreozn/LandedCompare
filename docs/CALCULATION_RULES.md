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

## Phase 4 — additional costs, adjustments & allocation

These rules are approved and implemented (see `src/calculation/`:
`AdditionalCost.ts`, `Percentage.ts`, `CostCalculation.ts`, `Allocation.ts`,
`CurrencyMinorUnit.ts`). They govern *how additional costs and adjustments
are applied to a merchandise total* to produce one supplier's calculated
landed total, and how a shared amount is split across that supplier's lines.

Phase 4 does **not** compare suppliers. Ranking, "cheapest", completeness,
tie handling, and percentage differences between suppliers are Phase 5.

### Working currency

- **The cost engine works in the project base currency.** The merchandise
  total is converted into it once (via Phase 2's `convertToBaseCurrency`)
  before any cost is applied, and every cost amount, percentage base and
  total in the result is a base-currency `Money`.
- **A fixed cost carries its own currency** and is converted with Phase 2's
  exchange-rate engine. No new FX logic exists in Phase 4.
- **A percentage cost carries no currency.** Its base is already a
  base-currency amount, so its result is too. Because conversion is a plain
  multiplication with no intermediate rounding, taking a percentage before or
  after conversion gives the same number — nothing is lost by fixing the
  order this way.
- **A missing rate blocks the calculation**, reusing Phase 2's
  `MissingExchangeRateError` semantics — including for a cost that would not
  have reached the total. An excluded cost is still shown in the breakdown,
  and showing it in a different currency from everything else would defeat
  the comparison the base currency exists to enable.

### Cost model

- A cost entry is one of three **kinds**: `COST`, `DISCOUNT`, `SURCHARGE`.
  Discount and surcharge are separate semantic concepts, not a signed cost.
- A cost entry has one of nine **categories** (`FREIGHT`, `INSURANCE`,
  `DUTY`, `BROKERAGE`, `BANK_FEE`, `LOCAL_TRANSPORT`, `PACKAGING`, `TAX`,
  `OTHER`) plus an optional free-text `label`. Only `FREIGHT` and `INSURANCE`
  carry calculation meaning (they are the components of the CIF-like base);
  every other category is treated identically. The label is carried through
  untouched — no display string is generated anywhere in this layer.
- **Exactly two calculation types exist:** a fixed amount, or a percentage.
  There is no formula engine. An entry must define exactly one of them.
- **Costs are supplier-level (shared).** Item-level costs were deliberately
  left out of Phase 4 — see [Architecture](ARCHITECTURE.md).

### Negative input

- **A cost, surcharge or discount amount must not be negative**
  (`InvalidCostAmountError`). `Freight = -500` is rejected; the same intent
  must be expressed as `Discount = 500`, with the engine applying the
  negative effect. This keeps "how much discount did I get?" answerable
  instead of buried inside a negative freight line.

### Percentage representation

- **One convention, application-wide: `"5"` means 5%.** The applied factor is
  `rate / 100`, and the cost is `base x rate / 100`, computed exactly on the
  Phase 1 decimal foundation.
- The alternative convention (`"0.05"` meaning 5%) is **not** supported
  anywhere. Supporting both would make `0.05` ambiguous between 5% and
  0.05% — a 100x error in a duty or discount that the engine could not
  detect.
- Dividing by 100 is an exponent shift in base 10, so the factor is exact for
  any decimal rate; no precision is lost before the multiplication.

### Percentage validation

- Malformed input surfaces Phase 1's `InvalidDecimalError`.
- A negative percentage is rejected (`InvalidPercentageError`).
- **Zero is accepted.** A 0% duty is a real business statement ("this line is
  duty-free"); rejecting it would force the user to delete the cost line and
  lose the fact that duty was considered at all. (This differs from Phase 2's
  zero *exchange rate*, which is rejected — a zero rate would erase money,
  whereas a zero percentage correctly adds nothing.)
- **No upper bound on a cost or surcharge percentage.** A >100% surcharge is
  unusual but not nonsense, and this engine does not invent bounds.
- **A percentage discount above 100% is rejected** (`InvalidDiscountError`).
  Exactly 100% is allowed: it drives the discounted merchandise base to zero,
  which is degenerate but not negative.

### Approved percentage bases

Only three bases exist. They are a closed set, not a user-defined expression.

| Base | Value |
| --- | --- |
| `MERCHANDISE` | the base-currency merchandise total |
| `MERCHANDISE_AFTER_DISCOUNT` | merchandise total − contributing discounts |
| `MERCHANDISE_PLUS_FREIGHT_INSURANCE` | merchandise-after-discount + contributing freight + contributing insurance costs |

- The third base exists so CIF-like duty scenarios can be modelled. The
  application makes **no claim** that duty is calculated on it — the user
  chooses the base.
- **Only amounts that actually reach the landed total enter a base.** A cost
  marked `alreadyIncludedInQuote` or `includeInComparison: false` is excluded
  from the CIF-like base as well as from the total, otherwise duty would be
  charged on freight the quoted price already contains.
- A base is never negative: the merchandise total is required to be
  non-negative, and discounts cannot exceed it (see below).

### Evaluation order and why cycles are impossible

Evaluation runs in **fixed stages**. A stage may only reference amounts that
earlier stages finalised; that ordering — not a dependency graph — is what
makes a circular base such as `Duty = 5% of (Merchandise + Freight + Duty)`
unrepresentable.

1. Merchandise total (input, converted to base currency).
2. **Discounts** → `merchandiseAfterDiscount`.
3. **Freight and insurance costs** → `merchandisePlusFreightInsurance`.
4. **All other costs.**
5. **Surcharges.**
6. `landedTotal`.

Which base each stage may reference follows directly from that order:

| Stage | Allowed percentage bases |
| --- | --- |
| Discounts | `MERCHANDISE` |
| Freight / insurance costs | `MERCHANDISE`, `MERCHANDISE_AFTER_DISCOUNT` |
| Other costs | all three |
| Surcharges | all three |

- A percentage **discount** can only be taken on `MERCHANDISE`, because
  nothing else exists at stage 2. A discount on "merchandise after discount"
  would be self-referential.
- A percentage **freight or insurance** cost cannot be taken on
  `MERCHANDISE_PLUS_FREIGHT_INSURANCE` — it is a component of that base.
  It *may* be a percentage of merchandise (e.g. insurance at 0.5% of goods
  value), which is resolved earlier.
- A **surcharge categorised as freight** does not enter the CIF-like base:
  surcharges are evaluated after percentage costs, so including them would
  reintroduce a cycle. It is still a legal entry; it just lands later.
- Violations are rejected at construction time with
  `InvalidPercentageBaseError`.
- Fixed costs depend on nothing, so their position among stages 3–5 cannot
  change any result. They are grouped by category only so that freight and
  insurance are final before the CIF-like base is assembled.

### Discount rules

- A discount is entered as a **positive magnitude**; the engine applies the
  negative effect.
- **Contributing discounts must not exceed the merchandise total**
  (`InvalidDiscountError`). This is checked on the *sum*, so two individually
  legal 60% discounts are rejected together. A discount excluded from the
  total (already in the quote, or excluded from comparison) does not count
  toward the ceiling.
- Equality is allowed — a 100% discount yields a zero base, not a negative
  one.

### Multiple discounts are parallel, not sequential

When several percentage discounts apply, **each one takes its rate on the
original `MERCHANDISE` total.** They are summed and subtracted once; no
discount is ever applied to a total another discount has already reduced.

```text
merchandise            100
discount A  10%   ->    10      (10% of 100, not of 90)
discount B  10%   ->    10      (10% of 100)
total discount          20
merchandise after       80
```

So in this MVP `10% + 10%` is an effective **20%**, not 19%.

- **Input order cannot change the result.** Every discount reads the same
  base, and the amounts are combined with exact decimal addition, so no
  ordering of the same discount set produces a different total, a different
  discounted base, or a different landed total. The ceiling check inherits
  this: an over-large set is rejected in every order.
- Fixed and percentage discounts mix freely under the same rule — a fixed
  discount depends on no base at all.
- The ceiling is checked against the **parallel** sum. Three 50% discounts
  total 150% and are rejected, even though sequential stacking
  (50 + 25 + 12.5 = 87.5) would have fitted. Two 50% discounts total exactly
  100% and are accepted, leaving a zero base — sequential stacking would have
  left 25.

**Sequential / chained discounts — `LATER`.** Compounding behaviour (each
discount applying to the running total) is **not implemented**. It would make
the result depend on discount order, which then needs a user-visible,
user-controllable ordering rule this phase has no approved design for. It is
recorded here as a deferred item rather than guessed at.

### Included / excluded behaviour

Two independent, user-controlled flags:

- `alreadyIncludedInQuote: true` — the supplier's quoted prices already
  contain this amount. It is **not added again**, but stays in the breakdown
  as information. Never inferred from the Incoterm.
- `includeInComparison: false` — the user does not want it counted. It is
  **not added to the comparison total**, but stays in the breakdown.

When both apply, `alreadyIncludedInQuote` is reported as the reason: it is a
structural fact about where the money is, while `includeInComparison` is a
preference about what to compare. Either way the entry's `signedEffect` is
exactly zero, so it cannot reach the total through any path.

### Incoterm

Phase 4 performs **no automatic Incoterm calculation**. An Incoterm never
adds freight, removes insurance, sets duty, or changes any flag. It remains a
recorded field for future warnings/context only.

### Calculated landed total

```text
landedTotal = merchandiseTotal + sum of every contributing signed effect
```

which is equivalently:

```text
landedTotal =
  merchandiseTotal
  - contributing discounts
  + contributing surcharges
  + contributing additional costs
```

Every entry publishes its own `signedEffect` (positive for a cost or
surcharge, negative for a discount, exactly zero when it does not
contribute), so the total is reproducible from the breakdown alone. Both
formulations are asserted in the tests.

**No rounding happens at the supplier level.** The landed total keeps full
calculation precision, continuing Phase 1/2's no-premature-rounding rule.

### Minor units

- A currency's minor-unit precision is resolved explicitly
  (`resolveMinorUnit`). The built-in table is deliberately tiny — TRY, USD,
  EUR, all 2 — and is **not** an ISO-4217 database.
- Any other currency must be declared by the caller
  (`resolveMinorUnit('JPY', { JPY: 0 })`). An unknown currency is a
  **blocking error**, never a silent fallback to 2, because assuming 2 for a
  0-decimal currency would produce unpayable amounts. This mirrors Phase 2's
  missing-rate stance.
- Rounding at a minor unit is **half-up**, not banker's rounding: with
  banker's rounding an allocation's remainder would depend on the parity of
  the digit before it, which is harder to explain and no more correct here.

### Rounding boundary

**Allocation is the only settlement boundary in Phase 4.** Merchandise
totals, discounts, percentage costs, percentage bases and the landed total
are all exact. Rounding happens only when a shared amount is split across
lines, because a per-line share of 33.3333… is not a payable figure.

Each allocation publishes both `exactAmount` (as calculated) and
`settledAmount` (rounded to the minor unit), so the sub-minor-unit residual
between them is visible rather than quietly absorbed into one line.

### Allocation methods

| Method | Weight |
| --- | --- |
| `BY_MERCHANDISE_VALUE` (default) | the line's merchandise value |
| `EQUAL_PER_LINE` | 1 per line |
| `BY_QUANTITY` | the line's resolved quantity |

- Each cost entry chooses its own method.
- **`BY_QUANTITY` requires every line to share one `comparisonUnit`**
  (`IncompatibleAllocationUnitsError`). Adding 500 pcs to 20 kg to build a
  ratio would produce a confident-looking number with no meaning, and no
  unit-conversion system exists.
- **No weight/volume/CBM/pallet allocation exists** in this phase.

### Unusable allocation bases

All three are rejected with `InvalidAllocationBaseError` rather than divided
through:

- **no lines** to allocate onto;
- **a total weight of zero** (e.g. every line's merchandise value is 0) —
  never a silent division by zero;
- **a negative weight**.

**The base is validated independently of the amount.** An unusable base is
rejected even when the amount being allocated is zero — for instance a 0%
duty spread over lines that all have zero merchandise value. Splitting zero
across a zero base is still an undefined ratio, and returning zeros would
present a broken weighting as a real answer. The caller is told the weighting
is wrong instead.

### Remainder distribution — largest remainder

1. Settle the amount's **magnitude** to the currency's minor unit.
2. Give each line its exact proportional share, at full precision.
3. **Truncate** each share down to the minor unit.
4. Compute the leftover as `settledTotal − sum(truncated shares)`, and hand
   it out one minor unit at a time to the lines with the **largest
   truncated-away fraction** first.
5. **Ties are broken by input order** (the earlier line wins), explicitly
   rather than relying on `Array#sort` stability.

Deriving the leftover from the settled total — not from the sum of the exact
shares — is what makes the method robust: a share that cannot be represented
exactly (1/3, say) cannot leak a lost minor unit into the result.

Worked example: 100.00 TRY across 3 equal lines → exact shares 33.3333…,
truncated to 33.33 each (99.99), leftover 0.01, all remainders tied so the
first line takes it → **33.34 / 33.33 / 33.33**, summing to exactly 100.00.

### Sign safety

The allocator runs **entirely on the amount's magnitude** and re-applies the
sign at the end. A discount (negative effect) therefore travels the exact
same code path as a freight cost, and "largest remainder" never has to mean
two different things depending on sign. Weights are required to be
non-negative, so every allocation shares the sign of the amount being
allocated, and a negative allocation is the exact mirror of its positive
twin. A signed zero is never emitted.

### Allocation invariant

```text
sum(allocations) === settledAmount     — exactly, always
```

This holds for both signs, every method, any line count, and any minor-unit
scale. If the distribution ever failed to reproduce the settled total, the
allocator throws `AllocationInvariantError` — an internal assertion that
makes a broken engine loud instead of losing a minor unit quietly.

### Discount allocation

A supplier-level discount reuses the same allocator. Additionally, **a line's
allocated discount must not exceed that line's own merchandise value**. With
`BY_MERCHANDISE_VALUE` this holds automatically once total discounts fit the
merchandise total, but a flat or quantity-weighted split can push a small
line negative. That configuration is **rejected**
(`InvalidDiscountError`) rather than clamped: clamping one line would break
the sum-to-the-whole invariant and would require inventing a redistribution
rule this phase has no approved answer for.

### Item-level output

Allocation produces per-entry allocations and a per-line allocated total —
the item-level *allocated amount* foundation. The **effective landed unit
cost** metric built on top of it is deliberately left to the results phase.

### Tax

The application is not a tax advisor. A tax cost is an ordinary cost entry
with a `TAX` category; `includeInComparison` is the only lever. There is no
recoverable-VAT engine, no tax-law logic, and no automatic duty lookup.

## Phase 5+ (not yet defined)

No calculation rules are defined or implemented yet for supplier comparison:
ranking, cheapest-supplier selection, quote completeness, tie handling,
percentage differences between suppliers, deterministic textual insights, or
scenario simulation. Also still deferred: order multiple (see the Phase 3
section), weight/volume/CBM allocation, item-level costs, and sequential /
chained discounts (see the Phase 4 discount section).

### Open item for Phase 5 — the ranking comparison boundary

Phase 4 deliberately leaves `calculatedLandedTotal` as an **exact decimal**
with no minor-unit rounding: allocation is the only settlement boundary in
that phase. That is the right answer for a single supplier, but it hands
Phase 5 a decision it must make explicitly rather than inherit.

Two landed totals can differ by less than one minor unit — 98,300.0001 TRY
versus 98,300.0000 TRY — typically because a percentage rate produced digits
far below the currency's precision. Compared as raw exact decimals, one of
them "wins". Presented to the user, both read as ₺98,300.00, and the ranking
would look arbitrary or, worse, quietly authoritative.

Phase 5 must therefore decide and document, before implementing ranking:

- at what precision landed totals are **compared** (comparing at the
  currency's minor unit is the obvious candidate, but it is a decision, not a
  default);
- what counts as a **tie** once that precision is fixed, and how ties are
  presented — a tie must not be resolved by an invisible sub-kuruş
  difference;
- whether the **displayed** total and the **compared** total are the same
  number, and if not, how the difference is disclosed.

None of this is implemented in Phase 4, and Phase 4's exact total must not be
read as an implicit answer to any of it.

Nothing beyond the Phase 1–4 sections above should be treated as an
implemented or approved rule until a calculation phase explicitly adds it
here.
