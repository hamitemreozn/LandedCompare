-- ===========================================================================
-- Phase 10 security suite, 3/6 — tenant isolation through the api surface
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7 B1/B2, §5; threat
-- model 2, 18, 20.
--
-- Every assertion below goes through an `api` VIEW rather than through the
-- underlying table or the helper functions, because that is the only path a
-- client has and therefore the only path whose behaviour is a product
-- guarantee. Calling `app_private.current_org_ids()` directly and checking it
-- returns the right array would prove the function works; it would not prove
-- that the view above it applies the function, which is the thing a missing
-- `security_invoker = on` silently breaks.
--
-- Two organisations, four users, built by this file so that no assertion
-- depends on what `seed.sql` happens to contain today.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(14);

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '1a1a1a1a-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'iso-owner-a@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', '1a1a1a1a-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'iso-member-a@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '1b1b1b1b-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'iso-owner-b@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', '1c1c1c1c-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'iso-orphan@example.test',   now(), now());

insert into app_data.organizations (id, name) values
  ('1f1f1f1f-0000-4000-8000-00000000000a', 'Isolation Org A'),
  ('1f1f1f1f-0000-4000-8000-00000000000b', 'Isolation Org B');

insert into app_data.profiles (user_id, display_name) values
  ('1a1a1a1a-0000-4000-8000-000000000001', 'Isolation Owner A'),
  ('1a1a1a1a-0000-4000-8000-000000000002', 'Isolation Member A'),
  ('1b1b1b1b-0000-4000-8000-000000000001', 'Isolation Owner B'),
  ('1c1c1c1c-0000-4000-8000-000000000001', 'Isolation Orphan');

insert into app_data.memberships (organization_id, user_id, role, status) values
  ('1f1f1f1f-0000-4000-8000-00000000000a', '1a1a1a1a-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE'),
  ('1f1f1f1f-0000-4000-8000-00000000000a', '1a1a1a1a-0000-4000-8000-000000000002', 'MEMBER', 'ACTIVE'),
  ('1f1f1f1f-0000-4000-8000-00000000000b', '1b1b1b1b-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE');
-- The orphan has an account and no membership. §13 requires the application to
-- distinguish that state from "no data" rather than rendering an empty screen.

insert into app_data.admin_events (organization_id, event_type, actor_user_id, subject_user_id, details) values
  ('1f1f1f1f-0000-4000-8000-00000000000a', 'MEMBER_PROVISIONED',
   '1a1a1a1a-0000-4000-8000-000000000001', '1a1a1a1a-0000-4000-8000-000000000002', '{"role":"MEMBER"}'),
  ('1f1f1f1f-0000-4000-8000-00000000000b', 'MEMBER_PROVISIONED',
   '1b1b1b1b-0000-4000-8000-000000000001', '1b1b1b1b-0000-4000-8000-000000000001', '{"role":"OWNER"}');

insert into app_data.provisioning_attempts (request_id, organization_id, email, requested_role, status, actor_user_id) values
  ('1aaaaaaa-0000-4000-8000-000000000001', '1f1f1f1f-0000-4000-8000-00000000000a', 'pending-a@example.test', 'MEMBER', 'IN_FLIGHT', '1a1a1a1a-0000-4000-8000-000000000001'),
  ('1bbbbbbb-0000-4000-8000-000000000001', '1f1f1f1f-0000-4000-8000-00000000000b', 'pending-b@example.test', 'MEMBER', 'IN_FLIGHT', '1b1b1b1b-0000-4000-8000-000000000001');

-- ===========================================================================
-- Owner of organisation A
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"1a1a1a1a-0000-4000-8000-000000000001","role":"authenticated"}', true);

select results_eq(
  $$ select name from api.organizations order by name $$,
  $$ values ('Isolation Org A') $$,
  'B1: api.organizations returns the caller''s own organisation and no other'
);

select results_eq(
  $$ select display_name from api.profiles
      where user_id in ('1a1a1a1a-0000-4000-8000-000000000001',
                        '1a1a1a1a-0000-4000-8000-000000000002',
                        '1b1b1b1b-0000-4000-8000-000000000001',
                        '1c1c1c1c-0000-4000-8000-000000000001')
      order by display_name $$,
  $$ values ('Isolation Member A'), ('Isolation Owner A') $$,
  'threat 18: a profile is visible only to users who share an ACTIVE membership — the other tenant''s owner and the orphan are not'
);

