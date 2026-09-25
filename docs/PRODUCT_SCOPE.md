# Product Scope

**Canonical source** for what LandedCompare is, who it is for, what the pilot
MVP includes and excludes, and which product decisions are still open.

- Entity shapes, relationships, lifecycles and invariants → [Data Model](DATA_MODEL.md)
- Tenancy, accounts, permissions, where the data lives → [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md)
- Local-pilot storage, backup format, restore — historical → [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md)
- Build order and phase sizing → [Implementation Plan](IMPLEMENTATION_PLAN.md)
- Layering and module boundaries → [Architecture](ARCHITECTURE.md)
- Financial rules → [Calculation Rules](CALCULATION_RULES.md)

Status as of Phase 9.5: the calculation/comparison engine (Phases 0–5), the i18n
foundation (Phase 6), local persistence and backup (Phases 7–8) and the first
screens — application boot, products, suppliers, customers (Phase 9) — are
implemented. Nothing described below as "operational" exists in code yet, and
nothing multi-user does either: the cloud architecture is designed (Phase 9.5)
and built from Phase 10 onward.

---

## 1. What LandedCompare is

LandedCompare is a web application — delivered as a Windows and macOS desktop
client — that carries one importing company's purchasing chain from *"which
supplier quotation is actually cheapest once every landed cost is counted?"*
through to *"what do we physically have in the warehouse, what is promised to a
customer, and what is still on the water?"* — built around an audited,
deterministic landed-cost engine and an append-only inventory movement ledger,
shared by the handful of people in one company who need to see the same numbers.

**It was, through Phase 9, a local-first single-machine application with no
backend, no accounts and no cloud dependency.** Phase 9.5 changed that, and the
reason is in the model rather than in the infrastructure: the product's central
invariant — a reservation may not push available stock below zero — is a
statement about the whole company, and two disconnected databases can each
satisfy it while jointly violating it. Shared operational truth needs a single
serialisation point. See
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md).

## 2. What changed in Phase 6.5, and why

The original scope stopped at quotation comparison. That is a decision-support
tool: it is used a few times per purchasing cycle and then closed. It cannot be
evaluated by a pilot user, because there is no daily work in it.

LandedCompare will first be used inside a real company as a **pilot**, and the
pilot must survive contact with daily operations. So the product scope now
covers one focused operational chain:

```text
QUOTE
  → PURCHASE DECISION
    → PURCHASE ORDER
      → INBOUND SHIPMENT
        → WAREHOUSE RECEIPT
          → INVENTORY
            → RESERVATION / COMMITMENT
              → OUTBOUND SHIPMENT
```

The landed-cost engine remains the procurement-analysis core. Everything added
in this phase extends it forward in time — from *deciding* what to buy to
*tracking* what was bought — rather than replacing it.

### The product principle that bounds this

**LandedCompare is not becoming an ERP.** It is not replacing Logo Tiger, and
"Logo Tiger has this feature" is not an argument for adding it. The test for any
new capability is whether it is needed to keep the chain above unbroken and
honest. Accounting, invoicing, valuation, CRM, HR and multi-site logistics all
fail that test and are listed as out of scope in §6.

---

## 3. Pilot operating model

### Shared, server-authoritative, and still free to run

The pilot runs on **several computers** at the company — the owner's machine,
the office, the warehouse — as a desktop application on Windows and macOS, with a
browser as the development client. All shared business data lives in one hosted
PostgreSQL database, which is the single source of truth. No device holds an
authoritative copy of anything. See
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md).

It still costs **$0/month** to operate: one Supabase Free project, no domain, no
paid hosting, no email provider, no paid plan of any kind. Nothing in the
architecture requires one.

Three consequences follow, and all three are binding:

1. **Internet access is required to read or change business data.** This is an
   accepted product limitation, not a gap to be closed later by a sync engine —
   see §7, Open Decision 16.
