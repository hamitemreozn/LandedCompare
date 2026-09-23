# Data Model

**Canonical source** for entities, relationships, lifecycles, the inventory
accounting model, and the invariants that hold across them.

- Why these areas exist and what is out of scope → [Product Scope](PRODUCT_SCOPE.md)
- Where this data lives, who may read it, and how it is protected → [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md)
- How the **local pilot** stored it — historical → [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md)
- Financial arithmetic rules → [Calculation Rules](CALCULATION_RULES.md)

This document is a **conceptual model**, written before implementation. It
deliberately contains no database code, no IndexedDB store definitions and no
TypeScript declarations — those arrive with the phases that build them
([Implementation Plan](IMPLEMENTATION_PLAN.md)). Field lists are written in a
TypeScript-like notation only because it is precise, not because the files
exist.

**The model below is storage-neutral and survives Phase 9.5 unchanged.** Entities,
relationships, lifecycles and the twenty-one invariants mean exactly what they
meant when the target was a single browser database. What Phase 9.5 changed is
*where they are enforced* and *who may see them* — every record now belongs to an
organisation, timestamps and attribution are server-owned, and several invariants
become database permissions rather than application rules. Those consequences are
collected in §13; the rest of this document is unaffected, and where a section
says "the persistence layer" it should now be read as "the storage layer,
whichever it currently is".

**Implementation status after Phase 9.** Products, suppliers and customers have
record shapes, validators, typed stores and screens; `Project` (with its
requirements and quotes), `InventoryMovement`, settings, counters and database
metadata have record shapes and validators. Purchase orders, shipments, receipts
and reservations have stores and no records yet. No stock arithmetic, no lifecycle
transition and no invariant from §11 beyond I18 is enforced in code; those arrive
with Phase 16 onward, against PostgreSQL.

---

## 1. Modelling rules

Six rules generate most of the decisions below. Where a later section seems
surprising, it is usually one of these being applied.

**R1 — Stock is derived from a ledger, never stored on the product.**
There is no `product.stockQuantity`. Physical stock is the sum of movement rows.
A stored balance is a second source of truth, and the two always diverge
eventually — usually silently, during an interrupted write.

**R2 — Persisted status expresses human intent; progress is derived.**
`DRAFT`, `ORDERED`, `CANCELLED`, `CLOSED` are decisions a person made.
"partially shipped", "partially received", "partially fulfilled" are arithmetic
over documents that already exist. Storing the second kind means maintaining it,
and maintaining it means it can be wrong. This is why the lifecycles below are
shorter than the ones originally proposed.

**R3 — Financial and physical history is append-only.**
Posted inventory movements and posted warehouse receipts are never edited or
deleted. A correction is a new, linked, opposite record.

**R4 — Analysis results are snapshotted into operations, never referenced live.**
A purchase order copies what it needs from the quotation and comparison at the
moment of decision. Later edits to the quotation cannot reach it.

**R5 — Aggregates own their lines.**
A purchase order and its lines are one unit: loaded together, written together,
one transaction. The inventory ledger is the exception — it is queried across
documents, so it stands alone.

**R6 — Restrictions are validation rules where they can be, schema shapes only
where they must be.**
Wherever the MVP narrows something (one order per shipment, one warehouse), the
narrowing lives in a validation function so relaxing it later costs no
migration. Where it must be structural, the migration is written down in advance
(§12).

---

## 2. Identity, time and mutability conventions

### Identifiers

- Every entity has an `id: string` — a **UUID** generated with
  `crypto.randomUUID()`.
- UUIDs are used because they are stable across export/restore, collide across
  no boundary, need no central allocator, and map directly onto a PostgreSQL
  `uuid` column if the backend migration in §13 ever happens. Auto-increment
  integers fail all four.
- **Array position is never identity.** Reordering a list must never change what
  a record means or what points at it.
- References are always by id, in a field named `<entity>Id` (or `<entity>Ids`).
- **Human-facing codes are not identifiers.** `PurchaseOrder.code`
  (`"PO-2026-0007"`), `Product.sku`, `InboundShipment.reference` are for people.
  They are unique where stated, but no record points at another record by code.
  Codes are allocated from counters in the platform layer, gaps are tolerated,
  and a code is assigned once and then immutable.

### Time

Two distinct kinds, never mixed:

- **Instants** — ISO 8601 UTC with milliseconds and a `Z` suffix
  (`new Date().toISOString()`). Used for `createdAt`, `updatedAt`, `recordedAt`,
  `postedAt`, `dispatchedAt`.
- **Business dates** — calendar dates as `YYYY-MM-DD` strings, no time, no zone.
  Used for `orderDate`, `departureDate`, `eta`, `actualArrivalDate`,
  `quoteDate`, `plannedDispatchDate`. An ETA is a day, not an instant; storing
  it as a timestamp makes it shift across midnight depending on where the reader
  is.

Inventory movements carry **both** `occurredAt` (when the physical event
happened — the business fact) and `recordedAt` (when the row was written — the
system fact). They differ whenever anything is entered late, which in a real
warehouse is often, and reconciliation needs both.

**Who is allowed to state a time, after Phase 9.5.** With several machines, that
distinction stops being descriptive and becomes the rule: the **server** owns
every instant that answers *"when did the system learn this"* — `createdAt`,
`updatedAt`, `recordedAt`, `postedAt` — and a client-supplied value is discarded,
not validated. The **user** owns every value that answers *"when did it
happen"* — `occurredAt` and every business date. See
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §9.

### Mutability classes

