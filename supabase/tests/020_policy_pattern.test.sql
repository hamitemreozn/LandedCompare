-- ===========================================================================
-- Phase 10 security suite, 2/6 — the four-policy pattern, proved
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7, "The four-policy
-- pattern"; threat model 1, 2 and 9b.
--
-- ---------------------------------------------------------------------------
-- Why this test builds its own table
--
-- Phase 10 owns no organisation-scoped table a client may WRITE. Products,
-- suppliers and customers are Phase 11, and inventing one here to have
-- something to test would be exactly the "create a table whose shape is guessed
-- a phase early" mistake §11 warns about.
--
-- But the pattern those tables will copy — `using` on SELECT, `with check` on
-- INSERT, BOTH clauses on UPDATE, no DELETE policy and no DELETE grant, plus
-- the stamping and tenant-immutability triggers — is being fixed NOW, and every
-- later phase inherits whatever is wrong with it. A defect in the pattern is a
-- defect in every table built after this one.
--
-- So the test constructs a probe table carrying the exact pattern, inside the
-- transaction it rolls back. The table never ships. What ships is the evidence
-- that the pattern refuses a cross-tenant write when it is exercised by a real
-- `authenticated` session against the real helper functions — rather than the
-- evidence that the SQL was typed the way the document types it, which is what
-- a test mirroring the migration would prove.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(12);

-- ---------------------------------------------------------------------------
-- Two tenants. One is not enough: a suite that proves a member sees their own
-- rows proves nothing until there are other rows for them to fail to see.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '0d0d0d0d-0000-4000-8000-00000000000a',
   'authenticated', 'authenticated', 'probe-a@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '0d0d0d0d-0000-4000-8000-00000000000b',
   'authenticated', 'authenticated', 'probe-b@example.test', now(), now());

insert into app_data.organizations (id, name) values
  ('0c0c0c0c-0000-4000-8000-00000000000a', 'Probe Org A'),
  ('0c0c0c0c-0000-4000-8000-00000000000b', 'Probe Org B');

insert into app_data.memberships (organization_id, user_id, role, status) values
  ('0c0c0c0c-0000-4000-8000-00000000000a', '0d0d0d0d-0000-4000-8000-00000000000a', 'MEMBER', 'ACTIVE'),
  ('0c0c0c0c-0000-4000-8000-00000000000b', '0d0d0d0d-0000-4000-8000-00000000000b', 'MEMBER', 'ACTIVE');

-- ---------------------------------------------------------------------------
-- The probe table, carrying the pattern verbatim
-- ---------------------------------------------------------------------------
create table app_data.policy_pattern_probe (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references app_data.organizations (id),
  label           text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid        references auth.users (id),
  updated_by      uuid        references auth.users (id),
  version         integer     not null default 1
);

alter table app_data.policy_pattern_probe enable row level security;
alter table app_data.policy_pattern_probe force  row level security;

revoke all on table app_data.policy_pattern_probe from public, anon, authenticated;
grant select, insert, update on table app_data.policy_pattern_probe to authenticated;
-- No DELETE grant. Deletion is not a client capability.

create policy probe_select on app_data.policy_pattern_probe
  for select to authenticated
  using (organization_id = any ((select app_private.current_org_ids())::uuid[]));

create policy probe_insert on app_data.policy_pattern_probe
  for insert to authenticated
  with check (organization_id = any ((select app_private.current_org_ids())::uuid[]));

create policy probe_update on app_data.policy_pattern_probe
  for update to authenticated
  using      (organization_id = any ((select app_private.current_org_ids())::uuid[]))
  with check (organization_id = any ((select app_private.current_org_ids())::uuid[]));

create trigger probe_stamp
  before insert or update on app_data.policy_pattern_probe
  for each row execute function app_private.stamp_row();

create trigger probe_tenant_immutable
  before update on app_data.policy_pattern_probe
  for each row execute function app_private.assert_tenant_immutable();

-- A row belonging to the OTHER tenant, written as the owner so the policies
-- under test are not the ones that put it there.
insert into app_data.policy_pattern_probe (id, organization_id, label)
values ('0e0e0e0e-0000-4000-8000-00000000000b', '0c0c0c0c-0000-4000-8000-00000000000b', 'B''s row');

-- ===========================================================================
-- Act as user A, through a real `authenticated` session
-- ===========================================================================
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"0d0d0d0d-0000-4000-8000-00000000000a","role":"authenticated"}',
  true
);

