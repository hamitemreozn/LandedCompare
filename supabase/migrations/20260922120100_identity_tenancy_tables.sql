-- ===========================================================================
-- Phase 10 — Cloud Foundation, 2/7: identity and tenancy tables
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §5, §11 Group 1.
--
-- Six tables, all in `app_data`, none of them reachable over HTTP. Policies,
-- grants and triggers arrive in migrations 3 and 4 — this file is shape only,
-- and every table is created with no privilege granted to anybody, which is the
-- state it would stay in if a later migration forgot it.
--
-- Products, suppliers, customers and customer statuses are NOT here. They are
-- Phase 11, and creating a table whose shape is guessed a phase early is how a
-- schema acquires columns nobody can explain.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- organizations — the company boundary
--
-- Named `organization` rather than `company` or `workspace` because
-- `organization_id` is unambiguous as a column name on forty tables, and
-- because "company" is a word this domain already uses for suppliers and
-- customers.
--
-- The three `write_lock*` columns are the restore write gate of §16. They are
-- created here, with the table, because retrofitting a gate onto live company
-- data is a migration nobody wants to run under pressure. Nothing in Phase 10
-- sets them: acquiring and releasing the gate is Phase 21's restore RPC, and
-- there is deliberately no client write path to this table at all. The gate's
-- enforcement — `app_private.assert_write_allowed` and its trigger — IS built
-- here, because Phase 11 attaches it to every business table it creates.
--
-- `maintenance_until` is deliberately absent. It was the earlier, broken form
-- of the gate: an expiring timestamp is the one thing a restore lock must not
-- be, because a lock a slow restore outlives is a lock that releases while the
-- data is half-replaced.
-- ---------------------------------------------------------------------------
create table app_data.organizations (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null,
  write_locked_at   timestamptz,
  write_locked_by   uuid        references auth.users (id) on delete set null,
  write_lock_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid        references auth.users (id) on delete set null,
  updated_by        uuid        references auth.users (id) on delete set null,
  version           integer     not null default 1,
  constraint organizations_name_not_blank
    check (btrim(name) <> ''),
  -- The gate is held, or it is not. A half-set gate — a timestamp with no
  -- holder, or a holder with no timestamp — would make "is this organisation
  -- locked?" a question with two answers, and §16's trigger asks it on every
  -- write.
  constraint organizations_write_lock_is_whole
    check (num_nonnulls(write_locked_at, write_locked_by, write_lock_reason) in (0, 3))
);

-- §11 rule 3 — every parent declares `unique (id, organization_id)` so a child
-- can carry a composite foreign key and be structurally unable to belong to a
-- parent in another organisation. For `organizations` the tenant IS the row, so
-- the pair collapses to the primary key and children reference
-- `organizations (id)` directly. Stated here because the rule's absence on this
-- one table would otherwise read as an omission.

comment on table app_data.organizations is
  'The company boundary. One row per company; the pilot has exactly one. No client write path exists in Phase 10.';
comment on column app_data.organizations.write_locked_at is
  'Restore write gate (§16). Set by Phase 21''s restore RPC in a committed transaction BEFORE the destructive one, so the gate is visible to every other transaction while it matters.';
comment on column app_data.organizations.write_locked_by is
  'The lock holder. A gate that names no holder cannot distinguish the restore''s own transaction from the same OWNER''s second browser tab.';

-- ---------------------------------------------------------------------------
-- profiles — one row per user, holding the display name
--
-- This is not a third tenancy concept. It exists because `auth.users` lives in
-- the `auth` schema, is not exposed over the Data API, and must not be:
-- exposing it would publish every user's e-mail address to every tenant.
-- Rendering "Ayşe tarafından kaydedildi" needs a name that is readable under a
-- row-level policy, and a profile is the only place to put one.
--
-- `must_change_password` drives the forced first-password-change flow of §4.
-- Its honest scope is recorded on the column.
-- ---------------------------------------------------------------------------
create table app_data.profiles (
  user_id              uuid        primary key references auth.users (id) on delete cascade,
  display_name         text        not null,
  must_change_password boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid        references auth.users (id) on delete set null,
  updated_by           uuid        references auth.users (id) on delete set null,
  version              integer     not null default 1,
  constraint profiles_display_name_not_blank
    check (btrim(display_name) <> '')
);

comment on table app_data.profiles is
  'Display identity, one row per auth user. Visible only to users who share an ACTIVE membership with it; auth.users itself is never exposed.';
