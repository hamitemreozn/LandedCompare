# Roadmap

This file covers the **post-MVP horizon** only — candidates for after the local
pilot.

- What is in the pilot MVP, and what is explicitly out → [Product Scope](PRODUCT_SCOPE.md)
- The phase-by-phase build order with difficulty ratings → [Implementation Plan](IMPLEMENTATION_PLAN.md)

## Post-pilot candidates

Items reach this list only when they are a genuine, considered candidate — it is
not a wishlist. Each carries the reason it is *not* in the MVP.

**Waiting on a pilot answer**

- **Lot / serial / expiry tracking.** Relevant to medical-device products, but it
  changes every receiving and dispatch screen and is worthless unless the
  company commits to capturing lot numbers at the door. That is an operating
  procedure decision the pilot exists to inform. The ledger is already shaped to
  accept it without being rewritten — see
  [Data Model](DATA_MODEL.md), "Future dimensions".
- **Multi-warehouse / locations.** One warehouse today. The migration is written
  down in advance ([Data Model](DATA_MODEL.md) §12).
- **Consolidated shipments** (lines from several purchase orders in one
  shipment). Already possible in the schema; blocked only by a validation rule.
- **Stock valuation** (weighted average / FIFO, inventory value reporting). Logo
  Tiger owns valuation during the parallel run. The landed-cost engine already
  produces the per-line figures a costing layer would consume, so this would be
  a derived reading of existing data rather than new capture.
- **Backup encryption at rest.** Deferred because a forgotten password destroys
  the only disaster-recovery copy — a worse risk than the one it removes. See
  [Product Scope](PRODUCT_SCOPE.md), Open Decision 9.

**Deferred in the engine, unchanged by Phase 6.5**

- Effective landed *unit* cost — still blocked on the required/ordered
  denominator business decision from Phase 5.
- Item-level additional costs, weight/volume allocation, order-multiple
  resolution. See [Calculation Rules](CALCULATION_RULES.md).

**Moved out of this list — now in the plan**

- ~~Backend migration: `React → API → PostgreSQL`, multi-user, permissions.~~
  **No longer post-pilot, and no longer only a plan.** Phase 9.5 decided it;
  **Phase 10 built the foundation** — the three-schema separation, identity and
  tenancy, row-level security, the provisioning workflow and the application
  seam, proved against a local Supabase stack — and Phase 11 migrates the
  catalog onto it. See
  [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md), whose §28
  reports what is real and what is still design, and
  [Implementation Plan](IMPLEMENTATION_PLAN.md). The data model was shaped so
  this would be a port rather than a redesign
  ([Data Model](DATA_MODEL.md) §13), and it is.

**Only if the pilot succeeds**

- Automatic FX rate lookup.
- Scenario analysis ("what if freight rises 20%?").
- Quotation history / versioning over time.
- Selective (partial) restore, e.g. catalog-only.
- **Realtime updates as a refresh hint.** Deliberately not in the MVP:
  correctness comes from database transactions, not from message delivery, and a
  refresh-after-mutation model is correct for a handful of users. If it is added,
  it is a *"yeni veri var — yenile"* affordance, never a data channel
  ([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §23).
- **A local read cache**, for list acceleration only — with a visible age marker,
  visually distinguishable from live data, and never a write target. The MVP has
  none on purpose: a cache reintroduces the question *"is this current?"* that the
  server-authoritative model exists to remove.
- **Custom SMTP**, enabling real email invitations and self-service password
  reset. Changes the *delivery* of an invitation, not the model.
- **Finer-grained roles** — `PURCHASING`, `WAREHOUSE`, `READ_ONLY`. One migration
  extending an enum plus new policy predicates; no structural change. Worth doing
  when someone is genuinely given access they should not have, and not before.
- **Supabase Pro**, which removes inactivity pausing and adds automatic backups
  and point-in-time recovery. A billing decision, not an architectural one.

**Rejected, not deferred**

- **Offline editing of shared business records, and any two-way sync or conflict
  merge.** The product's central invariants are statements about the whole
  company, not mergeable per-record state; a merge can only pick a loser after
  both users acted on the answer. See
  [Product Scope](PRODUCT_SCOPE.md), Open Decision 16.