| Class | Records | Rules |
| --- | --- | --- |
| **Editable** | `Product`, `Supplier`, `Customer`, `Project` (+ requirements, quotes), `PurchaseOrder` while `DRAFT`, `InboundShipment`, `InventoryReservation` while `ACTIVE`, `OutboundShipment` while `DRAFT` | carry `createdAt` + `updatedAt`; a write states the version it replaces and is **refused** on a mismatch — never merged. The token is `version` after Phase 9.5 ([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §9) and was `updatedAt` in the local pilot ([Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) §5) |
| **Frozen-on-commit** | `PurchaseOrder` commercial fields once it leaves `DRAFT`; `OutboundShipment` lines once `DISPATCHED` | header metadata (notes, dates, tracking) stays editable; quantities, prices and lines do not |
| **Append-only** | `InventoryMovement`, `WarehouseReceipt` (after posting), recovery snapshots | no `updatedAt` — there is no update. Corrections are new linked rows |

---

## 3. Entity relationship overview

Read top to bottom as time passing. Each arrow is "produces" or "references".

```text
            ══ PROCUREMENT ANALYSIS (exists today, unchanged) ══

  Project ──┬─► RequirementItem ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
            │        (optional productId, added in Phase 9) │
            ├─► supplierIds ──────► Supplier ◄──┐           │
            └─► Quote ──► QuoteItem             │           │
                   │                            │           │
                   │  compareSuppliers()        │           ▼
                   ▼  (pure, derived, not stored)│      ╔═════════╗
            SupplierComparisonResult             │      ║ Product ║
                   │                             │      ╚═════════╝
                   │  user picks a supplier      │        ▲ ▲ ▲ ▲
                   │  ── SNAPSHOT (one-way) ──   │        │ │ │ │
                   ▼                             │        │ │ │ │
            ══════════ PURCHASING ═══════════    │        │ │ │ │
                                                 │        │ │ │ │
  PurchaseOrder ──────► supplierId ──────────────┘        │ │ │ │
    │  analysisRef: frozen copy of the decision           │ │ │ │
    └─► PurchaseOrderLine ──► productId ──────────────────┘ │ │ │
              ▲                                             │ │ │
              │ purchaseOrderLineId                         │ │ │
    ══════════╪═══════ INBOUND LOGISTICS ═══════            │ │ │
              │                                             │ │ │
  InboundShipment                                           │ │ │
    └─► InboundShipmentLine ──► productId ──────────────────┘ │ │
              ▲                                               │ │
              │ inboundShipmentLineId                          │ │
  WarehouseReceipt (immutable once posted)                     │ │
    └─► WarehouseReceiptLine ──► productId ────────────────────┘ │
              │                                                  │
              │ posts                                            │
              ▼                                                  │
    ╔══════════════════════════════════════════════╗             │
    ║  InventoryMovement  (append-only ledger)     ║◄────────────┘
    ║  the ONLY thing that changes physical stock  ║   productId
    ╚══════════════════════════════════════════════╝
              ▲                              ▲
              │ posts                        │ posts
              │                              │
  OutboundShipment                    manual entry
    └─► OutboundShipmentLine          (opening balance,
              │  reservationId?        adjustment, stock count,
              ▼                        returns)
    InventoryReservation ──► customerId ──► Customer
      (reduces AVAILABLE stock, never PHYSICAL)
```

The two things worth reading twice:

- **Every arrow into `InventoryMovement` is a posting action**, and there are
  exactly three sources: warehouse receipts, outbound dispatches, and manual
  entries. Purchase orders and shipments have no arrow into it at all.
- **The arrow out of the analysis area is a snapshot**, drawn one-way on
  purpose. Nothing below it can read back up.

---

## 4. Catalog and parties

### Product

The catalog master, and the anchor of the whole inventory ledger.

```text
Product
  id                     UUID
  sku                    string   unique, trimmed, case-insensitive compare
  name                   string
  description?           string
  stockUnit              string   THE unit the ledger is kept in
  defaultPurchaseUnit?   string   e.g. "box"
  unitsPerPurchaseUnit?  Quantity e.g. 50  (stockUnits per purchase unit)
  manufacturer?          string
  manufacturerRef?       string   manufacturer/supplier part number
  active                 boolean
  note?                  string
  createdAt, updatedAt   instant
```

**`stockUnit` is the load-bearing field.** Every inventory movement for this
product is expressed in it, and the ledger performs no unit conversion — ever.
Conversions happen at data-entry time (a purchase order line entered in boxes is
converted using the factor recorded *on that line*), and the ledger only ever
sees stock units. This keeps stock arithmetic a plain sum with no hidden
multiplications, which is what makes it auditable.

Consequently `stockUnit` is **immutable once at least one movement exists for
the product** (Product Scope, Open Decision 14; invariant I11).

*Implementation note.* Phase 9 builds the product master but does **not**
enforce that rule, because at Phase 9 no movement can exist — the ledger has no
producer until Phase 16 builds it. The enforcement belongs to the phase that can
prove the precondition; the catalogue form states the rule to the user in the
meantime.

**What a unit value is.** `stockUnit` and `defaultPurchaseUnit` are `string`,
and a value is one of two things:

- a **canonical code** from a small fixed vocabulary — `PIECE`, `BOX`,
  `PACKAGE`, `CARTON`, `SET`, `METER`, `KILOGRAM`, `LITER` — chosen from the
  unit dropdown and displayed through a translation;
- **anything else**, which is a unit the company typed itself (`"Rulo"`),
  stored verbatim and displayed verbatim in every language.

The codes exist because the alternative is storing the *label*: a Turkish and
an English user picking the same unit would then create `"Adet"` and `"Piece"`
for one semantic fact. That is untidy on a single-user local pilot and a defect
the moment the data is shared, because nothing could group or compare across
the two — and I11 (`movement.unit === product.stockUnit`) would become a
question about which language someone had selected. Changing the interface
language must never change a stored value, and this is what makes that true.

There is deliberately **no second field.** No `unitCode` beside a `unitLabel`:
two fields meaning one fact is duplicated state that every writer has to keep
in step, which is the same trade §2 already refuses for `active`. Membership in
the canonical vocabulary is a total function over the single stored value, so
"is this one of ours?" needs no flag. `defaultPurchaseUnit` and
`unitsPerPurchaseUnit` are only defaults for new document lines; changing them
never touches history, because every line snapshots the factor it used.

`active: false` is the deletion mechanism. A product referenced by any movement,
order, shipment or reservation is never hard-deleted (§10).

### Supplier

The existing `src/domain/supplier/Supplier.ts` shape (`id`, `displayName`)
becomes a **company-wide master** rather than a per-project list, and gains
`active`, `note`, `createdAt`, `updatedAt` — plus, in Phase 11, the optional
`externalRef` described below, so a supplier can carry its code in the company's
existing system exactly as a customer already can.

This is the one structural finding of Phase 6.5 about existing code. Today
`Project` holds `readonly suppliers: readonly Supplier[]`, so in practice
suppliers are created per project — but a purchase order is a company fact, not
a project fact, and must reference one stable supplier record.

**This does not require changing the engine.** The resolution is a split between
the *persisted* record shape and the *runtime* domain shape:

- persisted: a `suppliers` store keyed by id, and a project record holding
  `supplierIds: string[]`.
- runtime: the persistence layer hydrates `Project.suppliers` from that store,
  producing exactly the `Project` shape `compareSuppliers()` already expects.

`src/domain`, `src/calculation` and `src/comparison` see no difference. See
[Architecture](ARCHITECTURE.md), "Persisted record shape vs runtime domain
shape".

### Customer

```text
Customer
  id, displayName, externalRef?, customerStatusId?, active, note?,
  createdAt, updatedAt
```

Deliberately the same minimal shape as `Supplier` — not a CRM record: no
addresses, contacts, terms, credit limits or history. It exists so reservations
aggregate reliably. Product Scope, Open Decision 1 explains the alternative that
was rejected. Outbound shipments additionally carry a free-text `recipientNote`
for one-off deliveries that do not deserve a customer record.

### CustomerStatus — a configurable classification, not an enum

The pilot company grades its customers `C`, `A`, `A+`, `A++`. The product must
support that **without knowing those values.**

```text
CustomerStatus
  id           UUID
  code         string   'C', 'A', 'A+', 'A++', or whatever the company uses
  sortOrder    integer  explicit display order
  active       boolean
  createdAt, updatedAt
```

```text
Customer.customerStatusId?  →  CustomerStatus     zero or one, never many
```

Four rules, and each one is the reason a field exists:

- **The list belongs to the company, not to the product.** A PostgreSQL enum or
  a TypeScript union would make adding `B` a schema migration and a release, and
  would be wrong for the next company by construction. The classification is
  configuration, so it is a table.
- **A customer has zero or one current status.** A nullable reference, not a join
  table. Status *history* is out of scope: this answers "what grade is this
  customer now", and a history table is a CRM concept the product does not have.
- **A deactivated status stays valid for the customers already carrying it.**
  `active: false` removes it from the picker for new assignments; nobody is
  silently reclassified and nothing displays differently. This is `active`
  meaning what it means everywhere else in this model (§2, §10) — and it is why
  the customer references the status *row* rather than copying its code.
- **Display order is deterministic** — `sortOrder`, then case-folded `code` as a
  stable tiebreak. `A+` and `A++` do not sort usefully under any natural rule,
  and a list whose order changes between two screens is a list nobody trusts.

Deliberately **not** on it: colour, discount percentage, credit limit, payment
terms, or any behaviour at all. A status is a label the company sorts and filters
by. The moment it drives a price or gates a reservation it has become a pricing
model, which is CRM (Product Scope §6).

Implemented in Phase 11, with the catalog, because it is a `customers` column:
adding it then costs one table and one nullable reference, and adding it later
costs a migration over live company data. See
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §11 for the
PostgreSQL form and its organisation scoping.

### `externalRef` — the external system code, and why it stays opaque

`Customer` already carries `externalRef?`. **`Supplier` gains the same field**
in Phase 11, for the same reason and with the same rules.

The pilot company identifies both with codes from an existing system:

```text
customer   120-34-00-11-001
supplier   320-…
```

A partial reading is known: `120` marks a customer and `320` a supplier, `34` is
a Turkish province plate code, `00` and `01` distinguish the Anatolian and
European sides of Istanbul — and `11-001` is **currently unknown.**

**None of that is in the model, and that is the decision.** `externalRef` is one
optional string, stored exactly as typed. No split into prefix / province / side
/ sequence, no format validation, no uniqueness, no generation, no parsing
anywhere.

The interpretation is partial and unverified, and a model that encodes
`34 = province` rejects the first foreign supplier and has to be migrated the
moment the real rule turns out to be something else — which, with a segment still
unknown, it may well be. Storing the complete value verbatim loses no
information, so every later capability (a format check, a unique index, a parsed
breakdown, a generator) remains an additive change to a column that already holds
the data.

The UI labels it **"Dış Sistem Kodu" / "External System Code"**; the field keeps
the name `externalRef`, which already means "this record's identifier in some
other system" and should not be renamed to match one company's vocabulary.

A **BUSINESS EXCEL CODE SCHEME ANALYSIS** checkpoint is scheduled for when real
spreadsheets arrive — see
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §26. Nothing
interprets the code before it.

### The RequirementItem → Product link

`RequirementItem` today has `productName: string` and an optional free-text
`sku`. Operations need a real product reference.

**Made in Phase 9: `productId?: string` on `RequirementItem`**, at
`schemaVersion` 3. Additive, optional, and read by nobody in
`src/calculation` or `src/comparison` — those modules consume `id`,
`requiredQuantity` and `comparisonUnit` only. It is the sole planned
modification to an engine-adjacent entity in the whole revised roadmap, and it
changes no monetary behaviour.

A link table in the persistence layer was considered and rejected: it adds a
join and a second place for the relationship to be wrong, to avoid an optional
field the engine ignores.

The link is optional on a requirement (a quick comparison of something the
company has never bought should not force catalog entry) and **required on a
purchase-order line** — product selection or creation is forced at the moment
the decision becomes an order.

---

## 5. Analysis → purchasing: the snapshot boundary

### Why a snapshot

A purchase order answers exactly one question: *what did we commit to, on what
basis?* If editing a quotation could change that answer retroactively, the order
cannot answer it. So the order carries its own copy.

### What a purchase order freezes

On the header, an optional `analysisRef` — present when the order came from a
comparison, absent for a direct purchase:

```text
analysisRef?
  projectId              UUID  (for navigation only; may later be deleted)
  projectName            string snapshot
  quoteId                UUID  (navigation only)
  baseCurrency           CurrencyCode
  exchangeRates          [{ from, to, rate }]  the rates used at decision time
  settledLandedTotal     Money  the authoritative comparison total
  comparedSupplierCount  number
  decidedAt              instant
  engineNote?            string  e.g. warnings present at decision time
```

On each line, the commercial facts:

```text
PurchaseOrderLine
  id                     UUID
  productId              UUID     required
  description            string   snapshot of the product name as ordered
  orderedQuantity        Quantity in orderedUnit
  orderedUnit            string
  unitsPerOrderedUnit?   Quantity conversion to product.stockUnit
  unitPrice              Money    in the order currency, per orderedUnit
  sourceQuoteItemId?     UUID     traceability only
  sourceRequirementId?   UUID     traceability only
  note?
```

`orderedStockQuantity = orderedQuantity × (unitsPerOrderedUnit ?? 1)` — derived,
never stored, and the figure every downstream comparison uses.

**Is this "persisting a derived value", which R1 forbids?** No, and the
distinction matters. R1 forbids persisting values derived from *current* state,
because current state moves and the copy goes stale. `analysisRef` records a
*past event*: what the engine computed on the day the decision was made. It
cannot be re-derived once a quote is edited, and it is never recomputed,
compared against a live calculation, or used as an input to anything. It is
evidence, not cache.

### What the purchase order does not do

It does not call `compareSuppliers()`. It does not store a `SupplierComparisonResult`
object — that type is derived output with a shape the engine owns and is free to
change, and pinning it into persisted data would freeze an internal contract.
Only the handful of scalar facts above are copied.

---

## 6. Purchasing

```text
PurchaseOrder
  id                UUID
  code              string   "PO-2026-0007", assigned on DRAFT → ORDERED, immutable after
  supplierId        UUID
  currency          CurrencyCode
  status            DRAFT | ORDERED | CLOSED | CANCELLED
  orderDate?        business date
  expectedDate?     business date
  incoterm?         string
  paymentTerms?     string
  reference?        string   supplier's own order/proforma number
  note?             string
  analysisRef?      (see §5)
  lines             PurchaseOrderLine[]
  createdAt, updatedAt, orderedAt?, closedAt?, cancelledAt?
```

### Lifecycle

```text
DRAFT ──► ORDERED ──┬──► CLOSED
  │                 │
  └──► (deleted)    └──► CANCELLED
                         (only while nothing has been received)
```

| State | Meaning | Stock effect |
| --- | --- | --- |
| `DRAFT` | being prepared; freely editable; hard-deletable | none, and not counted as on order |
| `ORDERED` | placed with the supplier; commercial fields frozen | counts toward **on order** |
| `CLOSED` | finished — fully received, or short-shipped and written off | no longer on order |
| `CANCELLED` | never happened | no longer on order |

**The six states originally proposed became four.** `PARTIALLY_SHIPPED`,
`SHIPPED`, `PARTIALLY_RECEIVED` and `RECEIVED` are not decisions anyone makes —
they are sums over shipment and receipt records that already exist (R2). Storing
them means a bug can make the stored status disagree with the documents, and
then neither is trustworthy. They are derived instead:

```text
shipmentProgress(po)  = NOT_SHIPPED | PARTIALLY_SHIPPED | FULLY_SHIPPED
receiptProgress(po)   = NOT_RECEIVED | PARTIALLY_RECEIVED | FULLY_RECEIVED
```

both computed per line in stock units and rolled up.

`CLOSED` is the one piece of progress that *is* a decision and therefore is
stored: "the supplier shipped 97 of 100 and we are not waiting for the other 3"
cannot be derived — only a human knows the remainder is not coming. Without it,
on-order figures would stay wrong forever.

`CANCELLED` is refused once any receipt exists against the order; the correct
action there is `CLOSED`, because cancellation must never appear to unwind
posted stock (I12).

**A purchase order never affects physical stock** (I5). Ordering is a promise.

---

## 7. Inbound logistics

```text
InboundShipment
  id, code            "SHP-2026-0031"
  supplierId          UUID
  status              PLANNED | IN_TRANSIT | IN_CUSTOMS | ARRIVED | CLOSED | CANCELLED
  reference?          string  supplier/forwarder shipment reference
  carrier?            string
  trackingRef?        string
  transportMode?      SEA | AIR | ROAD | COURIER | OTHER
  departureDate?      business date
  eta?                business date
  customsClearedAt?   business date
  actualArrivalDate?  business date
  note?
  lines               InboundShipmentLine[]
  createdAt, updatedAt

InboundShipmentLine
  id                    UUID
  purchaseOrderLineId   UUID   required
  productId             UUID   denormalised from the PO line for query convenience
  shippedQuantity       Quantity  in shippedUnit
  shippedUnit           string
  unitsPerShippedUnit?  Quantity  conversion to product.stockUnit
  note?
```

### Lifecycle

```text
PLANNED ──► IN_TRANSIT ──► IN_CUSTOMS ──► ARRIVED ──► CLOSED
   │             │              │            │
   └─────────────┴──────────────┴────────────┴──► CANCELLED
                                         (only while nothing received)
```

Eight proposed states became six. `READY` was dropped — "ready to ship" is a
date, not a state, and it is already expressible as a `PLANNED` shipment with a
`departureDate`. `CLEARED` was dropped as redundant with `ARRIVED`: leaving
customs and reaching the door are a few hours apart and are never separately
actionable; the clearance *date* is kept as `customsClearedAt` because the
paperwork matters. `RECEIVED` was dropped because it is receipt arithmetic (R2)
— `CLOSED` replaces it as the human decision "stop expecting anything more from
this shipment", which is what short shipments need.

`IN_CUSTOMS` survives despite being optional in general, because this company
imports medical-device-related goods where customs holds are routine and the
question "what is stuck at customs?" is asked out loud.

Skipping states forward is allowed (a courier shipment may go
`PLANNED → ARRIVED`). Moving backwards is allowed only while no receipt exists.

### The single-purchase-order rule

The purchase-order reference lives on the **line**, not the header. The MVP rule
"every line of a shipment must belong to the same purchase order" is therefore a
validation function, and consolidating several orders into one container later
means deleting that function — no schema change and no migration (R6, and
Product Scope, Open Decision 3).

One purchase order may have many shipments, which is the normal importing case.

**A shipment never affects physical stock** (I6). Goods on a ship are not goods
in a warehouse.

---

## 8. Warehouse receipt

### Why an explicit document rather than movements alone

Receiving could have been modelled as "shipment arrives → write movements".
It is not, for one reason: **discrepancies are the point.** Ordered 100, shipped
100, received 97 is the single most valuable thing the pilot can capture against
Logo Tiger, and it belongs to a physical event with a date, a document number
and a person. Movements alone can express the 97 but not the event, and
reconstructing "which receipt was this" by timestamp proximity is exactly the
kind of inference that is right until it is badly wrong.

So: **the receipt is the document; the movement is its ledger effect.** One
extra entity, and the audit trail reads forwards.

```text
WarehouseReceipt
  id, code               "RCP-2026-0114"
  inboundShipmentId      UUID
  receiptDate            business date
  postedAt               instant
  reversesReceiptId?     UUID   set only on a correcting reversal receipt
  note?
  lines                  WarehouseReceiptLine[]

WarehouseReceiptLine
  id                       UUID
  inboundShipmentLineId    UUID
  productId                UUID
  receivedQuantity         Quantity  in receivedUnit
  receivedUnit             string
  unitsPerReceivedUnit?    Quantity  conversion to product.stockUnit
  discrepancyReason?       SHORTAGE | DAMAGE | OVER_DELIVERY | OTHER
  note?
```

### Posting

A receipt is created and posted in **one atomic action** — there is no saved
draft receipt, because a half-entered receipt that looks posted is worse than no
receipt. Posting writes, in a single transaction:

1. the `WarehouseReceipt` and its lines, and
2. one `InventoryMovement` of type `PURCHASE_RECEIPT` per line, direction `IN`,
   quantity in `product.stockUnit`, `source = { kind: WAREHOUSE_RECEIPT, id }`.

After posting, the receipt is immutable (R3). Partial receipt is supported by
simply receiving fewer units than were shipped; a shipment may have any number
of receipts.

### Correcting a receipt

A reversal receipt: a new `WarehouseReceipt` with `reversesReceiptId` set,
carrying the same lines, which posts reversing movements (§9). The original
stays visible. A corrected quantity is then a third receipt with the right
figure. No row is ever edited.

---

## 9. Inventory — the ledger

This is the part of the model everything else exists to feed.

```text
InventoryMovement          ── append-only, never updated, never deleted ──
  id                    UUID
  productId             UUID
  type                  MovementType
  direction             IN | OUT
  quantity              Quantity   MAGNITUDE, always > 0
  unit                  string     must equal product.stockUnit
  occurredAt            instant    when it physically happened
  recordedAt            instant    when the row was written
  source                { kind: SourceKind, id?: UUID }
  reason?               AdjustmentReason   adjustments only
  reversalOfMovementId? UUID
  note?
```

### Magnitude plus direction, not a signed number

The existing audited `Quantity` type rejects negative values by construction,
and this model reuses it rather than introducing a second, sign-permitting
quantity type next to it. So a movement stores a positive magnitude and an
explicit `IN`/`OUT` direction. Every stock query is
`Σ(IN) − Σ(OUT)`, which is also the form that reads correctly in a UI ledger
table.

### Movement types

| Type | Direction | Created by |
| --- | --- | --- |
| `OPENING_BALANCE` | `IN` | manual, once per product at pilot start |
| `PURCHASE_RECEIPT` | `IN` | posting a warehouse receipt |
| `CUSTOMER_DISPATCH` | `OUT` | dispatching an outbound shipment |
| `CUSTOMER_RETURN` | `IN` | manual, against a past dispatch |
| `SUPPLIER_RETURN` | `OUT` | manual, sending goods back to the supplier |
| `POSITIVE_ADJUSTMENT` | `IN` | manual, with a reason |
| `NEGATIVE_ADJUSTMENT` | `OUT` | manual, with a reason |

Seven types, each with a distinct operational story. Two candidates were
rejected: a `TRANSFER` pair (meaningless with one warehouse) and a `REVERSAL`
type (a reversal is not a new kind of event — it is the *same* event undone, so
it keeps the original type and flips direction, which keeps type-based reporting
honest).

`SUPPLIER_RETURN` is kept separate from `NEGATIVE_ADJUSTMENT` because "we sent
20 defective units back to the manufacturer" and "the count was 20 short" are
different facts, and for medical-device products the first one gets asked about.

`AdjustmentReason` — `STOCK_COUNT | DAMAGE | LOSS | CORRECTION | OTHER` — keeps
provenance without inflating the type list. `STOCK_COUNT` is what the Logo Tiger
reconciliation workflow writes.

`SourceKind` — `WAREHOUSE_RECEIPT | OUTBOUND_SHIPMENT | MANUAL | OPENING`.

### Corrections: reversal, not rewriting

A wrong movement is corrected by posting a **reversal movement**: same product,
same type, same magnitude, opposite direction, `reversalOfMovementId` set to the
original. The correct figure, if any, is then a third movement. Reversals are
constrained by I10 (§11): the target must exist, must not already be reversed,
and must match in product, type and magnitude.

This is auditability without event sourcing. There is no event store, no
projection rebuild and no command/event split — just a rule that the ledger is
written forwards.

### The stock quantities

All per-product, all derived, none stored (R1).

```text
physicalStock   = Σ(IN movements) − Σ(OUT movements)
                  what is actually in the warehouse right now

reservedStock   = Σ over ACTIVE reservations of remainingReserved
                  physical stock promised to a customer, still on the shelf

availableStock  = physicalStock − reservedStock
                  what may still be promised to someone new

onOrder         = Σ over ORDERED purchase orders, per line,
                    max(0, orderedStockQty − receivedStockQty)
                  bought, not yet in the warehouse

inTransit       = Σ over lines of IN_TRANSIT shipments,
                    max(0, shippedStockQty − receivedStockQty)

inCustoms       = same, over IN_CUSTOMS shipments

arrivedNotReceived = same, over ARRIVED shipments
                  physically at the door, not yet booked in — deliberately
                  NOT physical stock

expectedIncoming = onOrder
```

**These buckets overlap by design and must never be added together.** A unit
that has shipped is both `onOrder` and `inTransit`. `onOrder` is the total of
everything bought and not yet received; the transit/customs/arrived figures are
a *breakdown of where inside that total* each unit currently is. The
non-overlapping remainder is:

```text
orderedNotYetShipped = onOrder − inTransit − inCustoms − arrivedNotReceived
```

Any UI showing these must present them as a decomposition, never as a column
that sums.

The worked example from the product brief, in these terms: physical 500,
reserved 120, available 380 — with, say, 200 more on order of which 150 are in
transit and 50 have not left the supplier.

### Stock count reconciliation

The pilot's bridge to Logo Tiger. The user enters a counted quantity for a
product; the system shows `counted − physicalStock`; posting the correction
writes a single `POSITIVE_ADJUSTMENT` or `NEGATIVE_ADJUSTMENT` with
`reason = STOCK_COUNT` and a note identifying the count. No new entity, no
count-sheet document — a multi-product count sheet is a post-pilot refinement.

The discrepancy is never hidden: the ledger keeps the pre-count balance, the
adjustment, and the post-count balance.

### Future dimensions

Lot, serial and expiry tracking are a **FUTURE PRODUCT DECISION** (Product
Scope, Open Decision 4), and the ledger is shaped so they can be added without
being rewritten:

- movements are **per line and per event**, never pre-aggregated, so they can be
  partitioned after the fact;
- a future `lotRef?` on `InventoryMovement` (plus a `Lot` entity carrying lot
  number, expiry date and receipt origin) turns product stock
  `Σ(movements for product)` into lot stock `Σ(movements for product, lot = x)` —
  the same sum with one more `WHERE`;
- receipts and dispatches already carry lines, which is where a lot would be
  captured;
- existing movements would migrate with `lotRef = null`, meaning "recorded
  before lot tracking", which is a truthful value rather than a guess.

Multi-warehouse extends the same way with `locationId` (Open Decision 5); §12
records the migration.

---

## 10. Reservations and outbound

### InventoryReservation

```text
InventoryReservation
  id
  productId              UUID
  customerId             UUID
  quantity               Quantity   in product.stockUnit
  status                 ACTIVE | CLOSED | CANCELLED
  reference?             string     customer PO/order number
  expectedDispatchDate?  business date
  note?
  createdAt, updatedAt, closedAt?, cancelledAt?
```

**A reservation writes nothing to the ledger.** It reduces *available* stock and
leaves *physical* stock untouched (I3, I4). Only dispatch moves stock.

`remainingReserved = max(0, quantity − Σ dispatched against this reservation)`,
where dispatches are outbound shipment lines carrying this `reservationId` on a
`DISPATCHED` or `DELIVERED` shipment. It is derived, never stored, which is what
makes partial dispatch fall out of the model for free (Open Decision 13).

Statuses, and why `FULFILLED` and `RELEASED` are not among them:

| Status | Contributes to `reservedStock` | Meaning |
| --- | --- | --- |
| `ACTIVE` | `remainingReserved` | live commitment |
| `CLOSED` | 0 | stopped early — "the customer took 50 of 120, forget the rest" |
| `CANCELLED` | 0 | called off; nothing was dispatched |

`FULFILLED` is derived, not stored: when everything has been dispatched,
`remainingReserved` is already 0 and the reservation already contributes
nothing. Storing `FULFILLED` would mean writing to the reservation every time a
shipment is dispatched — a side effect on a second aggregate inside the dispatch
transaction, existing only to restate arithmetic (R2).

`RELEASED` was folded into `CANCELLED`: both mean "this is no longer reserving
stock", both have identical arithmetic, and the difference between "the customer
postponed" and "the order was dropped" is a sentence in `note`, not a state
machine branch.

The derived `fulfilmentState` — `OPEN | PARTIALLY_FULFILLED | FULFILLED` — is
available for display.

### OutboundShipment

```text
OutboundShipment
  id, code              "OUT-2026-0208"
  customerId?           UUID       optional for a one-off recipient
  recipientNote?        string     free text, for ad-hoc deliveries
  status                DRAFT | DISPATCHED | DELIVERED | CANCELLED
  plannedDispatchDate?  business date
  dispatchedAt?         instant
  deliveredDate?        business date
  reference?            string     waybill / delivery-note number
  carrier?              string
  note?
  lines                 OutboundShipmentLine[]
  createdAt, updatedAt

OutboundShipmentLine
  id, productId
  quantity              Quantity   in product.stockUnit
  reservationId?        UUID       links the dispatch to a commitment
  note?
```

Lifecycle:

```text
DRAFT ──► DISPATCHED ──► DELIVERED
  │
  └──► CANCELLED    (only from DRAFT)
```

`PLANNED` and `READY` collapse into `DRAFT` — a not-yet-dispatched shipment is a
not-yet-dispatched shipment, and "ready" is a planned date. `DELIVERED` is kept
even though it has no stock effect, because "did it actually arrive?" is a
question the pilot user asks and nothing else in the system can answer.

**Dispatching is the posting action.** In one transaction it sets the status,
stamps `dispatchedAt`, and writes one `CUSTOMER_DISPATCH` movement per line,
direction `OUT`. Lines are frozen from that point. There is no courier
integration, no label printing and no tracking polling (Product Scope §6) — this
is operational tracking only.

After dispatch, corrections are ledger corrections: goods coming back are a
`CUSTOMER_RETURN`; a dispatch recorded in error is a reversal movement. The
shipment record is not deleted, because it happened.

---

## 11. Invariants

These are the rules the implementation must enforce and test. They are numbered
so tests and code comments can cite them.

**Stock arithmetic**

- **I1** `physicalStock(p) = Σ(IN movements for p) − Σ(OUT movements for p)`.
  There is no other source of physical stock, and no stored balance is
  authoritative.
- **I2** `reservedStock(p) = Σ remainingReserved(r)` over reservations of `p`
  with status `ACTIVE`.
- **I3** `availableStock(p) = physicalStock(p) − reservedStock(p)`.
- **I4** A reservation may not be created or increased if it would make
  `availableStock < 0` (Open Decision 6). A dispatch that would make
  `physicalStock < 0` requires explicit user confirmation and is recorded, but is
  not silently permitted (Open Decision 7).

**What does and does not move stock**

- **I5** Purchase-order quantities never affect physical stock.
- **I6** Inbound-shipment quantities never affect physical stock.
- **I7** Only three actions write to the movement ledger: posting a warehouse
  receipt, dispatching an outbound shipment, and an explicit manual movement
  (opening balance, return, adjustment, stock count). No other code path writes
  to it.
- **I8** Goods that have arrived but not been received are not physical stock.

**Ledger integrity**

- **I9** A posted movement is never updated or deleted. Corrections are new
  movements.
- **I10** A reversal movement must reference an existing movement, must match it
  in `productId`, `type` and `quantity`, must have the opposite `direction`, and
  a movement may be reversed at most once.
- **I11** `movement.unit === product.stockUnit` for every movement, and
  `product.stockUnit` is immutable once any movement exists for that product.
- **I12** Cancelling or closing a purchase order, shipment, reservation or
  outbound shipment never deletes or alters posted movements. Cancellation is
  refused where posted movements already exist and `CLOSED` is the correct
  action instead.
- **I13** A posted warehouse receipt is immutable; a correction is a reversing
  receipt that posts reversing movements.

**Document consistency**

- **I14** Every purchase-order line references an active-or-referenced product;
  a product with any reference is deactivated, never deleted.
- **I15** A shipment line's `purchaseOrderLineId` must belong to a purchase order
  in status `ORDERED` or `CLOSED`, and (MVP rule) all lines of one shipment must
  belong to the same purchase order.
- **I16** A receipt line's `inboundShipmentLineId` must belong to the shipment
  the receipt references.
- **I17** A purchase order's commercial fields (lines, quantities, prices,
  currency, `analysisRef`) are immutable once it leaves `DRAFT`.
