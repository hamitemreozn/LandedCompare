-- ===========================================================================
-- Phase 12 — organisation administration and the provisioned-user lifecycle
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4, §6, §31.
--
-- Posture first (S1–S7), then behaviour, every call made by a real
-- `authenticated` session through the typed `api` RPCs:
--
--   - OWNER / ADMIN / MEMBER / another tenant's OWNER, each against the same
--     membership, each refused or allowed by the DATABASE;
--   - version checks, self-change refusal, the admin_events trail;
--   - A-L6: disabling a shared identity in one organisation leaves the Auth
--     identity, its profile and its other membership untouched;
--   - the operator-only orphan report and purge, and their refusals.
--
-- `pg_temp.failure_of` reports `SQLSTATE:DETAIL`, so an assertion names the
-- exact refusal rather than merely that something failed.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(81);

create function pg_temp.failure_of(p_statement text)
returns text
language plpgsql
as $$
declare
  v_detail text;
begin
  execute p_statement;
  return 'NO ERROR';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlstate || ':' || coalesce(v_detail, '');
end $$;

create function pg_temp.act_as(p_user uuid)
returns void
language sql
as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- ===========================================================================
-- Posture
-- ===========================================================================

select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api'
    and p.proname in ('list_organization_members', 'set_member_role', 'set_member_status', 'clear_provisioning_attempt')
    and p.prosecdef
$$, 'S1: the Phase 12 api functions are SECURITY INVOKER wrappers');

select is(
  (select count(*)::integer
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('organization_members', 'change_member_role', 'change_member_status', 'clear_provisioning_attempt')
      and p.prosecdef),
  4,
  'S2: the four privileged bodies are SECURITY DEFINER, in the unexposed app_private schema'
);

select is_empty($$
  select fn from unnest(array[
    'api.list_organization_members(uuid)',
    'api.set_member_role(uuid,uuid,integer,text)',
    'api.set_member_status(uuid,uuid,integer,text)',
    'api.clear_provisioning_attempt(uuid,uuid)',
    'app_private.organization_members(uuid)',
    'app_private.change_member_role(uuid,uuid,integer,text)',
    'app_private.change_member_status(uuid,uuid,integer,text)',
    'app_private.clear_provisioning_attempt(uuid,uuid)'
  ]) as fn
  where not has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('anon', fn, 'EXECUTE')
$$, 'S3a: authenticated may execute the Phase 12 surface and anon may not');

select is_empty($$
  select fn from unnest(array[
    'app_private.organization_members(uuid)',
    'app_private.change_member_role(uuid,uuid,integer,text)',
    'app_private.change_member_status(uuid,uuid,integer,text)',
    'app_private.clear_provisioning_attempt(uuid,uuid)'
  ]) as fn
  where has_function_privilege('service_role', fn, 'EXECUTE')
$$, 'S3b: the secret-key role cannot reach the administration bodies — the Edge Functions have no business there');

select is_empty($$
  select fn from unnest(array[
    'app_private.lock_membership_administration(uuid)',
    'app_private.member_json(uuid,uuid)',
    'app_private.require_caller()',
    'app_private.orphaned_auth_identities()',
    'app_private.purge_orphaned_auth_identity(uuid)'
  ]) as fn
  where has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE')
$$, 'S4: internal helpers and the A-L6 operator functions are executable by no Data API role');

select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api'
    and p.proname in ('set_member_role', 'set_member_status')
    and (
      p.pronargdefaults <> 0
      or not exists (
        select 1 from unnest(p.proargnames, p.proargtypes::oid[]) as arg(name, type)
        where arg.name = 'p_expected_version' and arg.type = 'integer'::regtype
      )
    )
$$, 'S5: both membership mutations require p_expected_version integer, with no default (P20, extended)');

select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api' and p.prosecdef
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE'))
$$, 'S6: no SECURITY DEFINER function in the exposed schema is executable by a user role');

select is(
  (select string_agg(policyname::text || ':' || cmd, ',' order by policyname)
     from pg_policies where schemaname = 'app_data' and tablename = 'memberships'),
  'memberships_select_own:SELECT',
  'S7a: memberships keeps its single helper-free own-rows policy — administration did not widen it'
);

select is_empty($$
  select a.privilege_type
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname = 'app_data' and c.relname = 'memberships'
    and a.grantee = 'authenticated'::regrole and a.privilege_type <> 'SELECT'
$$, 'S7b: authenticated still holds nothing but SELECT on app_data.memberships');