select results_eq(
  $$ select organization_id, role from api.memberships $$,
  $$ values ('1f1f1f1f-0000-4000-8000-00000000000a'::uuid, 'OWNER') $$,
  'api.memberships returns the caller''s own membership rows'
);

select results_eq(
  $$ select organization_id from api.admin_events order by organization_id $$,
  $$ values ('1f1f1f1f-0000-4000-8000-00000000000a'::uuid) $$,
  'B2: an OWNER reads their own organisation''s admin events and not the other tenant''s'
);

select results_eq(
  $$ select email from api.provisioning_attempts $$,
  $$ values ('pending-a@example.test') $$,
  'B2: a stuck IN_FLIGHT attempt is visible to its own organisation''s OWNER, and only to it'
);

-- Naming the other tenant's row by its exact primary key is the same answer as
-- naming one that does not exist. The enumeration oracle closes with the access
-- control rather than beside it.
select is(
  (select count(*)::integer from api.admin_events
    where organization_id = '1f1f1f1f-0000-4000-8000-00000000000b'),
  0,
  'threat 2: filtering explicitly for the other tenant''s organisation_id returns nothing'
);

-- ===========================================================================
-- A MEMBER of the same organisation — the role boundary, not the tenant one
-- ===========================================================================
select set_config('request.jwt.claims',
  '{"sub":"1a1a1a1a-0000-4000-8000-000000000002","role":"authenticated"}', true);

select results_eq(
  $$ select name from api.organizations $$,
  $$ values ('Isolation Org A') $$,
  'a MEMBER reads the organisation they belong to'
);

select is(
  (select count(*)::integer from api.admin_events),
  0,
  'a MEMBER reads no admin events — administration is not shared business data'
);

select is(
  (select count(*)::integer from api.provisioning_attempts),
  0,
  'a MEMBER reads no provisioning attempts — the table names people being invited'
);

-- ===========================================================================
-- Owner of organisation B — the mirror image, which is what makes it isolation
-- rather than an empty database
-- ===========================================================================
select set_config('request.jwt.claims',
  '{"sub":"1b1b1b1b-0000-4000-8000-000000000001","role":"authenticated"}', true);

select results_eq(
  $$ select name from api.organizations $$,
  $$ values ('Isolation Org B') $$,
  'B1: the second tenant sees the second organisation — both directions, not one'
);

select results_eq(
  $$ select email from api.provisioning_attempts $$,
  $$ values ('pending-b@example.test') $$,
  'B2: and the second tenant''s OWNER sees only their own attempts'
);

-- ===========================================================================
-- An authenticated account with no membership
--
-- §13: this is a distinct application state. Authentication without membership
-- grants nothing, and the interface must say "your account is not attached to a
-- company" rather than rendering an empty product.
-- ===========================================================================
select set_config('request.jwt.claims',
  '{"sub":"1c1c1c1c-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is(
  (select count(*)::integer from api.organizations),
  0,
  'threat 17: an authenticated account with no membership reads no organisation'
);

select results_eq(
  $$ select display_name from api.profiles $$,
  $$ values ('Isolation Orphan') $$,
  '…but still reads its own profile, which is what lets the application name the state instead of failing blank'
);

-- ===========================================================================
-- The JWT is a credential, not an authorisation
--
-- A forged organisation claim in the token changes nothing, because no policy
-- in this system reads one. Every one of them resolves membership from
-- app_data.memberships at query time.
-- ===========================================================================
select set_config('request.jwt.claims',
  '{"sub":"1c1c1c1c-0000-4000-8000-000000000001","role":"authenticated",' ||
  '"organization_id":"1f1f1f1f-0000-4000-8000-00000000000a",' ||
  '"app_metadata":{"role":"OWNER","organizations":["1f1f1f1f-0000-4000-8000-00000000000a"]}}',
  true);

select is(
  (select count(*)::integer from api.organizations),
  0,
  'threat 3: a JWT asserting membership and an OWNER role grants nothing — tenancy is live database state'
);

reset role;

select * from finish();
rollback;
