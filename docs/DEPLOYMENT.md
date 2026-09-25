# Deployment

## Current status

**Current deployment state (authoritative).** Local and hosted migration
histories match at **13/13**, with no pending or hosted-only migration;
`20260925120000_phase12_organization_administration.sql` is deployed. Phase 12
(organisation administration, portable backup, A-L6, A-L7, and its security
correction pass) remains uncommitted and under final review. The corrected,
invitation-based `admin-provision-user` is ACTIVE; `admin-reset-password` and
the legacy password-reset RPC surface are absent. The Site URL and exact
redirect allow-list are `https://landedcompare.vercel.app`, and custom SMTP is
enabled and operational.

Final verification completed with 92 unit-test files / 1,329 tests, 9 database
test files / 256 assertions, 17 behavioural-security files / 141 tests, and
18/18 hosted checks. Vercel production serves the verified current frontend.
Real OWNER onboarding, additional-user provisioning, portable backup and the
cross-device multi-user pilot smoke test succeeded. The final NO_MEMBERSHIP
sign-out, Customer Status list-order wording and result-count alignment were
manually accepted in production.

*The paragraphs below record each earlier deployment as it happened.*

Phase 10 is deployed to the linked hosted Supabase project: all seven foundation
migrations, the `api`-only exposure posture, disabled public signup, both Edge
Functions, the advisor WARN gate and the current eighteen anonymous hosted checks are
verified. The project contains no real pilot organisation, user or business
data.

Phase 11 connects the running client to that foundation. Products, suppliers,
customers and configurable customer statuses are canonical in PostgreSQL;
IndexedDB participates only in the explicit one-time legacy cutover. All three
Phase 11 migrations are deployed; at that deployment local and remote history
matched 11/11, the hosted advisor WARN gate was clean and anonymous HTTP
verification passed 18/18. The Audit A remediation migration was deployed
afterwards (12/12).

---

## Local development — the only place migrations are written

```bash
npm install                 # includes the Supabase CLI, pinned
npx supabase start          # needs Docker Desktop or a compatible runtime

npm run db:reset            # replays EVERY migration from empty, then seeds
npm run db:test             # pgTAP: the catalogue and behavioural suites
npm run test:security       # HTTP: routing, tenancy, provisioning
npx supabase functions serve   # only needed to exercise the Edge Functions by hand
```

`supabase start` refuses to finish if the `api` schema does not exist, because
PostgREST is configured to serve that schema and nothing else. A failed start
with `schema "api" does not exist` means the migrations have not been applied —
run `npm run db:reset`.

The local stack binds to `127.0.0.1` and is never exposed. Its keys are
identical on every machine, are published in Supabase's own documentation, and
open a throwaway database holding four synthetic users — they are not secrets,
and `supabase/seed.sql` contains no Akgün Medikal data of any kind.

**Docker is the primary path, not a convenience.** A developer who cannot run it
can link a remote project and push, but loses `db reset` and therefore loses the
ability to prove the migration chain from empty — which is the precondition the
hosted push depends on.

---

## Phase 11 catalogue deployment

Only run this sequence after `db reset`, `db:test`, `test:security`, the full
application suite, lint, typecheck and build all pass. Dumps must be written to
a durable user-owned directory outside the repository, never a temporary path.
Phase 11 changes no governed Supabase
configuration, so there is deliberately no `config push`.

```bash
npx supabase migration list --linked

# Keep the established three-file rollback dump set outside the repository;
# use the exact dump commands and semantics documented in "Backup semantics".

npx supabase db push --linked --dry-run
# Review that only these are pending for a fresh Phase 10 project:
#   20260923120000_catalog_cloud_migration.sql
#   20260923121000_customer_status_defaults.sql
#   20260923122000_catalog_import_invoker.sql
#   20260923130000_remove_customer_status_defaults.sql

npx supabase db push --linked
npx supabase migration list --linked
npm run db:advisors
npm run verify:hosted
```

These checks are intentionally anonymous and structural. They do not create the
first real user or organisation. Authenticated hosted catalogue verification
starts only after the operator uses the existing bootstrap path with a real
email address supplied by the user.