-- ===========================================================================
-- Fixture
--
--   Org A: owner1, owner2, admin, member, shared (also in B)
--   Org B: ownerB, shared
--   orphan: an identity with no membership anywhere
--   ghost:  an identity with only a DISABLED membership
-- ===========================================================================

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', '9a000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p12-owner1@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9a000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p12-owner2@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9a000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'p12-admin@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9a000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'p12-member@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9a000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'p12-shared@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9b000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p12-ownerb@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9c000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p12-orphan@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9c000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p12-ghost@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9c000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'p12-pending@example.test', now(), now());

insert into app_data.organizations (id, name) values
  ('9f000000-0000-4000-8000-00000000000a', 'Phase 12 Org A'),
  ('9f000000-0000-4000-8000-00000000000b', 'Phase 12 Org B');

insert into app_data.profiles (user_id, display_name) values
  ('9a000000-0000-4000-8000-000000000001', 'Owner One'),
  ('9a000000-0000-4000-8000-000000000002', 'Owner Two'),
  ('9a000000-0000-4000-8000-000000000003', 'Admin'),
  ('9a000000-0000-4000-8000-000000000004', 'Member'),
  ('9a000000-0000-4000-8000-000000000005', 'Shared Person'),
  ('9b000000-0000-4000-8000-000000000001', 'Owner B'),
  ('9c000000-0000-4000-8000-000000000002', 'Ghost');

insert into app_data.memberships (organization_id, user_id, role, status) values
  ('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000002', 'OWNER',  'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000003', 'ADMIN',  'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000004', 'MEMBER', 'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000005', 'MEMBER', 'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000b', '9b000000-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000b', '9a000000-0000-4000-8000-000000000005', 'MEMBER', 'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000b', '9c000000-0000-4000-8000-000000000002', 'MEMBER', 'DISABLED');

insert into app_data.provisioning_attempts (request_id, organization_id, email, requested_role, status, actor_user_id) values
  ('9e000000-0000-4000-8000-000000000001', '9f000000-0000-4000-8000-00000000000a', 'stuck@example.test', 'MEMBER', 'IN_FLIGHT', '9a000000-0000-4000-8000-000000000001'),
  ('9e000000-0000-4000-8000-000000000002', '9f000000-0000-4000-8000-00000000000a', 'p12-pending@example.test', 'MEMBER', 'IN_FLIGHT', '9a000000-0000-4000-8000-000000000001');

set local role authenticated;

-- ===========================================================================
-- MEMBER and another tenant are refused before anything is read
-- ===========================================================================
select pg_temp.act_as('9a000000-0000-4000-8000-000000000004');

select is(pg_temp.failure_of($$ select api.list_organization_members('9f000000-0000-4000-8000-00000000000a') $$),
  '42501:FORBIDDEN', 'a MEMBER cannot list the colleague roster');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000005', 1, 'ADMIN') $$),
  '42501:FORBIDDEN', 'a MEMBER cannot change a role');
select is(pg_temp.failure_of($$ select api.set_member_status('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000005', 1, 'DISABLED') $$),
  '42501:FORBIDDEN', 'a MEMBER cannot disable anyone');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000004', 1, 'OWNER') $$),
  '42501:FORBIDDEN', 'a MEMBER cannot promote themselves through the RPC either');

select pg_temp.act_as('9b000000-0000-4000-8000-000000000001');

select is(pg_temp.failure_of($$ select api.list_organization_members('9f000000-0000-4000-8000-00000000000a') $$),
  '42501:FORBIDDEN', 'cross-tenant: an OWNER of B cannot list A');
select is(pg_temp.failure_of($$ select api.set_member_status('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000005', 1, 'DISABLED') $$),
  '42501:FORBIDDEN', 'cross-tenant: an OWNER of B cannot disable a shared person''s membership in A');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000dead', 1, 'ADMIN') $$),
  '42501:FORBIDDEN', 'cross-tenant: the refusal for a non-existent subject is the same FORBIDDEN — no existence oracle');
select is(
  (select jsonb_agg(m ->> 'email' order by m ->> 'email')
     from jsonb_array_elements(api.list_organization_members('9f000000-0000-4000-8000-00000000000b')) m),
  '["p12-ghost@example.test", "p12-ownerb@example.test", "p12-shared@example.test"]'::jsonb,
  'an OWNER of B lists exactly B''s members, e-mail included, and nobody from A alone'
);

