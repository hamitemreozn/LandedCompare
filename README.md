# LandedCompare

App that carries one importing company's purchasing chain from *"which supplier
quotation is actually cheapest once every landed cost is counted?"* through to
*"what is in the warehouse, what is promised to a customer, and what is still on
the water?"* — built around an audited, deterministic landed-cost engine and an
append-only inventory movement ledger, shared by the handful of people in one
company who need to see the same numbers.

**Status.** Phase 11 is implemented in the working tree. The running client now
boots through Supabase Auth, resolves live organisation membership, and reads
and mutates products, suppliers, customers and configurable customer statuses
through `DataGateway`. PostgreSQL is the sole authoritative catalogue after the
one-time cutover; IndexedDB is opened only to validate, back up and import a
legacy Phase 9 catalogue, then it is deleted. There is no offline business-data
fallback or write queue.

The four Phase 11 migrations are also deployed to the linked hosted project;
local and remote history match 11/11, the hosted advisor WARN gate is clean and
the anonymous HTTP posture verification passes 18/18. No real pilot account,
organisation or business data has been created.

The calculation and comparison engine (Phases 0–5), the
Turkish/English i18n foundation (Phase 6), the local persistence layer (Phase 7
— a versioned IndexedDB database with migrations, transactions and autosave, in
`src/persistence/`), the recovery layer (Phase 8 — snapshots, portable backup
files and validated restore, in `src/backup/`) and the first product UI
(Phase 9 — application startup, the shell, and the product, supplier and
customer masters) are implemented.

Historically, Phase 9 was the point at which the local application started: a boot sequence took the
`PRE_MIGRATION` snapshot before any schema upgrade, opens the database, runs
snapshot maintenance, reads external-backup freshness, and only then renders —
and refuses to render business data at all if any of that fails. Phase 6.5
expanded the product scope to an operational pilot (purchasing, inbound
logistics, inventory, reservations, outbound goods); those modules appear in the
navigation as explicitly unavailable and are **not built yet.**

### Cloud architecture and the Phase 11 cutover

Everything in the Phase 7–9 history ran on **one computer**, with no server and no accounts. That
is no longer the architecture. Phase 9.5 — an architecture checkpoint with no
production code — decided that **PostgreSQL, hosted by Supabase, becomes the
single source of truth for shared company data**, because the product's central
invariant (a reservation may not push available stock below zero) is a statement
about the whole company that two disconnected databases can each satisfy while
jointly violating.

From Phase 10 the application is multi-user: one organisation, email-and-password
accounts created by an administrator, three roles, row-level security scoping
every row to its company, and multi-row business operations as server-side
transactions. It runs at **$0/month** on the Supabase free plan. Offline editing
of shared records is explicitly rejected, not deferred — internet access is
required to read or change business data, which is a recorded product
limitation.

The canonical design is
**[Cloud & Multi-User Architecture](docs/CLOUD_MULTIUSER_ARCHITECTURE.md)**.

**Phase 10 built the foundation and Phase 11 activates it**: the
three-schema separation in which `api` is the only schema the Data API serves,
the identity and tenancy tables, row-level security enabled *and forced*
everywhere, the idempotent user-provisioning workflow, and 191 security
assertions across pgTAP and real HTTP requests. Phase 11 adds four canonical
catalogue tables, four read projections, twelve typed mutation RPCs and the
idempotent OWNER-only legacy import. Feature services no longer accept a local
`Database`; they accept the cloud gateway and selected organisation.

### Recovery history — local Phase 9

The local design had three layers, and the difference between them was deliberate.
**IndexedDB** held the working data. **Internal snapshots** were undo at the
database level — fast, automatic, and *lost with the disk, the browser profile
or the origin*. **External backup files** are the only disaster recovery: a
single checksummed JSON document that has left the machine. A restore is
replace-all, validated in full before anything is written, preceded by a
committed pre-restore snapshot, applied in one atomic transaction, and verified
by reading the database back.

The checksum detects corruption. It is not tamper-proofing — there is no
secret, so anyone who edits a backup can recompute it. And an exported file is
*exported*, not proven to be on disk: a browser never tells a page where a
download went.