The actual Phase 11 pre-deployment `roles.sql`, `schema.sql` and `data.sql`
files are retained at
`~/Documents/LandedCompare_Backups/phase11-predeploy-2026-09-23/`. They were
copied byte-for-byte from the still-existing original temporary files after
deployment and their SHA-256 checksums were verified equal; they were not
recreated and relabelled after the fact.

---

## Initial hosted connection — historical operator sequence

Run these in **your own terminal**. Two of them involve credentials, and neither
should be typed anywhere except into the prompt that asks for it.

### Why the order is what it is

The exposed-schema list is a security control, and it is also the one setting
that can be pushed *before the thing it points at exists*. Locally, starting the
stack with `[api] schemas = ["api"]` against a database with no `api` schema
made PostgREST fail its health check and refuse to serve at all — the schema
cache cannot load a schema that is not there.

So **migrations go first, configuration second**. At the moment `api` becomes
the exposed schema it already exists, already holds the `security_invoker` views,
and already has its grants.

**There is a brief window between the two, and it is harmless on an empty
project.** Until `config push` lands, the hosted project still has its factory
defaults: exposed schemas `public, graphql_public`, and sign-up enabled. During
that window —

- **no LandedCompare business table is exposed, at any moment.** The canonical
  tables are created in `app_data`, which is not in the default list and is not
  in the final list either. `app_private` likewise. There is no ordering in
  which they are reachable.
- **`public` is exposed and empty.** It holds no LandedCompare object — pgTAP
  P16 asserts that over the catalogue — so exposing it publishes nothing.
- **`api` exists but is not yet routed.** The views are unreachable for a few
  seconds. No client is deployed, so nobody notices.
- **sign-up is still open.** Someone who knew the project ref and publishable
  key could create an account. That account would have no membership and
  therefore no access to any business row — RLS is enabled *and forced* the
  moment the migrations land — and there is no business data in the project
  regardless. The ref and key are not published anywhere at this point.

The window is seconds long, and it can be closed entirely: **optionally, turn
"Allow new users to sign up" off in the Dashboard before step 5.** That is a
configuration action, not a schema change, so it does not breach the rule that
the dashboard is never the schema's source of truth — and `config push` makes
the repository authoritative over it a moment later anyway.

### The sequence

```bash
# 1  Authorise the CLI. Opens a browser; no token is typed or pasted anywhere.
npx supabase login

# 2  Link this repository to the project. Choose it from the list, or pass
#    --project-ref. The database password is prompted for, locally.
npx supabase link

# 3  Confirm the server is PostgreSQL 15 or later. `security_invoker` views do
#    not exist before 15, and a view without that option returns every tenant's
#    rows. This goes through the Management API, so no connection string and no
#    password enters your shell history.
npx supabase db query --linked "SHOW server_version;"

#    Belt and braces: the first migration asserts server_version_num >= 150000
#    and aborts the whole chain if it is not met, so a skipped check fails
#    safely rather than silently.

# 4  The dump set — the rollback. See "Backup semantics" below for what each
#    file actually contains; the names are not self-explanatory and one of them
#    used to be labelled wrongly.
#
#    WRITE THESE OUTSIDE THE REPOSITORY — they are company data, not source.
#    Stay in the working tree so the CLI finds supabase/, and give -f an
#    absolute path that points somewhere else.
BACKUP_DIR=~/Documents/LandedCompare_Backups/predeploy-$(date +%Y-%m-%d)
mkdir -p "$BACKUP_DIR"

npx supabase db dump --linked -f "$BACKUP_DIR/roles.sql"  --role-only
npx supabase db dump --linked -f "$BACKUP_DIR/schema.sql"
npx supabase db dump --linked -f "$BACKUP_DIR/data.sql"   --data-only --use-copy

# 5  Dry run, then push. The dry run prints the migrations that WOULD be
#    applied and applies none of them.
npx supabase db push --linked --dry-run
npx supabase db push --linked

# 6  Push the configuration. THIS is what sets the exposed-schema list to `api`
#    alone and disables sign-up on the hosted project; `db push` does not touch
#    either of them.
#
#    Review the diff first, and read the `declared` flag on every entry — see
#    "What config push actually writes" below. Exactly two entries must say
#    declared: true.
npx supabase config diff
npx supabase config push

# 7  Deploy the Edge Function. There is NO secret to set — see
#    "Secret handling" below.
npx supabase functions deploy admin-provision-user
#
#    Phase 12 deployment ONLY: remove the function Phase 12 retired. Until the
#    Phase 12 migration is applied it can still reset a colleague's global
#    password; after it, it fails at its first RPC and changes nothing, and
#    this removes it outright. Apply the migration (step 5) BEFORE this step.
npx supabase functions delete admin-reset-password
```