-- ===========================================================================
-- ADMIN: MEMBER and ADMIN memberships, never an OWNER's, never OWNER itself
-- ===========================================================================
select pg_temp.act_as('9a000000-0000-4000-8000-000000000003');

select is(jsonb_array_length(api.list_organization_members('9f000000-0000-4000-8000-00000000000a')), 5,
  'an ADMIN lists every member of A');
select is(pg_temp.failure_of($$ select api.set_member_status('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000001', 1, 'DISABLED') $$),
  '42501:FORBIDDEN', 'an ADMIN cannot disable an OWNER');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000002', 1, 'MEMBER') $$),
  '42501:FORBIDDEN', 'an ADMIN cannot demote an OWNER');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000004', 1, 'OWNER') $$),
  '42501:FORBIDDEN', 'an ADMIN cannot grant OWNER');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000003', 1, 'MEMBER') $$),
  '42501:FORBIDDEN', 'an ADMIN cannot change their own membership');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000004', 1, 'SUPERUSER') $$),
  'P0001:RECORD_INVALID', 'an unknown role is refused as invalid input');
select is(
  (select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000004', 1, 'ADMIN') ->> 'role'),
  'ADMIN', 'an ADMIN promotes a MEMBER to ADMIN, and the answer is the new projection');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000004', 1, 'MEMBER') $$),
  'P0001:STALE_WRITE', 'the same change sent with the version it replaced is a STALE_WRITE');
select is(pg_temp.failure_of($$ select api.set_member_status('9f000000-0000-4000-8000-00000000000a', '9f000000-0000-4000-8000-0000000000ff', 1, 'DISABLED') $$),
  'P0001:RECORD_NOT_FOUND', 'an administrator of A naming someone who is not in A gets RECORD_NOT_FOUND');
select is(pg_temp.failure_of($$ select api.clear_provisioning_attempt('9f000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-000000000001') $$),
  '42501:FORBIDDEN', 'an ADMIN cannot clear a stuck provisioning attempt — that is an OWNER decision (§4 case E)');

-- ===========================================================================
-- OWNER
-- ===========================================================================
select pg_temp.act_as('9a000000-0000-4000-8000-000000000001');

select is(pg_temp.failure_of($$ select api.set_member_status('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000001', 1, 'DISABLED') $$),
  '42501:FORBIDDEN', 'an OWNER cannot disable themselves');