comment on column app_data.profiles.must_change_password is
  'A UX gate, not a security control. The administrator handed this account a password out of band (§4) and the user is asked to replace it. The account is the user''s own, so clearing the flag without changing the password harms only themselves; proving the password actually changed would need an Auth hook this pilot does not have.';

-- ---------------------------------------------------------------------------
-- memberships — the join that carries the role and the status
--
-- Primary key (organization_id, user_id), so a user belongs to an organisation
-- at most once. A user MAY belong to several organisations: that is the natural
-- shape of a join table and costs nothing today, where a
-- `profiles.organization_id` column would cost a migration the first time it is
-- wrong. The MVP interface assumes exactly one active membership and selects it
-- without an organisation picker.
--
-- Role and status are `text` with a check constraint rather than a PostgreSQL
-- enum, because adding `WAREHOUSE` later should be one migration and a new
-- policy predicate — not an `alter type` that cannot run inside a transaction
-- block with everything else.
-- ---------------------------------------------------------------------------
create table app_data.memberships (
  organization_id uuid        not null references app_data.organizations (id) on delete restrict,
  user_id         uuid        not null references auth.users (id) on delete cascade,
  role            text        not null,
  status          text        not null default 'ACTIVE',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid        references auth.users (id) on delete set null,
  updated_by      uuid        references auth.users (id) on delete set null,
  version         integer     not null default 1,
  primary key (organization_id, user_id),
  constraint memberships_role_known
    check (role in ('OWNER', 'ADMIN', 'MEMBER')),
  constraint memberships_status_known
    check (status in ('ACTIVE', 'DISABLED'))
);

-- The lookup every RLS policy in the system performs, once per statement.
create index memberships_user_active_idx
  on app_data.memberships (user_id, organization_id)
  where status = 'ACTIVE';

comment on table app_data.memberships is
  'Which users belong to which organisations, as what, and whether that is currently in force. Read from the database on every request; never from a JWT claim.';
comment on column app_data.memberships.status is
  'ACTIVE | DISABLED. Setting DISABLED takes effect on the very next request, even if the user holds a valid unexpired access token — which is the control for "a removed member keeps an old token".';

-- ---------------------------------------------------------------------------
-- provisioning_attempts — the whole idempotency mechanism of §4
--
-- `auth.admin.createUser()` is an HTTP call to the Auth service and the profile
-- and membership rows are a PostgreSQL write. Between them sit a network, a
-- timeout, and an Edge Function that can be killed mid-execution. They do not
-- commit together and this table is what makes running the workflow twice
-- converge on one valid final state rather than producing a second one.
--
-- `request_id` is the primary key and is generated by the client, once per
-- press of the button, and reused on retry — exactly as the client already
-- generates entity UUIDs.
-- ---------------------------------------------------------------------------
create table app_data.provisioning_attempts (
  request_id      uuid        primary key,
  organization_id uuid        not null references app_data.organizations (id) on delete restrict,
  email           text        not null,
  requested_role  text        not null,
  status          text        not null default 'IN_FLIGHT',
  -- Whether THIS attempt created the auth user. The compensating delete in
  -- step 4 of §4 consults exactly this column, which is what makes case C
  -- (the e-mail already exists) safe: no path ever deletes an auth user it did
  -- not create in the same attempt.
  created_here    boolean,
  subject_user_id uuid        references auth.users (id) on delete set null,
  actor_user_id   uuid        references auth.users (id) on delete set null,
  failure_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint provisioning_attempts_status_known
    check (status in ('IN_FLIGHT', 'SUCCEEDED', 'FAILED')),
  constraint provisioning_attempts_role_known
    check (requested_role in ('OWNER', 'ADMIN', 'MEMBER')),
  constraint provisioning_attempts_email_normalised
    check (email = lower(btrim(email)) and email <> ''),
  -- A succeeded attempt names the user it linked. Without this, the stored
  -- outcome a retry returns could be an empty answer that looks like success.
  constraint provisioning_attempts_succeeded_has_subject
    check (status <> 'SUCCEEDED' or subject_user_id is not null)
);

create index provisioning_attempts_org_status_idx
  on app_data.provisioning_attempts (organization_id, status, created_at desc);

comment on table app_data.provisioning_attempts is
  'Idempotency record for admin-provision-user (§4). The only thing in the workflow that is ever left half-done, and it is inert.';