- **I18** Every entity id is a UUID and is unique within its store.

**Platform**

- **I19** Derived values are never persisted as authoritative state. A cache may
  exist, must be rebuildable from the ledger alone, and must be invalidated and
  rebuilt after every migration and every restore.
- **I20** A restore is atomic from the user's perspective: either the whole
  backup is applied, or the working database is exactly as it was.
- **I21** A migration never destroys the original data: a snapshot is written
  before it runs, and a failed migration leaves the database at its previous
  version.

---

## 12. Planned migrations already known

Written down now so the extension points in §9 are commitments rather than
hopes.

| Change | Migration | Destructive? |
| --- | --- | --- |
| ~~`RequirementItem.productId` (Phase 9)~~ | **done** — added at `schemaVersion` 3; existing requirements keep the key absent | no |
| ~~Supplier master normalisation (Phase 9)~~ | **no longer needed** — `suppliers` + `supplierIds` ship in `schemaVersion` 1 (Phase 7), and no persisted project data can predate it | n/a |
| ~~`CustomerStatus` + `Customer.customerStatusId` (Phase 11)~~ | **done in PostgreSQL** — organisation-scoped configurable rows that start empty, are created through the normal status mechanism, and have one nullable composite tenant-safe customer reference; imported customers keep it absent | no |
| ~~`Supplier.externalRef` (Phase 11)~~ | **done in PostgreSQL** — additive optional opaque text; imported suppliers keep the key absent | no |
| Multi-warehouse (future) | seed one `Location`; add required `locationId` to movements, receipts and dispatches; backfill every existing row with the seeded id | no — constant backfill, no information loss |
| Lot tracking (future) | add `Lot` store; add optional `lotRef` to movements and receipt/dispatch lines; existing rows get `null` = "pre-lot-tracking" | no |
| `externalRef` format rules — uniqueness, validation, parsed segments (future) | additive only: a unique index and/or derived columns over a column that already holds the complete value. **Blocked on the BUSINESS EXCEL CODE SCHEME ANALYSIS** (§4) — nothing is designed before real spreadsheets are examined | no |
| Stock balance cache (future) | add a rebuildable cache store; build it from the ledger on first run | no — derived, droppable |

