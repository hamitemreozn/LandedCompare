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
- **That budget is a real boundary, not a formality.** Parsing keeps every
  digit a string carries, but 34 significant digits bound the *result of every
  operation* — including `plus` and `minus`, not just multiplication and
  division. A value can therefore enter the domain layer exactly and lose
  digits on its first arithmetic step. Nothing in this document should be read
  as claiming unbounded exactness. Three consequences are handled explicitly
  rather than described away:
  - **Every monetary operation is evaluated at a precision derived from its
    own operands**, not at the default budget: `Money.add`, `Money.subtract`,
    `Money.multiply`, currency conversion, and a percentage's
    divide-by-100 — plus the whole-pack ceiling and proportional allocation
    shares (`addExact`, `subtractExact`, `multiplyExact`,
    `divideByPowerOfTenExact`, `divideCeil`, `proportionalShare` in
    `decimal.ts`). Each has a stated bound and is exact within it. The
    division that cannot terminate (a proportional share) is instead
    evaluated far past the digit its truncation reads.
  - Dividing a percentage rate by 100 is a **decimal-point shift in base 10**,
    so it is performed at the rate's own precision and costs nothing. A plain
    `dividedBy(100)` would have been capped at the default budget and could
    round a long rate before it was ever applied to an amount.
  - Amounts too large to settle exactly at a currency's minor unit are
    **rejected by name** at the settlement boundary — see "Precision envelope"
    under Phase 4.
- **Derived precision is not "a bigger number".** Raising
  `DECIMAL_PRECISION` from 34 to some larger constant would only move the
  cliff to a different input. The bound is computed per operation from how
  many digits *that* operation provably needs, and for ordinary business
  magnitudes it sits below 34, so nothing extra is allocated. It grows
  linearly with operand length, never with how many times an operation is
  repeated: summing a million invoice lines does not widen the precision of
  the running total.
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
  110 pcs resolved. A zero divisor is rejected rather than producing a
  non-finite quantity.
- **The pack ceiling is taken on an accurate quotient.** Dividing at the
  default 34-significant-digit budget and *then* taking the ceiling could move
  the answer a whole pack in either direction once the quantities themselves
  approached that many digits — under-ordering below what was required, or
  inventing a pack nobody needed. The division is therefore evaluated at a
  precision derived from the two operands (`divideCeil`), and the
  multiplication back to comparison units is exact (`multiplyExact`). Both
  bounds are stated in `src/domain/monetary/decimal.ts`.
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
- **Excess quantity:** `resolvedQuantity - requiredQuantity`. MOQ and pack
  rounding can only raise a quantity, so this should never be negative — and
  `resolveOrderQuantity` now **checks** that (`resolvedQuantity >= effective
  minimum`) instead of asserting it in prose, raising
  `QuantityResolutionInvariantError` if it ever fails. It used to be reachable:
  a quotient rounded to 34 significant digits could resolve *below* what was
  required, and the failure surfaced indirectly as an `InvalidQuantityError`
  from the subtraction. This is the trace value a later phase (Results UI) can
  use to explain "why did I order more than I asked for".
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
- Dividing by 100 is an exponent shift in base 10, so the factor loses nothing
  the rate itself could not already hold: it is exact for any rate expressible
  within the configured significant-digit budget, which is every rate a user
  would type. It is not exact for a rate carrying more significant digits than
  that budget — the shift is free, but the value still has to be represented.

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
- **Only amounts already inside the quoted price stay out of a base.** An
  entry marked `alreadyIncludedInQuote` is excluded from every percentage
  base as well as from the total, because the merchandise price the base is
  built from already contains it and counting it again would double it.
  `includeInComparison: false` does **not** exclude an entry from a base —
  see "Included / excluded behaviour" below.
- A base is never negative: the merchandise total is required to be
  non-negative, and base-affecting discounts cannot exceed it (see below).

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
- **Two discount totals exist, and they are not the same set.**
  - *Contributing discounts* — the ones that reduce the comparison total.
  - *Base-affecting discounts* — every discount not already inside the quoted
    price, whether or not the user excluded it from the comparison. This is
    the set that lowers `MERCHANDISE_AFTER_DISCOUNT`, and it is a superset of
    the contributing ones.
- **Base-affecting discounts must not exceed the merchandise total**
  (`InvalidDiscountError`). This is the binding ceiling — it is the
  subtraction that could drive a base negative — and because it is the larger
  sum, it also covers the classic "contributing discounts exceed the
  merchandise total" case, which keeps its own message. Checked on the *sum*,
  so two individually legal 60% discounts are rejected together.
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

Two independent, user-controlled flags. They answer **different questions**,
and conflating them is a real double-count / under-count risk in both
directions:

- `alreadyIncludedInQuote: true` — *where the money already is.* The
  supplier's quoted prices already contain this amount. It is **not added
  again**, and it does **not** enter any percentage base, because the
  merchandise price those bases are built from already contains it. It stays
  in the breakdown as information. Never inferred from the Incoterm.
- `includeInComparison: false` — *what the user wants compared.* The entry's
  own amount is **not added to the comparison total**, and it stays in the
  breakdown. But excluding a cost from a comparison does not make it stop
  existing, so the amount **remains economically present**:
  - a freight or insurance cost still builds the CIF-like base, so duty is
    still charged on it;
  - a discount still lowers `MERCHANDISE_AFTER_DISCOUNT`, so a percentage
    taken on that base still sees the reduction.

