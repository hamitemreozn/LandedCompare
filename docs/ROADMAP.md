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

**Only if the pilot succeeds**

- Automatic FX rate lookup.
- Scenario analysis ("what if freight rises 20%?").
- Quotation history / versioning over time.
- Selective (partial) restore, e.g. catalog-only.
- Backend migration: `React → API → PostgreSQL`, multi-user, permissions. The
  data model is shaped so this is a port rather than a redesign
  ([Data Model](DATA_MODEL.md) §13), but nothing is being built for it now.
