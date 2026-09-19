# LandedCompare

Local-first web app that carries one importing company's purchasing chain from
*"which supplier quotation is actually cheapest once every landed cost is
counted?"* through to *"what is in the warehouse, what is promised to a
customer, and what is still on the water?"* — built around an audited,
deterministic landed-cost engine and an append-only inventory movement ledger,
with no backend and no cloud dependency.

**Status.** The calculation and comparison engine (Phases 0–5), the
Turkish/English i18n foundation (Phase 6) and the local persistence layer
(Phase 7 — a versioned IndexedDB database with migrations, transactions and
autosave, in `src/persistence/`) are implemented. Phase 6.5 expanded the
product scope to a local operational pilot — purchasing, inbound logistics,
inventory, reservations, outbound goods, backup and restore — and defined the
architecture for it; none of that behaviour is built yet, and there is no UI.

**Do not enter pilot data yet.** Backup, snapshots and restore are Phase 8, so
the working database currently has nothing behind it. See
[Product Scope](docs/PRODUCT_SCOPE.md) and the
[Implementation Plan](docs/IMPLEMENTATION_PLAN.md).

## Stack

- React + TypeScript
- Vite (build & dev server)
- Vitest + React Testing Library (tests)
- oxlint (linting)
- i18next + react-i18next (internationalization)

## Commands

```bash
npm run dev        # start local dev server
npm run test       # run test suite
npm run lint       # run oxlint
npm run typecheck  # run TypeScript project check (no emit)
npm run build      # production build (tsc -b && vite build)
npm run preview    # preview the production build locally
```

## Internationalization

Supported languages: Turkish (`tr`) and English (`en`).

- Resources and setup live in [`src/i18n/`](src/i18n/): `locale.ts` (supported-locale
  type, browser-language normalization, the `landedcompare.locale` preference),
  `index.ts` (i18next wiring, the `setLocale`/`getLocale` API), and
  `resources/en.ts` / `resources/tr.ts` (translation catalogs, typed against a
  shared shape so a key missing from one is a compile error).
- Initial language: a stored `landedcompare.locale` preference wins; otherwise
  the browser language is matched to `tr`/`en`; otherwise it falls back to
  English. An invalid or corrupted stored value is ignored, not thrown.
- The financial engine (`domain`, `calculation`, `comparison`) stays
  language-agnostic: it returns machine-readable codes only. `src/i18n/engineText.ts`
  is the one place those codes are mapped to translation keys.
- `src/i18n/format.ts` provides `Intl.NumberFormat`-based number/currency/percentage
  formatting. These are presentation only — they never round or feed back into a
  financial calculation; `Money`/`Decimal` results remain authoritative.

## Documentation

Each topic has exactly one canonical document.

- [Product Scope](docs/PRODUCT_SCOPE.md) — what the product is, the pilot
  operating model, MVP scope, out of scope, open product decisions
- [Data Model](docs/DATA_MODEL.md) — entities, relationships, lifecycles, the
  inventory ledger, invariants
- [Local Persistence & Backup](docs/LOCAL_PERSISTENCE_AND_BACKUP.md) —
  IndexedDB, schema versioning and migrations, autosave, snapshots, backup
  format, restore
- [Calculation Rules](docs/CALCULATION_RULES.md) — the financial rules of the
  landed-cost engine
- [Architecture](docs/ARCHITECTURE.md) — module boundaries and layering
- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) — phase-by-phase build order
- [Testing](docs/TESTING.md)
- [Roadmap](docs/ROADMAP.md) — post-MVP candidates
- [Deployment](docs/DEPLOYMENT.md)
- [Product Requirements](docs/PRODUCT_REQUIREMENTS.md) — superseded, kept as a
  pointer