The first two ran as numbered `schemaVersion` steps under the rules in
[Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md). **From Phase 10
onward a migration is a numbered SQL file in `supabase/migrations/`**, proven
from empty locally before it reaches the hosted project
([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §20). The
discipline is unchanged — ordered, numbered, never inferred from the data, frozen
once released, and tested against a realistic fixture of the previous state.

---

## 13. The backend migration — active, not hypothetical

This section was written when the pilot was local-only and a backend was a
possibility. **Phase 9.5 decided it, Phase 10 built the foundation, and Phase 11
connected the catalogue: PostgreSQL, hosted by Supabase, is the single source
of truth for shared business data after cutover.** The canonical document is
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md); what follows
is only what the *model* above gains, changes and keeps.

### What made it a port rather than a redesign

The shaping decisions recorded here before anything was built are the ones that
paid off:

- **UUID primary keys** map directly to `uuid` columns and survive the
  export/import round trip without renumbering. They are still generated by the
  client (`crypto.randomUUID()`), which is safe under a primary key constraint
  and lets a client assemble a whole aggregate before sending it.
- **Append-only ledger** is exactly how an inventory table should look in a
  relational database, and derived stock is a `sum()` query.
- **Aggregates with embedded lines** map to parent/child tables with a foreign
  key; the aggregate boundary is already the transaction boundary. Lines were
  embedded in IndexedDB because IndexedDB has no joins and no foreign keys — in
  PostgreSQL they become child tables, and R5 is preserved by the thing that
  always enforced it, the transaction.
