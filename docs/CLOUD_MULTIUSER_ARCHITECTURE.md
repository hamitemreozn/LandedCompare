# Cloud & Multi-User Architecture

**Canonical source** for tenancy, authentication, authorisation, the
client/server boundary, concurrency, cloud backup, and the platform this
application runs on once more than one person uses it.

- What the data *is* → [Data Model](DATA_MODEL.md)
- What the product is and is not → [Product Scope](PRODUCT_SCOPE.md)
- Module boundaries and layering → [Architecture](ARCHITECTURE.md)
- Build order → [Implementation Plan](IMPLEMENTATION_PLAN.md)
- Financial rules → [Calculation Rules](CALCULATION_RULES.md)
- The **local pilot** storage architecture this supersedes for shared business
  data → [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md)

**Status: designed in Phase 9.5; the foundation is implemented in Phase 10.**
This document was written before any of it existed, for the same reason Phase
6.5 was: the modules that would be most expensive to retrofit — inventory,
reservations, receipts — had not been built yet, and that was the last cheap
moment to decide where the truth lives.

What is now real, and what is still design, is recorded in §28 rather than
scattered through the sections. Nothing in the design was changed to match what
was convenient to build; the three places where implementation proved a snippet
here *wrong* are corrected in place and listed in §28, because an architecture
document that is wrong about a mechanism is wrong in whichever direction the
mechanism happens to point.

---

## 1. Why this document exists

The pilot architecture answered one question: *how does a single computer with no
server keep a company's operational data safe?* The answer — IndexedDB, internal
snapshots, external backup files — is sound, implemented, and audited.

It answers a question the company no longer has. The real requirement is now:

- the owner uses LandedCompare from more than one computer;
- office personnel work on the same company data;
- several people see the same products, suppliers, quotes, purchases, shipments
  and stock;
- Windows and macOS desktop clients, and possibly a web client, run the same
  application.

**Independent browser-local databases cannot be the authoritative truth for any
of that.** Not because synchronising them is hard, but because the central
invariant of this product is not mergeable.

### The argument, in one paragraph

Data Model I4 says a reservation may not push available stock below zero.
That is a *global* constraint: it is a statement about the sum of every
reservation and every movement in the company, not about any one record. Two
disconnected devices can each satisfy it locally and violate it jointly — user A
reserves the last 10 units in Istanbul while user B reserves the same 10 in the
warehouse, both succeed, both tell a customer yes, and no merge algorithm
invented afterwards can make both right. It can only pick a loser after the
promise was made. The same shape recurs everywhere the product is valuable:
allocating `PO-2026-0007` twice, dispatching stock that is already gone, two
edits to the same purchase order. There is no correct generic merge, which is
exactly the reasoning [Product Scope](PRODUCT_SCOPE.md) Open Decision 10 already
used to refuse merge-mode restore on a *single* machine.

So the decision is not "cloud because cloud". It is that a **single serialisation
point** is a functional requirement of the inventory model, and a database
transaction is the only mechanism that provides one.

---

## 2. The authority model

> **PostgreSQL, hosted by Supabase, is the single source of truth for all shared
> company business data. There is no second authoritative copy anywhere, in any
> device, at any time.**

That sentence is the whole architecture. Everything below is its consequences.

```text
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ owner's Mac  │   │  office PC   │   │ warehouse PC │
   │ Tauri / web  │   │ Tauri / web  │   │ Tauri / web  │
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │ HTTPS            │                  │
          └──────────────────┼──────────────────┘
                             ▼
              ┌────────────────────────────────┐
              │  Supabase (hosted, Free plan)  │
              │  ├ Auth        (identity)      │
              │  ├ PostgREST   (data API)      │
              │  ├ Edge Fn     (privileged ops)│
              │  └ PostgreSQL  ◄── THE TRUTH   │
              │      RLS · constraints · RPC   │
              └────────────────────────────────┘
```

What each client holds:

| Client-side state | Authoritative? | Lifetime |
| --- | --- | --- |
| React component state (an open form) | no | until the screen closes |
| the result of the last read | no | until the next read |
| the auth session (access + refresh token) | n/a — it is a credential | until sign-out or expiry |
| device preferences (locale, sort, last route) | yes, *for the device* | `localStorage` |
| **business records** | **no — never again** | not stored |

The rule that follows, and it is not negotiable: **a client may never present
data it cannot currently confirm as a current business fact, and may never report
a write as succeeded that the server did not commit.**

### What was rejected, explicitly

**Dual-master / offline-editable-and-merge-later.** Rejected for the MVP and for
the foreseeable product. See §14 for the full reasoning and the resulting product
limitation.

**Local-first with a sync engine (CRDT / operational transform).** Rejected on
the same grounds as dual-master, plus one more: a CRDT makes *convergence*
guaranteed and *correctness* undecidable. Two converged replicas that agree stock
is −40 have converged. Nothing in the medical-device import business is improved
by that.

**IndexedDB as an offline write queue.** Rejected. A queue that can fail to apply
is a promise the UI already made. See §13 and §14.

---

## 3. Supabase: which services, and why each

| Service | Used | Role |
| --- | --- | --- |
| **PostgreSQL** | yes | the authoritative database: tables, constraints, RLS, `SECURITY DEFINER` functions, transactions |
| **Auth (GoTrue)** | yes | identity only — email + password. Not authorisation; see §5 |
| **PostgREST (Data API)** | yes | direct reads and single-row writes under RLS, plus `rpc/` for transactional operations |
| **Edge Functions** | yes, sparingly | exactly two jobs that need the secret key: provisioning a user account, and orchestrating a restore |
| **Realtime** | **no** (MVP) | see §23 — a product decision, not a cost one |
| **Storage** | **no** (MVP) | no attachments, photos or documents are in scope |
| **Vector / Queues / Cron** | no | not in scope |

Deliberately **not** built: a Node/Express API server. Every operation this
product performs is either a single-row CRUD under a row-level policy or a
multi-row transaction — and PostgreSQL already executes transactions. A stateless
HTTP tier in front of it would add a deployment target, a second place to get
authorisation wrong, and a hosting bill, to re-implement what `BEGIN … COMMIT`
does. See §7 for the classification that makes this safe rather than merely
cheap.

### Platform constraints, verified against current documentation

Checked September 2026. These are the facts the design must survive, not
assumptions.

| Free plan fact | Consequence for this design |
| --- | --- |
| **Projects pause after ~1 week of inactivity** | the app must have an honest unavailable state (§17); no synthetic keep-alive traffic |
| **Paused projects are restorable for 90 days**, after which only a downloadable logical backup remains | the pilot must not be left idle for months; independent portable backups are mandatory (§16) |
| **No automatic database backups on Free** | infrastructure backup is an explicit operator procedure, not a platform feature (§16-B) |
| 500 MB database, 5 GB egress, 1 GB storage | far beyond pilot volume; a year of orders and movements is single-digit MB |
| 50,000 MAU | irrelevant at 2–5 users |
| 500,000 Edge Function invocations, 25 functions | irrelevant — two functions, invoked a handful of times per week |
| 2 active projects | one for the hosted pilot; the second is *not* spent on staging (§20) |
| **Built-in auth email: 2 messages/hour, and only to pre-authorised Supabase team members** | **decisive** — email-based invitations and self-service password reset do not work at $0. See §4 |
| No custom domains, no PITR, no branching, no SSO | none are required; all marked OPTIONAL FUTURE |
| Log retention 1 day | audit must live in the database, not in platform logs (§21) |

Nothing in this architecture requires a paid plan. Where a paid capability would
help, it is marked **OPTIONAL FUTURE** and the design works without it.

---

## 4. Authentication

**Email + password. No magic links, no OAuth, no third-party identity provider.**

Two independent reasons point the same way, which is why this is a firm decision
rather than a preference.

**Reason one — the email constraint.** Supabase's built-in email service sends at
most 2 messages per hour *and only to addresses belonging to the Supabase
organisation's own team members*. An invitation sent to `muhasebe@akgunmedikal…`
simply never arrives. Magic links, email confirmation and self-service password
reset are all email-delivery features, and none of them functions on the Free
plan without configuring a third-party SMTP provider — an extra service, an extra
account, and a domain-verification step, for a pilot with three users.

**Reason two — Tauri.** Any redirect-based flow (OAuth, magic link) in a desktop
application requires a custom URL scheme, deep-link registration per platform, and
a redirect-allow-list — the exact complexity the brief asks to avoid. Email and
password is an HTTPS request. It behaves identically in a browser tab, a Tauri
webview on Windows, and a Tauri webview on macOS, with no platform-conditional
code at all.

### The MVP flow, end to end

```text
ADMIN                                  EMPLOYEE
─────                                  ────────
1. Kullanıcılar → "Kullanıcı ekle"
   e-posta, ad, rol
        │
        ▼
2. Edge Function: admin-provision-user
   (idempotent — see below)
   ├ verifies the caller's JWT
   ├ verifies caller is OWNER/ADMIN of the target org
   ├ ensures an auth user exists for the e-mail
   ├ RPC: profile + membership in one DB transaction
   └ returns the generated password ONCE
        │
        ▼
3. Admin reads the password to the
   employee, in person or by phone   ───►  4. Signs in: e-posta + parola
                                                │
                                                ▼
                                           5. Forced password change
                                              (must_change_password = true)
                                                │
                                                ▼
                                           6. Normal use
```

Why the password is handed over out of band: it is the only delivery channel that
exists at $0, and for three people in one office it is *better* than email — the
credential never sits in a mailbox. The password is shown once, is not stored
anywhere in the database in plaintext, and is useless after step 5.

### Provisioning is not one transaction, and must not be described as one

Step 2 crosses a boundary a database transaction cannot span. `auth.admin
.createUser()` is an **HTTP call to the Auth service**, and the profile and
membership rows are a **PostgreSQL write**. Between them sits a network, a
timeout, and an Edge Function that can be killed mid-execution. An earlier draft
wrote them on one line as though they committed together; they do not, and the
consequences are not hypothetical — the most likely one is an admin pressing the
button twice.

So the workflow is designed to be **idempotent**: running it again with the same
input converges on one valid final state rather than producing a second one.

```text
admin-provision-user(email, display_name, role, organization_id, request_id)
│
├─ 0  AUTHORISE
│     verify JWT → verify OWNER/ADMIN of organization_id
│     (a caller who fails here never reaches the Auth Admin API)
│
├─ 1  CLAIM THE ATTEMPT
│     RPC begin_provisioning(organization_id, email, request_id)
│     inserts into provisioning_attempts (request_id PK)
│       → conflict, status SUCCEEDED → return the stored outcome, stop
│       → conflict, status IN_FLIGHT  → return BUSY, stop (no double create)
│       → inserted                    → continue
│
├─ 2  RESOLVE THE AUTH USER          ← the non-transactional step
│     listUsers / getUserByEmail on the normalised address
│       → exists     : created_here = false,  password = null
│       → not exists : createUser({ email, password, email_confirm: true })
│                      created_here = true
│       → createUser fails with "already registered" (a race with another
│         admin): re-read, treat as exists
│
├─ 3  LINK, TRANSACTIONALLY
│     RPC complete_provisioning(request_id, user_id, display_name, role)
│       one transaction:
│         insert profiles      … on conflict (user_id) do update display_name
│         insert memberships   … on conflict (organization_id, user_id)
│                                do update set role = excluded.role,
│                                              status = 'ACTIVE'
│         insert admin_events  (actor, subject, organisation, role)
│         update provisioning_attempts set status = 'SUCCEEDED'
│
├─ 4  COMPENSATE ON FAILURE
│     if step 3 fails AND created_here = true:
│         auth.admin.deleteUser(user_id)        ← only ever the user THIS
│         mark the attempt FAILED                 attempt created
│     if step 3 fails AND created_here = false:
│         mark the attempt FAILED, delete nothing
│
└─ 5  RETURN  { status, user_id, temporary_password? }
```

`provisioning_attempts` is a small table — `request_id uuid primary key`,
`organization_id`, `email`, `status`, `created_at` — and it is the whole
idempotency mechanism. The client generates `request_id` once per press of the
button and reuses it on retry, exactly as it already generates entity UUIDs.

#### The five failure cases, and what each one does

| | Situation | Outcome |
| --- | --- | --- |
| **A** | Auth user created, profile/membership write fails | step 4 deletes the auth user it created, attempt marked `FAILED`. **Nothing is left behind**, and a retry starts clean |
| **B** | Request times out after the user was created; admin retries with the same `request_id` | step 1 finds the attempt. If it had reached `SUCCEEDED`, the stored outcome is returned and nothing is created. If it is still `IN_FLIGHT`, the retry is refused as `BUSY` rather than racing the first attempt |
| **C** | E-mail already exists in Auth | step 2 resolves it instead of creating it, `created_here = false`, and step 3 links it. **No password is returned** — the account is not this attempt's to re-credential. Resetting it is the separate, explicit action below |
| **D** | Membership already exists | `on conflict … do update` sets the role and re-activates. Re-inviting a disabled colleague is the same operation as inviting them, which is the behaviour an admin expects |
| **E** | Edge Function crashes between steps 2 and 3 | the attempt is left `IN_FLIGHT`. A retry with the same `request_id` returns `BUSY`; a **new** `request_id` resolves the now-existing user through case C and links it, converging on the correct final state. A stale `IN_FLIGHT` attempt is visible to an OWNER and can be cleared explicitly — never by a timeout that a slow run could trip |

Two properties fall out of this and are worth naming: **no path ever deletes an
auth user it did not create in the same attempt** (which is what makes case C
safe), and **the only thing that is ever "half done" is a `provisioning_attempts`
row**, which is inert.

**Not built: a job queue.** Every step is a single call with a bounded runtime,
the retry is a human pressing a button again, and the convergence argument above
needs no scheduler. A queue would add infrastructure to make an operation that
happens three times a year slightly more automatic.

**Password reset** is a separate, explicit action on the same Edge Function —
`admin-reset-password(user_id)` — which calls `auth.admin.updateUserById` with a
new temporary password and sets `must_change_password`. It is deliberately not
folded into provisioning: case C must not silently reset a colleague's password
because an admin re-entered an address. There is no self-service reset in the
MVP, and the UI says so rather than offering a "Şifremi unuttum" link that would
silently do nothing.

**The secret key never leaves the Edge Function.** Every step above that touches
the Auth Admin API runs server-side with `sb_secret_…` from Edge Function
secrets. The client sends an email, a name, a role and a `request_id`, and
receives a status and possibly a one-time password. It never holds a credential
capable of creating a user, and could not perform any of steps 2–4 itself (§19).

**Email verification** is set to confirmed at creation (`email_confirm: true`).
This is honest here and would not be in a public product: the address is not being
proven to belong to the person, it is being *asserted by an administrator who
knows them*. That is a stronger guarantee than a click on a link, and the design
does not pretend otherwise.

**Public sign-up is disabled** (`[auth] enable_signup = false`). Without it,
anyone could create an `auth.users` row. Such a user would have no membership and
therefore no access to any business row — but they would be an authenticated
principal, and an architecture that relies on "they can't do anything anyway" is
one bug away from being wrong. There is no legitimate self-registration in a
single-company pilot.

