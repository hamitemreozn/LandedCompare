# Deployment

## Current status — nothing is deployed yet

Phases 0–9 run from a local development server on one machine, and there is
nothing to deploy because there is nothing shared to deploy *to*.

**Phase 9.5 changed the target.** From Phase 10 the application has a backend:
PostgreSQL hosted by Supabase, which is the single source of truth for shared
company data. The canonical design is
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md); this document
covers only what gets deployed, where, and by whom.

## What gets deployed, from Phase 10

Two things, and they are deployed by different mechanisms.

### 1. The database — migrations, not click-ops

```text
repo/supabase/migrations/*.sql
  → supabase db reset        (local, Docker — proves the chain from empty)
  → npm test  +  supabase test db
  → THE DUMP SET             (the hosted project, BEFORE the push — the rollback)
  → supabase db push         (the hosted project)
```

**Migrations are the canonical schema history.** Nothing is changed through the
Supabase dashboard; if it ever is, `supabase db diff` captures it into a
migration immediately or it does not exist. This is the entire server-side
deployment surface — there is no application server to restart, because the
server-side logic is database functions and policies that ship with the
migrations.

**One setting deployed alongside them is a security control, not a preference.**
`config.toml` declares `[api] schemas = ["api"]`, so the Data API serves only the
`api` schema — the canonical tables in `app_data` and the helpers in
`app_private` have no route. The hosted project's "Exposed schemas" must match,
and it is a dashboard value that can drift from the repository, so **the CI suite
asserts it over HTTP** rather than trusting it: a request for a canonical table
must 404. See
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §7 and §20.

**The dump set before every push is not optional, and it is a set rather than a
command.** `supabase db dump` with default flags produces a **schema-only** dump
and **excludes the Supabase-managed schemas**, `auth` among them — so one
invocation backs up neither the data nor the users:

```bash
supabase db dump --db-url "$URL" -f roles.sql  --role-only
supabase db dump --db-url "$URL" -f schema.sql
supabase db dump --db-url "$URL" -f data.sql   --data-only --use-copy
supabase db dump --db-url "$URL" -f auth.sql   --schema auth     # see §16-B
```

The Free plan provides no automatic backups, so this set is the only rollback.
What each artefact does and does not recover — and the honest position on whether
Auth accounts survive a rebuild — is in
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §16-B. The
short version: the schema's authority is the migration files in this repository,
not `schema.sql`, and Auth recovery is not promised until the Phase 21 drill has
demonstrated it.

### 2. The client — Tauri desktop builds

```text
npm run build            (one Vite production build)
  → Tauri package (Windows)
  → Tauri package (macOS)
```

Both platforms are built from the same assets; the platform layer is file-save
and window chrome only. The build embeds the Supabase project URL and the
**publishable** key, both of which are designed to be public
([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §19), and a
build-time check fails the build if a secret key ever reaches the bundle.

Distribution during the pilot is a file handed to three people. There is no
update server, no code signing pipeline and no store listing — all
**OPTIONAL FUTURE**, and none of them blocks the pilot.

## Environments

Two, and [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §20
explains why that is enough:

| Environment | What it is |
| --- | --- |
| **local** | Supabase CLI stack in Docker — ephemeral, reset freely, where migrations are proven |
| **hosted pilot** | one Supabase Free project — production, for the pilot |

No hosted staging. The rehearsal happens locally against the same migration
chain, from empty, which is a stronger test than a long-lived staging database
that has drifted.

## Cost

**$0/month.** One Supabase Free project, no domain, no paid hosting, no email
provider, no paid plan. Marked **OPTIONAL FUTURE**, none required: Supabase Pro
(removes inactivity pausing, adds automatic backups and point-in-time recovery), a
custom domain, and a static host for a web client.

## What has to be true on each machine

- **The desktop client needs internet access.** Business data cannot be read or
  written offline — a recorded product limitation
  ([Product Scope](PRODUCT_SCOPE.md), Open Decision 16), not a gap.
- **Someone has to resume a paused project.** A Free-plan project pauses after
  about a week of inactivity. The application reports this honestly and tells
  administrators — and only administrators — what to do about it.
- **Someone has to run the weekly dump set** — four commands, not one — and store
  the artefacts off the machine. That is the infrastructure backup; the in-app
  organisation export is a different thing and does not replace it, in either
  direction.

## Historical — the local pilot

Through Phase 9, the plan was a build served from a stable local origin on one
company computer, with all data in that machine's IndexedDB and no server, DNS or
HTTPS involved. Two constraints applied and are worth keeping on record because
they explain a class of support question: IndexedDB is scoped per browser origin,
so a changing localhost port or a different hostname makes an existing database
invisible; and clearing browser data destroys the working database and every
internal snapshot in one action.

After Phase 11 neither constraint applies to business data, because business data
is no longer on the device. The origin still matters for one thing — the stored
session — and losing it means signing in again, not losing data.