- **ISO timestamps and `YYYY-MM-DD` business dates** map to `timestamptz` and
  `date` with no ambiguity.
- **Money and Quantity** already serialise to exact decimal strings via the
  existing `toJSON()`/`fromJSON()` contract, and map to `numeric` **with no
  precision or scale**. No float ever enters the model — and the decimal string
  remains the wire format, because PostgREST serialises `numeric` as a JSON
  number and JavaScript parses that as a float. That is enforced by the schema
  separation rather than by convention: the table carrying the `numeric` has no
  API route at all, so the casting projection is the *only* way the value can
  reach a client.

### What the model gains

- **A tenant.** Every business record belongs to exactly one organisation, and
  carries `organization_id` as a column — not derived through a join. Child rows
  are held to their parent's organisation by a composite foreign key, so a
  cross-tenant line is structurally impossible.
- **An actor.** `created_by` / `updated_by` on editable records, `posted_by` on
  the append-only ones. Attribution on an immutable row is permanent by
  construction.
- **A place, and a separate published surface.** Every entity in this document
  becomes a table in the **`app_data`** schema, which the Data API does not
  serve. What a client sees is a projection of it in the **`api`** schema — a
  `security_invoker` view for reads and typed functions for writes. The
  conceptual model is unchanged by that; what changes is that "a client can read
  a product" means "a client can read `api.products`", and the decimal columns
  arrive as canonical strings because the projection casts them.