### Verify, rather than assume

```bash
# 8  Migration history: local and remote must agree.
npx supabase migration list --linked

# 9  Repository gate over Supabase's hosted security-advisor output.
npm run db:advisors        # strict policy, including one documented exception
npm run db:advisors:raw    # uninterpreted advisor output for visibility

# 10 The configuration, asked of the server over real HTTP.
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
npm run verify:hosted
```

Step 10 is the one that matters, and it exists because steps 6 and 8 can both
succeed while the Data API serves something else. PostgREST reads its
exposed-schema list from `pgrst.db_schemas` on the `authenticator` role — a
value a dashboard edit changes out from under the repository — so the list is
**asked of the server** rather than read back from the file that was pushed.

`scripts/verify-hosted.mjs` makes eighteen unauthenticated requests and creates
nothing: it confirms that `app_data`, `app_private` and `public` all answer
`PGRST106` with the allow-list quoted back, that `anon` is refused at the schema
before any object is consulted, that all four Phase 11 catalogue views exist but
are unreadable to anon, that the private helper and provisioning RPCs have no
reachable route, that crafted canonical catalogue `POST` and `PATCH` requests
are refused, that sign-up is closed, and that the password grant still works.

Two details of that script are deliberate. It **refuses to run if handed a
secret key**, because `service_role` bypasses the posture the checks exist to
confirm and every one of them would pass while proving nothing. And its sign-up
probe sends a one-character password: GoTrue evaluates `DISABLE_SIGNUP` before
it validates password strength, so a correctly configured project still answers
`signup_disabled`, and a misconfigured one rejects the password before writing a
row. An earlier version used a valid password and created a real account when
run against a deliberately broken configuration, which is how this was found.

### What `config push` actually writes

**It writes every property this repository declares, and leaves the rest
alone.** That is the CLI's own contract:

> Pushes the properties your local config.toml declares to the linked project.
> Properties the file does not declare are left unchanged.

Which makes `supabase/config.toml`'s **silence** as meaningful as its contents,
and makes the file as generated by `supabase init` actively dangerous. Run
against this project for the first time, `config diff` reported **fifteen
declared differences**, of which thirteen were accidents of the template:

| Would have been overwritten | Local value | Hosted value |
| --- | --- | --- |
| `auth.site_url` | `http://127.0.0.1:3000` | `http://localhost:3000` |
| `auth.additional_redirect_urls` | `["https://127.0.0.1:3000"]` | `[]` |
| `auth.email.enable_confirmations` | `false` | `true` |
| `auth.email.max_frequency` | `1s` | `1m0s` |
| `auth.email.otp_length` | `6` | `8` |
| `auth.minimum_password_length` | `8` | `6` |
| `auth.password_requirements` | `""` | unset |
| `auth.mfa.totp.enroll_enabled` / `verify_enabled` | `false` | `true` |
| `auth.sms.twilio.enabled` | `false` | `true` |
| `db.pooler.default_pool_size` | `20` | `15` |
| `db.pooler.max_client_conn` | `100` | `200` |
| `storage.analytics.enabled` | `false` | `true` |

Pushing that would have pointed a production authentication service at a
developer's laptop, halved the connection pool, and switched off MFA — none of
which Phase 10 asks for, and none of which anyone would have connected to "I
deployed the exposed-schema setting" a week later.

So the file was stripped to what this product actually governs. `config.toml`'s
own header records the rule and the verified list of local-only keys.

**Reading a diff before a push.** `config diff` reports a `declared` flag on
every entry. Entries with `declared: false` are the CLI showing you where its
local defaults differ from your project — informational, and **not** pending
writes. Only `declared: true` entries are written:

```bash
npx supabase config diff            # human-readable
npx supabase config diff --exit-code   # exit 2 if any difference exists, for CI
```