select is(pg_temp.failure_of($$ select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000001', 1, 'ADMIN') $$),
  '42501:FORBIDDEN', 'an OWNER cannot demote themselves');
select is(
  (select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000002', 1, 'ADMIN') ->> 'role'),
  'ADMIN', 'an OWNER demotes another OWNER');
select is(
  (select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000002', 2, 'OWNER') ->> 'version'),
  '3', 'an OWNER grants OWNER, and the version moves exactly once per change');
select is(
  (select api.set_member_role('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000002', 3, 'OWNER') ->> 'version'),
  '3', 'setting the role a member already holds is a no-op: no version bump, no event');

-- A-L6 — disabling a SHARED identity in A.
select is(
  (select api.set_member_status('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000005', 1, 'DISABLED') ->> 'status'),
  'DISABLED', 'an OWNER disables a member');
select is(
  (select api.list_organization_members('9f000000-0000-4000-8000-00000000000a') @> '[{"userId":"9a000000-0000-4000-8000-000000000005","status":"DISABLED"}]'::jsonb),
  true, 'the disabled member stays on the roster as DISABLED — removal is a status, not a deletion');
select is(pg_temp.failure_of($$ delete from app_data.memberships where user_id = '9a000000-0000-4000-8000-000000000005' $$),
  '42501:', 'and no client statement can delete a membership row');

-- The shared person's own session, after the change in A.
select pg_temp.act_as('9a000000-0000-4000-8000-000000000005');
select is(
  (select array_agg(o order by o) from unnest(app_private.current_org_ids()) o),
  array['9f000000-0000-4000-8000-00000000000b']::uuid[],
  'A-L6: the shared person now reaches only B — access to A ended on the next statement, B is untouched'
);

select pg_temp.act_as('9a000000-0000-4000-8000-000000000001');
select is(
  (select api.set_member_status('9f000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000005', 2, 'ACTIVE') ->> 'status'),
  'ACTIVE', 're-enabling is the same call in reverse');

select is(
  (select api.clear_provisioning_attempt('9f000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-000000000001') ->> 'status'),
  'CLEARED', 'an OWNER clears a stuck IN_FLIGHT attempt explicitly');
select is(pg_temp.failure_of($$ select api.clear_provisioning_attempt('9f000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-000000000001') $$),
  'P0001:RECORD_NOT_FOUND', 'an attempt that is no longer in flight cannot be cleared twice');

select pg_temp.act_as('9b000000-0000-4000-8000-000000000001');
select is(pg_temp.failure_of($$ select api.clear_provisioning_attempt('9f000000-0000-4000-8000-00000000000b', '9e000000-0000-4000-8000-000000000002') $$),
  'P0001:RECORD_NOT_FOUND', 'an OWNER of B cannot clear A''s attempt by naming it under B');

reset role;

-- ===========================================================================
-- What the administration left behind — read as the owner
-- ===========================================================================
select is(
  (select count(*)::integer from auth.users where id = '9a000000-0000-4000-8000-000000000005'),
  1, 'A-L6: disabling the shared person in A did not delete their Auth identity');
select is(
  (select count(*)::integer from app_data.profiles where user_id = '9a000000-0000-4000-8000-000000000005'),
  1, 'A-L6: …nor their profile');
select is(
  (select status from app_data.memberships
    where organization_id = '9f000000-0000-4000-8000-00000000000b' and user_id = '9a000000-0000-4000-8000-000000000005'),
  'ACTIVE', 'A-L6: …nor their membership in B');

select is(
  (select string_agg(event_type || ':' || coalesce(details ->> 'old_role', details ->> 'role') || '>' || coalesce(details ->> 'new_role', ''), ',' order by event_type, details::text)
     from app_data.admin_events where organization_id = '9f000000-0000-4000-8000-00000000000a'),
  'MEMBER_DISABLED:MEMBER>,MEMBER_REENABLED:MEMBER>,MEMBER_ROLE_CHANGED:MEMBER>ADMIN,MEMBER_ROLE_CHANGED:OWNER>ADMIN,MEMBER_ROLE_CHANGED:ADMIN>OWNER',
  'every effective change wrote exactly one admin event, with the old and new role; refusals and no-ops wrote none'
);
select is(
  (select count(*)::integer from app_data.admin_events
    where organization_id = '9f000000-0000-4000-8000-00000000000a'
      and actor_user_id not in ('9a000000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000003')),
  0, 'each event names the administrator who acted, taken from the session and not from a parameter');
select is(
  (select failure_reason from app_data.provisioning_attempts where request_id = '9e000000-0000-4000-8000-000000000001'),
  'CLEARED_BY_OWNER', 'the cleared attempt is FAILED with a reason, and nothing else was deleted');
select ok(
  not exists (
    select 1 from app_data.organizations o
    where not exists (select 1 from app_data.memberships m
                      where m.organization_id = o.id and m.role = 'OWNER' and m.status = 'ACTIVE')
      and o.id in ('9f000000-0000-4000-8000-00000000000a', '9f000000-0000-4000-8000-00000000000b')
  ),
  'every organisation still has an active OWNER'
);

-- ===========================================================================
-- complete_provisioning: re-inviting your own address cannot change your role
-- ===========================================================================
insert into app_data.provisioning_attempts (request_id, organization_id, email, requested_role, status, actor_user_id) values
  ('9e000000-0000-4000-8000-000000000003', '9f000000-0000-4000-8000-00000000000a', 'p12-owner1@example.test', 'MEMBER', 'IN_FLIGHT', '9a000000-0000-4000-8000-000000000001'),
  ('9e000000-0000-4000-8000-000000000004', '9f000000-0000-4000-8000-00000000000a', 'p12-owner1@example.test', 'OWNER',  'IN_FLIGHT', '9a000000-0000-4000-8000-000000000001');

set local role service_role;
select is(pg_temp.failure_of($$ select api.complete_provisioning('9e000000-0000-4000-8000-000000000003', '9a000000-0000-4000-8000-000000000001', 'Owner One', false) $$),
  '42501:FORBIDDEN', 'an OWNER re-inviting their own address as MEMBER is refused — invitation is not a self-demotion path');
select is(
  (select api.complete_provisioning('9e000000-0000-4000-8000-000000000004', '9a000000-0000-4000-8000-000000000001', 'Owner One', false) ->> 'status'),
  'SUCCEEDED', '…while re-linking your own address with the role you already hold still converges (§4 case D)');
reset role;
select is(
  (select role from app_data.memberships where organization_id = '9f000000-0000-4000-8000-00000000000a' and user_id = '9a000000-0000-4000-8000-000000000001'),
  'OWNER', 'the owner is still an OWNER');

-- ===========================================================================
-- A-L6 operator functions
-- ===========================================================================
select is(
  (select string_agg(email || ':' || eligible_for_purge::text, ',' order by email)
     from app_private.orphaned_auth_identities() where email like 'p12-%'),
  'p12-ghost@example.test:false,p12-orphan@example.test:true,p12-pending@example.test:false',
  'the report lists identities with no ACTIVE membership; only the true orphan is purgeable'
);
select throws_ok(
  $$ select app_private.purge_orphaned_auth_identity('9c000000-0000-4000-8000-000000000002') $$,
  'P0001', null,
  'purge refuses an identity that still has a (DISABLED) membership: that is the product lifecycle, not an orphan'
);
select throws_ok(
  $$ select app_private.purge_orphaned_auth_identity('9c000000-0000-4000-8000-000000000003') $$,
  'P0001', null,
  'purge refuses an identity an in-flight provisioning attempt is about to link (§4 case E)'
);
select throws_ok(
  $$ select app_private.purge_orphaned_auth_identity('9a000000-0000-4000-8000-000000000005') $$,
  'P0001', null,
  'purge refuses an identity with ACTIVE memberships'
);
select is(app_private.purge_orphaned_auth_identity('9c000000-0000-4000-8000-000000000001'), 'PURGED',
  'purge deletes a true orphan');
select is((select count(*)::integer from auth.users where id = '9c000000-0000-4000-8000-000000000001'), 0,
  'the orphan identity is gone');

set local role authenticated;
select pg_temp.act_as('9a000000-0000-4000-8000-000000000001');
select is(pg_temp.failure_of($$ select app_private.orphaned_auth_identities() $$),
  '42501:', 'an OWNER session cannot run the operator report');
select is(pg_temp.failure_of($$ select app_private.purge_orphaned_auth_identity('9c000000-0000-4000-8000-000000000002') $$),
  '42501:', 'an OWNER session cannot purge an identity');
reset role;

set local role service_role;
select is(pg_temp.failure_of($$ select app_private.purge_orphaned_auth_identity('9c000000-0000-4000-8000-000000000002') $$),
  '42501:', 'the secret-key role cannot purge an identity either — no browser or Edge Function path reaches it');
reset role;

-- ===========================================================================
-- Security correction pass (P12-B1, P12-H1, P12-M1)
-- ===========================================================================

-- P12-B1: the password-reset RPCs no longer exist, for any role.
select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api' and p.proname in ('begin_password_reset', 'complete_password_reset')
$$, 'P12-B1: no RPC exists through which an organisation could replace a global credential');

-- Fixture: org C with two OWNERs; an outside identity whose global profile
-- already exists (it belongs to org B).
insert into app_data.organizations (id, name) values ('9f000000-0000-4000-8000-00000000000c', 'Phase 12 Org C');
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', '9d000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p12-c-owner1@example.test', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '9d000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p12-c-owner2@example.test', now(), now());
insert into app_data.profiles (user_id, display_name) values
  ('9d000000-0000-4000-8000-000000000001', 'C Owner One'),
  ('9d000000-0000-4000-8000-000000000002', 'C Owner Two');
insert into app_data.memberships (organization_id, user_id, role, status) values
  ('9f000000-0000-4000-8000-00000000000c', '9d000000-0000-4000-8000-000000000001', 'OWNER', 'ACTIVE'),
  ('9f000000-0000-4000-8000-00000000000c', '9d000000-0000-4000-8000-000000000002', 'OWNER', 'ACTIVE');
update app_data.profiles set must_change_password = false where user_id = '9a000000-0000-4000-8000-000000000005';

-- P12-H1: OWNER claims an OWNER invitation, is demoted to ADMIN, the
-- completion arrives afterwards.
set local role service_role;
select is(
  (select api.begin_provisioning('9e000000-0000-4000-8000-0000000000c1', '9f000000-0000-4000-8000-00000000000c',
     'p12-shared@example.test', 'OWNER', '9d000000-0000-4000-8000-000000000001') ->> 'status'),
  'CLAIMED', 'P12-H1: an OWNER claims an invitation that grants OWNER');
reset role;
update app_data.memberships set role = 'ADMIN'
 where organization_id = '9f000000-0000-4000-8000-00000000000c' and user_id = '9d000000-0000-4000-8000-000000000001';
set local role service_role;
select is(pg_temp.failure_of($$ select api.complete_provisioning('9e000000-0000-4000-8000-0000000000c1', '9a000000-0000-4000-8000-000000000005', 'Taken Over', false) $$),
  '42501:FORBIDDEN', 'P12-H1: after the actor is demoted to ADMIN, completing the OWNER grant is refused');
reset role;
select is(
  (select count(*)::integer from app_data.memberships
    where organization_id = '9f000000-0000-4000-8000-00000000000c' and user_id = '9a000000-0000-4000-8000-000000000005'),
  0, 'P12-H1: no membership, OWNER or otherwise, was granted on the stale authority');

-- P12-M1: org C (its remaining OWNER) invites the shared person as MEMBER
-- under a different name. The global profile keeps its name and its flag.
set local role service_role;
select is(
  (select api.begin_provisioning('9e000000-0000-4000-8000-0000000000c2', '9f000000-0000-4000-8000-00000000000c',
     'p12-shared@example.test', 'MEMBER', '9d000000-0000-4000-8000-000000000002') ->> 'status'),
  'CLAIMED', 'P12-M1: a second organisation claims an invitation for an existing identity');
select is(
  (select api.complete_provisioning('9e000000-0000-4000-8000-0000000000c2', '9a000000-0000-4000-8000-000000000005', 'Renamed By C', false) ->> 'status'),
  'SUCCEEDED', 'P12-M1: the existing identity is linked');
reset role;
select is(
  (select display_name || ':' || must_change_password::text from app_data.profiles where user_id = '9a000000-0000-4000-8000-000000000005'),
  'Shared Person:false', 'P12-M1: the global profile keeps its name and its password flag — org C did not rename the person org A and B see');
select is(
  (select role || ':' || status from app_data.memberships
    where organization_id = '9f000000-0000-4000-8000-00000000000c' and user_id = '9a000000-0000-4000-8000-000000000005'),
  'MEMBER:ACTIVE', 'P12-M1: the membership itself is created as invited');

-- ===========================================================================
-- Final credential correction — no account-existence oracle in what a
-- colleague or an administrator can read
-- ===========================================================================
select is(
  (select string_agg(k, ',' order by k) from app_data.admin_events e, jsonb_object_keys(e.details) k
    where e.organization_id = '9f000000-0000-4000-8000-00000000000c' and e.event_type = 'MEMBER_PROVISIONED'),
  'email,request_id,role',
  'the provisioning audit row carries no auth_user_created flag'
);

update app_data.profiles set must_change_password = true where user_id = '9d000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.act_as('9d000000-0000-4000-8000-000000000002');
select is(
  (select must_change_password::text || '|' || version || '|' || coalesce(created_at, 'null') || '|' || coalesce(updated_at, 'null')
     from api.profiles where user_id = '9d000000-0000-4000-8000-000000000001'),
  'false|0|null|null',
  'a colleague sees another member''s name only: no onboarding flag, version or timestamps'
);
select is(
  (select display_name from api.profiles where user_id = '9d000000-0000-4000-8000-000000000001'),
  'C Owner One', '…while the display name — the reason a colleague may read a profile — is still there');
select ok(
  (select created_at is not null and version >= 1 from api.profiles where user_id = '9d000000-0000-4000-8000-000000000002'),
  'the caller still reads their OWN profile in full');
select pg_temp.act_as('9d000000-0000-4000-8000-000000000001');
select is(
  (select must_change_password from api.profiles where user_id = '9d000000-0000-4000-8000-000000000001'),
  true, 'the person themself still sees their own onboarding flag');
reset role;

-- ===========================================================================
-- Final onboarding correction — password setup is derived from the Auth
-- record, never from whether this attempt created the account
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, invited_at, created_at, updated_at) values
  -- a retained orphan: invited, never accepted, being RE-invited (p_created_here = false)
  ('00000000-0000-0000-0000-000000000000', '9e100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p12-orphan-reinvited@example.test', null,  now(), now(), now()),
  -- an established account: confirmed, never invited, no profile yet
  ('00000000-0000-0000-0000-000000000000', '9e100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p12-established@example.test',       now(), null,  now(), now()),
  -- accepted its invitation but was never onboarded here (no profile)
  ('00000000-0000-0000-0000-000000000000', '9e100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'p12-accepted-unonboarded@example.test', now(), now(), now(), now()),
  -- a brand-new invitation, created by this very attempt
  ('00000000-0000-0000-0000-000000000000', '9e100000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'p12-fresh@example.test',            null,  now(), now(), now());

create function pg_temp.provision_c(p_request uuid, p_email text, p_user uuid, p_created_here boolean)
returns text language plpgsql as $$
begin
  perform api.begin_provisioning(p_request, '9f000000-0000-4000-8000-00000000000c', p_email, 'MEMBER', '9d000000-0000-4000-8000-000000000002');
  return api.complete_provisioning(p_request, p_user, 'Onboarding Case', p_created_here) ->> 'status';
end $$;

set local role service_role;
select is(pg_temp.provision_c('9e100000-0000-4000-8000-0000000000a1', 'p12-orphan-reinvited@example.test', '9e100000-0000-4000-8000-000000000001', false),
  'SUCCEEDED', 'a retained orphan is re-invited and linked by a request that did NOT create it');
select is(pg_temp.provision_c('9e100000-0000-4000-8000-0000000000a2', 'p12-established@example.test', '9e100000-0000-4000-8000-000000000002', false),
  'SUCCEEDED', 'an established account is linked');
select is(pg_temp.provision_c('9e100000-0000-4000-8000-0000000000a3', 'p12-accepted-unonboarded@example.test', '9e100000-0000-4000-8000-000000000003', false),
  'SUCCEEDED', 'an invitation-born account that accepted but was never onboarded is linked');
select is(pg_temp.provision_c('9e100000-0000-4000-8000-0000000000a4', 'p12-fresh@example.test', '9e100000-0000-4000-8000-000000000004', true),
  'SUCCEEDED', 'a brand-new invited account is linked');
reset role;

select is(
  (select string_agg(u.email || '=' || p.must_change_password::text, ',' order by u.email)
     from app_data.profiles p join auth.users u on u.id = p.user_id
    where u.id::text like '9e100000-%'),
  'p12-accepted-unonboarded@example.test=true,p12-established@example.test=false,p12-fresh@example.test=true,p12-orphan-reinvited@example.test=true',
  'password setup follows the Auth record: required for every invitation-born or unaccepted account, not for an established one, and not tied to p_created_here'
);
select is(
  (select created_here::text from app_data.provisioning_attempts where request_id = '9e100000-0000-4000-8000-0000000000a1'),
  'false', 'the lifecycle fact stays separate: the re-invitation attempt records that it did not create the identity');

-- An existing profile is never touched — not even its onboarding flag.
update app_data.profiles set must_change_password = false where user_id = '9e100000-0000-4000-8000-000000000004';
insert into app_data.organizations (id, name) values ('9f000000-0000-4000-8000-00000000000d', 'Phase 12 Org D');
insert into app_data.memberships (organization_id, user_id, role, status) values
  ('9f000000-0000-4000-8000-00000000000d', '9d000000-0000-4000-8000-000000000002', 'OWNER', 'ACTIVE');
set local role service_role;
select is(
  (select api.begin_provisioning('9e100000-0000-4000-8000-0000000000a5', '9f000000-0000-4000-8000-00000000000d',
     'p12-fresh@example.test', 'MEMBER', '9d000000-0000-4000-8000-000000000002') ->> 'status'),
  'CLAIMED', 'a second organisation claims the onboarded account');
select is(
  (select api.complete_provisioning('9e100000-0000-4000-8000-0000000000a5', '9e100000-0000-4000-8000-000000000004', 'Other Name', true) ->> 'status'),
  'SUCCEEDED', '…and links it');
reset role;
select is(
  (select display_name || ':' || must_change_password::text from app_data.profiles where user_id = '9e100000-0000-4000-8000-000000000004'),
  'Onboarding Case:false', 'an existing profile keeps its name and its completed onboarding, whatever the caller claims');

select * from finish();
rollback;