-- ---------------------------------------------------------------------------
-- admin_events — the one narrow audit exception
--
-- There is no generic audit log and no event sourcing, because this product
-- already has an audit log for everything that matters: the append-only
-- inventory ledger is the history of every physical fact. What that ledger does
-- not record is the operations that change WHO CAN DO THINGS and leave no other
-- row behind. Those are rare, high-consequence and invisible otherwise, which
-- is exactly the case a log is for.
--
-- Append-only, and enforced as such by a trigger in migration 3 as well as by
-- the absence of any update or delete grant or policy.
-- ---------------------------------------------------------------------------
create table app_data.admin_events (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references app_data.organizations (id) on delete restrict,
  event_type      text        not null,
  actor_user_id   uuid        references auth.users (id) on delete set null,
  subject_user_id uuid        references auth.users (id) on delete set null,
  -- Already-safe structured context: a role, a checksum, a set of counts.
  -- Never a password, and never anything derived from one.
  details         jsonb       not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  constraint admin_events_type_known
    check (event_type in (
      'MEMBER_PROVISIONED',
      'MEMBER_DISABLED',
      'MEMBER_REENABLED',
      'MEMBER_ROLE_CHANGED',
      'PASSWORD_RESET_BY_ADMIN',
      'ORGANIZATION_DATA_IMPORTED',
      'ORGANIZATION_DATA_RESTORED',
      'WRITE_GATE_ACQUIRED',
      'WRITE_GATE_RELEASED'
    )),
  constraint admin_events_details_is_object
    check (jsonb_typeof(details) = 'object')
);

create index admin_events_org_time_idx
  on app_data.admin_events (organization_id, occurred_at desc);

comment on table app_data.admin_events is
  'Append-only record of the seven operations that change who can do things. No updated_at and no version, because there is no update — the absence of the columns says so.';

-- ---------------------------------------------------------------------------
-- counters — human-code allocation, server-side by necessity
--
-- `PO-2026-0007` must be unique across every device in the company, which is
-- precisely what independent local databases could not promise. Allocation
-- happens inside an RPC from a row locked FOR UPDATE, and gaps are tolerated —
-- already the rule.
--
-- No client touches this table by any path: no grant, no policy, RLS forced.
-- The allocation function arrives with the first table that needs a code
-- (Phase 16). What it gets in Phase 10 is the write gate, because counters are
-- part of an organisation's portable export and therefore part of what a
-- restore replaces.
-- ---------------------------------------------------------------------------
create table app_data.counters (
  organization_id uuid        not null references app_data.organizations (id) on delete restrict,
  key             text        not null,
  next_value      bigint      not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid        references auth.users (id) on delete set null,
  updated_by      uuid        references auth.users (id) on delete set null,
  primary key (organization_id, key),
  constraint counters_key_not_blank check (btrim(key) <> ''),
  constraint counters_next_value_positive check (next_value >= 1)
);

comment on table app_data.counters is
  'Per-organisation human-code sequences. Server-only: no grant and no policy, so there is no client path to an allocation. The allocation RPC arrives with the first table that needs a code.';

-- ---------------------------------------------------------------------------
-- Register every table created above
--
-- The pgTAP suite asserts this registry and `pg_class` agree in both
-- directions. A seventh table added to `app_data` without a row here fails the
-- build, and so does a row here naming a table that does not exist.
-- ---------------------------------------------------------------------------
insert into app_private.managed_table (table_schema, table_name, policy_class, note) values
  ('app_data', 'organizations',
   'TENANT_READONLY',
   'Members read their own organisations. No client write path: renaming is Phase 12, the write-lock columns are Phase 21.'),
  ('app_data', 'memberships',
   'TENANT_READONLY',
   'A user reads the memberships of organisations they are an ACTIVE member of. Changes go through the provisioning and administration RPCs.'),
  ('app_data', 'profiles',
   'IDENTITY_SELF',
   'Not organisation-scoped. Readable by users sharing an ACTIVE membership; updatable only by its owner, through api.update_own_profile.'),
  ('app_data', 'provisioning_attempts',
   'TENANT_SERVER_WRITTEN',
   'Readable by OWNER/ADMIN so a stuck IN_FLIGHT attempt is visible. Written only by the SECURITY DEFINER provisioning RPCs.'),
  ('app_data', 'admin_events',
   'TENANT_APPEND_ONLY',
   'Readable by OWNER/ADMIN. Never updated or deleted, enforced by trigger as well as by the absence of grants.'),
  ('app_data', 'counters',
   'SERVER_ONLY',
   'No client access of any kind. Allocation happens inside an RPC from a row locked FOR UPDATE.');