The current state of this repository produces exactly two declared differences,
and they are the two Phase 10 requires:

```
DECLARED  update  api.schemas         ["api"] -> ["public","graphql_public"]
DECLARED  update  auth.enable_signup  false   -> true
```

`config push` prompts per changed resource in a terminal, showing the exact
diff. **Expect exactly two prompts. If a third appears, abort.** A
non-interactive run (no TTY, `--yes`, or piped stdin) defaults to proceeding,
which is why it must not be scripted.

### When local and hosted must genuinely differ

`[remotes.<name>]` override blocks, confirmed working on the pinned CLI:

```toml
[remotes.pilot]
project_id = "<project-ref>"

[remotes.pilot.auth]
site_url = "https://the-real-origin.example"
```

`config diff` then reports `Comparing against project … using [remotes.pilot]`
and the override replaces the base value for that project.

Phase 10 does not need one: the three properties it governs — the exposed-schema
list, public sign-up, and the e-mail provider — have the same correct value in
both places. The first real case will be `auth.site_url` when a web client is
deployed and the hosted origin stops being `localhost`.

**An override is applied on top of the base, not instead of it.** A base
declaration still reaches the hosted project unless the remote block overrides
that exact property, so stripping the base remains the load-bearing step and a
remote block is not a substitute for it.

### One deliberately deferred decision

`auth.minimum_password_length` was declared as `8` locally; the hosted project
has Supabase's default of `6`. That declaration was **removed rather than
pushed**, because no part of the canonical Phase 10 architecture specifies a
value and "the local file happened to say 8" is not a reason to reconfigure a
production auth service.

It is recorded here rather than silently dropped: **raising the hosted minimum
is a reasonable change, and it should be made as its own reviewed decision.**
Since Phase 12 every password is the person's own choice (accounts are
invited, never given a generated password), so the minimum governs every
password in the system. That makes this decision more relevant, not less; it
should still be somebody's explicit call rather than a side effect of a
deployment.

### Secret handling

**There is no project secret to set, and that is a correction.** The first
Phase 10 runbook required
`supabase secrets set LANDEDCOMPARE_SECRET_KEY=sb_secret_…` before the Edge
Functions would work. Measured against the pinned CLI's runtime, that variable
duplicated a credential the platform already injects into every invocation:

| Injected variable | What it is |
| --- | --- |
| `SUPABASE_SECRET_KEYS` | the current server credential, as a JSON envelope keyed by name — `{"default":"sb_secret_…"}` |
| `SUPABASE_SERVICE_ROLE_KEY` | the legacy key, still injected; Supabase is retiring the legacy pair by the end of 2026 |
| `SUPABASE_URL` | the project URL |

A duplicated secret is not a neutral extra step. It is a second copy of the most
dangerous credential in the system, created and carried by a human, which
diverges from the real one the first time the project's keys are rotated and
nobody remembers the copy exists. It was removed.

`supabase/functions/_shared/secretKey.ts` resolves the credential, prefers the
current key over the deprecated one, tolerates the envelope changing shape —
it is **plural** because Supabase supports several active keys during a rotation
— and fails closed with a named reason rather than returning an empty string
that would surface later as an unexplained 401. It takes a plain environment
record and touches no Deno global, which is what lets
`src/cloud/serverSecretKey.test.ts` unit-test every shape with no runtime and no
real credential.

What belongs in Edge Function secrets, if it is ever added: credentials for a
third-party service used directly by a future function. The operational SMTP
credentials belong to hosted Auth configuration; they are not copied into an
Edge Function secret. Nothing else.

### Backup semantics — what each dump command actually contains

The names are not self-explanatory, and the earlier version of this document
labelled one of these files as something it is not. Every row below was produced
by running the command against the local database and reading the result.