**One switch next to it must be left ON, and its name is a trap.**
`[auth.email] enable_signup` does not mean "allow sign-up by e-mail". The
Supabase CLI maps it to GoTrue's `GOTRUE_EXTERNAL_EMAIL_ENABLED`, which disables
the e-mail provider **entirely** — including sign-IN. Setting it to `false`
produces `422 email_provider_disabled` on every password login, which for a
product whose only authentication method is e-mail and password means nobody can
use it at all. `[auth] enable_signup = false` (GoTrue's `DISABLE_SIGNUP`) is the
one that closes registration while leaving
`POST /auth/v1/token?grant_type=password` working. Phase 10's behavioural suite
asserts **both halves** — that `POST /auth/v1/signup` is refused and that the
password grant still succeeds — because a test for the first alone would call
the broken configuration a success.

**Session handling.** `supabase-js` persists the session in `localStorage` and
refreshes the access token automatically. A refresh the server REFUSES (revoked
token, disabled user) surfaces as an explicit `SESSION_EXPIRED` state that
returns the user to the sign-in screen — never as an empty data screen. A
refresh that cannot be ATTEMPTED because the network or server is down is
`OFFLINE` / `SERVER_UNAVAILABLE` and keeps the session, so the user continues
when the connection returns (Audit A, A-L1). Sign-out removes the session from
this device unconditionally — even offline with an expired access token — and
only then asks the server to revoke it (A-M3). A session change made in another
tab, and a membership withdrawn on the server, end the running application
state rather than leaving it READY under the old identity (A-M2); §30 has the
mechanism.

**OPTIONAL FUTURE.** Custom SMTP (a free-tier transactional email provider) would
enable real email invitations and self-service password reset. It changes the
invitation *delivery*, not the model: the membership row and the role are
unchanged. Nothing needs to be redesigned to add it.

---

## 5. Tenancy: organisations, memberships, profiles

### The entities

Two entities carry the tenancy model. A third carries identity presentation, and
earns its place separately.

```text
  auth.users  (Supabase-managed, in the `auth` schema, not exposed to the API)
      │ 1:1
      ▼
  profiles ──────────┐
   user_id  PK/FK    │ N
   display_name      │
   must_change_pw    ▼
   created_at    memberships ──────► organizations
   updated_at     organization_id FK   id
                  user_id         FK   name
                  role  OWNER|ADMIN|   created_at
                        MEMBER          updated_at
                  status ACTIVE|
                         DISABLED
                  PK (organization_id, user_id)
```

**`organizations`** — the company boundary. One row per company. The pilot has
exactly one (`Akgün Medikal`). Named *organization* rather than *company* or
*workspace* because `organization_id` is unambiguous as a column name on forty
tables, and because "company" is already a word this domain uses for suppliers and
customers.

**`memberships`** — the join between a user and an organisation, carrying the role
and the status. Primary key `(organization_id, user_id)`, so a user belongs to an
organisation at most once. **A user may belong to several organisations**: that is
the natural shape of a join table and costs nothing today, where a
`users.organization_id` column would cost a migration the first time it is wrong.
The MVP interface assumes exactly one active membership and selects it
automatically without an organisation picker.

**`profiles`** — one row per user, holding the display name. This is *not* a third
tenancy concept; it exists because `auth.users` lives in the `auth` schema and is
not exposed over the Data API, and exposing it would publish every user's email to
every tenant. Rendering "Ayşe tarafından kaydedildi" on a warehouse receipt needs
a name that is readable under a row-level policy, and a profile is the only place
to put one. Its RLS policy is: **a profile is visible only to users who share an
active membership with it.**

### How tenant ownership is represented

**Every business row carries `organization_id uuid not null references
organizations(id)`.** Flat, denormalised, on every table including child tables.

The alternative — deriving the tenant through a join, so that a
`purchase_order_lines` row inherits its tenant from its parent — was rejected.
It turns every row-level policy into a correlated subquery, makes a missing index
a sequential scan of another tenant's data, and puts the security predicate one
join away from the thing it protects. A security rule that is hard to read is a
security rule that will eventually be read wrong.

The denormalised column has one failure mode, and it is closed structurally
rather than by discipline: a child row whose `organization_id` disagrees with its
parent's. Every parent table declares `unique (id, organization_id)`, and every
child declares a **composite foreign key**:

```sql
constraint purchase_order_lines_parent_fk
  foreign key (purchase_order_id, organization_id)
  references app_data.purchase_orders (id, organization_id)
```

A line can therefore only ever belong to a parent in the same organisation. It is
not a trigger, not a check written in application code, and not something a future
migration can forget — it is a foreign key, and the database refuses the row.

---

## 6. Roles and permissions

**Three roles: `OWNER`, `ADMIN`, `MEMBER`.** Stored as a single column on
`memberships`.

| Capability | OWNER | ADMIN | MEMBER |
| --- | :---: | :---: | :---: |
| Read all business data in the organisation | ● | ● | ● |
| Create / edit / deactivate business records | ● | ● | ● |
| Post receipts, dispatches, movements, reservations | ● | ● | ● |
| Export a portable organisation backup | ● | ● | ○ |
| Invite, disable and re-enable members; change roles | ● | ● | ○ |
| **Restore / import over existing organisation data** | ● | ○ | ○ |
| Transfer ownership; delete the organisation | ● | ○ | ○ |

**Why three and not two.** The line between OWNER and ADMIN carries exactly one
thing at MVP, and that thing is worth a role: **restore is the only operation in
the system that can destroy a company's data in one action.** The existing local
documentation already calls restore "the most dangerous operation in the
application" when it could only destroy one person's copy; against shared data it
destroys everyone's. Making it OWNER-only is a real control. Everything else an
ADMIN can do is recoverable.

**What is deliberately not built.** No per-module permissions, no
`PURCHASING`/`WAREHOUSE`/`READ_ONLY`, no permission matrix, no groups, no
delegation. Three users do not need an IAM system, and every role that exists must
be enforced in a policy and tested — the cost of a role is not the enum value.

**Future capability, documented so the extension is not a redesign.** `role` is a
single enum column. Adding `WAREHOUSE` means one migration (extend the enum) plus
new predicates in the policies of the tables it restricts. No table changes, no
data backfill beyond a default. The moment to do it is when someone is genuinely
given access they should not have — not before.

**The role is read from the database on every request, never from the JWT.**
This is the control for "a removed member keeps an old token"; see §22, threat 3.

---

## 7. Row Level Security

This section is the security architecture. "Enable RLS" is not a design.

### Three schemas, and only one of them is an API

This is the foundation the rest of the section stands on, and getting it wrong
undoes everything else — which is what an earlier draft did by putting the
canonical tables in `public` and then granting `authenticated` `select` on them.
`public` is an **exposed** schema, so `GET /rest/v1/products` was a live route
past every projection this architecture relies on (§10).

```text
  ┌─────────────────────────────────────────────────────────────┐
  │  api          ← THE ONLY BUSINESS SCHEMA EXPOSED TO THE     │
  │                 DATA API. Read views + typed RPCs. Nothing   │
  │                 else. This schema IS the public surface.     │
  └───────────────────────────┬─────────────────────────────────┘
                              │ security_invoker views · RPCs
  ┌───────────────────────────▼─────────────────────────────────┐
  │  app_data     ← canonical business tables. NOT exposed.     │
  │                 RLS enabled and forced. organizations,       │
  │                 memberships, profiles, products, suppliers,  │
  │                 customers, customer_statuses, and every      │
  │                 future operational table.                    │
  └───────────────────────────┬─────────────────────────────────┘
                              │ called by policies and triggers
  ┌───────────────────────────▼─────────────────────────────────┐
  │  app_private  ← security and trigger helpers. NOT exposed.  │
  └─────────────────────────────────────────────────────────────┘

  public         ← holds no business object. Left alone.
```

Exposure is configured once, in `supabase/config.toml`, and is part of the
repository rather than a dashboard setting:

```toml
[api]
schemas = ["api"]                  # NOT "public"; NOT "app_data"
extra_search_path = ["public", "extensions"]
```

PostgREST routes **only** the schemas in that list. A client selecting a schema —
`supabase.schema('app_data')` or an `Accept-Profile` header — receives
**`PGRST106: The schema must be one of the following`** for anything outside it.
There is no header, no embedding path and no foreign-key expansion that reaches an
unexposed schema.

### The distinction this architecture turns on

> **A database `EXECUTE` or `SELECT` privilege is not a Data API route.**

They are two different mechanisms and confusing them produced both of the defects
this correction round exists to fix:

| | Grants the privilege | Creates a REST route |
| --- | --- | --- |
| `grant select on app_data.products to authenticated` | ✅ | ❌ — `app_data` is not exposed |
| `grant execute on function app_private.current_org_ids() to authenticated` | ✅ | ❌ — `app_private` is not exposed |
| `grant select on api.products to authenticated` | ✅ | ✅ — `api` is exposed |

`authenticated` **must** hold privileges on `app_data`: a `security_invoker` view
checks permissions against the *caller*, so without `usage` on the schema and
`select` on the table the view returns a permission error rather than data. The
same is true of an RLS helper — see "Private helpers need `EXECUTE`" below.
Holding those privileges is required for the system to work and grants no
reachability whatsoever, because reachability is decided by the exposed-schema
list.

**One warning about the obvious copy-paste.** Supabase's own custom-schema guide
demonstrates `grant all on all tables in schema myschema to anon, authenticated,
service_role` plus matching `alter default privileges`. **Do not run that.** It is
written for a schema you intend to publish; here it would hand `anon` every table
and pre-authorise every table a future phase adds, which is the exact opposite of
the posture below. Grants in this system are always per-object, per-role, in the
migration that creates the object.

### The posture: default-deny by grant, then policy

Three independent layers, in this order:

1. **Exposure.** Canonical tables are in `app_data`, which PostgREST does not
   serve. A table added to `app_data` by a future phase has no route on the day it
   is created and never acquires one by accident — acquiring one requires someone
   to write a view or a function *in `api`*, which is a visible, reviewable act.
2. **Grants.** `anon` receives **no privilege on any business object, anywhere, in
   any schema.** `authenticated` receives exactly the privileges the `api` layer
   needs it to hold, named object by object, in the same migration that creates
   the object. A table created without that block is unreachable even from `api`.
3. **Policies.** RLS is `enable`d **and `force`d** on every table in `app_data`,
   so a plain table owner is subject to it too. **FORCE does not bind a role
   holding BYPASSRLS** — and `postgres`, which owns these tables and every
   `SECURITY DEFINER` function here, holds it. A DEFINER function therefore
   reads across tenants unless its own SQL filters by organisation; FORCE is not
   the safety net for that, explicit filtering is (correction recorded by Audit
   A, A-L8).

```sql
create schema if not exists api;          -- exposed  (config.toml, §20)
create schema if not exists app_data;     -- NOT exposed
create schema if not exists app_private;  -- NOT exposed

grant usage on schema api      to authenticated;
grant usage on schema app_data to authenticated;   -- usage ≠ a route
-- anon gets nothing, not even usage, on any of the three.

alter table app_data.products enable row level security;
alter table app_data.products force  row level security;
revoke all on app_data.products from anon, authenticated;
grant select, insert, update on app_data.products to authenticated;
-- note: no `delete` grant, anywhere. See §12.
```

The `insert` and `update` grants are what let the `SECURITY INVOKER` mutation
RPCs of §8 write as the caller, so RLS evaluates inside them automatically. They
are not a bypass: there is no route to `app_data.products` for any statement the
client could compose.

### The membership helper, and why it is a function

A policy on `products` that reads `memberships` would make `memberships`' own
policy evaluate, which reads `memberships` again — Postgres raises `42P17`,
*infinite recursion detected in policy*, and every query fails. The standard
resolution is a `SECURITY DEFINER` function, which runs as its owner (`postgres`,
which has `BYPASSRLS`) and therefore breaks the cycle.

```sql
create schema if not exists app_private;   -- NOT in the API's exposed schemas

create or replace function app_private.current_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
  from app_data.memberships m
  where m.user_id = (select auth.uid())
    and m.status  = 'ACTIVE';
$$;

create or replace function app_private.has_org_role(org uuid, roles text[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from app_data.memberships m
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.status  = 'ACTIVE'
      and m.role    = any (roles)
  );
$$;

-- Fail closed first, then grant exactly what policy evaluation needs.
revoke execute on function app_private.current_org_ids()          from public;
revoke execute on function app_private.has_org_role(uuid, text[]) from public;
revoke execute on function app_private.current_org_ids()          from anon;
revoke execute on function app_private.has_org_role(uuid, text[]) from anon;

grant usage on schema app_private to authenticated;               -- not to anon
grant execute on function app_private.current_org_ids()          to authenticated;
grant execute on function app_private.has_org_role(uuid, text[]) to authenticated;
```

### Private helpers need `EXECUTE` — a correction

An earlier draft claimed these helpers need no grant at all, on the reasoning
that "the policy is evaluated by the system, not invoked by the user."
**That is wrong**, and PostgreSQL's own documentation says so plainly:

> Since policy expressions are added to the user's query directly, they will be
> run with the rights of the user running the overall query. Therefore, users who
> are using a given policy must be able to access any tables or functions
> referenced in the expression or they will simply receive a permission denied
> error when attempting to query the table that has row-level security enabled.

So a policy calling `app_private.current_org_ids()` requires the **caller** to
hold `EXECUTE` on it and `USAGE` on `app_private`. Without those grants the
architecture does not fail open — it fails *shut*, with every authenticated query
against every protected table returning `permission denied for function`. The
defect was a documented falsehood that would have produced a totally broken
Phase 10, not a security hole; it is corrected here because an architecture
document that is wrong about a mechanism is wrong in whichever direction the
mechanism happens to point.

This is also Supabase's own documented pattern for private RLS helpers:

```sql
revoke execute on function private.user_list_ids() from public;
grant usage on schema private to authenticated;
grant execute on function private.user_list_ids() to authenticated;
```

**And it changes nothing about reachability.** `app_private` is not an exposed
schema, so `POST /rest/v1/rpc/current_org_ids` has no route regardless of who
holds `EXECUTE`. Privilege and route are the two different mechanisms named
above, and this helper is precisely the case that proves they are different: it
*must* be executable and *must not* be callable.

**Trigger helpers are genuinely different.** `app_private.stamp_row()`,
`assert_write_allowed()` and the write-gate trigger functions need no grant to
`authenticated` at all: PostgreSQL checks `EXECUTE` on a trigger function when
the trigger is **created**, against the creator, not when DML fires it. They
therefore stay revoked from everyone. The distinction is worth keeping straight
because the two kinds of helper look identical in the source tree.

Three details that are not stylistic:

- **`set search_path = ''` with fully schema-qualified names.** Without a pinned
  search path, a caller can create an object that shadows an unqualified name and
  have it executed with the function owner's privileges. This is the standard
  privilege-escalation route through `SECURITY DEFINER` and it is closed by one
  line.
- **The function lives in `app_private`, which is not an exposed schema.** A
  `SECURITY DEFINER` function in an exposed schema is callable over the Data API
  *with its creator's privileges*. These are not.
- **`stable`, returning an array, called once per statement.** The policy calls it
  as `(select app_private.current_org_ids())::uuid[]`, which Postgres evaluates
  as an `InitPlan` — once for the whole statement, not once per row. A per-row
  membership lookup is the classic RLS performance cliff and it is avoided by the
  shape of the call, not by a cache.
- **The `::uuid[]` cast is load-bearing, and its absence does not compile.**
  Written as `x = any ((select f()))`, PostgreSQL parses the parenthesised select
  as the **subquery** form of `ANY` — it expects a *set* of `uuid` and receives
  one value of type `uuid[]`, so the expression fails with
  `operator does not exist: uuid = uuid[]` and the migration does not apply. The
  cast makes the operand an ordinary array expression, selecting the array form
  of `ANY` while keeping the sub-select that produces the InitPlan. Writing
  `any (app_private.current_org_ids())` also compiles and silently gives up the
  once-per-statement evaluation. Every policy and helper in the implementation
  uses the cast form; Phase 10 discovered this by the migration refusing to run.

And one detail that is **deliberately absent**: this function knows nothing about
maintenance or restore. An earlier draft filtered out organisations under a
restore lock here, which put a *write* concern on the *read* path — it blinded
readers for no safety benefit (a `select` cannot corrupt a restore), and because
blinding the person running the restore was unacceptable it needed an OWNER
exemption, which left that OWNER able to mutate company data from a second tab
during the restore. The gate belongs on the write path and nowhere else; §16 has
the corrected design.

### The four-policy pattern

Every client-accessible business table gets exactly this, with `products`
standing in for all of them:

```sql
create policy products_select on app_data.products
  for select to authenticated
  using ( organization_id = any ((select app_private.current_org_ids())::uuid[]) );

create policy products_insert on app_data.products
  for insert to authenticated
  with check ( organization_id = any ((select app_private.current_org_ids())::uuid[]) );

create policy products_update on app_data.products
  for update to authenticated
  using      ( organization_id = any ((select app_private.current_org_ids())::uuid[]) )
  with check ( organization_id = any ((select app_private.current_org_ids())::uuid[]) );

-- DELETE: no policy and no grant. Deletion is not a client capability.
```

These policies are what protect the table when it is reached through an `api`
view or a `SECURITY INVOKER` RPC — which, since `app_data` has no route, is the
only way it is ever reached. Tenant isolation therefore does not depend on any
function remembering to filter: it is evaluated by the database on every
statement, inside and outside every RPC.

**`SELECT` — `using`.** A row outside the caller's organisations does not exist
as far as the query is concerned. A guessed UUID returns zero rows, which is
indistinguishable from "no such record" — the enumeration oracle is closed by the
same mechanism as the access control.

**`INSERT` — `with check`.** This is the control the brief asks for by name:
*client-supplied `organization_id` cannot be used to write into another tenant.*
The value the client sends is checked against the caller's live membership set and
the insert is refused otherwise. There is no UI check, no service-layer check, and
no trust in the client's honesty involved.

**`UPDATE` — both clauses, and the second is the one that is forgotten.** `using`
decides which rows may be modified. Without `with check`, a user can take a row
they legitimately own and rewrite its `organization_id` to another tenant's —
producing a row they can no longer see, sitting in someone else's catalogue. Both
clauses, on every table, always.

**`DELETE` — absent by design.** Data Model §10 and I14 already say a referenced
record is deactivated, never destroyed. Expressing that as *the absence of a
policy and a grant* makes it structural: no client request can delete a business
row by any path. The one legitimate hard delete in the model — a `DRAFT` purchase
order (Data Model §6) — is a named `SECURITY DEFINER` function that checks the
status first, not a broad policy.

### Server-set columns are set by triggers, not trusted or validated

```sql
create or replace function app_private.stamp_row()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := (select auth.uid());
    new.updated_at := new.created_at;
    new.updated_by := new.created_by;
    new.version    := 1;
  else
    if new.organization_id is distinct from old.organization_id then
      raise exception 'organization_id is immutable' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := (select auth.uid());
    new.version    := old.version + 1;
  end if;
  return new;
end $$;
```

The trigger **overwrites** rather than validates. A client that sends
`created_by: '<someone else>'` does not get an error, it gets its value silently
replaced by the truth — which is the correct outcome, because the value was never
input in the first place. The same applies to `created_at`, `updated_at` and
`version`. Attribution and time are server facts.

`organization_id` immutability is enforced here as well as by the `with check`.
The policy prevents moving a row into a tenant the caller does not belong to; the
trigger prevents moving it at all, which matters the moment a user is a member of
two organisations.

### Views are `security_invoker`, and that is not optional

§10 requires every decimal column to reach the client as text, and the natural
way to do that is a view that casts `numeric::text`. **A view is the single
easiest way to destroy everything above**, because of a PostgreSQL default that
points the wrong way:

> A view executes with the privileges of **its owner**, not its caller. Views
> created by `postgres` therefore **do not respect the RLS of the tables they
> read** — the owner has `BYPASSRLS`. A `select` through such a view hands out
> every row the underlying policies were written to withhold, successfully and
> silently.

Supabase's own Security Advisor flags exactly this as lint **`0010`
security_definer_view**, and the remediation is explicit:

```sql
create view api.products
  with (security_invoker = on)          -- ← without this, RLS is bypassed
as
select
  p.id,
  p.organization_id,
  p.sku,
  p.name,
  p.stock_unit,
  p.units_per_purchase_unit::text as units_per_purchase_unit,  -- §10
  p.external_ref,
  p.active,
  p.version,
  to_char(p.updated_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at        -- §10
from app_data.products p;
```

`security_invoker` was introduced in **PostgreSQL 15**. The hosted project is
created new in Phase 10 and will be on 15 or later; **Phase 10 asserts the server
version before it creates a single view**, because on 14 the option is silently
accepted-as-unknown territory and the fallback (no views; cast inside RPCs) is a
different design that must be chosen deliberately rather than discovered.

**The rule, stated so no future view can be written without meeting it:**

> Every view reachable through the Data API is created `with (security_invoker =
> on)`, selects only from tables in the same organisation-scoped RLS regime, and
> **adds no privilege of its own**. A view is a projection and a cast. It is
> never a way to read something.

#### Grants, on the view and on the table underneath

`security_invoker` makes the *caller's* policies apply — which also means the
caller needs privileges on the **underlying table**, not only on the view. Both
sides are granted explicitly, in the same migration:

```sql
-- underlying table, in the UNEXPOSED schema
grant usage on schema app_data to authenticated;
revoke all on app_data.products from anon, authenticated;
grant select, insert, update on app_data.products to authenticated;

-- the view, in the EXPOSED schema: SELECT only, and only to authenticated
grant usage on schema api to authenticated;   -- not to anon
revoke all on api.products from anon, authenticated;
grant select on api.products to authenticated;
```

| Object | Schema exposed? | `anon` | `authenticated` |
| --- | --- | --- | --- |
| `app_data.products` (table) | **no** | nothing | `select`, `insert`, `update` — never `delete` |
| `api.products` (view) | **yes** | nothing | `select` only |

The table grant looks alarming and is not: it is the privilege the
`security_invoker` view and the `SECURITY INVOKER` RPCs need in order to act as
the caller, and it creates no route (see "The distinction this architecture turns
on" above). **Reads reach the data only through `api.products`, where the
decimals are already text; writes reach it only through the RPCs of §8.**

Writes never go through a view. Both paths are governed by the same policies on
the same table — which is the point: **the view adds a cast, and subtracts
nothing from the security model.**

### Function EXECUTE privileges are revoked before they are granted

PostgreSQL's default is the second trap of the same kind: **`EXECUTE` on a newly
created function is granted to `PUBLIC` automatically**, and `anon` and
`authenticated` are members of `PUBLIC`. A function is therefore callable by
everyone the moment it exists, unless something says otherwise.

```sql
-- Private RLS helpers: revoked from PUBLIC and anon, granted to authenticated
-- because policy evaluation requires it (see "Private helpers need EXECUTE").
-- No route: app_private is not exposed.
revoke execute on function app_private.current_org_ids() from public, anon;
grant usage on schema app_private to authenticated;
grant execute on function app_private.current_org_ids() to authenticated;

-- Trigger helpers: nobody. EXECUTE is checked at CREATE TRIGGER, not at DML.
revoke execute on function app_private.stamp_row()           from public, anon, authenticated;
revoke execute on function app_private.assert_write_allowed(uuid)
                                                             from public, anon, authenticated;

-- Published RPCs: revoked from PUBLIC first, then granted to exactly one role.
revoke execute on function api.update_product(uuid, uuid, integer, …) from public, anon;
grant  execute on function api.update_product(uuid, uuid, integer, …) to authenticated;
```

**The order matters and is the whole technique:** `revoke … from public` first,
`grant … to authenticated` second. Granting without revoking leaves the default
`PUBLIC` grant in place underneath, so `anon` keeps the privilege and the
explicit grant reads like a control while enforcing nothing.

| Function class | Schema | Exposed? | Mode | `EXECUTE` held by |
| --- | --- | --- | --- | --- |
| RLS / membership helpers | `app_private` | no | `DEFINER` | **`authenticated`** — required for policy evaluation; still no route |
| trigger functions | `app_private` | no | — | **nobody** — checked at `CREATE TRIGGER`, not at DML |
| business RPCs (create, update, deactivate, save, place order) | `api` | **yes** | `INVOKER` | `authenticated` |
| ledger posting RPCs | `api` | **yes** | `DEFINER` | `authenticated` |
| restore / import | `api` | **yes** | `DEFINER` | `authenticated` (re-proves OWNER inside) |
| anything at all | anywhere | — | any | **never `anon`** |

`anon` holds no `EXECUTE` on any function in this system, and no `USAGE` on any
of the three schemas. There is no unauthenticated operation.

### Proving it, rather than believing it

The highest-likelihood security failure in this entire design is **an object
added in a future phase without the posture applied to it** — a table with no
RLS, a view without `security_invoker`, a function left callable by `PUBLIC`.
Three controls, in increasing strength:

1. `supabase db lint` / the Security Advisor flags unprotected tables and
   security-definer views in exposed schemas. Run in CI.
2. **pgTAP assertions over the catalogue**, below. Written once in Phase 10,
   extended by every phase that adds an object, and they **fail on the day
   someone adds one without thinking** — the only kind of control that survives a
   year of phases.
3. **Behavioural proofs**: two tenants, and an HTTP client. These are what turn
   the catalogue assertions from syntax into demonstrated properties, and two of
   them *cannot* be expressed in pgTAP at all.

#### Part 1 — pgTAP, over the catalogue

| # | Assertion | Catches |
| --- | --- | --- |
| P1 | every table in `app_data` has `relrowsecurity` **and** `relforcerowsecurity` | a table added with RLS forgotten, or enabled but not forced |
| P2 | every table in `app_data` has at least one policy per command it grants | RLS enabled with no policy — which denies everything, a correctness failure rather than a security one |
| P3 | every `UPDATE` policy has a `with_check` expression, not only `using` | the tenant-move hole (§ four-policy pattern) |
| P4 | no table in `app_data` grants `delete` to `authenticated`, and none has a `DELETE` policy | a hard-delete path appearing by accident |
| P5 | `anon` holds **no** privilege on any table, view, sequence or function, and **no `USAGE` on `api`, `app_data` or `app_private`** | the unauthenticated surface staying empty |
| P6 | every view in **`api`** has `reloptions` containing `security_invoker=on` | lint `0010` — the RLS-bypassing view |
| P7 | every view in `api` reads only from tables that satisfy P1 | a view reaching into an unprotected table |
| P8 | every function in `api` and `app_private` has `EXECUTE` revoked from `PUBLIC` (`proacl` not null, no `=X/` entry for `PUBLIC`) | the default `PUBLIC` grant left in place |
| P9 | every `SECURITY DEFINER` function has `proconfig` containing `search_path=` | the standard privilege-escalation route |
| P10 | **no function in `app_private` grants `EXECUTE` to `anon`**; the RLS helpers grant it to `authenticated` and the trigger helpers to nobody | an over-grant to `anon`, and — in the other direction — an RLS helper left ungranted, which breaks every query |
| P11 | every business table has `organization_id not null`, a stamping trigger, and a `version` column | the shape rules of §11 |
| P12 | `app_data.inventory_movements` grants no `insert`, `update` or `delete` to `authenticated`, and has no policy for them | I7 and I9 as permissions (§12) |
| P13 | **`api` contains no base tables** — only views and functions | a canonical table created in, or moved into, the exposed schema |
| P14 | **no object in `app_data` or `app_private` is granted to a role that could reach it through `api`'s exposure list**, i.e. the schemas hold no views or functions intended as API surface | the two private schemas staying private in intent as well as in configuration |

**P10 is a two-sided assertion, and that is deliberate.** It fails if a helper is
over-granted to `anon`, *and* it fails if an RLS helper is not granted to
`authenticated` — because the correction this round made is that the second case
is a real defect too. An ungranted RLS helper does not leak; it makes every
authenticated query on every protected table return `permission denied for
function`. Both directions are caught by one test.

#### Part 2 — behavioural, and two of these need HTTP

pgTAP runs *inside* the database and therefore **cannot see PostgREST's
exposed-schema configuration at all.** The single control that makes the exact-
decimal contract an invariant — that `app_data` has no route — is not provable by
any in-database test. It needs a real request.

| # | Proof | How |
| --- | --- | --- |
| B1 | an authenticated member reads **only their own tenant** through `api.products` | two orgs, two users, pgTAP or HTTP |
| B2 | an authenticated member **cannot** read the other tenant's rows through any `api` view or RPC | " |
| B3 | an RLS policy **evaluates successfully** for an authenticated member — i.e. the helper grants are present | any authenticated `select`; its absence is a `permission denied for function` |
| B4 | **`app_private.current_org_ids` has no RPC route** | `POST /rest/v1/rpc/current_org_ids` → `PGRST106`/404, **while B3 passes** |
| B5 | **`app_data.products` has no REST route** | `GET /rest/v1/products` and `supabase.schema('app_data').from('products')` → `PGRST106`/404 |
| B6 | **the same field is returned as an exact string** through `api.products` | HTTP; the response body's raw JSON is inspected, not the parsed object |
| B7 | **no JSON-number route exists for that field** | B5 and B6 together: the only route returns text |
| B8 | `anon` reaches nothing — every `api` view and RPC refuses an unauthenticated request | HTTP with the publishable key and no session |
| B9 | a hand-crafted `PATCH` against a catalog table is refused | `PATCH /rest/v1/products` → no route (§8, §9) |

**B4 and B6 are the pair that make the two corrections in this round real.** B4
proves "privilege without a route" is an actual state rather than a claim — the
helper is executable by `authenticated` (or B3 fails) *and* unreachable as an RPC.
B6 proves the decimal contract is enforced by the server rather than observed by
the client.

#### The hostile precision fixture

B6 uses a value chosen to fail visibly if it ever takes a float64 detour:

```text
units_per_purchase_unit = 12345678901234567890.0047
```

`JSON.parse('{"v":12345678901234567890.0047}').v` yields
`12345678901234567000` — wrong in the integer part, and the four decimal places
gone entirely. So the assertion is exact string equality against the raw response
body:

```text
assert  body.units_per_purchase_unit === "12345678901234567890.0047"
assert  typeof body.units_per_purchase_unit === "string"
```

A test that parsed the JSON and compared numerically would pass while the data
was being destroyed, which is the failure mode §10 exists to prevent. The
fixture belongs to Phase 11 and is the acceptance criterion for the decimal
contract at Audit Checkpoint A.

---

## 8. The client/server boundary

The classification rule, and it is now short because the schema separation of §7
did most of the work:

> **The `api` schema is the entire client surface. Reads are
> `security_invoker` views; every write is a small, typed PostgreSQL function.
> No canonical table is addressable.**

Two earlier drafts got this wrong in the same way, and both errors are worth
keeping on the record because they were the same mistake at two depths.

### Why "a single row" was the wrong test

The first draft said a client may write directly when the operation touches a
single row whose correctness is expressible as policy plus constraints, and put
`UPDATE` in that category on the strength of the optimistic-concurrency
predicate:

```sql
update products set … where id = $1 and version = $2   -- the client's request
update products set … where id = $1                    -- version? what version?
```

**The second statement is the same request with a clause removed**, and PostgREST
would execute it. RLS still confined the write to the caller's organisation, so
nothing leaked — but the stale-write protection evaporated, and two people editing
the same supplier would have had the second silently win. That is the exact
failure Phase 7 built `assertNotStale` to prevent.

### Why withdrawing the `UPDATE` grant was still not enough

The second draft fixed that by moving the predicate into an RPC and revoking
`UPDATE` on the table — but left `select` and `insert` granted, on tables in
`public`, which **is an exposed schema.** So `GET /rest/v1/products` and
`POST /rest/v1/products` were both live routes:

- the `GET` returned `numeric` columns as **JSON numbers**, walking straight past
  the text-casting view that §10 depends on;
- the `POST` was a write whose entire correctness rested on constraints, which is
  defensible, but which left two different write paths for one entity.

The fix is not another grant adjustment. It is that **the canonical tables are not
in an exposed schema at all** (§7), which removes every route in one move and
makes the remaining question simple: what does `api` contain?

### The mutation boundary, uniform

```text
READ            client → api.<entity>          security_invoker view,
                                               decimals already text

CREATE          client → api.create_<entity>()
UPDATE          client → api.update_<entity>()      + expected_version
DEACTIVATE      client → api.set_<entity>_active()  + expected_version

no direct INSERT · no direct UPDATE · no direct DELETE · no table route at all
```

`CREATE` joins the RPCs, and the reason is uniformity rather than a newly
discovered hole. With `app_data` unexposed there is no `POST /rest/v1/products`
to keep, so the choice is between publishing a write view with an `INSTEAD OF`
trigger or publishing a function — and a function is the same thing with a name,
a typed signature, and no trigger indirection. One entity, one set of three small
functions, one place to read them.

**What `CREATE` must enforce, and it is not stale-write.** A create has no prior
read to race against, so there is no `expected_version` and asking for one would
be theatre. What it does enforce:

- **tenant membership** — `has_org_role(p_organization_id, …)` as the first
  statement, and RLS `with check` underneath it;
- **tenant ownership** — `organization_id` is a parameter, checked, and stamped on
  the row; the payload cannot name another tenant;
- **server-owned audit fields** — `created_at`, `created_by`, `updated_at`,
  `updated_by`, `version = 1` are absent from the signature and set by the
  trigger;
- **database uniqueness** — the case-insensitive per-organisation SKU index does
  the work no application check can do without a race (§9);
- **canonical validation** — `check` constraints, `numeric` casts from canonical
  decimal strings, and the domain rules the client already applies in
  `productService` before it ever calls.

### The RPC shape: typed, per-entity, small

```sql
create function api.update_product(
  p_id               uuid,
  p_organization_id  uuid,
  p_expected_version integer,
  p_sku              text,
  p_name             text,
  p_description      text,
  p_stock_unit       text,
  p_default_purchase_unit    text,
  p_units_per_purchase_unit  text,     -- canonical decimal string, §10
  p_manufacturer     text,
  p_manufacturer_ref text,
  p_external_ref     text,
  p_note             text,
  p_active           boolean
) returns setof api.products             -- ← the view, so decimals come back text
language plpgsql
-- SECURITY INVOKER (the default): RLS still applies inside, so the tenant
-- guarantee is the same one every other statement gets.
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not app_private.has_org_role(p_organization_id,
                                  array['OWNER','ADMIN','MEMBER']) then
    raise exception 'not an active member of this organization'
      using errcode = '42501';
  end if;

  update app_data.products p
     set sku = btrim(p_sku),
         name = btrim(p_name),
         …,
         units_per_purchase_unit = nullif(p_units_per_purchase_unit, '')::numeric,
         active = p_active
   where p.id              = p_id
     and p.organization_id = p_organization_id
     and p.version         = p_expected_version     -- ← not the client's choice
  returning p.id into v_id;

  if not found then
    raise exception 'stale write or missing record'
      using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;

  return query select * from api.products where id = v_id;
end $$;

revoke execute on function api.update_product(…) from public, anon;
grant  execute on function api.update_product(…) to authenticated;
```

Note the return type: **`setof api.products`, the view — not the table.** A
function returning `app_data.products` would hand the client a row whose
`units_per_purchase_unit` is a `numeric`, and PostgREST would serialise it as a
JSON number — reopening the exact hole §10 exists to close, through the one door
that is still open. Every RPC that returns business data returns **the API
projection**, so there is a single place where a decimal becomes text and no way
to route around it.

Seven properties, each of which is the reason a line is there:

1. **Membership and role are re-proved** in the function, not assumed from the
   fact that the client could call it.
2. **`p_expected_version` is a required argument.** There is no overload without
   it and no default — omitting it is a type error at the API boundary, not a
   silently weaker write.
3. **The predicate is `id` + `organization_id` + `version`, all three, inside the
   function.** The tenant column is in the `WHERE` as well as in the policy,
   because defence in depth costs one clause.
4. **Zero rows is an error, not a success.** `not found` raises, the gateway maps
   the `STALE_WRITE` detail to the existing code, and `src/i18n/persistenceText.ts`
   renders the sentence it already renders today. The user-facing contract is
   untouched.
5. **`created_at`, `created_by`, `updated_at`, `updated_by` and `version` are
   absent from the parameter list.** The stamping trigger owns them; the client
   cannot name them, so it cannot forge them (§22, threat 8).
6. **`SECURITY INVOKER`.** The function needs no privilege the caller lacks —
   only the *shape* of the statement is being taken out of the client's hands, not
   the authorisation. RLS evaluates inside exactly as it would outside.
7. **It returns the API projection.** Decimals leave as text on the write path as
   well as the read path, so there is one serialisation rule rather than two.

**Deactivation is its own function**, `set_product_active(p_id, p_organization_id,
p_expected_version, p_active)`, for the same reason it was its own service
function in Phase 9: it flips one flag and must not be able to carry a field edit
with it.

### What this is not

**It is not a generic god-RPC.** There is no `mutate(table, id, payload jsonb)`.
Such a function would take the typing away from the boundary, make the parameter
list unreviewable, and re-create by another route exactly the "the client decides
the statement" problem this section exists to remove. One function per entity per
operation:

```text
api.create_product          api.update_product          api.set_product_active
api.create_supplier         api.update_supplier         api.set_supplier_active
api.create_customer         api.update_customer         api.set_customer_active
api.create_customer_status  api.update_customer_status  api.set_customer_status_active
api.update_own_profile
```

Thirteen small, typed, individually reviewable functions for the whole catalog
and identity surface. **Each one is a published API**, which is the useful
consequence of putting them in `api`: adding a function there is a visible act
with a review attached, where adding one to a schema that was already exposed
by default was not.

**It is not a service layer in the database.** The functions contain no business
logic beyond the authorisation check and the concurrency predicate. Validation
that belongs to the domain stays in the domain (`Quantity.fromString`,
`normaliseSku`, the form rules) and validation that belongs to the data stays in
constraints. The RPC's job is to make the *statement* unforgeable.

### No table keeps a client-reachable write path

The previous draft ended this section with a table of "residual `UPDATE` grants",
including one genuine exception: a user editing their own `profiles` row. With
`app_data` unexposed that table is empty, and the exception is gone with it —
not because the reasoning was wrong, but because there is no longer a route for
it to apply to.

| Entity | Client write path |
| --- | --- |
| products, suppliers, customers, customer_statuses | `api.create_*` / `api.update_*` / `api.set_*_active` |
| own profile display name | `api.update_own_profile(p_display_name)` — the policy is still `user_id = auth.uid()`, now reached through a function like everything else |
| projects and children | one aggregate-save RPC (R5) |
| purchase orders, shipments, receipts, reservations, outbound | lifecycle RPCs with cross-table rules |
| `inventory_movements` | **none** — no grant at all; the three `SECURITY DEFINER` posting functions are the only writers (§12) |

`update_own_profile` is a small loss of elegance and a real gain in uniformity:
there is now exactly one sentence describing how a client writes anything, and no
reader has to hold an exception in mind.

### The general rule, restated

The second half of the classification rule is unchanged and is the one that
matters most for the operational phases: a client that reads available stock and
then posts a dispatch has a window between the two in which someone else
dispatched. No amount of client-side care closes it. A function does, because the
read and the write are the same transaction.

### Security mode: invoker by default

**Business RPCs are `SECURITY INVOKER`** (the PostgreSQL default). They run as the
caller, so row-level policies still apply *inside* them — the tenant check is
automatic and the function's body only has to enforce the *business* invariant.
Transactionality is unaffected: a `plpgsql` function is a single transaction
regardless of its security mode.

**`SECURITY DEFINER` is a privilege escalation and is used only where the function
genuinely needs a privilege the caller does not have.** There are three such
places, and every one of them re-proves the caller's membership and role as its
first statement:

- the **membership helpers** in §7, which must bypass RLS to avoid recursion.
  `authenticated` holds `EXECUTE` on them because policy evaluation requires it —
  and they remain uncallable because `app_private` has no route;
- the **three ledger-posting functions**, which must write a table the caller has
  no `insert` grant on (§12) — which is what makes Data Model I7 a permission
  rather than a convention;
- the **restore and import functions**, which must delete and repopulate tables
  no client may delete from, and which re-prove OWNER authority before anything
  else (§16).

Everything else — including all thirteen catalog and identity mutation RPCs — is
`SECURITY INVOKER`. The distinction is worth keeping sharp: `update_product`
takes the *shape of the statement* out of the client's hands, not the
*authorisation*. It needs no extra privilege, so it is not given one.

```sql
create function api.post_warehouse_receipt(p_organization_id uuid, …)
returns … language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.has_org_role(p_organization_id,
                                  array['OWNER','ADMIN','MEMBER']) then
    raise exception 'not an active member of this organization'
      using errcode = '42501';
  end if;
  …
end $$;

revoke execute on function api.post_warehouse_receipt(uuid, …) from public, anon;
grant  execute on function api.post_warehouse_receipt(uuid, …) to authenticated;
```

### The classification

Every row below is an object in `api`. Nothing else is reachable.

| Operation | Path | Why |
| --- | --- | --- |
| Product / Supplier / Customer / customer status — list, read | `select` on the `api.<entity>` **view** — `security_invoker`, decimals already text (§7, §10) | every rule is a policy; the view adds a cast and subtracts nothing |
| Product / Supplier / Customer / customer status — create | **typed RPC** — `api.create_product`, … | no table route exists; tenant by check + `with check`, uniqueness by index, identity and time by trigger, `version = 1` by definition |
| Product / Supplier / Customer / customer status — update | **typed RPC** — `api.update_product`, … | the `version` predicate must not be a clause the client can omit |
| Deactivate (`active = false`) | **typed RPC** — `api.set_product_active`, … | same reason, and it must not be able to carry a field edit |
| Own profile display name | **typed RPC** — `api.update_own_profile` | `app_data.profiles` has no route either; uniformity beats one exception |
| Project + requirements + quotes + quote items — save | **RPC** | one aggregate, many rows; R5 says they are written together |
| Purchase order placement (`DRAFT → ORDERED`) | **RPC** | allocates the code from a counter, freezes commercial fields, and changes status — one transaction or none |
| Purchase order `CLOSED` / `CANCELLED` | **RPC** | I12: cancellation must be refused where receipts exist, which is a cross-table read |
| Warehouse receipt posting | **RPC** (`SECURITY DEFINER`) | receipt + lines + one movement per line, atomically. The canonical rule since Phase 6.5 |
| Outbound dispatch | **RPC** (`SECURITY DEFINER`) | status + movements + the negative-stock decision |
| Manual movement / stock count / opening balance | **RPC** (`SECURITY DEFINER`) | ledger append with I10/I11 checks |
| Reservation create or increase | **RPC** | reads available stock and then writes — the textbook time-of-check/time-of-use race (§9) |
| Reservation close / cancel | **RPC** | one row, but not a free one: an `ACTIVE` reservation is a term in `reservedStock` (I2), so its status is part of the stock invariant. A direct update could omit the version, or move a `CLOSED` reservation back to `ACTIVE` and silently re-commit stock that has since been promised elsewhere. The RPC checks the transition is legal and takes the product lock |
| Portable organisation export | **RPC** (read-only) | one consistent read across every table |
| Organisation import / restore | **Edge Function + RPC** | privileged, destructive, OWNER-only, needs a pre-restore archive |
| Provision / disable a user | **Edge Function** | creating an `auth.users` row requires the Admin API and the secret key |

Two Edge Functions in total. Everything else is a view or a `plpgsql` function in
`api`, which means the deployment surface is *the database migrations* —
versioned, reviewable, and testable locally. **And it means the client surface is
enumerable**: `\dv api.*` and `\df api.*` list the entire API, which is a property
worth having at an audit.

---

## 9. Concurrency and transactions

### Optimistic concurrency: `version`, not `updated_at`

The existing contract — load a record, send back the `updatedAt` you loaded,
refuse the write if the stored value moved — is **preserved in behaviour and
changed in token**:

```sql
update app_data.products
   set name = $3, …
 where id = $1
   and organization_id = $2
   and version = $4          -- the value the client loaded
returning *;
```

Zero rows returned means the version moved. The gateway maps that to the existing
`STALE_WRITE` code, which the existing `persistenceText.ts` already translates to
*"bu kayıt başka bir yerde değişti — yeniden yükleyin"*. **The user-facing
contract does not change at all.**

### …and that statement lives on the server, not in the client

The predicate above is the whole protection, so **where it is written decides
whether it is a protection at all.** It is inside `api.update_product` /
`api.set_product_active` / their siblings, and the table it updates —
`app_data.products` — **has no Data API route at all** (§7).

That is a correction to two earlier drafts. The first had the client send this
statement through PostgREST, which is no protection: a statement a client
composes is a statement a client can compose differently, and dropping
`and version = $4` produced a valid, authorised, RLS-confined request that
silently overwrote someone else's edit. The second withdrew the `UPDATE` grant,
which closed that particular hole but left the table itself addressable in an
exposed schema.

So the invariant is now a property of routing rather than of privilege or of the
client's good behaviour:

> **A client cannot bypass stale-write protection by crafting a different
> PostgREST request**, because no request reaches the table. The only paths into
> `app_data.products` are the `api` view (read-only) and the `api` mutation
> functions, each of which requires `p_expected_version` in its signature.

Proven by B9 in §7: a hand-crafted `PATCH /rest/v1/products` returns no route.

`version` and the `STALE_WRITE` outcome are otherwise exactly as described: the
argument is mandatory, zero affected rows raises, and the message the user reads
is unchanged.

Why a counter rather than the timestamp:

1. **`now()` is transaction time, not statement time.** Two updates to the same
   row inside one transaction receive an identical `updated_at`, which makes the
   token non-monotonic in exactly the situation an RPC creates.
2. **Timestamps invite comparison.** A value that looks like a clock reading will
   eventually be used to decide which of two writes is *newer* — and across
   devices, ordering by a timestamp is ordering by whoever's clock is wrong. A
   counter admits no such reading: it answers "is this the version I read?" and
   nothing else.
3. It costs one `integer` column and one line in the trigger that already exists.

`updated_at` remains on every record as server-set metadata for display and audit.
It is never a concurrency token and never an ordering key.

### Clocks: who is allowed to state a time

| Value | Source | Reason |
| --- | --- | --- |
| `created_at`, `updated_at` | **server** (`now()`, by trigger) | system facts; a client clock must never define them |
| `recorded_at`, `posted_at` | **server** | when the row was written is a system fact |
| `occurred_at` (inventory movement) | **client** | a *business* fact the user states: "this actually happened yesterday afternoon". Data Model §2 already separates the two, and this is where that separation earns its keep |
| business dates (`order_date`, `eta`, …) | **client** | user input, `date` type, no zone, no clock involved |

The rule in one line: **the server owns every value that answers "when did the
system learn this"; the user owns every value that answers "when did it happen".**

### Serialising stock decisions: `FOR UPDATE` on the product row

The inventory races — two reservations for the last units, a reservation racing a
dispatch — are all the same shape: read a derived total, decide, write. The
serialisation point is the **product row**:

```sql
-- inside reserve_stock(...) / post_dispatch(...)
perform 1 from app_data.products
 where id = p_product_id and organization_id = p_organization_id
   for update;               -- every stock decision for this product queues here

-- now the reads below cannot be overtaken
select coalesce(sum(case when direction = 'IN' then quantity
                         else -quantity end), 0)
  into v_physical
  from app_data.inventory_movements
 where organization_id = p_organization_id and product_id = p_product_id;
…
```

Why the product row and not something else: the ledger is append-only, so there is
no row there to lock; a table-level lock would serialise the whole warehouse. The
product is the natural granularity — two operations on the same product queue,
two on different products do not block each other at all, and the lock is released
by the commit that made the decision real.

**`SERIALIZABLE` isolation was considered and rejected**: it is correct, but it
pushes serialisation-failure retry handling into every caller, for a 2–5 user
pilot where the contended case is two people touching the same product within the
same second. `FOR UPDATE` is simpler, needs no retry loop, and is easier to prove
correct in a test.

### Uniqueness is a database constraint, not a check

| Rule | Mechanism |
| --- | --- |
| SKU unique per organisation, trimmed, case-insensitive | `unique index on products (organization_id, lower(btrim(sku)))` |
| Human code unique per organisation | `unique (organization_id, code)`; allocated inside an RPC from a `counters` row locked `for update`; gaps tolerated (already the rule) |
| One membership per user per organisation | `primary key (organization_id, user_id)` |
| A movement's unit equals the product's stock unit (I11) | checked inside the posting function, which reads the product it has already locked |

The IndexedDB implementation had to solve SKU uniqueness with a full-store scan
inside the write transaction, because IndexedDB compares string keys by code unit
and cannot express a case-insensitive unique index. Postgres can, and the race
disappears into the index.

**One implementation constraint to carry into Phase 11, named here so it is not
discovered later.** `normaliseSku` in the client folds case with
locale-independent `toLowerCase()`, deliberately, so that SKU identity does not
depend on the selected language. Postgres `lower()` is collation-dependent and the
two can disagree on Turkish `İ`/`I`. Phase 11 must prove they agree with a test
over a Turkish-character fixture, and where they do not, **the database expression
is authoritative and the client function changes to match** — the client's check
exists for the error message, not for the guarantee.

---

## 10. Money, quantities and exact decimals

The financial engine's contract is unchanged, and this section exists to keep it
that way.

### Column types

| Value | Type | Constraint |
| --- | --- | --- |
| money amount | `numeric` — **no precision, no scale** | paired with a `…_currency text` column, `check (… ~ '^[A-Z]{3}$')` |
| quantity | `numeric` | `check (value >= 0)` — matching `Quantity`'s construction-time rule |
| exchange rate | `numeric` | `check (rate > 0)` |
| percentage | `numeric` | "5" means 5%, unchanged from `Percentage` |

**Never `numeric(10,2)` or any other fixed scale.** The engine's settlement
envelope is defined by `DECIMAL_PRECISION` in
`domain/monetary/decimal.ts`, not by a column width, and Round 2 Checkpoint 3
exists because an accepted input settling to the wrong cent is a real defect class
in this codebase. A column-level scale would round an input the engine accepts,
silently, before the engine ever saw it — reintroducing exactly that defect at the
storage layer. `numeric` without a scale is arbitrary-precision and stores what it
is given.

**Never `float`, `double precision`, or PostgreSQL's `money` type.** The first two
cannot represent `0.0047`; the third is a locale-dependent fixed-point type whose
scale is a server setting.

A money amount is always **two columns**, never one. `unit_price_amount` +
`unit_price_currency`. The `Money` type refuses to combine two currencies by
construction; storing an amount without its currency beside it would make the
database the one place that rule does not hold.

### Where rounding happens: nowhere in the database

The database stores **exact source precision** and performs **no settlement**. It
does not round, does not resolve a minor unit, and does not compute a landed
total. Currency settlement remains where it already is: one named stage in the
engine (`Money.roundToMinorUnit`, driven by `CurrencyMinorUnit.resolveMinorUnit`),
producing `settledLandedTotal` as the authoritative commercial figure.

The database performs exactly one kind of arithmetic on stored decimals:
**`sum()` over ledger quantities** for stock derivation. That is exact `numeric`
addition of non-negative quantities with no rounding anywhere in it, and it agrees
with the client's `Quantity` arithmetic because both are exact decimal addition of
the same values.

### The wire format, and a real hazard

**PostgREST serialises a `numeric` column as a JSON number, and `JSON.parse` in
JavaScript turns a JSON number into an IEEE-754 float64.** A value of
`12345678901234567890.0047` does not survive that round trip, and neither, in the
general case, does `0.1`. This is the single most dangerous detail in the whole
cloud port, because it fails silently and produces plausible numbers.

The rule that closes it:

> **`numeric` is the storage type. The wire format is a canonical decimal
> string.**

### …and it is a server invariant, not a client convention

An earlier draft stated the rule above, put the casting view beside the table in
`public`, and left `authenticated` holding `select` on both. Since `public` **is
an exposed schema**, a client that asked for the table instead of the view
received `numeric` columns as JSON numbers and destroyed them on `JSON.parse`.
The rule was true of the path the client was *expected* to take, which is not
what the word "invariant" means.

The fix is §7's schema separation, and it is what makes the two statements below
enforceable rather than aspirational:

> **No canonical business table is directly addressable through the Supabase Data
> API.**
>
> **Every client-visible exact decimal is returned only through an `api`
> projection or RPC that serialises it as canonical text.**

- **Reads** go through `api.<entity>` views that cast every decimal column to
  `text`. The client receives `"12.5"` and hands it to `Quantity.fromJSON` /
  `Money.fromJSON` — the existing contract, unchanged. There is no second route
  that returns the same field as a number, because `app_data` is not exposed.
  One precision about what that means (Audit A, A-L9): PostgREST lets a caller
  ask for a cast in `select` — `select=units_per_purchase_unit::numeric` returns
  a JSON number. No route does it by default and the supported client never
  asks; the gateway also refuses any decimal that does not arrive as a
  canonical string. The invariant is therefore a property of the projection
  plus the supported client, not a claim that a deliberately crafted request
  cannot choose a lossy representation for itself.

  **Every such view is created `with (security_invoker = on)`.** This is not a
  footnote: a PostgreSQL view executes with its *owner's* privileges by default,
  and a view created by `postgres` over an RLS-protected table returns **every
  tenant's rows**. The cast that makes the decimals safe would be the thing that
  makes the data unsafe. §7 has the full rule; pgTAP P6/P7 and behavioural proofs
  B1/B2 are the evidence.
- **Writes** send the canonical decimal string produced by the existing
  `.toJSON()`, as a `text` parameter on the mutation RPC, which casts it to
  `numeric` (§8). The string never becomes a JavaScript `number` on either side
  of the wire.
- **RPC return types are the `api` view, never the `app_data` table.** A function
  returning a table row hands PostgREST a `numeric` and the hole reopens on the
  write path — the one door that would still have been open after the schema
  split. §8 makes this a property of every business RPC.

**Proof, not intention.** §7's B6 asserts exact string equality against the raw
response body for `12345678901234567890.0047` — a value whose float64 round trip
visibly destroys both the integer part and all four decimals — and B5/B7 assert
that no JSON-number route exists for the same field. Together those are the
difference between a documented rule and an enforced one.
- **No arithmetic is ever performed on a value in JavaScript's `number` type.**
  The existing engine already never does this; the gateway must not become the
  first place that does.
- **The engine round trip, too.** Phase 11 ports
  `persistence/engineIsolation.test.ts` — which today runs `compareSuppliers()`
  before and after a local save/load round trip and requires identical results —
  into a cloud sibling that round-trips through PostgreSQL. If the engine's answer
  changes because data went to a server and came back, that test fails.

The same rule applies to timestamps for a smaller reason: PostgreSQL returns
`timestamptz` as `2026-09-21T15:04:05.123456+00:00`, which the existing
`expectInstant` validator rejects (it expects `…123Z`, milliseconds, `Z`). The
`api` views normalise it with `to_char(… at time zone 'utc', …)` rather than
leaving it to the gateway, for the same reason the decimals are cast there: one
place, no second route, nothing to remember.

---

## 11. The PostgreSQL model

Identity and shape rules that apply to **every** business table, from the first
one to the last:

0. **It lives in `app_data`, which is not exposed** (§7). Its client surface is
   whatever `api` projects from it, and nothing else. Every table name below is
   `app_data.<name>` even where the schema is elided for readability.
1. `id uuid primary key default gen_random_uuid()` — but **the client generates
   it** with `crypto.randomUUID()`, as it does today. This is safe (a colliding id
   is refused by the primary key; a guessed id is invisible under RLS) and it lets
   the client build a whole aggregate graph before sending it. The default is the
   fallback for server-created rows.
2. `organization_id uuid not null references app_data.organizations(id)`.
3. `unique (id, organization_id)` on every parent, to carry the composite child FK.
4. `created_at`, `updated_at timestamptz not null default now()` — trigger-owned.
5. `created_by`, `updated_by uuid references auth.users(id)` — trigger-owned.
6. `version integer not null default 1` — trigger-incremented.
7. `active boolean not null default true` where the entity is master data (§12).
8. RLS enabled **and forced**; the four-policy pattern; explicit grants; no
   `delete`.
9. Decimals as `numeric`; money as amount + currency; **projected as `text` by
   `api`**, never returned from a table or an RPC that returns a table row.

And one rule about the other side of the boundary:

10. **Every table in `app_data` that a client needs gets exactly one `api` view
    and its set of `api` functions.** `api` holds no base tables (pgTAP P13), and
    an object added there is a published API with a review attached — which is
    the property that makes the surface enumerable and auditable.

### Group 1 — MUST EXIST for the cloud foundation (Phase 10)

| Table | Contents |
| --- | --- |
| `organizations` | `id`, `name`, **`write_locked_at`, `write_locked_by`, `write_lock_reason`** (the restore write gate, §16), timestamps |
| `memberships` | `(organization_id, user_id)` PK, `role`, `status`, timestamps |
| `profiles` | `user_id` PK → `auth.users`, `display_name`, `must_change_password`, timestamps |
| `provisioning_attempts` | `request_id` PK, `organization_id`, `email`, `status`, `created_at` — the idempotency record for §4 |
| `admin_events` | append-only record of membership changes, imports and restores (§21) |
| `counters` | `(organization_id, key)` PK, `next_value` — human-code allocation |

Plus the `app_private` schema and its helper functions, the shared triggers
(stamping, tenant immutability, **write-gate**), and the pgTAP suite that proves
the pattern holds.

`maintenance_until` is **not** in this list. It was the earlier, broken form of
the write gate and is replaced by the three `write_lock*` columns for the reasons
in §16 — a holder identity is required, and an expiring timestamp is the one
thing the gate must not be.

### Group 2 — NEXT PHASE (Phase 11, catalog migration)

`products`, `suppliers`, `customers`, and `customer_statuses`.

The first three are the tables Phase 9 already has screens for, which is what
makes Phase 11 a migration rather than a feature. The fourth is new, and it
arrives here rather than later because it is a `customers` column: adding it in
the same phase costs one table and one nullable FK, and adding it afterwards
costs a migration over live company data.

```sql
-- Organisation-configurable customer classification. NOT an enum.
create table app_data.customer_statuses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references app_data.organizations(id),
  code             text not null,          -- 'C', 'A', 'A+', 'A++', or anything
  sort_order       integer not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  version          integer not null default 1,
  unique (id, organization_id),
  constraint customer_statuses_code_not_blank check (btrim(code) <> '')
);

create unique index customer_statuses_org_code_key
  on app_data.customer_statuses (organization_id, lower(btrim(code)));

-- deterministic display order, and a stable tiebreak so it never wobbles
create index customer_statuses_order_idx
  on app_data.customer_statuses (organization_id, sort_order, lower(btrim(code)));

-- customers gains one nullable reference, tenant-safe by composite FK
alter table app_data.customers
  add column customer_status_id uuid,
  add constraint customers_status_fk
    foreign key (customer_status_id, organization_id)
    references app_data.customer_statuses (id, organization_id);
```

Why it is a table and not an enum, in either language: the values the pilot
company uses today are `C`, `A`, `A+`, `A++`, but that list is **theirs**, and a
`create type … as enum` or a TypeScript union would make adding `B` a schema
migration and a release. A second organisation would need a different list
entirely. The classification is configuration, so it lives in a table — and it
lives in an **organisation-scoped** table, under the same RLS as everything else,
so one company's grading scheme is invisible to another.

Four rules the shape encodes:

- **A customer has zero or one current status.** A nullable FK, not a join table.
  Status *history* is not in scope — this answers "what grade is this customer
  now", and a history table would be a CRM concept the product does not have.
- **Deactivating a status does not break history.** `active = false` removes it
  from the picker for new assignments; every customer already carrying it keeps
  it, keeps displaying it, and is not silently reclassified. This is `active`
  meaning exactly what it means everywhere else in this model (§22 of
  [Data Model](DATA_MODEL.md) — deactivation, never deletion), and it is why the
  FK is to the status row rather than a copied string.
- **Display order is deterministic.** `sort_order` first, then case-folded
  `code` — because `A+` and `A++` do not sort usefully by any natural rule, and a
  list whose order changes between two screens is a list nobody trusts.
- **`code` is unique per organisation, case-insensitively**, by the same index
  technique as SKU (§9), including the Turkish-collation caveat recorded there.

Deliberately **not** added: colour, weight, discount percentage, credit limit,
payment terms, or any behaviour attached to a grade. A status is a label the
company sorts and filters by. The moment it starts *doing* something — driving a
price, gating a reservation — it stops being a label and becomes a pricing model,
which is CRM and is out of scope ([Product Scope](PRODUCT_SCOPE.md) §6).

#### External system code — an opaque string, on purpose

The company identifies customers and suppliers with codes from an existing
system:

```text
customer   120-34-00-11-001
supplier   320-…
```

A partial reading is known from the owner: `120` marks a customer and `320` a
supplier, `34` is the Turkish province plate code, `00` and `01` distinguish the
Anatolian and European sides of Istanbul, and `11-001` is **currently unknown**.

**Nothing in that paragraph is encoded in the schema, and that is the decision.**

```sql
-- customers already has external_ref (Data Model §4).
alter table app_data.suppliers add column external_ref text;
```

One nullable `text` column on each party table, storing the code exactly as the
user typed it. No split into prefix / province / side / sequence. No `check`
constraint on the format. No uniqueness. No generation. No parsing anywhere in
the application.

The reason is that the interpretation is **partial and unverified**. A schema
that encodes `34 = province` is a schema that rejects the first foreign supplier,
mis-files the first record that breaks the pattern, and has to be migrated the
moment the real rule turns out to be something else — and `11-001` being unknown
means the real rule is, by definition, not yet known. Encoding a guess costs a
migration over live data; storing a string costs nothing and loses no
information, because the full code is retained verbatim.

Uniqueness is deliberately **not** imposed either. It is plausible that the codes
are unique, and plausible that the pilot data contains duplicates, blanks or
historical variants. A unique index added before that is known turns the first
import into a debugging session; it can be added later in one migration once the
data has been looked at.

UI wording becomes **"Dış Sistem Kodu" / "External System Code"**. The canonical
field name stays `externalRef` / `external_ref`: it already exists on `Customer`,
it already means "this record's identifier in some other system", and renaming a
field to match one company's vocabulary would be the wrong direction for a name
the schema will carry for years.

**A future analysis checkpoint is scheduled for this** — see §26. Only after real
spreadsheets have been examined may parsing, validation, uniqueness or code
generation be designed, and each of those is an additive change to a column that
already holds the data.

### Group 3 — Procurement analysis (Phases 13–15)

`projects`, `requirement_items`, `quotes`, `quote_items`, `project_suppliers`
(the join that replaces `supplierIds`), `exchange_rates`, `additional_costs`.

### Group 4 — FUTURE OPERATIONS (Phases 16–19)

`purchase_orders` + `purchase_order_lines`, `inbound_shipments` +
`inbound_shipment_lines`, `warehouse_receipts` + `warehouse_receipt_lines`,
`inventory_movements`, `inventory_reservations`, `outbound_shipments` +
`outbound_shipment_lines`.

**These are not created now.** Creating a table is cheap; creating a table whose
shape is guessed a year before anything writes to it is how a schema acquires
columns nobody can explain. The shape rules above are what prevent a dead end —
not the tables themselves.

### Lines become child tables

The IndexedDB design embedded document lines in their parent record because
IndexedDB has no joins and no foreign keys, so an aggregate had to be one value to
be written atomically. Postgres has both, and
[Data Model](DATA_MODEL.md) §13 already anticipated the change: *"aggregates with
embedded lines map to parent/child tables with a foreign key; the aggregate
boundary is already the transaction boundary."*

So lines are child tables, and R5 ("aggregates own their lines") is preserved by
the thing that always enforced it — the transaction. A parent and its lines are
written by one RPC, in one transaction, or not at all. What is gained: real
foreign keys from a line to a product, the composite tenant FK of §5, and derived
progress (`receiptProgress`, `onOrder`) as a SQL aggregate rather than a scan of
parsed JSON.

### The inventory ledger, in Postgres

```sql
create table app_data.inventory_movements (
  id              uuid primary key,
  organization_id uuid not null references app_data.organizations(id),
  product_id      uuid not null,
  type            text not null check (type in (…seven types…)),
  direction       text not null check (direction in ('IN','OUT')),
  quantity        numeric not null check (quantity > 0),   -- magnitude
  unit            text not null,
  occurred_at     timestamptz not null,   -- business fact, client-stated
  recorded_at     timestamptz not null default now(),      -- system fact
  source_kind     text not null,
  source_id       uuid,
  reason          text,
  reversal_of_movement_id uuid references app_data.inventory_movements(id),
  note            text,
  posted_by       uuid not null references auth.users(id),
  constraint inventory_movements_product_fk
    foreign key (product_id, organization_id)
    references app_data.products (id, organization_id),
  constraint inventory_movements_reversed_once unique (reversal_of_movement_id)
);
```

Note what is absent and what is present:

- **no `updated_at`, no `version`** — there is no update. Append-only is the
  mutability class, and the absence of the columns says so (Data Model §2).
- **`unique (reversal_of_movement_id)`** enforces half of I10 — *a movement may be
  reversed at most once* — as a constraint rather than a check the posting
  function has to remember.
- `posted_by not null` — attribution on an immutable row, permanent by
  construction (§21).
- magnitude + direction, not a signed number, unchanged from Data Model §9.

---

## 12. Inventory safety under concurrent users

The domain principle is **unchanged**, and this section is only about enforcing it
when two people act at once:

```text
physicalStock   = Σ(IN) − Σ(OUT)            over the movement ledger
reservedStock   = Σ remainingReserved        over ACTIVE reservations
availableStock  = physicalStock − reservedStock

purchase orders and shipments affect NONE of these  (I5, I6)
receipts post stock IN; dispatches post stock OUT   (I7)
```

Three mechanisms make it hold:

**1. Only three code paths can write the ledger — enforced as a permission.**
`authenticated` has **no `insert` grant** on `inventory_movements`. The only
writers are the three `SECURITY DEFINER` posting functions (receipt, dispatch,
manual). Data Model I7 stops being a rule the code review has to catch and becomes
something the database refuses. There is no direct-insert path to forget about.

**2. A posted movement cannot be changed — enforced twice.** No `update` or
`delete` policy, no `update` or `delete` grant, plus a `before update or delete`
trigger that raises unconditionally — so even a `SECURITY DEFINER` function
written in a future phase cannot edit history. I9 becomes structural. Corrections
remain what Data Model §9 already says they are: a new reversal movement.

**3. The decision and the write are one transaction, behind the product lock.**

```text
post_dispatch(org, shipment, lines[], allow_negative):
  ── one transaction ──
  assert active membership
  for each distinct product in lines:
      SELECT … FROM products WHERE id = … FOR UPDATE   ← serialisation point
  recompute physical / reserved / available from the ledger and reservations
  if a line would push physical below zero and allow_negative is false:
      raise  (Open Decision 7: allowed, but only behind explicit confirmation)
  update outbound_shipments  … status = 'DISPATCHED', dispatched_at = now()
  insert one inventory_movements row per line, direction 'OUT'
  ── commit ──
```

The reservation guard (I4, *may not make available negative*) is the same shape
with the opposite sign and no override — a reservation is a promise about the
future and refusing an impossible one is safe, which is Open Decision 6, unchanged.

**What this buys that the local design could not.** User A reserving the last 10
units and user B dispatching them at the same moment now queue on the same product
row. One of them commits; the other recomputes against the committed result and
either succeeds or is refused with a reason. Neither can observe a total that was
true a moment ago and act on it. That is the guarantee two independent IndexedDB
databases cannot offer at any price, and it is the reason this checkpoint happens
before Phase 16 rather than after.

**Not implemented in Phase 9.5.** No table, no function and no test from this
section exists yet. Phase 16 owns it.

---

## 13. What happens to IndexedDB

**Strategy: ONLINE-FIRST / SERVER-AUTHORITATIVE. IndexedDB is retired as a
business database.**

Store by store:

| Store | Fate | Note |
| --- | --- | --- |
| `products`, `suppliers`, `customers` | **RETIRE** | migrated to Postgres in Phase 11; the local stores are then dropped |
| `projects` | **RETIRE** | migrated in Phase 13 |
| `counters` | **RETIRE** | code allocation must be server-side to be unique across devices |
| `purchaseOrders`, `inboundShipments`, `warehouseReceipts`, `inventoryMovements`, `inventoryReservations`, `outboundShipments` | **DROP** | these stores have never held a record — no code path writes them. There is nothing to migrate |
| `snapshots` | **RETIRE** | an undo layer over a non-authoritative cache protects nothing |
| `settings` | **MOVE to `localStorage`** | locale, list sort, last route — device preferences, which is what `landedcompare.locale` already is |
| `meta` | **RETIRE** | `installId` and local schema version describe a database that no longer exists |

**The local database is dropped entirely, in Phase 11**, once the last
authoritative store is empty. Keeping a versioned IndexedDB with a migration
chain, a boot gate and a snapshot policy to hold three UI preferences would be
paying the full cost of the Phase 7 machinery for none of its value.

### No local read cache in the MVP

Explicitly decided, with a reason: a cache reintroduces the question *"is what I
am looking at current?"* on every screen, which is the exact question this
checkpoint exists to eliminate. The existing UI already re-reads after every
mutation — `useMasterDataList`'s "persist first, then reflect" — and against a
server on an office LAN that read is not perceptible.

**OPTIONAL FUTURE**, with preconditions that are part of the decision: a cache may
be added for read-only list acceleration only, must carry a visible
"son güncelleme" marker wherever cached rows are shown, must be visually
distinguishable from live data, and must never be a write target or a fallback
that the user cannot tell apart from the real thing.

### What survives, and it is the valuable part

The **boot gate** is the best idea in Phase 9 and it transfers unchanged in
principle: *no business data renders until the application knows it has a working
data source.* Locally that meant "the database opened". In the cloud it means:

```text
  session valid  →  server reachable  →  membership resolved  →  READY
       │                  │                      │
       ▼                  ▼                      ▼
  SIGNED_OUT         UNAVAILABLE            NO_MEMBERSHIP
  (sign-in screen)   (§17)                  ("bu hesap bir şirkete bağlı değil")
```

and in none of the three failure states does a screen render an empty list. An
application that shows an empty product table because the server is unreachable
has told the user their catalogue is gone, and the natural response is to start
re-entering it. That reasoning is in `src/app/bootstrap.ts` today and it is more
important against shared data, not less.

---

## 14. No dual-master sync — an accepted product limitation

**Question:** should two people be able to edit shared business records offline on
two computers and merge them later?

**Answer: no. Rejected for the MVP and for the foreseeable product.**

The reasoning is §1's, restated as a decision:

1. The product's central invariants are **global constraints**, not per-record
   state. Available stock, unique order codes and reservation totals are
   statements about the whole organisation. Offline replicas can each satisfy them
   and jointly violate them, and a merge can only pick a loser after both users
   have already acted on the answer.
2. For the records where a merge *is* theoretically possible — editing a
   supplier's name on two machines — there is no correct generic resolution.
   "Last write wins" is a coin flip dressed as a policy. This is the reasoning
   [Product Scope](PRODUCT_SCOPE.md) Open Decision 10 already used to refuse
   merge-mode restore on one machine; it is stronger, not weaker, with more
   machines.
3. The failure mode is silent. A stale-write refusal is visible and actionable; a
   merge that resolved wrongly is a number that is quietly incorrect, discovered
   during a stock count weeks later.

### The limitation, stated plainly

> **Internet access is required to create or change business data.** Without a
> connection, the application shows an unavailable state and all save actions are
> disabled. Reading is unavailable too, because nothing is cached.

For an office pilot this is acceptable: the alternative on offer is not "keep
working", it is "keep working and find out later that the stock figure was wrong".
It is recorded in [Product Scope](PRODUCT_SCOPE.md) as a known limitation rather
than hidden as an implementation detail.

**One thing that is not an offline feature and must not be confused with one.** If
a save fails because the connection dropped, the form **keeps its contents** — the
user's typing is in React state and is not discarded, and the error says
*"sunucuya ulaşılamadı, yeniden deneyin"* with a retry. That is the difference
between "no offline support" and "loses your work", and it is a UI requirement,
not a sync mechanism. Nothing is queued, nothing is persisted, and nothing is
retried automatically.

---

## 15. Migrating the current local data to the cloud

Currently the local data is test data. The path is designed anyway, because the
mechanism has to exist before anyone can be told it is safe to enter real master
data — and because the alternative, retyping, is how a catalogue acquires typos.

```text
 1  local app  →  "Bulut aktarımı için dışa aktar"
                  the existing Phase 8 envelope: magic, versions, entityCounts,
                  SHA-256 over canonical(data).  Already implemented.
 2  cloud app  →  OWNER-only import screen, file selected
 3  client-side validation — the existing prepareRestore() pipeline, unchanged:
                  size → depth → prototype-safe parse → magic → envelope →
                  schemaVersion → checksum → counts → payload migration →
                  per-record structural validation
 4  PREVIEW      per-store counts, file date, and what the organisation
                  currently contains
    ── everything above writes nothing ──
 5  confirm      explicit, typed, not a single OK
 6  RPC          import_organization_data(p_organization_id, p_payload)
                  ├ re-proves the caller is OWNER of that organisation
                  ├ REFUSES if the organisation already holds business data
                  │   (import is a bootstrap, not a merge — Open Decision 10)
                  ├ re-validates every record SERVER-SIDE
                  ├ stamps organization_id, created_by, timestamps, version = 1
                  └ inserts, in ONE transaction
 7  verify       counts compared against the envelope manifest inside the same
                  transaction; a mismatch aborts
 8  report       per-table counts, and only then does the local database stop
                  being canonical
```

Two rules worth stating separately:

- **The client-side validation is UX; the server-side validation is the control.**
  A payload that reached step 6 has been checked by a client the server does not
  trust. Every record is validated again inside the transaction. The client pass
  exists so the user sees a useful preview and a specific error, not so the server
  can skip work.
- **The payload's own `organization_id` values are ignored, not honoured.** Every
  inserted row is stamped with the organisation the *caller* proved membership of.
  A crafted file cannot write into another tenant; see §22, threat 12.

**Operational note for the owner, and it is a real one:** until Phase 11 exists,
data entered into the local application lives only in one browser profile on one
machine, and there is still no export button (Phase 9's honest limitation). Large
real master-data entry is better done *after* Phase 11 than before it. Small
amounts are fine and will migrate.

---

## 16. Backup and restore after the cloud

The Phase 8 backup system protects IndexedDB. Once PostgreSQL is authoritative,
that protection is worth nothing, and saying otherwise would be the most dangerous
sentence in this document. Two different things are needed, and conflating them is
the failure mode.

### A — USER PORTABLE BACKUP (a product feature)

An organisation-scoped export, in the format the pilot already has.

| | |
| --- | --- |
| **Who** | OWNER or ADMIN |
| **What** | one JSON file, one organisation's business data |
| **Format** | the existing envelope — `magic`, `backupFormatVersion` (**bumped**: records now carry `organization_id`, `version`, `created_by`), `schemaVersion`, `entityCounts` for every store including empty ones, SHA-256 over a canonical serialisation of `data` |
| **How** | a read-only RPC returns the payload from one consistent snapshot; the existing `canonicalJson` + `checksum` + `download` modules produce the file |
| **Covers** | products, suppliers, customers, projects, orders, shipments, receipts, the full movement ledger, reservations, outbound shipments, counters |
| **Does not cover** | auth users, memberships, other organisations, the schema, functions or policies |
| **Retention** | none, automatically — keeping and rotating files off-machine is a human process, with the same 7-day staleness reminder the local design already defines |

This is where most of Phase 8 survives, and it survives because it was written
storage-agnostically: the envelope, the canonical serialiser, the checksum, the
limits, the payload migration chain, the preview and the two-phase
prepare/apply split are all about *what a backup is*, not about where the data
came from.

The checksum's honest scope is unchanged and must be restated wherever it is
shown: **it detects corruption and truncation. It is not tamper-proofing and not
authentication** — there is no secret, so anyone who edits a payload can recompute
it.

### B — INFRASTRUCTURE DISASTER RECOVERY (an operator procedure, and a set)

Not a product feature, and not something an office user can perform.

**The claim this section previously made was too broad.** It said a weekly
`supabase db dump` covers "everything A does not: auth users, memberships,
profiles, multiple organisations, the schema, functions, triggers and policies."
Checked against the CLI reference, that is **not what the command does**:

> `supabase db dump` performs a **schema-only** dump by default, and **excludes
> Supabase-managed schemas — `auth`, `storage`, and those created by extensions**.
> Data requires `--data-only`; cluster roles require `--role-only`.

So one command produces neither the data nor the users. Believing otherwise is
the kind of error that is discovered on the one day it matters, which is why the
recovery story is now an explicit **set of artefacts**, each with a named source
of truth.

#### The Free-plan disaster-recovery set

| # | Artefact | Where the canonical copy lives | How it is produced |
| --- | --- | --- | --- |
| B1 | **Schema, functions, triggers, policies, grants** | **the Git repository** — `supabase/migrations/*.sql` | already version-controlled; `supabase db reset` rebuilds it from nothing. This, not a dump, is the authority (§20) |
| B2 | **Business data, all organisations — and the auth users with it** | weekly dump | `supabase db dump --linked -f data.sql --data-only --use-copy`. See the correction under B5: this file **does** contain `auth.users` rows |
| B3 | **Schema dump as a cross-check** | weekly dump | `supabase db dump --linked -f schema.sql` — schema-only, and it **excludes the Supabase-managed schemas**. Compared against B1 to catch drift, **not** used as the source of truth |
| B4 | **Cluster roles and grants** | weekly dump | `supabase db dump --linked -f roles.sql --role-only`. Logical dumps carry no role passwords; a restored custom login role needs its password set again |
| B5 | **Auth users** | **already inside B2**; separately targetable | `supabase db dump --linked -f authdata.sql --data-only --schema auth --use-copy`. See the correction below — an earlier version of this table was wrong about both halves of this row |
| B6 | **Edge Function source** | **the Git repository** — `supabase/functions/**` | nothing to dump; it is code |
| B7 | **Secrets** (`sb_secret_…`, any future SMTP credential) | **a password manager, never the repository** | recreated by hand on a new project; they are credentials, not data (§19) |
| B8 | **Hosted Auth configuration** — sign-up disabled, password policy, JWT expiry, redirect allow-list | **`supabase/config.toml` in the repository**, plus a short written checklist | `config.toml` is the declared form; the checklist exists because not every hosted setting is guaranteed to be pushed from it, and the gap must be closed by a human who knows what to look at |
| B9 | **The JWT secret** | password manager | if a new project does not reuse it, every existing session is invalidated (users sign in again — acceptable) and **the API keys are regenerated**, which means rebuilding the clients |

#### A correction: what each dump command actually produces

The rows above were checked against the pinned CLI (2.117.0) by running every
variant and reading the generated `pg_dump` invocation and the resulting file.
Two claims in the earlier version of this section were **wrong in opposite
directions**, which is worse than one of them being wrong, because together they
described a recovery set that omitted the users while appearing to include them.

| Command | What it actually contains |
| --- | --- |
| `db dump` (no flags) | `pg_dump --schema-only`, with `--exclude-schema` covering the Supabase-managed schemas. **Schema only. No data. No `auth`.** |
| `db dump --role-only` | cluster roles |
| `db dump --data-only --use-copy` | `pg_dump --data-only --schema '*'` with an exclude list that **does not contain `auth`**. So this file carries `COPY "auth"."users"` **and** every business table. Only `auth.schema_migrations`, `storage.migrations` and `supabase_functions.migrations` are excluded |
| `db dump --schema auth` | `pg_dump --schema-only --schema=auth`. **Table definitions for the `auth` schema and ZERO user rows.** A file produced by this command and filed as "the Auth backup" is an empty promise |
| `db dump --data-only --schema auth --use-copy` | the `auth` rows on their own — a targeted subset of what the plain data dump already holds |

So: **the users are in the ordinary data dump**, and the command that names
`auth` in its flags is the one that does *not* contain them. The earlier text
said the reverse of both.

#### Auth recovery: the honest assessment

Supabase documents that the `auth` schema — including users and their password
hashes — *can* be copied between projects, and that reusing the original JWT
secret keeps existing tokens valid. So capturing the users is possible, and per
the correction above it happens by default.

It is still the artefact this architecture is **least willing to promise**, for
two reasons that survive the correction: restoring into the `auth` schema of a
*managed* service is a project-migration procedure rather than a routine
restore, and its internals are Supabase's to change; and it has never been
rehearsed here. What changed is that the *capture* is no longer the weak link —
the *restore* is.

**So the guarantee is stated at the level it has actually been earned:**

> **Guaranteed:** the schema (B1), all business data (B2) and every
> organisation's membership structure can be rebuilt. Who the users are, what
> they are called, and what role each holds is recoverable, because the
> **portable organisation export (A) carries a `members` manifest** — e-mail,
> display name, role, status — for exactly this purpose.
>
> **Not guaranteed:** that password hashes and Auth identities survive into a new
> project. If they do, nobody has to do anything. If they do not, the documented
> fallback is that an OWNER re-provisions each account through
> `admin-provision-user` (§4) and the membership rows are re-linked by e-mail
> from the manifest. **For two to five users that is twenty minutes of work, not
> a data loss.**

The `members` manifest is the piece that makes the fallback work, and it is worth
being precise about what it is and is not: it contains **no credential and no
password material**, it is not restorable as Auth state, and it exists solely so
that "who should have access, and as what" is recoverable from a file an
administrator already has. Adding it to the export is a Phase 12 deliverable.

**Phase 21 turns the assessment into a fact.** The recovery drill restores B1–B5
into a *fresh* project and records what actually happened to Auth. Until that
drill has run, the honest statement above stands, and the product does not claim
more.

#### When, and by whom

Weekly during the pilot, and **before every migration applied to the hosted
project, without exception** (§20) — that pre-migration dump is the rollback, and
it is the reason two environments are enough. One person runs it; the artefacts
live off the machine that runs the application — and, before that, outside the
Git repository. `data.sql` carries `auth.users` and will carry the company's
business records; a backup artefact in version control is company data
published to every clone, permanently, and `.gitignore` is a safety net rather
than a control.

**Neither A nor B replaces the other, and the product must say so.** A portable
organisation export cannot rebuild a Supabase project. A dump set is not something
the pilot user can produce, read, or restore. Both exist, for different disasters.

**OPTIONAL FUTURE:** a CI job running the four dump commands on a schedule and
storing the output in a **private** location. It removes the human from a weekly
task and is not needed to start.

### Restoring into shared cloud data

The most dangerous operation in the system. **Not implemented in Phase 9.5, and
not in Phase 10 — it is Phase 21**, deliberately late, because a restore capability
that exists before anyone has needed a backup is a loaded weapon with no safety
drill behind it.

The settled parts first:

- **Who:** OWNER only. Not ADMIN.
- **Tenant scoping:** the target `organization_id` comes from the caller's proven
  OWNER membership. Every row is stamped with it. Ids inside the payload are
  ignored. A file from another tenant cannot land anywhere.
- **Pre-restore archive:** the function writes the current contents to a
  `restore_archives` row **in the same transaction** that replaces them. Postgres
  makes this simpler than IndexedDB did: if the transaction rolls back, nothing was
  replaced and no archive is needed; if it commits, the archive committed with it.
  The elaborate "commit the snapshot in a separate earlier transaction" dance the
  local design required exists because IndexedDB could not do this.
- **Verification inside the transaction:** counts and a re-validated sample are
  checked against the transaction's own uncommitted writes, and a failure aborts.
  *Failed restore = no-op* is preserved, and here it is free.
- **Auditability:** an `admin_events` row recording who, when, the source file's
  checksum, and the counts before and after.
- **Replace-all only.** Merge is still not offered.

#### The write gate, corrected

An earlier draft locked the organisation with a `maintenance_until` timestamp
checked inside `app_private.current_org_ids()`, exempting the OWNER. **That design
does not hold, for two independent reasons**, and both are worth stating because
each is a different class of mistake.

1. **The OWNER exemption defeats the lock.** The person running a restore is an
   OWNER — and so is the browser tab they left open on the products screen, and
   so is their laptop at home. An exemption granted to a *role* is granted to
   every session that role has. The one user guaranteed to be active during a
   restore was the one user allowed to write during it.
2. **A flag set inside the destructive transaction is invisible until it
   commits.** Other transactions read a snapshot that predates it, so for the
   entire duration of the restore — the only time the gate matters — the gate is
   not there. A lock that becomes visible when the work is finished is not a lock.

The required invariant is unambiguous:

> **During a cloud restore, no normal business mutation — including one from
> another OWNER session — may cross the restore boundary.**

Meeting it takes three committed transactions and a barrier, not one flag.

```text
TX1 — ACQUIRE                                    (short, commits immediately)
  SELECT … FROM organizations WHERE id = $org FOR UPDATE
  assert caller is OWNER
  assert no gate is already held
  SET write_locked_at = now(), write_locked_by = auth.uid(),
      write_lock_reason = 'RESTORE'
  COMMIT            ← the gate is now VISIBLE to every other transaction

TX2 — DRAIN, then REPLACE                        (the destructive transaction)
  SELECT … FROM organizations WHERE id = $org FOR UPDATE
        ↑ blocks until every in-flight writer has finished — see below
  assert caller is OWNER and write_locked_by = auth.uid()
  set_config('app.restore_in_progress', $org, /* local */ true)
  write restore_archives (the current contents)
  delete + insert the business tables
  verify counts and re-validate a sample, against its own uncommitted writes
  COMMIT  or  ABORT

TX3 — RELEASE                                    (short)
  clear write_locked_at / write_locked_by / write_lock_reason
  insert admin_events
  COMMIT
```

**How the gate actually stops a writer — including an OWNER.** Not through a
policy, because policies govern reads as well and blinding readers buys nothing.
Through a `BEFORE INSERT OR UPDATE` trigger on every business table, which is the
one place a client cannot route around by composing a different request:

```sql
create function app_private.assert_write_allowed(org uuid)
returns void language plpgsql set search_path = '' as $$
declare v_locked_by uuid;
begin
  -- The shared lock is the drain barrier. Writers do not block each other;
  -- only TX2's FOR UPDATE blocks, and only until they are all done.
  perform 1 from app_data.organizations o where o.id = org for share;

  select o.write_locked_by into v_locked_by
    from app_data.organizations o where o.id = org;

  if v_locked_by is null then
    return;                                    -- normal operation
  end if;

  if v_locked_by = (select auth.uid())
     and current_setting('app.restore_in_progress', true) = org::text then
    return;                                    -- the restore's own transaction
  end if;

  raise exception 'organization is locked for maintenance'
    using errcode = '55006';                   -- object_in_use
end $$;
```

The exemption is now **two conditions, both required**: the caller must be the
lock holder *and* be executing inside the restore function's transaction. An
OWNER's second browser tab satisfies the first and cannot satisfy the second —
`app.restore_in_progress` is set with `is_local = true` by the restore RPC alone,
so it exists for the duration of that one transaction and nowhere else. Nothing a
client can send through PostgREST sets it.

**The drain barrier closes the in-flight race.** After TX1 commits, a writer
whose statement begins later reads the gate and is refused — at `READ COMMITTED`
each statement takes a fresh snapshot, so this is immediate. The writer whose
statement was *already executing* when TX1 committed has already passed the
check, and may still commit. That is the race, and the `FOR SHARE` in the trigger
is what closes it: every writer holds a shared lock on the organisation row until
it commits, and **TX2's `FOR UPDATE` cannot be granted until all of them have
released.** When TX2 acquires the row, the drain is provably complete — no writer
is in flight, and no new one can start.

Lock ordering is consistent (organisation row first, then business rows) so this
introduces no deadlock cycle, and the cost on the normal path is one shared lock
on one row per mutation, which at pilot volume is not measurable.

#### Failure semantics, at every point

The question a caller must always be able to answer is *what state is the data in
now* — the same question Phase 8's `RESTORE_COMMITTED_BUT_UNVERIFIABLE` code
exists to answer, asked again in a world where other people are watching.

| Failure point | Gate | Business data | What happens next |
| --- | --- | --- | --- |
| Before TX1 (validation, preview, wrong role) | not set | **untouched** | nothing happened; ordinary error |
| TX1 fails or aborts | not set (rolled back) | **untouched** | retry |
| **Between TX1 and TX2** — crash, timeout, closed laptop | **set, and stuck** | **untouched** | the organisation is **read-only** until released. Reads work normally; every write raises `55006` and the UI shows *"şirket verisi bakım nedeniyle geçici olarak salt okunur"* with the lock's age. An OWNER releases it explicitly |
| TX2 aborts (verification failed, constraint, crash) | still set | **untouched** — rollback | retry, or release the gate. *Failed restore = no-op* holds |
| **TX2 commits, TX3 fails** | still set | **replaced** | the data is the restored data and is correct; the gate is stuck read-only. An OWNER releases it. This is the one case where "the restore worked but the app says maintenance" is true, and the message must not imply failure |
| All three commit | cleared | **replaced** | done; archive and `admin_events` row exist |

**The stuck gate is released explicitly, never by a timeout.** A rule like
"ignore a lock older than thirty minutes" is a lock that a slow restore defeats —
precisely when the data is half-replaced. So the lock persists until an OWNER
clears it, the admin screen shows who set it and when, and clearing it writes its
own `admin_events` row. A read-only company for an hour is a bad afternoon; a
gate that expires underneath a running restore is a corrupted database.

---

## 17. Free-plan pausing, and what the application says

Three distinct states that need three different messages, because treating them
alike is how a user is told the wrong thing.

| State | Detected by | What the user sees |
| --- | --- | --- |
| **OFFLINE** | no network / fetch network error | *"İnternet bağlantısı yok. Bağlantı kurulana kadar kayıt yapılamaz."* |
| **SERVER_UNAVAILABLE** | connection refused, timeout, or a platform 5xx | *"Sunucuya ulaşılamıyor. Verileriniz sunucuda güvende; bağlantı kurulana kadar kayıt yapılamaz. Lütfen yöneticinize bildirin."* |
| **FORBIDDEN / NO_MEMBERSHIP** | authenticated, but no active membership | *"Hesabınız bu şirkete bağlı değil veya pasif durumda. Yöneticinize başvurun."* |
| **ORGANIZATION_LOCKED** | a write raised `55006` — the restore write gate is held (§16) | *"Şirket verisi bakım nedeniyle geçici olarak salt okunur. Görüntüleme açık, kayıt kapalı."* Reads keep working, and the OWNER additionally sees who holds the lock and since when |

`ORGANIZATION_LOCKED` is the only one of the four in which **reading still
works**, and the wording has to carry that — telling a user the system is down
when they can still look things up is both wrong and needlessly alarming.

A paused Supabase project presents as `SERVER_UNAVAILABLE`. The normal member is
never shown the word "Supabase", never shown "project paused", and never asked to
do something they cannot do.

**The OWNER and ADMIN see one extra panel**, and only they:

> *Sunucu yanıt vermiyor. Ücretsiz plandaki proje yaklaşık bir hafta
> kullanılmazsa otomatik olarak duraklatılır. Supabase panelinden projeyi
> "Resume project" ile yeniden başlatın.*
> Proje referansı: `xxxxxxxx` · Son başarılı bağlantı: `21.09.2026 14:32`

Three rules that are not negotiable:

- **No write is ever reported as succeeded.** A mutation resolves only on a
  committed server response. There is no optimistic success anywhere.
- **No stale data is shown as current.** In the MVP there is no cache, so the
  degraded state is simply "veri yüklenemedi" — which is the honest outcome and
  the simplest one. If a cache is ever added (§13), cached rows must be visually
  distinguishable and carry their age.
- **No synthetic keep-alive.** Manufacturing traffic to evade the inactivity
  policy is refused as a design: it works against the plan's intent and it creates
  a false signal about whether the product is being used. The honest answers are
  "the pilot is used daily, so it does not pause" and, if that stops being true,
  **OPTIONAL FUTURE:** a paid plan, which cannot be paused.

**A precondition for going beyond a pilot**, stated here so it is not discovered
later: an application that can be unavailable until an administrator clicks
"Resume" is acceptable for an evaluation and is not acceptable as a company's
daily operational system. Upgrading is a billing decision, not an architectural
one — nothing in this document changes when it happens.

---

## 18. Tauri and browser clients

**One application. One React/TypeScript codebase. No business-logic fork.**

```text
        src/  (domain · calculation · comparison · features · ui · i18n · cloud)
                              │
                    one Vite production build
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
    Tauri (Windows)     Tauri (macOS)      browser (dev, and a
    packaging layer     packaging layer    possible web client later)
```

The platform layer contains **exactly two things**:

1. **File save.** The browser's download path (the existing `download.ts`) versus
   Tauri's dialog + filesystem plugin. One small interface, two implementations,
   and the browser path stays the required fallback — the product never loses
   backup capability because a platform API is missing.
2. **Window/updater chrome.** Not architectural.

Everything else — auth, data access, validation, the engine, i18n — is identical
because it is all HTTPS and pure TypeScript.

**Auth implications for Tauri, which is where this could have gone wrong.**
Email + password needs no redirect, no custom URL scheme, no deep-link
registration and no OAuth allow-list. The session lives in the webview's
`localStorage`, which persists across restarts at a stable app origin. This is the
second independent reason for the §4 decision, and it is why that decision is not
revisited when the desktop clients are packaged.

**The bundle contains the publishable key**, and a desktop binary is a file on
someone's computer — anything compiled into it is public. That is fine, and §19
explains exactly why.

**A web client later** changes one configuration item (allowed origins) and
nothing else. Static hosting remains sufficient, since there is no server-side
application code to deploy — the server-side logic is database migrations.

---

## 19. Keys and client security

| Location | May contain | Must never contain |
| --- | --- | --- |
| React bundle — browser **and Tauri** | project URL, **publishable key** (`sb_publishable_…`) | anything else |
| Committed `.env` / repository | nothing secret | every secret |
| Build-time env (`VITE_…`) | project URL, publishable key — these end up in the bundle by definition | secrets |
| **Edge Function secrets** (`supabase secrets set`) | SMTP credentials if ever added. **Not the secret key** — the platform injects that itself; see below | — |
| Developer machine / CI | database connection string for migrations, Supabase access token | — never shipped to a client |

Current key model, verified September 2026: Supabase issues **publishable keys**
(`sb_publishable_…`), which are designed to be public and enforce RLS as the `anon`
or `authenticated` role, and **secret keys** (`sb_secret_…`), which bypass RLS
entirely and are refused by the client library when it detects a browser
environment. The legacy `anon` / `service_role` JWT keys are being deprecated by
the end of 2026, so **new work uses the publishable/secret pair** and never the
legacy names.

### The statement that has to be explicit

**A publishable key is not a secret and is not treated as one.** It is a project
identifier. It grants exactly what the `anon` and `authenticated` roles are
granted — and `anon` is granted **nothing** on any business table (§7). Extracting
it from a bundle, a network trace or a decompiled Tauri binary gives an attacker
the capabilities of a logged-out visitor.

**A secret key must never be embedded in a React bundle, a browser, or a Tauri
executable.** It bypasses every policy in this document.

**And it is not managed by hand at all.** Supabase injects the server credential
into every Edge Function invocation — `SUPABASE_SECRET_KEYS`, a JSON envelope
keyed by name, with `SUPABASE_SERVICE_ROLE_KEY` still present on projects using
the legacy pair. Phase 10 originally required an operator to
`supabase secrets set` a project-specific copy; that was removed once the
injected variables were measured, because a duplicated secret is a second copy
of the most dangerous credential in the system, created and transported by a
human, which silently diverges from the real one the first time the project's
keys are rotated. `supabase/functions/_shared/secretKey.ts` resolves it, prefers
the current key over the deprecated one, and fails closed with a named reason.

### The test this design must pass

> If an attacker extracts every string from the shipped binary, they gain nothing
> beyond what an unauthenticated visitor already has.

That is what "no security-by-hidden-key architecture" means concretely. Security
comes from row-level policies evaluated on the server against a verified JWT — not
from anything being hard to find.

**One cheap, concrete control worth building in Phase 10:** a build step that
scans the production bundle for secret key material and **fails the build** on a
hit. It catches the one mistake that would be catastrophic and silent. A legacy
`service_role` key is a JWT whose role is base64url-encoded, so the text
`service_role` never appears inside it: the scan DECODES every JWT-shaped string
and refuses any role but `anon`, alongside `sb_secret_…`. The same rule
(`src/cloud/credentialPolicy.mjs`) guards the runtime configuration and the
hosted posture script (Audit A, A-M4).

---

## 20. Environments and the development workflow

### Two environments, and why that is enough

| Environment | What it is | Purpose |
| --- | --- | --- |
| **local** | Supabase CLI stack in Docker, ephemeral | where migrations are written and proven from empty |
| **hosted pilot** | one Supabase Free project | production, for the pilot |

**No separate hosted staging**, and the reasoning is not frugality. A staging
environment's value is rehearsing a deployment against production-like data. That
rehearsal already happens locally, against **the same migration chain**, with
`supabase db reset` replaying every migration from nothing — which is a stronger
test than a long-lived staging database that has drifted. And the Free plan allows
two projects; spending the second on an environment nobody looks at costs the
option of a second pilot company.

**Two rules make two environments sufficient, and they are binding:**

1. A migration reaches the hosted project only after it has run from empty
   locally, with the test suite green.
2. **The dump set is taken before every migration applied to the hosted
   project** — roles, schema and data, as three commands, because one command
   does not produce all three (§16-B). That set is the rollback. It is not
   optional and it is not a "should".

**OPTIONAL FUTURE:** when a second company joins, the current project becomes
staging and a new one becomes production. Clean promotion, no redesign.

### The workflow

```text
repo/
  supabase/
    config.toml          # exposed schemas, auth config, enable_signup = false
    migrations/
      20261001120000_cloud_foundation.sql
      20261015093000_catalog.sql
      …
    seed.sql             # a development organisation, users and sample data
    functions/
      admin-provision-user/
      organization-restore/
  src/                   # unchanged application code
```

**The exposed-schema setting is part of the repository**, not a dashboard click,
because it is a security control (§7):

```toml
[api]
enabled = true
schemas = ["api"]                        # NOT "public"; NOT "app_data"
extra_search_path = ["public", "extensions"]

[auth]
enable_signup = false
```

The hosted project's "Exposed schemas" setting must match, and **Phase 10 asserts
it over HTTP rather than trusting it** — behavioural proofs B4 and B5 in §7 are
exactly that assertion. PostgREST reads the list from `pgrst.db_schemas` on the
`authenticator` role, so it is a value that a dashboard edit can change out from
under the repository; the test is what notices.

`extra_search_path` includes `public` so that extension functions resolve
normally. That is a *search path*, not an exposure: it does not create a route to
anything in `public`, and `public` holds no business object in any case.

- **Migrations are the canonical schema history.** Dashboard click-ops is not a
  schema-change mechanism. If a change is ever made in the dashboard, it is
  captured into a migration with `supabase db diff` immediately, or it does not
  exist.
- **Docker (or a compatible container runtime) is required** for the full local
  stack — verified against current documentation. A developer who cannot run
  Docker can work against a remote development project by linking and pushing, but
  loses `db reset`, loses a throwaway database, and therefore loses the ability to
  prove the migration chain from empty. **Docker-local is the primary path;
  remote-only is a fallback, not an equal option.**
- **`supabase test db` (pgTAP)** is where §7's catalogue assertions P1–P14 live.
  The behavioural proofs B1–B9 are split: the two-tenant reads can run there, but
  **B4, B5, B6, B7, B8 and B9 need a real HTTP client**, because routing and JSON
  serialisation are PostgREST's behaviour and are invisible from inside the
  database. Both suites run in CI on every change.
- The existing `npm run test` / `lint` / `typecheck` / `build` commands are
  unchanged; the database and HTTP suites are additive.

---

## 21. Audit and traceability

Minimum useful, and no more.

| Where | Columns | Why |
| --- | --- | --- |
| every editable business table | `created_by`, `updated_by` | "who last touched this supplier?" |
| `inventory_movements` | `posted_by` (not null) | attribution on an append-only row is permanent by construction |
| `warehouse_receipts` | `posted_by` | a receipt is a physical event with a person attached |
| `outbound_shipments` | `dispatched_by` | same |

**No generic `audit_log`, and no event sourcing.** The reason is that this product
already has an audit log for everything that matters: **the append-only inventory
ledger is the history of every physical fact**, corrections are reversal rows
rather than edits, and purchase orders freeze their own commercial evidence. A
second, parallel, generic history would duplicate that and diverge from it.

**One narrow exception: `admin_events`.** A small append-only table for the
operations that change *who can do things* and leave no other row behind:

| Event | Recorded |
| --- | --- |
| member invited / provisioned | actor, subject, organisation, role, timestamp |
| member disabled / re-enabled | " |
| role changed | ", plus old and new role |
| password reset by an administrator | actor, subject, timestamp (never the password) |
| organisation data imported | actor, file checksum, counts |
| organisation data restored | actor, file checksum, counts before and after |
| write gate acquired / released | actor, reason, timestamp — including a stuck gate cleared by hand (§16) |

Seven event types. They are rare, high-consequence, and invisible otherwise —
which is exactly the case a log is for, and the reason it is not a
general-purpose one.

---

## 22. Security threat model

Each threat, and the **architectural** control. Not one of them is answered by the
interface hiding a button.

| # | Threat | Control |
| --- | --- | --- |
| 1 | User alters `organization_id` in a network request | RLS `with check` on INSERT and UPDATE refuses any organisation the caller is not an ACTIVE member of. Plus a trigger making the column immutable on UPDATE. Not a UI concern at any point |
| 2 | Authenticated user probes another tenant's UUID | RLS `using` on SELECT/UPDATE: the row is invisible and unmodifiable. A correct guess returns zero rows, identical to a wrong one — the enumeration oracle closes with the access control |
| 3 | Removed member keeps a valid JWT | Every policy resolves membership from the `memberships` table **at query time**, never from a JWT claim. `status = 'DISABLED'` takes effect on the very next request. Authentication without membership grants nothing. (Admin sign-out additionally revokes refresh tokens; the policy is the load-bearing control) |
| 4 | Desktop application reverse engineered | The binary contains a project URL and a publishable key. Both are designed to be public. `anon` has no grant on any business table, so extraction yields the capabilities of a logged-out visitor |
| 5 | Publishable key extracted from a bundle or a network trace | Same as 4 — this is the key's intended use. RLS and platform rate limits are the defence |
| 6 | Secret key exposure | It exists only in Edge Function secrets, never in the repository, never in a `.env` that is committed, never in a bundle. **A build step scans the production bundle for `sb_secret_` and for JWT-form keys whose decoded role is not `anon`, and fails on a hit** (§19) |
| 7 | Manipulated RPC parameters | Every function re-proves membership and role from the database as its first statement; `SECURITY INVOKER` functions additionally inherit RLS. Parameters are strongly typed (`uuid`, `numeric`, `date`), all SQL is static or parameterised, and every `SECURITY DEFINER` function pins `search_path = ''` with schema-qualified names |
| 8 | Client forges `created_by` / timestamps | The stamping trigger **overwrites** rather than validates. The client's value is discarded, because it was never an input |
| 9 | Stale-write race (two people edit one record) | `update … where version = $expected`. Zero rows = refusal, surfaced through the existing `STALE_WRITE` code and its existing translation. No merge, ever |
| 9b | **Client omits the version predicate** — a modified or buggy client sends `PATCH /rest/v1/products?id=eq.…` with no version | **The table has no Data API route.** `app_data` is not an exposed schema, so the request 404s before privileges are consulted. The predicate lives inside `api.update_product` / `api.set_product_active` with `p_expected_version` as a required argument. Proven by B9 (§7, §8, §9) |
| 10 | Duplicate SKU race | `unique index (organization_id, lower(btrim(sku)))`. The database serialises it; no application check can lose the race. The client's `normaliseSku` exists for the message, not the guarantee (§9) |
| 11 | Inventory double-spend | `SELECT … FOR UPDATE` on the product row inside the posting function serialises every stock decision for that product; the derivation and the movement insert are one transaction (§12) |
| 12 | Restore or import over another tenant | OWNER-only; the target organisation comes from the caller's proven membership; every inserted row is stamped with it and the payload's own ids are **ignored**. Pre-restore archive plus an `admin_events` row |
| 13 | Malformed or hostile import file | The existing Phase 8 pipeline: size before read, depth scan before parse, prototype-key rejection of the whole file, magic, envelope, checksum, count cross-check, per-record structural validation, whole-file refusal with a specific code. **Then all of it again server-side**, because the client pass is UX and the server pass is the control |
| 14 | Compromised local storage on a device | There is no authoritative local business data. Nothing read from a device is trusted: every write is re-authorised and re-validated server-side. The worst case is a stolen session, which is threat 15 |
| 15 | XSS or client compromise | **The residual risk RLS cannot mitigate** — an attacker in the page has the user's session and therefore the user's permissions. Controls: React's default escaping with no `dangerouslySetInnerHTML` anywhere (lint-asserted), no `eval`/`Function`/dynamic import of untrusted input, a CSP on the web build, a deliberately small dependency surface (five runtime dependencies today), and blast-radius limitation by role — a MEMBER's compromised session cannot restore data or provision users |
| 16 | RLS missing on a table added in a future phase | Three layers: **grants are default-deny**, so a table with no explicit grant is unreachable through the API; a **pgTAP assertion over `pg_class`/`pg_policies`** fails the build the day a table is added without RLS forced and policies present; and `supabase db lint` / Security Advisor runs in CI (§7) |
| 17 | Anyone creates an account and probes the API | Public sign-up is **disabled**. Accounts exist only because an administrator created them (§4) |
| 18 | `profiles` leaks every user's identity across tenants | A profile is visible only to users who share an ACTIVE membership with it. `auth.users` is never exposed to the Data API |
| 19 | Edge Function abused to provision a user into someone else's organisation | The function verifies the caller's JWT, then verifies OWNER/ADMIN membership **of the organisation named in the request**, before it touches the Admin API |
| 20 | **A view leaks every tenant's rows** — `numeric::text` views are created by `postgres`, and a PostgreSQL view executes with its **owner's** privileges, bypassing the RLS of the tables it reads | Every `api` view is created `with (security_invoker = on)`; grants are explicit on both the view and the table underneath; **pgTAP P6/P7** assert it over the catalogue and behavioural proofs B1/B2 run the two-tenant suite against the views. This is Supabase lint `0010`, and it is the shortest path from a correct RLS design to a total leak (§7) |
| 21 | **A helper function is callable by anyone** — PostgreSQL grants `EXECUTE` on a new function to `PUBLIC` by default, and `anon`/`authenticated` are members of `PUBLIC` | `revoke … from public, anon` **before** any grant, on every function. RLS helpers are then granted to `authenticated` — which policy evaluation *requires* — and remain unreachable because `app_private` is not exposed. Trigger helpers are granted to nobody. **pgTAP P8/P10** assert the grants; **B4** asserts the absence of a route while **B3** asserts the grant is present (§7) |
| 21b | **A canonical table is directly addressable, bypassing the API projection** — `GET /rest/v1/products` returns `numeric` as a JSON number, destroying exact decimals, and skips every cast and normalisation the read path relies on | Canonical tables live in **`app_data`, which is not in the exposed-schema list**. PostgREST answers `PGRST106` for any schema outside it, and there is no header, embedding or foreign-key expansion that reaches one. `api` holds no base tables (**P13**), RPCs return the `api` view rather than the table, and **B5/B6/B7** prove over HTTP that the only route returns an exact string (§7, §8, §10) |
| 22 | **An OWNER writes during a restore from a second tab** | The write gate is not a role exemption. It is a trigger on every business table requiring *both* that the caller holds the lock *and* that execution is inside the restore transaction (`app.restore_in_progress`, set transaction-locally by the restore RPC alone). A second session satisfies the first condition and cannot satisfy the second (§16) |
| 23 | **A write already in flight commits across the restore boundary** | The gate is acquired in a **committed** transaction before the destructive one, and every writer takes `FOR SHARE` on the organisation row. The restore's `FOR UPDATE` cannot be granted until they have all finished, so acquiring it proves the drain is complete (§16) |
| 24 | **Double-provisioning, or an orphaned Auth user** — the Auth Admin API and the database are not one transaction | `request_id` idempotency, an `IN_FLIGHT`/`SUCCEEDED` attempt record, and compensating deletion of **only** an Auth user this attempt created. Retries converge on one valid final state; a pre-existing account is linked, never re-credentialled (§4) |

---

## 23. Realtime

**Not in the MVP.** This is a product decision, not a cost one — the Free plan
includes 200 concurrent connections and 2 million messages per month, which is far
beyond three users.

**Correctness must never depend on message delivery.** Stock correctness comes
from database transactions and the product-row lock (§12); write safety comes from
the `version` check (§9). Both are unaffected by whether a notification arrived. A
design where a dropped message can cause a wrong write is unacceptable, and the
easiest way to guarantee that is to have no messages.

**What the MVP does instead**, which for 2–5 office users is correct and not merely
cheap:

- re-read after every own mutation (`useMasterDataList` already does exactly this);
- re-read on navigation into a screen;
- an explicit refresh control on list screens;
- and when two people do collide, the stale-write refusal names it —
  *"bu kayıt başka bir yerde değişti — yeniden yükleyin"* — which tells the user
  more than a row silently changing under their cursor would.

**OPTIONAL FUTURE**, with the shape that keeps it safe: subscribe to changes on
the current screen's table and surface a *"yeni veri var — yenile"* affordance.
A hint to refresh, never a data channel, and never an input to a decision.

---

## 24. The application seam

Phase 9's UI is not redesigned. The change is one layer deep, and it is small
because the existing layering already anticipated it.

**Today:**

```text
ProductsScreen → productService(database, …) → productStore → IndexedDB
```

**After Phase 11:**

```text
ProductsScreen → productService(gateway, …) → DataGateway → Supabase → PostgreSQL
```

**The feature service already is the seam.** `ProductsScreen` calls
`listProducts(database)` and `createProduct(database, draft, options)` and does not
know what `database` is — that handle arrives from the `AppRuntime` context, which
was built to carry exactly one data handle. So:

| File | Change |
| --- | --- |
| `app/runtime.ts` | `database: Database` → `gateway: DataGateway`; the boot states gain `SIGNED_OUT`, `UNAVAILABLE`, `NO_MEMBERSHIP` |
| `features/catalog/productService.ts` | `saveProduct(database, record)` becomes `gateway.products.create(record)` on create and `gateway.products.update(record, expectedVersion)` on edit — **two methods where there was one**, because the server paths are two different RPCs (§8). Stops stamping `createdAt`/`updatedAt` (the server owns them) and passes `expectedVersion` instead of `previousUpdatedAt`. **`ProductDraft`, `productDraftFrom`, `buildRecord`, the locale handling, the pack-factor parsing and every validation rule are untouched** |
| `features/parties/partyService.ts` | the same, plus the two new fields: `Supplier.externalRef` and `Customer.customerStatusId` |
| `features/shared/useMasterDataList.ts` | one line: `load(database)` → `load(gateway)` |
| screens, forms, `masterData.ts`, `decimalInput.ts`, `units.ts`, `formError.ts`, `ui/`, `i18n/` | **unchanged**, beyond the new fields' form controls |

The split of `save` into `create` and `update` is worth noting because it is the
one place §8's corrected mutation boundary reaches the client code. It is not an
abstraction change — the service already knew which case it was in (it branches on
whether an `existing` record was passed) and simply calls a different method now.

**One `DataGateway` type, not an abstraction framework.** No repository interface
per entity, no unit of work, no DTO layer, no factory. It is a single type with a
method per operation the features actually call — the same explicit-functions
philosophy `src/persistence/index.ts` already follows.

It exists rather than having services call `supabase` directly for three concrete
reasons, all of which are jobs, not indirection:

1. **It is where the boundary conversions live** — `numeric` as text (§10),
   `timestamptz` normalised to the existing instant format, `version` handling.
   One place, tested once.
2. **It is where the read/write asymmetry is hidden from the services.** A read
   is a `select` on an `api` view; every write is an `rpc()` call with a typed
   parameter list. Two shapes, one place that knows which is which, and a service
   that still just asks for what it wants. The gateway is also the one place that
   names `api` — no feature file mentions a schema, so if the API surface is ever
   reorganised, one module changes.
3. **It is where PostgREST and PostgreSQL errors become the existing code
   vocabulary** — `STALE_WRITE` (raised by the RPC, not inferred from a row
   count in the client), `DUPLICATE_KEY`, `RECORD_NOT_FOUND`, plus the new
   `OFFLINE`, `SERVER_UNAVAILABLE`, `FORBIDDEN`, `SESSION_EXPIRED`,
   `ORGANIZATION_LOCKED` (§16). So `src/i18n/persistenceText.ts` **extends**
   rather than being replaced, and no raw Postgres error message ever reaches a
   screen — the same rule that already keeps `DOMException` text off the UI.

---

## 25. What survives from Phases 7 and 8

Classified honestly. Nothing is kept because effort was spent on it.

### KEEP — unchanged, or changed only in what it is pointed at

| Asset | Note |
| --- | --- |
| `src/domain`, `src/calculation`, `src/comparison` | the engine. Storage-agnostic by construction, which is the whole reason this port is a port |
| `Money` / `Quantity` exact decimals and the `toJSON`/`fromJSON` decimal-string contract | becomes the wire format; `numeric` is its home in Postgres (§10) |
| `src/i18n`, `engineText.ts`, `persistenceText.ts` | the code→translation mapping extends to cloud error codes |
| Phase 9 screens, forms, `masterData.ts`, `decimalInput.ts`, `units.ts`, `ui/` | untouched by the seam change (§24) |
| `backup/canonicalJson.ts`, `checksum.ts`, `limits.ts`, `envelope.ts`, `payloadMigrations.ts` | storage-agnostic; re-pointed at a cloud payload |
| `backup/download.ts` | plus a Tauri file-save path beside it |
| **The boot gate principle** — no business data renders until a working data source is confirmed | more important against shared data, not less (§13) |
| **"Persist first, then reflect"** | more correct against a server than it was locally (§24) |
| **Failed restore = no-op**, and the two outcomes a caller must distinguish | Postgres makes the first free; the *distinction* still must be reported (§16) |
| **Untrusted-input discipline** — validate every record, reject the whole file, name the failure | applies to imports unchanged, and now runs twice (§15) |
| **Derived state is never stored** (R1, I19) | unchanged, and easier: no `product.stock_quantity` column, ever |
| **The append-only ledger and I1–I13** | unchanged in meaning; §12 changes only where they are enforced |
| `active: boolean` as the deletion mechanism | unchanged — and now backed by *no delete grant at all* (§7) |

### ADAPT — the idea survives, the implementation changes

| Asset | Becomes |
| --- | --- |
| Feature services (`productService`, `partyService`) | same public shape; `Database` → `DataGateway` |
| Stale-write refusal | `updatedAt` token → `version` token; the code, the message and the UX are unchanged (§9) |
| Boot sequence (`bootstrap.ts`, `useApplicationBoot.ts`) | session → reachability → membership, with the same refusal to render (§13) |
| `backup/businessData.ts` record validators | validate cloud-shaped records (organisation id, version, server timestamps) |
| `backup/restore.ts` prepare/apply split | `prepare` stays client-side; `apply` becomes a server transaction (§15, §16) |
| `persistence/validation.ts` | still the untrusted-input validator set, for imports |
| `PRE_RESTORE` snapshot | a server-side pre-restore archive, in the same transaction (§16) |
| Backup envelope | `backupFormatVersion` bump — records now carry organisation, version and actor |
| `schemaVersion` | becomes the migration-chain version of the **PostgreSQL** schema; the migration files are the chain |

### RETIRE — no longer protects anything, or no longer true

| Asset | Why |
| --- | --- |
| **IndexedDB as the canonical business database** | the entire point of this checkpoint |
| `persistence/idb.ts`, `database.ts`, `schema.ts`, `migrations.ts` | IndexedDB-specific |
| `persistence/stores/*` | replaced by the gateway |
| `backup/snapshots.ts`, `retention.ts`, `maintenance.ts`, `preMigration.ts` | an undo layer over a non-authoritative cache protects nothing; the pre-migration dance was an IndexedDB constraint |
| `persistence/autosave.ts` | Phase 9 already chose explicit Save for master data, and explicit Save is right against a server. If a long-lived editable document ever needs it, it returns as a *server* save policy |
| `persistence/tabAdvisory.ts` (BroadcastChannel) | two tabs are no longer a data-loss vector; the server arbitrates, and the `version` check reports it |
| `persistence/storage.ts` (quota, `navigator.storage.persist`) | nothing durable lives on the device |
| Local `counters` | code allocation must be server-side to be unique across devices |
| Local `snapshots` as a recovery layer | see above |
| "The pilot runs on one computer" as the **final** architecture | superseded by this document; kept in [Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md) as the historical record of the local pilot |

**The honest summary.** A large part of Phase 7 retires, and that is the correct
outcome rather than a loss. What Phases 7 and 8 actually produced was not an
IndexedDB layer — it was a set of invariants, a validated-boundary discipline, a
transactional mindset and an error vocabulary. All of those survive, and they are
exactly what makes the PostgreSQL design above short instead of speculative.

---

## 26. Decisions, closed and scheduled

### Closed

The three questions this document opened have been answered. They are recorded
here as settled architecture, not as pending items.

| | Decision | Consequence |
| --- | --- | --- |
| **C1** | **Internet is required for authoritative business reads and writes. ACCEPTED for the pilot.** | No offline mutation of shared data, no dual-master sync, no offline queue. Recorded as a product limitation ([Product Scope](PRODUCT_SCOPE.md), Open Decision 16) rather than hidden as an implementation detail. §14 is the reasoning; a failed save still keeps the user's typing |
| **C2** | **Individual accounts for anyone posting inventory or operational actions.** A shared warehouse login is not the normal model. | `posted_by` on every movement, receipt and dispatch resolves to a person, permanently — the ledger is append-only, so attribution not captured is attribution not recoverable. A shared account remains *possible* without schema change; it is simply not how the pilot is set up |
| **C3** | **Current local master data is test/development data.** | Phase 11 builds and proves the validated import path (§15), but does **not** design around preserving a large production catalogue. Bulk entry of the real catalogue happens after Phase 11, into the cloud |

### Scheduled — BUSINESS EXCEL CODE SCHEME ANALYSIS

Not an open decision, because nothing is blocked by it and the safe default is
already chosen (§11 — `external_ref` is an opaque string). It is a **deferred
analysis with a trigger**: when the owner provides real spreadsheets of customer
and supplier records.

What the analysis must establish before **any** parsing, validation, uniqueness
constraint or code generation is designed:

| Question | Why it decides something |
| --- | --- |
| Is the `120` / `320` prefix consistent across every record? | whether prefix is derivable from the record type, or is data |
| Does the province segment hold for every domestic record? | whether `34` is a province at all, or a branch/region code that merely looks like one |
| How are the Istanbul side digits (`00`, `01`) used elsewhere? | whether the third segment is district, side, or something province-specific |
| **What is `11-001`?** | the currently unknown segment — sequence, customer type, account sub-code, something else |
| Are the codes actually unique? Are there blanks, duplicates, historical variants? | whether a unique index is safe, and whether import must tolerate collisions |
| Are codes ever *assigned by this company*, or always received from elsewhere? | whether generation is even a feature this product should have |
| **How are foreign customers and suppliers coded?** | a province-based scheme has no answer for a supplier in Guangzhou; this is the most likely place the pattern breaks |
| Does the scheme originate in Logo Tiger? | if so, LandedCompare must **mirror** it and never generate it — Logo Tiger owns its own identifiers ([Product Scope](PRODUCT_SCOPE.md) §3) |

Until that analysis has run, the code is stored and displayed verbatim and
nothing interprets it. Each capability it might unlock — a format check, a unique
index, a parsed breakdown for filtering, a generator — is an **additive** change
to a column that already holds the complete value, so waiting costs nothing and
guessing costs a migration over live data.

### Still genuinely open

**None.** Every other question this checkpoint raised has a technically safe
default recorded in the section that raised it. Two items are *scheduled
unknowns* rather than open decisions, and both are named where they live: the
Excel code scheme above, and whether Auth users survive a project rebuild
(§16-B), which the Phase 21 recovery drill answers by doing it rather than by
being decided.

---

## 27. Cost

The pilot runs at **$0/month**.

| Item | Cost | Note |
| --- | --- | --- |
| Supabase Free project | $0 | one project; database, auth, API, Edge Functions |
| Domain | $0 | not required — the hosted Supabase endpoint is used directly |
| Hosting for the client | $0 | Tauri desktop builds run locally; a static web build, if ever wanted, fits a free static host |
| Email | $0 | no SMTP provider — §4 removes the dependency |
| Backups | $0 | portable export is a product feature; the infrastructure dump set is four CLI commands (§16-B) |

Marked **OPTIONAL FUTURE**, none required: Supabase Pro (removes pausing, adds
automatic backups and PITR), a custom domain, a transactional email provider for
self-service password reset, and a paid static host with a custom domain for a web
client.

---

## 28. Implementation status — what Phase 10 built

Recorded here rather than scattered through the sections above, so that the
design reads as a design and this reads as a report against it.

### Built and proved

| Section | Delivered in Phase 10 |
| --- | --- |
| §3, §20 | `supabase/` in the repository — `config.toml`, seven migrations, `seed.sql`, `tests/`, `functions/`. The CLI is a pinned dev dependency (`supabase@2.117.0`), so the version that proves a migration locally is the version that pushes it |
| §7 | The three schemas, exactly as described. `[api] schemas = ["api"]`, `public` and `graphql_public` both removed from the exposure list, `auto_expose_new_tables = false` |
| §7 | The helper grants, in the corrected direction: `USAGE` on `app_private` and `EXECUTE` on the three RLS helpers to `authenticated`; trigger helpers granted to nobody; `anon` granted nothing anywhere |
| §7, §10 | PostgreSQL 17.6 locally. Migration 1 asserts `server_version_num >= 150000` **before any view exists**, so a server without `security_invoker` stops the chain instead of silently accepting an unknown option |
| §5, §11 | `organizations` (with the three `write_lock*` columns), `memberships`, `profiles`, `provisioning_attempts`, `admin_events`, `counters`. No business table — products, suppliers, customers and customer statuses remain Phase 11 |
| §7 | RLS enabled **and forced** on all six, the four-policy pattern where a client writes, explicit per-object grants, no `delete` grant and no `DELETE` policy anywhere |
| §7 | Stamping, tenant-immutability, append-only and write-gate triggers; `stamp_row` overwrites rather than validates |
| §8 | `api.update_own_profile` and `api.acknowledge_password_change`, both `SECURITY INVOKER`, both requiring `p_expected_version`, both returning `setof api.profiles` — the view, never the table |
| §4 | `api.begin_provisioning` / `complete_provisioning` / `fail_provisioning` / `begin_password_reset` / `complete_password_reset`, `SECURITY DEFINER`, granted to `service_role` alone |
| §4 | The `admin-provision-user` and `admin-reset-password` Edge Functions, including the compensating delete that only ever removes an auth user the same attempt created |
| §16 | The write gate's **enforcement** — columns, `assert_write_allowed`, and the trigger — attached to `counters`, the one organisation-scoped table Phase 10 has that a restore would replace. Phase 11 attaches it with every business table; Phase 21 owns the restore that acquires and releases it |
| §19 | `npm run build` greps the production bundle for `sb_secret_` and `service_role` and fails on a hit. Verified by planting one. *Audit A (A-M4) later showed the plain-text marker cannot see a JWT-form legacy key; the scan now decodes it — §30* |
| §19 | The Edge Functions read the server credential from the platform-injected `SUPABASE_SECRET_KEYS`. There is **no project secret to set** — see the correction below |
| §7, §20 | `npm run verify:hosted` — eighteen unauthenticated HTTP checks of the hosted exposed-schema list, Phase 11 catalogue posture and auth configuration, creating nothing. Proved by pointing it at a deliberately broken configuration |
| §20 | `supabase/config.toml` declares only what this product governs on the hosted project. Every declared property is pushed, so the file's silence is a control — see the fifth correction below |
| §24 | `src/cloud/` — config, client, gateway, error vocabulary and boot states. See "the seam is built and not connected" below |
| §7 | 105 pgTAP assertions and 37 HTTP behavioural assertions. See [Testing](TESTING.md) |

### Three corrections the implementation forced

Each one is fixed in place above rather than listed as an erratum, because a
reader of §7 should not have to find §28 to learn that a snippet does not
compile.

1. **`x = any ((select f()))` does not compile** when `f()` returns an array —
   PostgreSQL parses it as the subquery form of `ANY`. Every policy and helper
   uses `::uuid[]` (§7).
2. **`[auth.email] enable_signup = false` disables sign-IN**, not sign-up. The
   correct switch is `[auth] enable_signup` (§4).
3. **No policy in this schema calls a helper that reads the table the policy is
   on.** The canonical text relies on the `SECURITY DEFINER` owner's `BYPASSRLS`
   to break the recursion cycle, which works and is asserted (pgTAP P17) — but
   `memberships`, the one table every helper reads, is given a helper-free
   policy (`user_id = auth.uid()`) so the cycle does not exist to be broken in
   the first place. That makes 42P17 structurally impossible rather than
   avoided, and costs nothing: what a client needs from that table is "which
   companies am I in, as what", which is exactly the caller's own rows. Listing
   a colleague's role is the Phase 12 administration screen and will reach it
   through a function that re-proves OWNER/ADMIN, not by widening the policy.

### One addition the design did not specify

**`app_private.managed_table`** — a registry declaring the policy class of every
table in `app_data`, maintained by the migration that creates the table, with
pgTAP asserting that the registry and `pg_class` agree **in both directions**.

It exists because §7 names the highest-likelihood failure in this design — an
object added by a future phase without the posture applied to it — and the three
controls listed against it all assume somebody remembers to extend them. The
registry inverts that: a seventh table added to `app_data` without a class
declaration fails the build immediately, naming the table, and every
class-conditional assertion is then about it automatically.

### Deferred, honestly

| Item | Where it goes, and why |
| --- | --- |
| **The hostile-precision fixture** (`12345678901234567890.0047` asserted as an exact string) | **Phase 11**, as §7 already says — Phase 10 has no financial column, and a fixture table invented to hold one would be the "table whose shape is guessed a phase early" §11 refuses. What Phase 10 establishes instead is the *boundary the fixture lands on*: `app_data` has no HTTP route (proved over HTTP), and pgTAP **P15** fails the build the day an `api` view or RPC exposes a `numeric`, `real`, `double precision` or `money` column without casting it to text. The contract cannot be broken quietly between now and the phase that proves it with a value |
| **The `INSERT` `with check` tenant guard, on a real business table** | Phase 10 owns no organisation-scoped table a client may write. The **pattern** is proved instead, by a probe table built inside a rolled-back pgTAP transaction carrying the exact four-policy shape and exercised by a real `authenticated` session against the real helpers — because the pattern is fixed now and every later table inherits whatever is wrong with it |
| **Acquiring and releasing the write gate** | **Phase 21**, with the restore it exists for. Phase 10 built and tested the enforcement, including threat 22 — the lock holder's own second session is refused |
| **Organisation administration UI** (invite, disable, re-role, reset) | **Phase 12**. The Edge Functions and the `admin_events` behind it exist and are tested; there is no screen |
| **`api.update_own_profile` reaching a screen** | **Phase 11/12**, with the seam switch |
| **Realtime, Storage, a second organisation, self-service password reset** | Unchanged: §23, §3, §20 and §4 respectively |

### The seam is built and not connected — deliberately

Nothing in `src/cloud/` is imported by `src/App.tsx`, `src/app/runtime.ts` or any
feature service. Products, suppliers and customers still read and write
IndexedDB, exactly as in Phase 9, and the application is unchanged.

That is the Phase 10/11 boundary and it is a decision rather than unfinished
work. Re-pointing some entities at PostgreSQL while others stay on the device is
two sources of truth — the single thing this whole document exists to prevent —
and it would be two sources of truth arranged at their worst: a boot gate that
refuses to start when the server is unreachable, in front of a catalogue sitting
on the local disk the entire time. Phase 11 switches the catalog in one move and
drops the local database with it.

### Four runbook corrections, found in review before anything was deployed

The first draft of the hosted sequence was checked against the pinned CLI's own
help output and against measured behaviour, not against memory. Four things were
wrong, and all four would have been discovered during a production deployment —
which is the worst moment to discover any of them.

1. **`supabase config push` was missing entirely.** `db push` applies migrations
   and touches neither the exposed-schema list nor the sign-up switch, so a
   deployment consisting of `db push` alone would have left the hosted project
   serving `public, graphql_public` with registration open — the factory
   defaults — while every local test reported the posture as correct. The
   sequence now pushes the schema first (PostgREST cannot serve a schema that
   does not exist) and the configuration second, and [Deployment](DEPLOYMENT.md)
   explains why the gap between them is harmless on an empty project.
2. **`supabase db remote-version` does not exist.** Passing an unknown
   subcommand makes the CLI print the parent help and exit successfully, so the
   step would have *appeared* to pass while checking nothing. Replaced with
   `supabase db query --linked "SHOW server_version;"`, which goes through the
   Management API and therefore puts no connection string or password into shell
   history. Migration 1's own assertion remains the real gate.
3. **The Auth dump was mislabelled, and the data dump was under-described.**
   `db dump --schema auth` is schema-only: table definitions, zero users. The
   ordinary `--data-only` dump, meanwhile, *does* contain `auth.users`. §16-B
   now records what each variant actually produces, measured by running them.
4. **The Edge Function secret duplicated a platform credential.** Removed; §19
   has the reasoning.

### A fifth, found when the first `config diff` ran against the real project

**`config push` writes every property the repository declares**, and
`supabase init`'s template declares a great many. The first diff against the
hosted project reported fifteen declared differences: two intended — the
exposed-schema list and public sign-up — and **thirteen accidents of the
template**, including a `127.0.0.1` site URL and redirect allow-list, e-mail
confirmation and OTP behaviour, MFA and Twilio toggles, connection-pooler
sizing and storage settings.

None of those is a Phase 10 decision. Pushing them would have pointed a
production authentication service at a developer's laptop as a side effect of
deploying a security control — and nobody would have connected the two a week
later.

`supabase/config.toml` is therefore stripped to what this product actually
governs, and carries a header saying so, because the file's **silence is as
meaningful as its contents**. The exposure list, public sign-up and the e-mail
provider switch are declared; everything else is either local-only and never
compared (verified by flipping each key and re-running the diff) or left to the
platform.

Where local and hosted must genuinely differ on a governed property — the first
real case is `auth.site_url` once a web client exists — the supported mechanism
is a `[remotes.<name>]` override block, confirmed working on the pinned CLI. It
overrides the base rather than replacing it, so stripping the base stays the
load-bearing step. [Deployment](DEPLOYMENT.md) has the detail, including the
one value deliberately *not* pushed and left as its own reviewed decision.

### Hosted project

The hosted Free project is linked and Phase 10 is deployed: seven migrations,
both Edge Functions, `api` as the only exposed business schema, disabled public
signup, a clean advisor WARN gate and eighteen anonymous HTTP checks. It contains
no real pilot organisation, user or business data. Phase 11 uses the same
reviewed migration and rollback sequence; it does not push unrelated config.

Hosted verification is a script rather than a checklist. `npm run verify:hosted`
makes eighteen unauthenticated requests and creates nothing, because the
exposed-schema list and the sign-up switch are values a dashboard edit can change
out from under the repository — and a checklist item saying "confirm Exposed
schemas is api" is read by somebody who already believes the answer. It was
proved by pointing it at a deliberately broken local configuration and watching
it go red.

---

## 29. Phase 11 implementation status — catalogue cutover

Phase 11 activates the seam reported in §28 without weakening any Phase 10
control. `app_data.products`, `suppliers`, `customers` and `customer_statuses`
are the canonical catalogue. Every table is registered as `TENANT_EDITABLE`,
has RLS enabled and forced, uses live membership policies, has no client DELETE,
and carries server-owned audit columns plus integer `version`. The customer to
status reference is a composite `(id, organization_id)` foreign key. Product
SKU uniqueness is organisation-scoped and case-folded. Product conversion
quantities are unbounded `numeric` in `app_data` and text in `api`.

The read surface is four `security_invoker` views. The write surface is twelve
typed invoker RPCs (`create_*`, `update_*`, `set_*_active`) plus one narrowly
scoped OWNER-only, idempotent catalogue-import invoker. Its append-only audit
event has a strict OWNER insert policy and no direct API route; this keeps the
hosted security-advisor WARN gate clean without bypassing RLS. Updates and lifecycle
changes require `expected_version`; no overload omits it. Customer and supplier
external system codes remain opaque optional text. Customer statuses are tenant
configuration, never an enum; a new organisation starts with none. Labels such
as the pilot company's `C`, `A`, `A+`, `A++` are created through the same typed
customer-status mechanism as any other business-owned classification.

The application now boots session → reachability → live membership → selected
organisation → write-lock state and then renders the cloud-backed catalogue.
Signed-out, unavailable, expired-session, no-membership and locked states are
explicit. Feature services depend on `DataGateway`, not a local `Database`, and
the gateway is the only module that names PostgREST views and RPCs.

`src/cloud/legacyMigration.ts` is the sole supported IndexedDB business-data
path. It detects a legacy database without creating one, reuses the Phase 8
validator, takes the required snapshot and delivers a complete checksummed
backup, reuses a persisted request id for retry, invokes one server transaction,
proves every legacy record in the cloud by id and content (§30 — the original
organisation-wide count comparison was replaced after Audit A), and only then
deletes the local database and writes the
completion marker. A corrupt row or an unconfirmed import leaves local data in
place. There is no read fallback, write queue, cache authority or dual-master
mode after cutover.

The release-blocking precision proof uses
`12345678901234567890.0047`: the real HTTP suite creates it through the typed
RPC, reads it from the `api.products` view, asserts exact raw and parsed string
equality and `typeof === "string"`, and proves that neither a canonical-table
route nor a writable-view bypass exists. Separate signed-in sessions for the
same organisation prove shared authoritative state and stale-version refusal.

Phase 12 administration and portable cloud export, every operational module,
realtime hints, restore and granular roles remain deferred exactly as planned.

All four Phase 11 migrations are deployed to the linked hosted project. Local
and remote history match 11/11; no configuration push was needed, the hosted
security advisor reports no WARN findings, and the eighteen anonymous HTTP posture
checks pass. No real user, organisation or business row was created.

---

## 30. Audit A remediation, pass 1

The independent Audit A (after Phase 11) failed the phase on one HIGH and five
MEDIUM findings. None was a tenant-isolation or decimal-precision breach on the
server; all of them were places where the client could present something other
than the server's truth, or where the tests could not see a regression. What
changed, by finding:

| Finding | What was wrong | What holds now |
| --- | --- | --- |
| **A-H1** | Catalogue lists were one PostgREST request; `max_rows` (1000) truncated them silently, so a larger catalogue was shown as complete | Every catalogue list is read in keyset pages by `id`, each asking for an exact count of the rows ahead; the loop ends only when the server reports none left, and a page that is empty while rows remain is refused. Correct whatever `max_rows` is — proved with 1001 and 1500 rows and page sizes above and below the cap. Every traversal is then reconciled against one exact count (correction pass 2, below) |
| **A-M1** | The legacy cutover compared the organisation's whole cloud row count with the legacy count, which locked a device out for good beyond 1000 rows, when a colleague saved a record, on a second device, and on a record the server refused | Proof is per legacy record, by id and content, under the server's own normalisation. Extra cloud rows never block it; a catalogue the cloud already holds converges without an import (a lost response, a second device); a record breaking a server limit is named before anything is sent; a genuine conflict, or missing records in a cloud catalogue already in use, stops with a named reason and nothing merged. The one way past a conflict is an OWNER decision behind a confirmation, preceded by a fresh complete backup file |
| **A-M2** | The application stayed READY when the session changed in another tab or a membership was withdrawn, and an RLS-empty list read as "your catalogue is empty" | Auth events (relayed between tabs) invalidate the runtime; every business call checks the signed-in user before and after the request; an empty list is re-checked against live membership and becomes `NO_MEMBERSHIP` when the organisation is no longer visible. The shell names the signed-in user and organisation |
| **A-M3** | Offline sign-out with an expired access token left the session stored, and the previous user returned with the network | Sign-out clears the device's session unconditionally, refuses to report success while any credential remains stored, and only then revokes on the server as a best effort |
| **A-M4** | The secret guards searched for the text `service_role`, which a JWT-form key never contains | One policy module decodes the role; build scanner, runtime configuration and hosted script all refuse any role but `anon` (and `anon` only where explicitly allowed) |
| **A-M5** | Granting UPDATE on an `api` view, or removing a version predicate, left every suite green | pgTAP P18–P20 (view privileges, no overloads, `p_expected_version` on every update/lifecycle RPC) and a narrowed P12; per-entity stale-write, assignability and writable-view tests over real HTTP; the regressions were re-applied locally and each turned the suites red |

Cheap, directly related LOW findings were fixed in the same pass: transport
failures now reach `OFFLINE` / `SERVER_UNAVAILABLE` and wrong credentials read
as such (A-L1); an inspection failure no longer invents zero counts, and the
catalogue-only guard lives inside the migration (A-L2); `api.import_catalog`
validates JSON types NULL-safely and stores the checksum exactly (A-L3);
required identifiers must contain a visible character (A-L4); and the
documentation statements above were corrected (A-L8, A-L9).

**Forward migration, local only.** `20260924120000_audit_a_remediation.sql`
adds the visible-identifier constraints, the typed import helpers and the
strict `api.import_catalog`. It is proved from an empty local database and is
**not yet applied to the hosted project**; that is a separate, reviewed
deployment step. Applied migrations were not edited.

**Deferred, and recorded:** the cross-tenant UUID existence oracle (A-L5),
provisioned-user deletion (A-L6) and the organisation selector (A-L7) belong to
Phase 12 or later; opaque external codes are unchanged by design.

### 30.1 Correction pass 2 (source review of pass 1)

A source-level review of pass 1 found that its own claims were stronger than
its code in five places. Each is corrected without a schema change:

| ID | What was wrong | What holds now |
| --- | --- | --- |
| **R-1 / R-2** | A catalogue read is several requests. A membership withdrawn between two pages ended the loop with a SHORTER list and no error, and a row committed behind the cursor was silently missed, although the code claimed "complete or fails" | Every traversal is reconciled against one exact count of the whole visible set, taken after it. Equal: return. Smaller: the membership was withdrawn — `NO_MEMBERSHIP`. Larger: rows were committed behind the cursor — read everything again, at most `MAX_CATALOG_TRAVERSALS` (3) times, then fail explicitly |
| **R-3** | The legacy proof compared decimals as TEXT, so `1.20` (PostgreSQL keeps the scale it was given) and `1.2` (what `Quantity` writes) were a false conflict | Exact value equality on canonical decimal text (`sameExactDecimal`): trailing fraction zeros and leading integer zeros are representation; no value ever becomes a JavaScript number. Pre-import comparison and post-import verification share it. Validation is unchanged |
| **R-4** | The migrate and retire actions could finish after a sign-out or a sign-in as someone else and restore the previous user's migration screen; retire could delete the local database on that stale authority | A monotonic generation, advanced by every invalidation, retry, boot run and sign-out. A stale action writes no state. Right before the local database is deleted, and again before the cutover is marked complete, the action checks that its generation is current AND that the session still belongs to the user the screen was built for |
| **N-1** | The boot read the user id once, then three more things; a sign-in as someone else in between could publish A's id beside B's profile or company | The boot re-reads the signed-in user at the end and publishes nothing unless it is the same; otherwise it starts over, at most `BOOT_IDENTITY_ATTEMPTS` (3) times |
| **R-5** | pgTAP P18 used `has_table_privilege`, which does not see a COLUMN grant — `grant update (note) on api.customers` left every suite green | P18 now checks table privileges, `has_any_column_privilege` for INSERT/UPDATE/REFERENCES, and the raw view and column ACLs for any grantee; P18b keeps the legitimate SELECT in place |

**The read guarantee, stated exactly.** A successful catalogue list returns
exactly the set of row IDS the caller could see at one instant — the moment of
the reconciliation count. That rests on three schema facts: no client path
deletes a catalogue row (P4a/P4b), no row changes organisation
(`assert_tenant_immutable`), and no RPC changes an `id`. It is NOT an atomic
snapshot of the CONTENT: pages are separate requests, and a row updated after
its page was read is returned as that page saw it. Writes are protected by
`expected_version`, not by the read. A future DELETE path or mutable id would
invalidate the argument and must change `readAll` with it.

**Correction pass 3 — live authority before a local deletion.** The check
that runs right before the legacy database is deleted (and again before the
cutover is marked complete) no longer trusts the role the boot cached. After
confirming the action's generation and the signed-in user, it re-reads the
user's OWN membership rows from the server and requires the row for this
organisation to be ACTIVE — and, for the OWNER-only "back up and remove",
to carry the OWNER role — then confirms generation and user once more. A
downgraded, disabled or removed membership aborts with nothing deleted and
nothing marked, and the application reboots from live state. The automatic
retirement of an EMPTY legacy database requires no role, but is bound in the
same way to the boot that observed it and to that boot's user.
