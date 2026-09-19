# Product Requirements

> **Superseded by [Product Scope](PRODUCT_SCOPE.md) as of Phase 6.5.**
>
> This file used to be the canonical product definition, written when
> LandedCompare was scoped to supplier-quotation comparison only. That scope was
> expanded in Phase 6.5 into a local operational pilot (purchasing, inbound
> logistics, inventory, reservations, outbound goods) for use inside a real
> company alongside Logo Tiger.
>
> The material that used to live here — product definition, users, MVP
> boundaries, excluded scope — now lives in one canonical place so the two
> cannot drift apart.

| Topic | Canonical document |
| --- | --- |
| What the product is, who it is for, the pilot operating model | [Product Scope](PRODUCT_SCOPE.md) |
| MVP scope and out-of-scope list | [Product Scope](PRODUCT_SCOPE.md) §5, §6 |
| Open product decisions and their MVP defaults | [Product Scope](PRODUCT_SCOPE.md) §7 |
| Entities, relationships, lifecycles, inventory model, invariants | [Data Model](DATA_MODEL.md) |
| Storage, schema versions, migrations, backup and restore | [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) |
| Financial rules of the landed-cost engine | [Calculation Rules](CALCULATION_RULES.md) |
| Module boundaries and layering | [Architecture](ARCHITECTURE.md) |
| Build order and phase sizing | [Implementation Plan](IMPLEMENTATION_PLAN.md) |
| Post-MVP candidates | [Roadmap](ROADMAP.md) |

## The unchanged core

One thing from the original scope is unchanged and worth keeping here, because
everything else was built around it: the product's job is to normalize supplier
quotations — in different currencies, with different MOQs, pack sizes and cost
structures — into a shared landed-cost model, and show which *complete*
quotation has the lowest calculated landed cost under the assumptions the user
entered. Not the lowest unit price, and never a "best supplier".