### What changes in §2's conventions

- **Time is server-owned where it is a system fact.** `createdAt`, `updatedAt`,
  `recordedAt` and `postedAt` are set by the database, never by a client clock.
  `occurredAt` and every business date stay client-supplied, because those are
  facts the *user* states — which is precisely the distinction §2 already draws
  between "when it physically happened" and "when the row was written", now
  load-bearing rather than descriptive.
- **The concurrency token becomes `version`, an integer, not `updatedAt`.** The
  behaviour is identical — a write states the version it is replacing and is
  refused on a mismatch — but a counter cannot collide (two updates in one
  transaction share `now()`) and cannot be mistaken for an ordering across
  devices. `updatedAt` remains on the record as display metadata.

### What does not change

The entities, the relationships, the lifecycles, the seven movement types,
magnitude-plus-direction, the derived-not-stored rule (R1, I19), the snapshot
boundary between analysis and purchasing (R4), and **invariants I1–I18** are
unchanged in meaning. What changes is where they are enforced: I7 (only three
actions write the ledger) and I9 (a posted movement is never updated or deleted)
become *permissions* — `authenticated` has no insert, update or delete grant on
the movement table — rather than rules the application must remember.

I19–I21 are restated for the new platform in
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §16: a restore
is still atomic from the user's perspective, and *failed restore = no-op* still
holds — in PostgreSQL it is free, because a rolled-back transaction changed
nothing.

### What is still deliberately not being built

No repository interface per entity, no unit-of-work abstraction, no DTO layer,
and **no sync protocol** — dual-master synchronisation is explicitly rejected,
not deferred (see
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §14). One
`DataGateway` with a method per operation the features actually call is enough,
for the same reason the local persistence module was a set of explicit functions.

The coupling this section told us to watch held: the persistence layer was the
single place that knew about IndexedDB, and that is exactly what makes replacing
it a contained change.