| Command | Contains | Does NOT contain |
| --- | --- | --- |
| `db dump --role-only` | cluster roles | role passwords — a restored custom login role needs its password set again |
| `db dump` (no flags) | `pg_dump --schema-only`, excluding the Supabase-managed schemas: the LandedCompare tables, views, functions, policies and grants | **any data**; **anything in `auth`** |
| `db dump --data-only --use-copy` | `pg_dump --data-only --schema '*'`. The business data **and `auth.users`** — `auth` is absent from the exclude list. Only the three `*_migrations` tables are skipped | schema definitions |
| `db dump --schema auth` | `pg_dump --schema-only --schema=auth`: **the table definitions of the `auth` schema and zero user rows** | **the users.** A file from this command filed as "the Auth backup" is an empty promise |
| `db dump --data-only --schema auth --use-copy` | the `auth` rows alone — a targeted subset of what the plain data dump already holds | everything else |

Two consequences worth stating plainly, because the earlier text had them
backwards:

1. **The users are already in `data.sql`.** The ordinary data dump carries
   `COPY "auth"."users"`.
2. **The command that names `auth` in its flags is the one that does not contain
   them**, unless `--data-only` is given as well.

**For the first deployment, three files is the proportionate set** — roles,
schema, data — and on a project this new they are nearly empty. They are taken
anyway because the habit is what is being established, and the day it matters is
not the day to start. The separate `authdata.sql` becomes worth taking once
there are accounts worth isolating from a large business dump.