2. **A Free-plan project is paused after about a week of inactivity**, and an
   administrator must resume it from the Supabase dashboard. The application says
   so honestly rather than pretending to work; ordinary users see a plain
   unavailable message and administrators see what to do about it.
3. **There are still no automatic database backups.** The Free plan does not
   provide them. Two different protections exist instead, and the product never
   lets one be mistaken for the other: an organisation-scoped **portable export**
   that an administrator can download, and an **infrastructure dump set** — more
   than one command, because the default dump is schema-only and excludes the
   managed `auth` schema — that the project's operator runs weekly and before
   every migration. What each one does and does not recover, including the honest
   position on Auth accounts, is in
   [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §16.

*Historical, through Phase 9:* the pilot was designed to run in a browser on one
computer, with no server, no login and no synchronisation, and all data in that
machine's IndexedDB. That constraint was deliberate rather than a shortcut, and
it produced the persistence and backup work in Phases 7–8 — most of whose
*discipline* survives even though its storage does not
([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §25). What
retired it was not ambition but the requirement that several people see the same
stock.

### Accounts, and who can do what

Three roles, and no more: **OWNER**, **ADMIN**, **MEMBER**. Everyone can do the
day-to-day work; administrators additionally manage who has access and can export
the company's data; only the owner can restore over it. An administrator adds
a person by e-mail address; the person receives an invitation at that address
and chooses their own password (Phase 12). No administrator ever sees or sets
anyone's password, and there is no self-registration.

**Everyone who posts stock movements, receipts or dispatches has their own
account.** A shared warehouse login is not the operating model, and the reason is
the ledger: it is append-only, so the person recorded against a movement is
recorded permanently, and attribution that was never captured cannot be
recovered. A shared account would still *work* — nothing in the model forbids it
— it would simply make "who booked this in?" unanswerable for every row it ever
wrote.

### Parallel run with Logo Tiger

The company's system of record stays Logo Tiger for the whole pilot.
LandedCompare runs **alongside** it.

| | Logo Tiger | LandedCompare (pilot) |
| --- | --- | --- |
| Legal/accounting books | **Authoritative** | Not involved |
| Invoices, tax, e-documents | **Authoritative** | Not involved |
| Stock valuation / costing | **Authoritative** | Not computed |
| Official stock quantity | **Authoritative** | Operational view only |
| Landed-cost analysis before buying | Not supported | **Authoritative** |
| Day-to-day operational tracking | Awkward | **Being evaluated** |

Two consequences follow, and both are binding:

1. **LandedCompare must never present itself as the accounting truth.** Stock
   figures it shows are an operational view derived from what the pilot user
   entered. Where the two systems disagree, Logo Tiger wins by definition, and
   LandedCompare's job is to make the disagreement *visible* rather than to
   argue with it.
2. **No Logo Tiger integration is in scope.** No export connector, no database
   read, no file sync, no posting of journal entries. Reconciliation during the
   pilot is a human activity, supported by a stock-count adjustment workflow
   (§5) that records the correction as a normal, traceable ledger movement.

### The pilot users

The primary pilot user is the owner's father — an experienced operator, not a
software tester. What he will surface is *missing workflow and friction*, not
bug reports. The product therefore has to be usable end-to-end with real data
before feedback is meaningful, which is what drives the roadmap order in
[Implementation Plan](IMPLEMENTATION_PLAN.md): the shared foundation and backup
first (nothing else is safe to enter data into), then the analysis screens, then
the operational chain.

Beside him are office and warehouse personnel — two to five people in total, none
of them technical. Two design constraints follow from that number and that
profile. **Signing in must be as simple as an email address and a password**,
which is one of the two reasons no other authentication method is offered. And
**the application must never explain its infrastructure to them**: when the
server is unreachable an ordinary user is told that saving is unavailable and to
tell their administrator, and only an administrator is shown what actually needs
doing.

The company handles medical-device-related products. That does **not** pull lot
/ serial / expiry tracking into the MVP (see §7, Open Decision 4), but it does
mean the inventory ledger must be designed so those dimensions can be added
later without being rewritten.

---

## 4. Domain boundaries

Five bounded areas, with one hard rule between them.

```text
┌────────────────────────────────────────────────────────────┐
│ PROCUREMENT ANALYSIS          (exists, frozen in 6.5)       │
│ Project · RequirementItem · Supplier · Quote · QuoteItem    │
│ landed-cost calculation · supplier comparison               │
└──────────────────────────┬─────────────────────────────────┘
                           │ one-way: a decision snapshot
                           ▼
┌────────────────────────────────────────────────────────────┐
│ PURCHASING                    Catalog ──────────────────┐   │
│ PurchaseOrder · Line          Product · Supplier ·      │   │
└──────────────────────────┬──   Customer                 │   │
                           │                              │   │
                           ▼                              │   │
┌────────────────────────────────────────────────────┐    │   │
│ LOGISTICS                                          │    │   │
│ InboundShipment · WarehouseReceipt ·               │◄───┘   │
│ OutboundShipment                                   │        │
└──────────────────────────┬─────────────────────────┘        │
                           │ posts movements                  │
                           ▼                                  │
┌────────────────────────────────────────────────────────────┐│
│ INVENTORY                                                  ││
│ InventoryMovement (append-only ledger) ·                   ││
│ InventoryReservation · derived stock views                 ││
└────────────────────────────────────────────────────────────┘│
                                                              │
┌─────────────────────────────────────────────────────────────┘
│ PLATFORM   identity · tenancy · access control ·
│            data access · schema migration · backup/restore · i18n
└──────────────────────────────────────────────────────────────
```

**The hard rule: the dependency from analysis to operations is one-way and
snapshot-based.** Purchasing reads a *frozen copy* of an analysis result at the
moment a purchase decision is made. Nothing in purchasing, logistics or
inventory can call back into the comparison engine, and editing a quote next
month can never change what a purchase order says was ordered. See
[Data Model](DATA_MODEL.md), "Quote → Purchase Order".

**A second hard rule, added in Phase 9.5: every business record belongs to
exactly one organisation, and that boundary is enforced by the database, not by
the interface.** Products, suppliers, customers, projects, quotes, orders,
shipments, receipts, movements, reservations and outbound shipments all carry
their organisation, and a row outside the caller's organisation does not exist as
far as any query is concerned.

The procurement-analysis area keeps its existing property of being pure,
React-free and storage-free. The operational areas get the same treatment: the
domain rules live in plain TypeScript modules, and the storage technology —
whichever it currently is — is a detail the platform layer owns.

---

## 5. MVP scope (pilot)

Everything below must exist before the pilot is considered feature-complete.

### 5.1 Procurement analysis — already built, needs a UI

- Projects, requirements, suppliers, quotations, multi-currency with manual
  exchange rates.
- MOQ / pack / order-quantity resolution.
- Additional costs (freight, insurance, duty, brokerage, bank fees, local
  transport, packaging, tax, other), discounts, surcharges, shared-cost
  allocation.
- Incomplete-quotation detection, deterministic ranking and insight codes.
- Turkish and English UI.

### 5.2 Catalog and parties

- **Product master** with an internal SKU, a single authoritative stock unit,
  optional purchase unit + pack factor, and an active/inactive flag.
- **Supplier master** shared by analysis and purchasing (one supplier record,
  not one per project).
- **Customer master** — minimal: name, optional external system code, optional
  classification, active flag. Not a CRM record (Open Decision 1).
- **Customer classification**, configured by the company rather than fixed by the
  product. The pilot company grades customers `C`, `A`, `A+`, `A++`; another
  company would use something else, so the list is data, not an enum. A customer
  carries zero or one current grade, the order is explicit, and retiring a grade
  never reclassifies the customers already holding it (Open Decision 19).
- **External system code** on customers *and* suppliers — the identifier the
  company already uses in its existing system, stored and shown exactly as typed.
  Nothing parses, validates, generates or de-duplicates it yet (Open Decision 20).

### 5.3 Purchasing

- Purchase orders with lines, created either from a selected quotation (with a
  frozen analysis snapshot) or manually.
- Explicit lifecycle: `DRAFT → ORDERED → CLOSED | CANCELLED`.
- Derived fulfilment progress (shipped / received against ordered) — computed,
  never stored.

### 5.4 Inbound logistics

- Inbound shipments with lines referencing purchase-order lines.
- Lifecycle covering planning, transit, customs, arrival, closure, cancellation.
- Carrier / reference / departure date / ETA / actual arrival tracking.
- One purchase order may ship in several shipments (partial shipment is normal
  in importing).

### 5.5 Warehouse receiving

- Warehouse receipts against an inbound shipment, with per-line received
  quantities, supporting **partial receipt** and shortages.
- Posting a receipt is what creates inventory movements. Nothing before it does.
- A posted receipt is immutable; corrections are reversing receipts.

### 5.6 Inventory

- **Append-only inventory movement ledger** — the single source of stock truth.
- Opening balances, purchase receipts, customer dispatches, customer returns,
  supplier returns, positive/negative adjustments.
- Corrections by reversal, never by edit or delete.
- Derived stock views per product: physical, reserved, available, on order,
  in transit, in customs, arrived-not-received, expected incoming.
- **Stock count adjustment**: enter a counted quantity, see the difference
  against the derived physical stock, post the correction as an adjustment
  movement with a stock-count reason. This is the Logo Tiger reconciliation
  bridge.

### 5.7 Reservations and outbound

- Reservations committing physical stock to a customer without removing it.
- Reserved stock reduces *available*, never *physical*.
- Outbound shipments; dispatching posts the stock-out movements.
- Partial dispatch against a reservation.

### 5.8 Accounts and access

- One company (organisation); every business record belongs to it.
- Sign-in with email and password. An administrator adds a person by address;
  Auth e-mails that person an invitation and they choose their own password
  (Phase 12 — requires an SMTP provider on the hosted project). No
  self-registration; no administrator-known passwords.
- Three roles — OWNER, ADMIN, MEMBER — with administrators managing membership
  and only the owner able to restore over company data.
- A user can be disabled, which takes effect on their next request. Membership is
  never deleted, so attribution on past stock movements keeps resolving.
- Every posted movement, receipt and dispatch records who posted it.

### 5.9 Platform

- PostgreSQL as the single source of truth, with row-level security scoping every
  row to its organisation.
- Multi-row business operations as server-side transactions, so an invariant can
  never depend on a sequence of independent client requests.
- Optimistic concurrency: a write states the version it replaces and is refused,
  never merged, on a mismatch.
- Version-controlled schema migrations as the canonical schema history.
- Organisation-scoped portable backup export, in a versioned, checksummed,
  fully-validated format, with a freshness reminder.
- Validated, atomic restore that cannot leave the database half-replaced.
- Honest offline and server-unavailable states: no write is ever reported as
  succeeded, and no stale data is presented as current.
- Windows and macOS desktop clients built from the same application code.

---

## 6. Out of scope

Not in the pilot MVP, and not partially started "to make it easier later".

**Because Logo Tiger owns it**

- Accounting, journal entries, chart of accounts, VAT/e-invoice/e-archive.
- Invoicing, payments, receivables/payables, bank reconciliation.
- **Stock valuation and costing** (FIFO, weighted average, inventory value
  reporting). LandedCompare tracks *quantities*; money on the operational side
  stops at the purchase-order snapshot. See Open Decision 11.
- Payroll, HR, fixed assets.
- Any Logo Tiger integration, import, export or sync.

**Because it is not the product**

- CRM: opportunities, contacts, activities, pricing agreements, sales orders as
  a separate entity.
- Supplier portal, supplier self-service, RFQ distribution, supplier scoring or
  quality/lead-time ratings.
- Automatic FX rate lookup; automatic customs/duty/HS-code lookup.
- AI/LLM features, OCR, PDF or e-mail quotation parsing.
- Courier/carrier API integration, label printing, track-and-trace polling.
- Barcode scanners, handheld terminals, warehouse bin locations, pick paths.
- Demand forecasting, reorder-point automation, MRP.

**Because the pilot is one company, a handful of users, and $0/month**

- **Offline editing of shared business records, and any form of two-way sync or
  conflict merging.** Explicitly rejected rather than deferred — Open Decision 16.
- **Real-time push updates.** Correctness comes from database transactions, not
  from message delivery; a refresh-after-mutation model is correct for this many
  users ([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §23).
- Self-service registration, self-service password reset, email invitations,
  Google/Microsoft sign-in, SSO/SAML, multi-factor authentication.
- Fine-grained permissions beyond the three roles — no per-module rights, no
  groups, no delegation, no permission matrix.
- Multi-company operation *in the interface*. The data model supports a user
  belonging to several organisations; the pilot UI assumes one and does not offer
  a picker.
- A traditional Node/Express API tier, a custom domain, or paid hosting of any
  kind.
- **Multi-warehouse / multi-location** (Open Decision 5).
- Native mobile applications; offline-installable PWA packaging.
- Telemetry, analytics, crash reporting.
- File attachments, document uploads and photos.

**Deferred with a known reason**

- Lot / serial / expiry tracking (Open Decision 4).
- Effective landed *unit* cost — still blocked on a business decision carried
  over from Phase 5, see [Calculation Rules](CALCULATION_RULES.md).
- Item-level additional costs, weight/volume allocation, order-multiple
  resolution — all previously deferred in the engine, unchanged by this phase.
- Backup encryption at rest (Open Decision 9).
- Merge-mode restore (Open Decision 10).
- CSV/XLSX and clipboard import of quotation grids — useful, but it is a data
  *entry* convenience, and the pilot's first job is to prove the workflow.
  Scheduled late (Phase 20), droppable without breaking the chain.

---

## 7. Open product decisions

Each has an MVP default chosen so the build is not blocked. The default is what
will be implemented unless the pilot says otherwise; none of them requires a
rewrite to change later.

### 1 — Customer: entity or free text?

**Default: a minimal `Customer` entity.** Id, display name, optional external
reference, active flag, note — the same deliberately-not-a-CRM shape the
existing `Supplier` already uses.

*Why:* reservations are only useful if "what is committed to this customer" is
answerable, and free-typed Turkish company names do not aggregate — one typo
and the reservation is invisible. Four fields is not CRM.
*Extension:* contacts, addresses, payment terms and delivery addresses attach to
this entity later without touching reservations or shipments. A one-off
recipient is handled by a free-text `recipientNote` on the outbound shipment, so
the entity is not forced on every ad-hoc delivery.

### 2 — Can one purchase order ship in several shipments?

**Default: yes.**

*Why:* in importing this is the normal case, not an exception — suppliers split
by production readiness and container space. Forcing one shipment per order
would make the pilot user record fiction on his first real order.
*Extension:* none needed; it is the general case.

### 3 — Can one shipment carry lines from several purchase orders?

**Default: no, for the MVP — but as a validation rule, not a schema limit.**

*Why:* consolidating two orders into one container happens, but it roughly
doubles the receiving/allocation UI while the pilot has not yet proven the
simple case.
*Extension:* the purchase-order reference lives on the shipment *line*, not the
shipment header, and the single-order restriction is one validation function.
Supporting consolidation later means deleting that check — **no data migration**.

### 4 — Lot / serial / expiry tracking

**Default: not in the MVP. FUTURE PRODUCT DECISION.**

*Why:* it is a real possibility for medical-device products, but it changes
every receiving and dispatch screen and every stock view, and it is worthless
unless the company actually commits to capturing lot numbers at the door.
That is an operating-procedure decision the pilot exists to inform.
*Extension:* the ledger is already per-movement and per-line, never
pre-aggregated. Adding tracking means adding an optional `lotRef` to
`InventoryMovement` plus a `Lot` entity; product-level stock stays
`sum(movements for product)` and lot-level stock becomes
`sum(movements for product where lotRef = x)`. It **partitions** the ledger
rather than restructuring it. See [Data Model](DATA_MODEL.md), "Future
dimensions".

### 5 — Multi-warehouse

**Default: single implicit location. No `locationId` field in the MVP.**

*Why:* the company operates one warehouse. Carrying a field no code reads
invites two incompatible readings of `null` (the default warehouse, or unknown)
and every future migration then has to guess which one historic rows meant.
*Extension:* introduce a `Location` entity, add a required `locationId` to
`InventoryMovement` and to receipts/dispatches, and backfill every existing
movement with the single seeded default location id. It is a mechanical constant
backfill with no information loss, run inside a normal versioned migration with
a pre-migration snapshot.

### 6 — May a reservation push available stock below zero?

**Default: no — blocked.**

*Why:* a reservation is a promise about the future. Refusing an impossible
promise is safe and protects the person who reserved the stock first.
*Extension:* if the company genuinely over-commits against incoming shipments, a
future "reserve against expected incoming" mode can allow it explicitly, with
the shortfall shown.

### 7 — May a dispatch push physical stock below zero?

**Default: allowed, but only behind an explicit confirmation, and recorded.**

*Why:* this is the opposite situation to Decision 6. A dispatch is a physical
fact that already happened. If the receipt paperwork is late, refusing to record
reality does not prevent the error — it pushes the user into faking a receipt,
which corrupts the ledger far worse than a temporary negative balance. The
negative balance is visible and self-correcting when the receipt is entered.
*Extension:* the confirmation can be tightened to a hard block per product, or
replaced by a "pending receipt" concept, without changing the ledger.

### 8 — Can goods be received without a purchase order and shipment?

**Default: no. Receiving flows only from a shipment; the escape hatch is a
positive adjustment.**

*Why:* it preserves the traceability chain that is the point of the system, and
an adjustment still records the stock honestly — it just does not pretend to
have a procurement history it does not have.
*Extension:* a standalone "direct receipt" document if the pilot shows it
happens often.

### 9 — Backup encryption at rest

**Default: not in the MVP. Post-pilot.**

*Why:* the backup files are company operational data, downloaded by an
administrator onto company hardware; the realistic threat is *losing* them, not
someone reading them. A password-based scheme adds a permanent, irreversible
failure mode — a forgotten password destroys a disaster-recovery copy — which is
a worse risk than the one it removes. The data at rest in the database is a
separate question and is answered by access control, not by file encryption.
*Extension:* Web Crypto AES-GCM with PBKDF2 key derivation, added as a
`backupFormatVersion` bump with the unencrypted format still readable. See
[Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md), "Backup
security".

### 10 — Restore: replace or merge?

**Default: replace-all only.**

*Why:* merging two divergent ledgers requires answering "which of these two
edits to the same purchase order wins?", and there is no correct generic answer.
A backup is always either a restore point or a move to new infrastructure, and
neither needs a merge. This reasoning is what Decision 16 then applies to offline
editing, where it is stronger still.
*Consequence against shared data:* restore is **owner-only**, scoped to one
organisation, refuses to import into an organisation that already holds business
data, and locks every other member out for its duration. Destroying one person's
copy was already the most dangerous operation in the product; destroying
everyone's needs more than a confirmation dialog.
*Extension:* selective/partial restore (e.g. "catalog only") is a plausible
later addition and is safer than a true merge.

### 11 — Does the pilot compute stock value?

**Default: no. Quantities only.**

*Why:* valuation is an accounting output, Logo Tiger owns it, and a second
system publishing a different inventory value is actively harmful during a
parallel run.
*Extension:* the landed-cost engine already produces exactly the per-line landed
figures a weighted-average cost layer would need, and the purchase-order
snapshot preserves them per receipt. Valuation can be added as a derived reading
of existing data rather than new data capture — after the pilot, and only if the
company wants a second opinion on cost.

### 12 — Do reservations need a sales-order entity behind them?

**Default: no. The reservation *is* the demand record.**

*Why:* a `SalesOrder` with its own lines, pricing and lifecycle is the front door
to CRM/order management, and the pilot's question is "is this stock free?", not
"what did we sell it for?".
*Extension:* if order management is ever needed, a `SalesOrder` becomes the
parent of reservations; reservations already carry a customer and a reference,
so they can be re-parented without changing the stock arithmetic.

### 13 — What happens to a partially dispatched reservation?

**Default: the remaining quantity is derived, not edited.**
`remaining = reserved − dispatched-against-this-reservation`, and reserved stock
counts the remainder. A reservation is closed manually when the customer will
not take the rest.

*Why:* it keeps the reservation a stable record of what was promised, and makes
partial dispatch fall out of the same subtraction as everything else.
*Extension:* automatic closure rules or expiry dates, if reservations start
going stale.

### 14 — Can a product's stock unit change?

**Default: no, once any movement exists for that product.**

*Why:* the ledger performs no unit conversion by design. Changing the unit
underneath an existing ledger silently reinterprets every historical row.
*Extension:* if a unit truly must change, the supported path is a new product
record plus an explicit transfer adjustment pair — which leaves an auditable
trail instead of rewriting one.

### 15 — Does a purchase order recompute landed cost?

**Default: never. The purchase order snapshots the decision.**

*Why:* it is a historical commercial record. If editing a quotation in a
comparison project rewrote what a past order says, the system would be unable to
answer "what did we agree to?" — the one question an order exists to answer.
*Extension:* a "re-analyse this order against today's quotes" read-only view is
possible, and would produce a *new* comparison, not mutate the order.

### 16 — Can people work offline?

**Default: no. Internet access is required to read or change business data, and
this is an accepted product limitation.**

*Why:* the alternative is not "keep working" — it is "keep working and find out
later that the stock figure was wrong". Available stock, reservation totals and
unique order codes are statements about the whole company; two offline devices
can each satisfy them and jointly violate them, and a merge performed afterwards
can only pick a loser after both users already told a customer yes. This is the
same reasoning Decision 10 uses to refuse merge-mode restore, applied to a case
where it is stronger rather than weaker.
*What this does not mean:* a failed save never discards what the user typed. The
form keeps its contents and offers a retry. That is a UI requirement, not a sync
mechanism — nothing is queued and nothing is retried automatically.
*Extension:* narrowly-scoped offline *drafts* for a screen that genuinely needs
them — never for anything that touches stock. Full offline operation is rejected,
not deferred.

### 17 — Individual accounts, or a shared warehouse login?

**Default: individual accounts for everyone who posts stock movements.**

*Why:* every posted movement, receipt and dispatch records who posted it, and
that attribution is permanent — the ledger is append-only. A shared login
produces a record that is true and useless. The model supports a shared account
without any change, but it cannot recover attribution that was never captured.
*Extension:* none needed in either direction; this is an operating decision the
company makes, not a schema one.

### 18 — What happens when the free project is paused?

**Default: the application says so honestly and refuses to write. An
administrator resumes it from the Supabase dashboard.**

*Why:* a Free-plan project pauses after about a week of inactivity. Manufacturing
synthetic traffic to evade that is refused as a design — it works against the
plan's intent and creates a false signal about whether the product is being used.
A pilot in daily use will not pause; a pilot that sat idle for a week can be
resumed in under a minute.
*Consequence to state plainly:* an application that can be unavailable until an
administrator clicks "Resume" is acceptable for an evaluation and is **not**
acceptable as a company's daily operational system.
*Extension:* a paid plan, which cannot be paused and adds automatic backups. It
is a billing decision and changes nothing in the architecture.

### 19 — How are customers classified?

**Default: an organisation-configurable list that starts empty. Never a fixed
enum and never populated with product-owned defaults.**

*Why:* the grades are the company's, not the product's. The pilot company may
create `C`, `A`, `A+`, `A++` through the ordinary status UI, but those values are
business data rather than bootstrap behaviour. A `create type … as enum`
or a TypeScript union would make adding `B` a schema migration and a release, and
would be wrong for the next company by construction. A customer carries zero or
one current grade — this answers "what grade is this customer now", and grade
*history* is a CRM concept the product does not have. A retired grade stays valid
for every customer already holding it: deactivation removes it from the picker,
never reclassifies anyone.
*What it deliberately does not do:* nothing. A grade is a label the company sorts
and filters by. It carries no discount percentage, credit limit or payment terms,
because the moment it drives a price it has become a pricing model, which is CRM
and is out of scope (§6).
*Extension:* if a grade ever must mean something, that meaning attaches to the
status row as new fields — the customers already point at it.

In the model this is `CustomerStatus` plus `Customer.customerStatusId`; see
[Data Model](DATA_MODEL.md) §4. Implemented in Phase 11, with the catalog,
because it is a `customers` column and adding it later costs a migration over
live company data.

### 20 — What is the external system code, and what does the product do with it?

**Default: an opaque optional string on both customers and suppliers. Stored and
displayed verbatim. Nothing parses it, validates it, generates it, or requires it
to be unique.**

The company's codes look like `120-34-00-11-001` for a customer and `320-…` for a
supplier. A partial reading is known — `120`/`320` are the party-type prefixes,
`34` is a Turkish province plate code, `00`/`01` separate the Anatolian and
European sides of Istanbul — and `11-001` is **currently unknown.**

*Why not encode the pattern:* the interpretation is partial and unverified. A
schema that treats `34` as a province rejects the first foreign supplier and has
to be migrated the moment the real rule turns out to be different — which, with a
whole segment still unknown, it may well be. Uniqueness is likewise unproven: the
real data may contain duplicates, blanks or historical variants, and a unique
index added before anyone has looked turns the first import into a debugging
session.
*Why storing it is still worth doing now:* the complete value is retained, so
every later capability is **additive** — a format check, a unique index, parsed
segments for filtering, a generator — over a column that already holds the data.

In the model this is the optional `externalRef` field, which `Customer` already
has and `Supplier` gains in Phase 11; see [Data Model](DATA_MODEL.md) §4. The
field keeps that name — it already means "this record's identifier in some other
system" — while the interface labels it *Dış Sistem Kodu*.
*Extension, and it has a trigger:* a **BUSINESS EXCEL CODE SCHEME ANALYSIS**
runs when the owner provides real spreadsheets. It must settle prefix
consistency, the province and district segments, the unknown `11-001`, actual
uniqueness, whether the company ever *assigns* codes or only receives them, how
foreign parties are coded, and whether the scheme originates in Logo Tiger — in
which case LandedCompare mirrors it and must never generate it. Only after that
may parsing or generation be designed. See
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §26.

---

## 8. Success criteria for the pilot

The pilot is judged on whether the chain holds, not on feature count:

1. A real purchase can be analysed, ordered, shipped, received, reserved and
   dispatched entirely inside the application.
2. The stock figure it shows can be explained, movement by movement, back to the
   documents that created it.
3. A discrepancy against Logo Tiger can be found, corrected and traced.
4. The database can be destroyed and fully restored without silent data loss.
5. The pilot user can complete a normal day without needing the developer.
6. **Two people working at once see the same numbers**, and when they collide the
   application says so instead of silently picking a winner.
7. **No one can see or change another company's data**, proven by test rather
   than by the interface not offering a way.