-- ---------------------------------------------------------------------------
-- B3 — the policy EVALUATES. Its absence is `permission denied for function`.
--
-- This is the first thing to check and the one that would be missed: an RLS
-- helper left ungranted does not leak, it makes every authenticated query
-- against every protected table fail. A suite that only tested for absence of
-- data would report that as a pass.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select count(*) from app_data.policy_pattern_probe $$,
  'B3: an authenticated SELECT evaluates its policy — the helper grants are present'
);

-- ---------------------------------------------------------------------------
-- SELECT `using` — the other tenant's row does not exist, as far as the query
-- is concerned. A guessed UUID returns zero rows, indistinguishable from "no
-- such record", so the enumeration oracle closes with the access control.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_data.policy_pattern_probe),
  0,
  'B1/B2: before writing anything, A sees zero rows — B''s row is invisible, not merely filtered from a list'
);

select is(
  (select count(*)::integer from app_data.policy_pattern_probe
    where id = '0e0e0e0e-0000-4000-8000-00000000000b'),
  0,
  'B2: naming the other tenant''s row by its exact primary key still returns nothing'
);

-- ---------------------------------------------------------------------------
-- INSERT `with check` — the control the brief asks for by name:
-- a client-supplied organization_id cannot be used to write into another tenant
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into app_data.policy_pattern_probe (organization_id, label)
     values ('0c0c0c0c-0000-4000-8000-00000000000a', 'A''s row') $$,
  'INSERT into the caller''s own organisation succeeds'
);

select throws_ok(
  $$ insert into app_data.policy_pattern_probe (organization_id, label)
     values ('0c0c0c0c-0000-4000-8000-00000000000b', 'smuggled') $$,
  '42501',
  null,
  'threat 1: an INSERT naming another tenant''s organization_id is refused by with_check'
);

-- ---------------------------------------------------------------------------
-- The stamping trigger OVERWRITES rather than validates
--
-- A client sending `created_by: '<someone else>'` does not get an error. It
-- gets its value silently replaced by the truth, which is correct because the
-- value was never an input.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into app_data.policy_pattern_probe (organization_id, label, created_by, updated_by, version, created_at)
     values ('0c0c0c0c-0000-4000-8000-00000000000a', 'forged',
             '0d0d0d0d-0000-4000-8000-00000000000b',
             '0d0d0d0d-0000-4000-8000-00000000000b',
             999, '1999-01-01T00:00:00Z') $$,
  'threat 8: a forged created_by/version/created_at is accepted without error'
);

select results_eq(
  $$ select created_by, version from app_data.policy_pattern_probe where label = 'forged' $$,
  $$ values ('0d0d0d0d-0000-4000-8000-00000000000a'::uuid, 1) $$,
  'threat 8: …and is silently replaced — attribution and version are server facts'
);

select ok(
  (select created_at > '2020-01-01T00:00:00Z'::timestamptz
     from app_data.policy_pattern_probe where label = 'forged'),
  'threat 8: the client''s clock does not define created_at either'
);

-- ---------------------------------------------------------------------------
-- UPDATE — both clauses, and the second is the one that gets forgotten
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::integer from app_data.policy_pattern_probe),
  2,
  'A sees exactly the two rows A wrote — the smuggled one was never written, and B''s is still invisible'
);

select throws_ok(
  $$ update app_data.policy_pattern_probe
        set organization_id = '0c0c0c0c-0000-4000-8000-00000000000b'
      where label = 'A''s row' $$,
  '42501',
  null,
  'threat 1: rewriting a row''s organization_id into another tenant is refused'
);

-- The UPDATE `using` clause refuses the other tenant's row by making it
-- invisible: zero rows matched rather than an error, which is the same answer
-- a nonexistent id gives.
with attempted as (
  update app_data.policy_pattern_probe set label = 'hijacked'
   where id = '0e0e0e0e-0000-4000-8000-00000000000b'
  returning 1
)
select is(
  (select count(*)::integer from attempted),
  0,
  'threat 2: an UPDATE aimed at the other tenant''s row affects nothing — zero rows, not an error, exactly as a nonexistent id would'
);

-- ---------------------------------------------------------------------------
-- DELETE — absent by design, and absent means "no privilege", not "no policy"
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ delete from app_data.policy_pattern_probe where label = 'A''s row' $$,
  '42501',
  null,
  'deletion is refused at the privilege level: no grant, so no statement gets as far as a policy'
);

reset role;

select * from finish();
rollback;