The schema's authority is the migration files in this repository, never
`schema.sql`; that file exists to be *compared* against them to catch drift. And
whether Auth accounts survive being restored into a *fresh* project is still not
promised — capturing them is solved, restoring them into a managed service has
never been rehearsed here, and the Phase 21 drill is what turns that into a fact.
See [Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §16-B.

### Creating the first organisation

There is deliberately no self-service path to an OWNER: `admin-provision-user`
requires the caller to already be an ACTIVE OWNER or ADMIN, and a "first user
becomes OWNER" rule would be self-registration wearing a different name on a
project where sign-up is disabled precisely to prevent one.

So the first organisation is created once, by the operator, from a superuser
connection:

```sql
-- After creating the owner's auth account in the dashboard's Authentication
-- section (an account, not a table row — the schema is never edited there).
select app_private.bootstrap_organization(
  'Akgün Medikal',
  '<the new auth user id>',
  'Ad Soyad'
);
```

`bootstrap_organization` is a function in a migration rather than five rows
typed into the Table Editor, because what it does — normalise, verify the auth
user exists, create the organisation, the profile, the membership and the admin
event — is five statements that must agree, and five statements typed by hand at
midnight are four statements and a mistake. `EXECUTE` is revoked from every Data
API role including `service_role`; it is reachable only from a superuser
connection.

### Phase 12 hosted preconditions — completed

Phase 12 onboards a new person by an Auth **invitation e-mail** — no
administrator ever holds a password. The controlled hosted preflight and
deployment are complete:

1. Custom SMTP is configured and was positively verified through real OWNER
   and additional-user invitation/onboarding flows.
2. `auth.site_url` is `https://landedcompare.vercel.app`.
3. The redirect allow-list contains the exact production origin
   `https://landedcompare.vercel.app`.
4. The corrected `admin-provision-user` is deployed and uses the Auth
   invitation flow; its deployed source was verified against the local source.
5. `admin-reset-password` and the legacy password-reset RPCs are absent.
6. Local and hosted migration history is 13/13 with no pending migration, and
   the anonymous hosted verifier passes 18/18 checks.

**Security-advisor accepted pilot residual.** The raw advisor reports
`auth_leaked_password_protection`: leaked-password protection is unavailable on
the Supabase Free plan. The warning remains visible and is the gate's only
accepted WARN. Public signup remains disabled, invitation-based onboarding is
enforced, and existing password/auth controls are unchanged. When the project
moves to a plan that supports leaked-password protection, enable it and remove
this exception.

**Invitation links on a shared device — accepted residual.** With a session
already on the device, every invitation or recovery link asks before replacing
it; if the session cannot be read, the link is held, not used. On a device
where nobody is signed in, a forwarded link is adopted automatically and the
password screen names the verified account with a "not my account — sign out"
action. That anonymous-device residual is accepted as LOW for the pilot and
is not eliminated ([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md)
§31.9).

### Orphaned Auth identities (A-L6) — an operator procedure

Removing someone from the company is an OWNER/ADMIN action in the application
(`DISABLED`), and it never deletes the person's Auth account: the account is
global and may belong to another organisation
([Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §31.2).
Deleting an Auth identity is reserved for the operator, and only for a true
orphan — an account with no membership anywhere. Provisioning never deletes an
identity: when the invitation succeeds and the link step then fails, the Auth
identity is RETAINED on purpose (attempt `FAILED`, reason `LINK_FAILED`),
because another organisation may already have linked it. A retained identity
is normally converged by inviting the same address again (a new request
re-invites it and links it); only one that is truly orphaned — no membership
of any status, no in-flight attempt — is a candidate for the purge below.

From a superuser connection (the SQL editor of the hosted project, or `psql`
against the local stack):

```sql
-- 1  Report. Read-only. Lists every identity with no ACTIVE membership.
select * from app_private.orphaned_auth_identities();

-- 2  Purge ONE identity the report marks eligible_for_purge = true.
--    Refused for an identity with a membership of any status, or one an
--    in-flight provisioning attempt is about to link. A provisioning whose
--    link step fails KEEPS the identity it invited (attempt FAILED, reason
--    LINK_FAILED); if nobody re-invites the address, these are the usual
--    orphans.
select app_private.purge_orphaned_auth_identity('<user id>');
```

An identity with only `DISABLED` memberships is not an orphan: it is a person
whose access was withdrawn, and the membership row is the record of that. Leave
it. Neither function is reachable over the Data API by any role, including the
secret key.

### A forgotten password — an operator procedure

No company administrator can reset a password: an account is global, and the
person may belong to more than one company (Phase 12). Nobody — not an
administrator and not the operator — sets or learns the new password; the person
chooses it:

1. Confirm the request with the person directly, by a channel you already trust.
2. Raise the onboarding flag, so the application asks them to choose a password
   when the recovery link signs them in:

```sql
update app_data.profiles set must_change_password = true where user_id = '<user id>';
```

3. In the Supabase dashboard, Authentication → Users → the person → **Send
   password recovery**. The e-mail goes to the person's own address through the
   configured SMTP provider; its link lands on the application, which accepts a
   `recovery` link exactly like an invitation and asks for a new password.

The pilot is active with the real OWNER and an additional user. Do not create
further production users or enter, import or alter production business data
without explicit authorisation.

---

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
  → supabase db push         (the hosted project: schema, first)
  → supabase config push     (the hosted project: exposed schemas + auth, second)
  → npm run verify:hosted    (ask the server what it is actually serving)
```

**`db push` and `config push` are two different deployments and both are
required.** `db push` applies migrations; it does not touch the exposed-schema
list or the sign-up switch. Migrations go first because PostgREST cannot serve a
schema that does not exist yet — the operator sequence above explains the order
and why the gap between them is harmless on an empty project.

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
and **excludes the Supabase-managed schemas**, so one invocation backs up no data
at all:

```bash
npx supabase db dump --linked -f roles.sql  --role-only
npx supabase db dump --linked -f schema.sql
npx supabase db dump --linked -f data.sql   --data-only --use-copy
```

**Write them outside this repository.** `data.sql` already contains
`auth.users`, and from Phase 11 it will contain the company's product,
supplier and customer records — that is company data and a backup artefact, not
source code, and it does not belong in version control under any circumstances.
`.gitignore` carries a rule for `supabase/dumps` as a safety net against writing
one here by accident, but a gitignored file is one `git add -f` or one tooling
change away from being committed permanently, and a secret or a customer list
committed once is committed in every clone forever. Use a directory outside the
working tree, such as
`~/Documents/LandedCompare_Backups/<phase>-predeploy-<date>/`. Do not use
`/tmp`, `/private/tmp` or another automatically cleaned temporary location; move the artefacts
off the machine (§16-B).

Three commands, not four: the data dump already carries `auth.users`, so the
separate `--schema auth` file the earlier version of this document prescribed was
both redundant *and* mislabelled — without `--data-only` it contains no users at
all. "Backup semantics" above has the measured breakdown of every variant.

The Free plan provides no automatic backups, so this set is the only rollback.
The schema's authority is the migration files in this repository, not
`schema.sql`, and Auth *recovery* is not promised until the Phase 21 drill has
demonstrated it — see
[Cloud & Multi-User Architecture](CLOUD_MULTIUSER_ARCHITECTURE.md) §16-B.

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