Worked example — merchandise 1,000, freight 200 marked
`includeInComparison: false`, duty 10% of the CIF-like base:

```text
CIF-like base   = 1,000 + 200 = 1,200
duty            = 120
landed total    = 1,000 + 120 = 1,120      (the 200 is never added)
```

Each entry publishes both facts: `contributes` (does it reach the total) and
`affectsPercentageBases` (is it economically present). When both flags are
set, `alreadyIncludedInQuote` is reported as the exclusion reason — it is the
structural statement, and it is the one that also removes the amount from the
bases. Either way the entry's `signedEffect` is exactly zero, so it cannot
reach the total through any path.

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

This total is **exact and unrounded**: `calculatedLandedTotal`. It is kept for
audit and traceability, and it is *not* the figure shown to a user or ranked
on — see the next section.

### Authoritative commercial total

```text
settledLandedTotal = roundHalfUp(calculatedLandedTotal, minorUnit)
rankingAmount      = settledLandedTotal
```

**Calculate the true total, round the total once, then reconcile the breakdown
to it.** The authority runs in that direction and only that direction. The
displayed total, ranking, tie detection, the difference amount, and every
breakdown the user can add up are all this one value.

The alternative — summing separately rounded components into the total —
looks equivalent and is not. It makes the answer depend on **how the same
money was split across rows**, because `round(a) + round(b)` is not
`round(a + b)`:

| Merchandise | Cost entries | Exact total | Summed-parts total | Authoritative |
| --- | --- | --- | --- | --- |
| 1,000 | `20.008` | 1,020.008 | 1,020.01 | 1,020.01 |
| 1,000 | `10.004 + 10.004` | 1,020.008 | 1,020.00 | 1,020.01 |
| 1,000 | `16 × 1.004` | 1,016.064 | 1,016.00 | 1,016.06 |
| 1,000 | `1 × 16.02` | 1,016.02 | 1,016.02 | 1,016.02 |