See [Local Persistence & Backup](docs/LOCAL_PERSISTENCE_AND_BACKUP.md) for the
format, the retention policy and the restore flow — and
[Cloud & Multi-User Architecture](docs/CLOUD_MULTIUSER_ARCHITECTURE.md) §16 for
what replaced this once the data moved to the server, where the portable export
survives and the snapshot layer does not.

### Starting up now

`src/app/useApplicationBoot.ts` constructs the configured cloud gateway, checks
the session, proves server reachability, reads the profile and live membership,
and deterministically selects the pilot organisation. Only then does it inspect
for a legacy local catalogue. A non-empty legacy catalogue stops at an explicit
OWNER migration screen; a complete checksummed file is delivered before the
single server import transaction, cloud counts are read back, and only then is
the local database retired. Signed-out, unavailable, no-membership and
write-locked states never masquerade as an empty catalogue.

## Stack

- React + TypeScript
- Vite (build & dev server)
- Vitest + React Testing Library (tests)
- oxlint (linting)
- i18next + react-i18next (internationalization)
- Supabase — PostgreSQL, Auth, PostgREST, Edge Functions (cloud foundation)
- pgTAP (database security assertions), Supabase CLI pinned as a dev dependency

## Commands

```bash
npm run dev        # start local dev server
npm run test       # run test suite  (no Docker needed)
npm run lint       # run oxlint
npm run typecheck  # run TypeScript project check (no emit)
npm run build      # production build, and refuse it if a secret key is in the bundle
npm run preview    # preview the production build locally
```

Database and cloud security — these need a running Docker-compatible runtime,
and everything above keeps working without one:

```bash
npx supabase start    # bring up the local stack
npm run db:reset      # replay every migration from empty, then seed
npm run db:test       # pgTAP catalogue and behavioural assertions
npm run db:lint       # database lint
npm run test:security # HTTP: routing, tenancy, membership, provisioning
```

Against a deployed project (no Docker needed, creates nothing):

```bash
npm run db:advisors   # Supabase security advisor against the linked project
SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… npm run verify:hosted
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
- `src/i18n/format.ts` provides `Intl`-based number/currency/percentage and
  instant formatting. These are presentation only — they never round or feed
  back into a financial calculation; `Money`/`Decimal` results remain
  authoritative, and a stored instant remains UTC with milliseconds.
- `src/i18n/persistenceText.ts` does for the persistence, backup and startup
  layers what `engineText.ts` does for the engine: it is the one place their
  machine-readable codes become translation keys. A `DOMException`'s
  browser-dependent message text never reaches a screen.
- `document.documentElement.lang` follows the selected locale. This is not
  cosmetic: CSS `text-transform: uppercase` is language-sensitive, so a Turkish
  heading rendered under `lang="en"` loses the dotted capital `İ`.

## Documentation

Each topic has exactly one canonical document.

- [Product Scope](docs/PRODUCT_SCOPE.md) — what the product is, the pilot
  operating model, MVP scope, out of scope, open product decisions
- [Data Model](docs/DATA_MODEL.md) — entities, relationships, lifecycles, the
  inventory ledger, invariants
- [Cloud & Multi-User Architecture](docs/CLOUD_MULTIUSER_ARCHITECTURE.md) —
  tenancy, authentication, row-level security, the client/server boundary,
  concurrency, cloud backup, the threat model
- [Local Persistence & Backup](docs/LOCAL_PERSISTENCE_AND_BACKUP.md) — the
  local pilot's IndexedDB, schema versioning and migrations, autosave,
  snapshots, backup format, restore. **Superseded for shared business data** by
  the document above; the backup format and its untrusted-input rules are kept
- [Calculation Rules](docs/CALCULATION_RULES.md) — the financial rules of the
  landed-cost engine
- [Architecture](docs/ARCHITECTURE.md) — module boundaries and layering
- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) — phase-by-phase build order
- [Testing](docs/TESTING.md)
- [Roadmap](docs/ROADMAP.md) — post-MVP candidates
- [Deployment](docs/DEPLOYMENT.md)
- [Product Requirements](docs/PRODUCT_REQUIREMENTS.md) — superseded, kept as a
  pointer