The first pair is economically identical and used to rank differently. The
second pair is worse: the supplier that is genuinely 0.044 more expensive won.
The same applies to a surcharge, a discount, and to parallel percentages —
`20%` and `10% + 10%` on the same base are the same money (see
[Multiple discounts are parallel, not sequential](#multiple-discounts-are-parallel-not-sequential):
additive, never a sequential 19%), so they must produce the same commercial
total.

**Reconciling the parts.** `settledMerchandiseTotal` keeps its own settlement
— `roundHalfUp(merchandiseTotal, minorUnit)` — so cost residue is never hidden
inside merchandise to force an equality. What is left,
`settledLandedTotal - settledMerchandiseTotal`, is distributed over the cost
entries (`reconcileSettledEffects`):

1. Entries are split into two pools by the sign of their effect: costs and
   surcharges on one side, discounts on the other.
2. Each pool starts at its own settled sum. The leftover between those two and
   the required difference is a **residual of at most one minor unit**, and it
   is applied to the pool whose sign matches it — a shortfall to the costs, a
   surplus to the discounts. Both pool targets therefore stay non-negative.
3. Each pool's target is spread across its own members by largest remainder,
   weighted by their exact amounts — the same distribution allocation and the
   per-line merchandise split use.

This is **sign-safe** by construction: each pool is distributed on magnitudes
and the sign is re-applied afterwards, so a cost can never settle negative, a
discount can never settle positive, and an entry that does not contribute
keeps an effect of exactly zero. A `settledEffect` stays within a minor unit
of the entry's own rounded effect.

**Ordering.** Remainders are broken on the semantic `cost.id`, not on a row's
position in the input array. Reordering the cost entries therefore changes
nothing at all — not the total, not the rank, not the tie result, not the
winner, and not even an individual component's settled figure. There is no
"put the difference on the last row" step anywhere.

A user controls three input orderings, and they do **not** carry the same
guarantee. Stating the difference exactly matters more than claiming a blanket
one:

| Reordering | Total, ranking amount, settled effects, rank, winner | Per-line values |
| --- | --- | --- |
| Cost entries | unchanged | unchanged — settlement breaks on `cost.id` |
| Quote items within a quote | unchanged | unchanged — items are matched to requirements by id, so their order is pure input noise |
| Project requirements | unchanged | **the leftover minor unit may land on a different line** |

The third row is the one exception, and it is presentation only. Requirement
order *is* meaningful: it is the order lines are reported in and the tie-break
order for largest-remainder distribution, so with equal remainders the earlier
line takes the spare minor unit. Reordering the requirements can therefore move
a single minor unit between two lines. What it cannot do is change what the
lines add up to, what the supplier is ranked on, or who wins — the exact total
is built with exact addition, so no ordering of the lines changes it.

The guarantees, all asserted:

```text
rankingAmount == settledLandedTotal
             == roundHalfUp(calculatedLandedTotal, minorUnit)
             == settledMerchandiseTotal + Σ settledEffect
             == Σ (per-line settled merchandise + per-line allocated cost)
```

The last line holds whenever allocation is available; when it is not, there
are no per-line cost shares to reconcile and the supplier-level breakdown is
the reconciling view. `CostCalculation.ts` checks the supplier-level
reconciliation and `SupplierEvaluation.ts` the per-line one; both raise
`SettlementReconciliationError` rather than shipping a total and a breakdown
that disagree.

**Allocation follows the reconciled figure.** An entry's per-line shares are
weighted by its *exact* economic amount but sum to its *reconciled*
`settledEffect`, which `allocateAmount` receives as an explicit settlement
target. Re-rounding the exact amount there instead would put the per-line
breakdown a minor unit away from the header whenever reconciliation moved the
entry.

**Per-line merchandise values.** Phase 2's rule is unchanged: line subtotals
stay exact in the quote's currency and the *total* is converted once. For a
per-line base-currency figure, each line is restated at that same rate —
a proportional restatement of one conversion, not a second rate — and those
values are settled across the merchandise total with the same
largest-remainder distribution allocation uses. So the displayed lines add up
to the displayed merchandise total, exactly.

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

**Every intermediate value is exact.** Merchandise totals, discounts,
percentage costs and percentage bases are all computed and kept unrounded, as
is `calculatedLandedTotal`.

Settlement happens at exactly **one stage**, once every effect is known, and
produces the whole set of commercial figures at the same minor unit from the
same decision: `settledLandedTotal` (the exact total rounded once, and the
anchor everything else reconciles to), `settledMerchandiseTotal`, each entry's
reconciled `settledEffect`, the per-line settled merchandise values, and the
per-line allocations. There is one `minorUnit` input to
`calculateSupplierCosts`, and allocation reads it from that result rather than
resolving its own — two independently resolved scales are exactly how a header
and a breakdown drift apart.

Each allocation still publishes both `exactAmount` (as calculated) and
`settledAmount` (settled to the minor unit), and each individual allocation
now also carries its own exact share, so the sub-minor-unit residual is
visible rather than quietly absorbed into one line.

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
sum(allocations) === settledAmount     — exactly
```

This holds for both signs, every method and any line count, **for amounts
inside the precision envelope below**. That qualifier is not decoration: the
invariant was previously documented as holding for any amount at any
minor-unit scale, and it did not. The proportional shares are now computed at
a precision derived from the amount, the weights and the minor unit, which is
what makes the truncation step read the true digit.

If the distribution ever fails to reproduce the settled total, the allocator
throws `AllocationInvariantError` — an internal assertion that makes a broken
engine loud instead of losing a minor unit quietly. It is reserved for that:
an out-of-range amount is a different thing and gets a different error.

### Precision envelope

An amount whose settled form would need more significant digits than the
decimal configuration provides cannot be settled exactly, and no sum built
from it reconciles. Such an amount is **rejected explicitly**, by name, at
every settlement boundary:

```text
integerDigits(amount) + minorUnit > 34   →   PrecisionEnvelopeExceededError
```

- The bound is **derived from `DECIMAL_PRECISION`**, read straight off the
  decimal configuration, in the same spirit as `MAX_MINOR_UNIT_DIGITS`. It is
  **not** a commercial maximum amount, and this engine invents no such limit.
- It is **not** an internal-correctness failure. The arithmetic did not
  misbehave; the input is outside the range this engine can settle exactly.
  At supplier level it therefore produces an `INVALID` supplier with an
  explanation, not a crash and not a silently wrong total.
- Before this existed, such an amount reached the distribution and surfaced as
  `AllocationInvariantError` escaping the whole comparison — an internal "the
  allocator is broken" assertion raised for an input that was simply too large.
- **The envelope is a promise, and the promise is now truthful.** It used to
  say only "the *settled* figure fits in 34 digits" while the intermediate
  arithmetic that produced that figure had already rounded: an accepted input
  could still settle to the wrong minor unit (12345678901234567890123456789012.34
  at 10.005% settled to a cent ending `.69` where the mathematics says `.68`).
  With every monetary operation now evaluated at derived precision, an
  accepted amount settles to the mathematically correct minor unit, and the
  only inputs that do not settle correctly are the ones this error names. The
  boundary itself is unchanged:

  ```text
  integerDigits + minorUnit <= 34   →   accepted, and correct
  integerDigits + minorUnit >= 35   →   PrecisionEnvelopeExceededError
  ```

- Intermediate values are explicitly **not** bound by the envelope. The exact
  landed total for an accepted input routinely carries more than 34
  significant digits, and it is kept in full: `exactCalculatedLandedTotal` is
  the exact economic decimal, not a 34-digit approximation of it.

### Discount allocation

A supplier-level discount reuses the same allocator. Additionally, **a line's
allocated discount must not exceed that line's own merchandise value**. With
`BY_MERCHANDISE_VALUE` this holds automatically once total discounts fit the
merchandise total, but a flat or quantity-weighted split can push a small
line negative. That configuration is **rejected**
(`InvalidDiscountError`) rather than clamped: clamping one line would break
the sum-to-the-whole invariant and would require inventing a redistribution
rule this phase has no approved answer for.

**Both sides of that comparison are exact.** The check reads each line's
*exact* allocated share against that line's *exact* merchandise value. It used
to compare a settled share against an exact value, so a share rounded up by
part of a minor unit could reject a discount that exactly equalled the line it
sat on — a settlement artefact deciding legality. Settlement is a presentation
boundary; it does not decide whether a configuration is valid.

### Discount validation vs explanatory allocation

Allocation answers two questions that look alike and are not:

| | Validation-critical | Explanatory |
| --- | --- | --- |
| Question | Does this discount make a line economically invalid? | Which line did this cost land on? |
| Applies to | Non-zero, base-affecting discounts | Every contributing entry |
| Mandatory | Yes | No |
| Failure | Supplier `INVALID` | `COMPLETE` + `ALLOCATION_UNAVAILABLE` warning |

They run as **two separate passes, validation first**:

```text
calculate landed total
  → validate discount line allocations   (mandatory, outside any warning path)
      ↳ fails → supplier INVALID
  → explanatory allocation               (inside a narrow warning-producing try)
      ↳ fails → COMPLETE + ALLOCATION_UNAVAILABLE
```

They used to be one pass, with the discount rule checked at the *end* of the
explanatory allocation. So an unrelated cost with an unusable weighting —
freight by quantity across `pcs` and `kg` — threw first, the caller correctly
read that as "no breakdown available", and the discount rule was never
evaluated. A supplier whose discount took 300 TRY off a 100 TRY line was
published as `COMPLETE` with a warning. **Which cost happened to fail first
decided whether a financial rule was enforced**, and reordering the cost rows
could change a supplier's verdict.

`validateDiscountLineAllocations` therefore runs on its own, before the
explanatory pass, reusing `exactAllocationShares` — the same weighting and the
same proportional arithmetic the allocator uses, stopped one step before
settlement. Nothing is recalculated: the entries, their exact signed effects
and their allocation methods all come from the cost result the caller already
holds, and the landed total is never computed twice.

**An unprovable check is not a passed one.** If a *non-zero* discount's own
weighting cannot be established — `BY_QUANTITY` across mixed comparison units,
a zero base — then how much of it lands on each line is unknowable, so the
per-line rule has no answer and the supplier is `INVALID`. It is raised as
`DiscountAllocationValidationError`, a distinct type, precisely so it cannot
be mistaken for the survivable `ALLOCATION_UNAVAILABLE` case: the same
underlying weighting failure means "no breakdown" for a freight cost and "not
provably legal" for a discount.

**A zero-value discount is exempt.** A discount whose exact economic amount is
`0` takes nothing off any line, so there is no per-line rule for it to break
and no reason to establish a weighting for it. Invalidating a supplier because
a 0 TRY discount could not be allocated would be inventing a financial error
where there is no money. If its method is unusable, the explanatory pass still
reports that as a warning.

**The scope is every base-affecting discount**, i.e. exactly the set
`baseAffectingDiscounts` is built from — *not* the narrower set the allocator
spreads across lines:

- `includeInComparison: false` keeps a discount out of the compared total, but
  the money did not stop existing. It still lowers `merchandiseAfterDiscount`
  and every percentage taken on that base, and the supplier-level ceiling
  already refuses it when it exceeds the merchandise total. Its `signedEffect`
  is zero, so the per-line check reads `baseCurrencyAmount` instead —
  otherwise the same 600 TRY would be real money at supplier level and absent
  at line level.
- `alreadyIncludedInQuote: true` is the opposite kind of statement: the money
  is already inside the quoted line prices. It affects no base, and validating
  it against a line would count it twice. It is skipped.

The allocator keeps its narrower `contributes` scope, correctly: showing an
excluded discount on a line would display money the compared total never
counted. Presentation and validity are separate questions here as well.

### Non-negative per-line settlement

```text
exactLineLanded >= 0   =>   settledLineLanded >= 0
```

A line's *exact* landed value can never be negative — a discount that takes
more off a line than that line is worth is refused outright by the rule above.
Its *settled* value could be, and that was a real defect: merchandise cents
and discount cents were distributed independently, so a line worth `0.004`
settled its merchandise to `0.00`, then received the discount's leftover
`0.01`, and was displayed at **`-0.01`**. The supplier total still reconciled
exactly. The line was nonsense.

```text
lines 0.004 / 10 / 10,  discount 0.012 EQUAL_PER_LINE

exact share per line   0.004      — valid at exact precision
before                 -0.01 / 10.00 / 10.00      total 19.99
after                   0.00 /  9.99 / 10.00      total 19.99
```

This is a **rounding** question, not a validity question, and the two are kept
apart:

| | Discount validation | Per-line settlement |
| --- | --- | --- |
| Asks | Is this discount economically legal? | Where does the remainder minor unit go? |
| Compares | exact discount share vs **exact** merchandise value | settled discount share vs **settled** line capacity |
| Failure | Supplier `INVALID` | `SettlementReconciliationError` — an engine assertion, not a verdict on the quote |

The right-hand column is an **internal assertion**: no input is expected to
reach it, because the capacity rule below is what keeps a valid line at or
above zero. It is not claimed to be provably unreachable, and it is
deliberately not mapped to `INVALID` — if cent distribution ever does put a
valid line below zero, that is a broken engine and must not be presented as a
broken quote. See [Error capture boundary](#error-capture-boundary).

Settlement therefore runs in **capacity order**, which is not display order:

```text
1. merchandise            (already settled across the lines)
2. positive effects       COST, SURCHARGE
3. discounts
```

Each line carries a **running settled capacity** — its share of the settled
merchandise total, plus every positive effect settled onto it, less the
discounts already placed on it. A discount may take another minor unit from a
line only while

```text
allocatedDiscount + step <= capacity
```

still holds. A line with no room is skipped and the unit moves to the next
line in the same largest-remainder order. Freight on a line is money that line
can give back, which is why positive effects are settled first.

**Not a clamp.** Raising a `-0.01` to `0.00` would create a minor unit out of
nothing and break the reconciliation. Nothing is clamped and nothing is
dropped: the allocations still sum to exactly the settled effect the
authoritative total counted, and the lines still sum to `settledLandedTotal`.

**Feasibility is guaranteed, not hoped for.** The lines' total capacity is
`settledMerchandiseTotal + Σ positive settledEffect`, and the settled
discounts come to that figure minus `settledLandedTotal`, which is
non-negative because discounts are capped at the merchandise total. So there
is always somewhere to put every cent. If there ever is not,
`AllocationCapacityError` says so, and a negative line that somehow survives
raises `SettlementReconciliationError` at the supplier level — loud, never
silently corrected.

**Determinism.** Entries are settled positive-first, then by ascending cost
id — the same input-order independence the effect pools settle on, so which
line absorbs a remainder minor unit does not depend on where a cost row sat in
the input. Ties within a discount keep the documented largest-remainder
tie-break (earlier line first) among the lines that still have capacity.
Calculation order is not display order: `byEntry` comes back in the order the
costs were supplied, and `byLine` in the order the lines were supplied.

### Item-level output

Allocation produces per-entry allocations and a per-line allocated total —
the item-level *allocated amount* foundation. The **effective landed unit
cost** metric built on top of it is deliberately left to the results phase.

### Tax

The application is not a tax advisor. A tax cost is an ordinary cost entry
with a `TAX` category; `includeInComparison` is the only lever. There is no
recoverable-VAT engine, no tax-law logic, and no automatic duty lookup.

## Phase 5 — supplier comparison engine

These rules are approved and implemented (see `src/comparison/`:
`ComparisonStructuralValidation.ts`, `SupplierEvaluation.ts`, `Ranking.ts`,
`ComparisonInsights.ts`, `SupplierComparison.ts`). They govern *whether a
supplier's landed total can be trusted at all*, and, for the ones that can,
*how they are ranked, tied, and explained* — never a landed-cost formula
itself, which stays exactly what Phase 2–4 defined.

**The product never selects a "best supplier".** It shows the lowest
calculated landed cost among comparable suppliers, and says why. Lead time,
warranty, payment terms and other metadata may be carried alongside the
comparison, but Phase 5 does not turn them into a score, and nothing in this
engine ever produces a quality/supplier score.

### Supplier status model

Every supplier resolves to exactly one status:

- **`COMPLETE`** — a quote exists, every required item is quoted, quantity
  resolution and cost calculation succeed, and a landed total is produced.
  Only `COMPLETE` suppliers are ranked. A `COMPLETE` supplier **may carry
  non-blocking warnings** (see "Allocation availability"); a warning never
  affects its status, its total or its rank.
- **`INCOMPLETE`** — the supplier's data is not structurally broken, but is
  insufficient for comparison: no quote at all, an empty quote (a quote with
  zero items, distinct from a quote whose merchandise total is zero), or a
  quote missing one or more required items. `missingRequirementIds` lists
  exactly which requirements are uncovered, in the project's requirement
  order. **No partial/apparent total is ever computed or exposed as if it
  were comparable** — an incomplete supplier cannot be cheapest and never
  receives a rank.
- **`INVALID`** — the supplier's data is present but cannot be trusted:
  duplicate quote items for the same requirement, a quote item referencing a
  requirement not in the project, or an expected calculation error (see
  "Error capture boundary" below). Also excluded from ranking.

A missing quote is `INCOMPLETE`, not `INVALID` — the data is absent, not
wrong. A duplicate or unknown-requirement quote item is `INVALID` even if
every required item also happens to be present — malformed data is not made
trustworthy by being complete.

### Comparison-level structural validation

Some problems make the *comparison itself* meaningless rather than
implicating one supplier: an empty requirements list, a duplicate
requirement id, a duplicate supplier id, a requirement with zero required
quantity (Phase 1's `Quantity` allows zero technically; comparison readiness
requires `requiredQuantity > 0`), a quote referencing a supplier id that does
not exist, more than one quote for the same supplier (ambiguous — the engine
does not guess which one is authoritative), a mismatch between the project's
base currency and the exchange rate table's base currency, or a per-supplier
cost list that is present but is not an array. These throw
`InvalidComparisonInputError` and block the whole comparison before any
supplier is evaluated; they are never downgraded to a per-supplier issue. A
quote item referencing an unknown *requirement*, by contrast, is
supplier-level (`INVALID`) — it says the supplier's data is broken, not that
the comparison's own structure is.

A malformed cost list sits on the comparison side of that line deliberately:
`costsBySupplierId` is an argument to `compareSuppliers`, exactly like
`project`, so a value the engine cannot read means the caller's input
container is broken — not that one supplier's commercial data is untrusted.
Ranking the remaining suppliers would present a comparison built on an input
that was never understood. A supplier with **no** entry is still an ordinary
`[]`.

### Supplier ids are user-controlled keys

Supplier ids are user-typed text, and per-supplier data is looked up by them.
A plain `map[supplier.id]` therefore reads *inherited* members for an id like
`constructor`, `toString`, `valueOf`, `hasOwnProperty` or `__proto__`, and
what comes back is a function or `Object.prototype` — not `undefined`, so a
`?? []` fallback never fires. Every such lookup crashed the entire
comparison with "costs is not iterable".

**A user-controlled identifier must never resolve data through the prototype
chain.** Lookups use `Object.hasOwn` before reading, and the value's shape is
verified rather than assumed.

### QuoteItem unit price — must not be negative

**`QuoteItem.quotedUnitPrice` must be `>= 0`.** This is validated in
`createQuoteItem` (Phase 1's domain layer) — the earliest possible
construction boundary, added during the Phase 5 Checkpoint 1 hardening
review after the error-capture-boundary audit below surfaced that nothing
enforced it. `< 0` is rejected (`InvalidQuoteItemError`); **`0` is
explicitly allowed** — a free/sample/included item is a real quotation
scenario the MVP does not forbid, the same "negative rejected, zero
accepted" stance `Quantity` already takes. `Money` itself stays
general-purpose and sign-unrestricted (Phase 4's discounts and signed cost
effects rely on a negative `Money`), so this is a `QuoteItem`-specific rule,
not a change to `Money`. Because there is no other construction path for
`QuoteItem` (no `fromJSON`/import exists yet — see Phase 7), rejecting here
means a negative price can never reach Phase 2's merchandise engine or
anything built on it.

### Additional costs are validated at the engine boundary

`AdditionalCost` is a plain readonly interface, not a class. An object literal
that never met `createAdditionalCost` — or a JSON payload, or a mutated copy —
is structurally acceptable to TypeScript and reaches `calculateSupplierCosts`
unchecked. A `COST` with `fixedAmount = -5000` arriving that way drove a
landed total below zero, ranked as "cheapest", and then crashed the whole
comparison from inside a percentage calculation.

**The engine does not assume its inputs met the factory.**
`assertValidAdditionalCost` holds the full rule set — id, kind, category,
label, exactly-one-of fixed/percentage, non-negative fixed amount, the
runtime *types* of `Money` and `Percentage`, the discount and percentage-base
rules, the inclusion flags, the allocation method — and **both**
`createAdditionalCost` and `calculateSupplierCosts` call it. The rules are not
duplicated in two places that could drift apart. A cost that fails becomes an
`INVALID` supplier; the rest of the comparison continues.

### Error capture boundary

Four categories, kept apart on purpose:

| Category | Meaning | Behaviour |
| --- | --- | --- |
| **Comparison-blocking** | the comparison itself cannot be constructed | `InvalidComparisonInputError`, `InvalidMinorUnitError` — thrown, nothing is ranked |
| **Supplier `INVALID`** | this supplier's own data cannot be trusted | issue on that supplier; the others are still compared |
| **`COMPLETE` + warning** | the total is trustworthy, a secondary output is not | `warnings`; status, total and rank unaffected |
| **Internal failure** | an engine invariant broke | propagates, never relabelled |

Expected user/domain errors are mapped to `INVALID` via a closed allow-list
(not a catch-all) in `SupplierEvaluation.ts`. Every entry corresponds to a
throw site this pipeline executes:

- `InvalidMoqError`, `InvalidPackSizeError` — a bad MOQ or pack size on one
  quote item.
- `MissingExchangeRateError` — a quote or cost currency with no configured
  rate.
- `InvalidDiscountError` — discounts exceeding the merchandise total (for the
  comparison total or for the percentage bases), or a per-line allocated
  discount exceeding that line's own merchandise value.
- `DiscountAllocationValidationError` — a non-zero discount whose own
  weighting cannot be established, so the per-line rule above cannot be
  evaluated for it. Same underlying failure as the two allocation errors kept
  *off* this list; what differs is that it belongs to a discount, whose
  per-line effect is a question of validity rather than of presentation.
- `InvalidCostDefinitionError`, `InvalidCostAmountError` — a cost that fails
  `assertValidAdditionalCost`, including a duplicate id.
- `InvalidPercentageBaseError` — an unknown percentage base, or one not
  resolved at its stage.
- `PrecisionEnvelopeExceededError` — this supplier's own amounts are too
  large to settle exactly at the base currency's minor unit.
- `InvalidQuantityError`, `CurrencyMismatchError` — kept as defense in depth.
  Both correspond to real call sites here (the excess-quantity subtraction;
  the single-currency checks in `Money`/`Allocation`), and both are guarded
  upstream today: `resolveOrderQuantity` checks its own post-condition before
  subtracting, and `Quote` guarantees at construction that its items share its
  currency. They stay on the list because their *meaning* is "the data doesn't
  add up" — the safer classification if one of those guarantees is ever
  weakened. They are **not** claimed to be provably unreachable.

**Not on the list, on purpose:**

- `InvalidAllocationBaseError`, `IncompatibleAllocationUnitsError` — see
  "Allocation availability" below. They reach the warning path only from the
  *explanatory* pass; raised while validating a non-zero discount they are
  translated into the `DiscountAllocationValidationError` above first.
- `InvalidPercentageError` — `Percentage.fromString` is not called anywhere in
  this pipeline; a `Percentage` only ever arrives pre-built inside an
  `AdditionalCost`. Note it *is* called in `Ranking.ts`, outside this
  boundary — ranking guards its own inputs instead of relying on this list.
- `InvalidMinorUnitError` — an unresolvable base-currency minor unit is a
  comparison-wide configuration problem, resolved once before any supplier is
  evaluated and left to propagate out of the whole comparison. Mapping it here
  would let one supplier's data mask a project-level gap.
- Internal assertions — `AllocationInvariantError`,
  `QuantityResolutionInvariantError`, `SettlementReconciliationError`,
  `RankingInvariantError` — and anything else unexpected. An
  engine-correctness bug must never be relabelled as "this supplier's data is
  invalid": that hides a broken calculation behind a plausible business
  explanation instead of surfacing it.

### Allocation availability

**Allocation is an explanation layer, not a correctness prerequisite for the
landed total.** It splits amounts the total already knows across lines; it
never produces or corrects the total itself.

Two failures say only that no defensible *weighting* exists:

- `InvalidAllocationBaseError` — no lines, a zero total weight, or a negative
  weight;
- `IncompatibleAllocationUnitsError` — `BY_QUANTITY` across mixed comparison
  units.

Either one leaves the supplier **`COMPLETE`**: the landed total stands, the
rank stands, `costAllocation` is `undefined`, and a structured non-blocking
warning is published on that supplier:

```text
warnings: [{ code: 'ALLOCATION_UNAVAILABLE',
             reason: 'INVALID_ALLOCATION_BASE' | 'INCOMPATIBLE_ALLOCATION_UNITS',
             message }]
```

Treating these as invalid data is what made the engine wrong in the first
place. A supplier landing at 6,800 TRY was dropped out of the comparison
because its freight could not be split across lines measured in pcs and kg,
handing "lowest calculated landed cost" to a supplier at 10,200 TRY. Nothing
about the 6,800 was in doubt.

`warnings` is a **separate list from `issues`**, so a consumer rendering "this
quote is invalid because…" cannot pick one up by mistake, and no comparison
insight is emitted for it — a warning belongs to the supplier it describes.

The `try` around allocation is deliberately narrow. An `InvalidDiscountError`
raised *during* allocation still means the discount configuration is wrong and
still invalidates the supplier; an internal assertion still propagates.

**Unavailable allocation never suspends the per-line discount rule.** That
check runs in its own pass before the explanatory one, so a freight cost that
cannot be weighted no longer decides whether a discount is validated — see
"Discount validation vs explanatory allocation" in Phase 4. A supplier can
therefore be `INVALID` for its discount and, separately, would have carried an
`ALLOCATION_UNAVAILABLE` warning for its freight; the invalid verdict wins,
and no warning is published on a supplier that was never compared.

### Ranking boundary — exact total vs. ranking amount

Ranking never runs on the raw exact `calculatedLandedTotal`. Two suppliers
can differ by less than one minor unit (e.g. 98,300.0001 TRY vs.
98,300.0000 TRY) purely from digits a percentage rate produced below the
currency's display precision; compared as exact decimals one of them
"wins", but both display as ₺98,300.00 — an invisible, quietly authoritative
difference.

```text
rankingAmount = settledLandedTotal
```

That is the authoritative commercial total defined under Phase 4: the exact
landed total rounded **once** to the base currency's minor unit, with the
displayed components reconciled to it. `exactCalculatedLandedTotal` is
preserved unchanged alongside it on every `COMPLETE` supplier result, for
audit and traceability — but it is never what decides an order, because a
sub-minor-unit difference is not a difference a user can see or pay.

**Ranking, tie detection, the displayed total, the displayed difference and
every breakdown are all `rankingAmount`**, so what the user sees is never a
different number from what decided the order, and never a different number
from what the lines add up to.

### Per-line trace

Every `COMPLETE` supplier publishes a `lines` entry per requirement, carrying
what the pipeline already computed: `requiredQuantity`, `resolvedQuantity`,
`quotedUnitQuantity`, `excessQuantity`, `moq` / `moqApplied`,
`unitsPerQuotedUnit` / `packApplied`, `comparisonUnit`, `quotedUnit`, the
quoted unit price, the exact line value in both currencies, the settled
merchandise value, and — when allocation is available — the allocated cost
total and the settled landed value.

All of it is **derived output**, computed on demand, never a persisted source
of truth, and never recalculated: the quantities come from Phase 3's
resolution and the values from Phase 2's line subtotals. It exists so a
results view can say "you asked for 105, the MOQ forced 200" without redoing
the calculation — the engine computed all of that and then dropped it.

### Tie semantics

Two `COMPLETE` suppliers tie when `rankingAmount` is exactly equal —
`supplierA.rankingAmount.equals(supplierB.rankingAmount)`. Raw exact totals
never participate in the tie decision. A tie is not resolved by any hidden
criterion (name, id, insertion order as a "winner" pick) — it is reported as
a tie.

### Dense ranking and stable tie order

Ranked suppliers use **dense ranking**: `100.00 / 100.00 / 110.00` produces
ranks `1, 1, 2`, never `1, 1, 3`. Suppliers are sorted ascending by
`rankingAmount`; when two suppliers tie, the **original project supplier
order** (input order) decides their relative position — never an alphabetic
sort on supplier name or any other hidden key. This mirrors Phase 4's
allocation tie-break philosophy: determinism here is a financial guarantee,
made explicit rather than left to incidental array-sort stability.

### Winner semantics

- **Two or more `COMPLETE` suppliers, one unique lowest `rankingAmount`** —
  `LOWEST_CALCULATED_LANDED_COST` insight for that supplier.
- **Two or more `COMPLETE` suppliers, several sharing the lowest
  `rankingAmount`** — `TIED_LOWEST_CALCULATED_LANDED_COST` insight for the
  whole tied group.
- **Exactly one `COMPLETE` supplier** — it is technically rank 1, but it is
  **not** presented as a comparative winner: `ONLY_COMPARABLE_SUPPLIER`
  instead. There is nothing to compare it against.
- **No `COMPLETE` supplier** — no ranking, no winner:
  `NO_COMPARABLE_SUPPLIERS`.

### Percentage difference and the zero-denominator case

For every `COMPLETE` supplier:

```text
differenceAmount   = supplierRankingAmount − lowestRankingAmount
differencePercent  = differenceAmount / lowestRankingAmount × 100
```

computed on the exact-decimal foundation (never native `number`), against
`rankingAmount` — the same precision boundary as the displayed total, so
ranking, display and difference never disagree.

**The published percentage is rounded to two decimal places, half-up.** A
ratio like 1/3 is an endless decimal, and the engine was publishing
`33.33333333333333333333333333333333%` as a commercial statement — a
calculation artefact escaping as a figure a buyer would read and repeat.
`33.33%` is the figure; `6.255%` publishes as `6.26%`. The unrounded ratio is
kept alongside it (`exactPercentageDifference`) for audit.

Rounding here is **display only**. No monetary value depends on it: ranking,
ties and `differenceAmount` are all decided before any percentage exists.

When `lowestRankingAmount` is zero:

- suppliers tied at zero get `differenceAmount = 0`, `differencePercent = 0`;
- a supplier with a positive `rankingAmount` gets a real, computed
  `differenceAmount`, but `differencePercent` is **`undefined`** — the ratio
  is mathematically undefined at a zero denominator. The engine never
  produces `Infinity`, `NaN`, or an invented percentage.

**A negative ranking amount is not a possible state.** Merchandise totals are
non-negative, cost amounts are validated non-negative, and discounts cannot
exceed the merchandise total — so ranking treats one as a broken engine and
raises `RankingInvariantError`. It does not present a negative total as the
cheapest supplier, and it does not quietly report "percentage unavailable" and
carry on. Previously such a value surfaced as an `InvalidPercentageError`
thrown from inside a percentage constructor, naming neither the cause nor the
supplier.

### Deterministic insights

The engine emits **semantic codes with structured parameters only** — no
natural-language text, no AI/LLM. A later i18n phase renders these into
TR/EN copy. Implemented codes:

| Code | When | Parameters |
| --- | --- | --- |
| `ONLY_COMPARABLE_SUPPLIER` | exactly one `COMPLETE` supplier | `supplierId`, `rankingAmount` |
| `NO_COMPARABLE_SUPPLIERS` | zero `COMPLETE` suppliers | — |
| `LOWEST_CALCULATED_LANDED_COST` | a unique lowest `rankingAmount` | `supplierId`, `rankingAmount` |
| `TIED_LOWEST_CALCULATED_LANDED_COST` | several suppliers share the lowest `rankingAmount` | `supplierIds`, `rankingAmount` |
| `INCOMPLETE_QUOTE` | one per `INCOMPLETE` supplier | `supplierId`, `missingRequirementIds` |
| `INVALID_QUOTE` | one per `INVALID` supplier | `supplierId`, `issueCodes` |
| `LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST` | see below | `lowestMerchandiseSupplierIds`, `lowestLandedSupplierIds`, `lowestMerchandiseAmount`, `lowestLandedRankingAmount` |

Ordering is fixed and explicit: the single comparability/winner insight
first (exactly one of the first four codes above always applies), then the
merchandise-vs-landed flip if any, then `INCOMPLETE_QUOTE` insights and
`INVALID_QUOTE` insights, each group walked in the project's supplier order —
never `Object.keys` iteration order or any other incidental ordering.

#### Merchandise-vs-landed insight

`LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST` fires when a `COMPLETE`
supplier has the **unique** lowest merchandise total (compared at the same
minor-unit precision as ranking, via a `merchandiseRankingAmount` computed
the same way as `rankingAmount`) but is **not** among the lowest-landed-cost
suppliers. If merchandise totals themselves tie for lowest, no "merchandise
leader" is claimed and the insight does not fire — a tie must never be
reported as a false single leader.

### "Best supplier" — explicitly not a concept here

The engine never selects, computes, or exposes a "best supplier". It
answers exactly one question: *which comparable supplier's calculated
landed total is lowest, and why is that comparison valid?* Lead time,
warranty and payment terms may travel alongside the result as reference
metadata; nothing in Phase 5 turns them into a score, weight, or ranking
input.

### Effective landed unit cost — deferred, with the plumbing ready

**This metric is NOT IMPLEMENTED.** Nothing computes it, and a UI layer must
not compute it either.

What changed: the per-line trace above now carries every input it would need —
both quantities, the settled per-line merchandise value, and the allocated
cost share in the base currency. The original blocker (per-line values existed
only in the quote's currency, next to a settled cost share) is gone.

What has **not** changed is the part that was never a plumbing problem: **what
the denominator means.**

```text
required = 100, resolved due to MOQ = 150, landed = 1500

1500 / 150 = 10   "what each unit I receive costs me"
1500 / 100 = 15   "what each unit I actually needed costs me"
```

Those are two different business questions with two different answers, and
either can be the right one depending on whether the excess has value to the
buyer. Picking one here would be inventing a business rule. It stays an open
product decision until a calculation phase designs and approves it in this
document.

Nothing beyond the Phase 1–5 sections above should be treated as an
implemented or approved rule until a calculation phase explicitly adds it
here.
