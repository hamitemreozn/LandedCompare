-- ===========================================================================
-- Phase 10 security suite, 1/6 — the catalogue assertions (P1–P17)
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7, "Proving it,
-- rather than believing it".
--
-- These do not test behaviour. They test the POSTURE: that every object in the
-- three schemas has the protections this architecture says every object has.
-- The failure they exist to catch is not a bug in this phase — it is an object
-- added by a phase eighteen months from now with one line missing, which no
-- amount of care at the time of writing prevents and which a test written once
-- catches on the day it happens.
--
-- Every assertion below is expressed over the CATALOGUE rather than over a list
-- of names, so a table, view or function added later is inside its scope
-- automatically. An assertion phrased as "app_data.products has RLS" would pass
-- forever while `app_data.quotes` did not.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(29);

-- ---------------------------------------------------------------------------
-- P0 — the registry and the catalogue agree, in both directions
--
-- This is the assertion that makes every class-conditional one below
-- meaningful. Without it a developer could add a table, skip the registry row,
-- and every "for each table of class X" test would simply not be about it.
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app_data'
    and c.relkind = 'r'
    and not exists (
      select 1 from app_private.managed_table m
      where m.table_schema = 'app_data' and m.table_name = c.relname
    )
$$, 'P0a: every table in app_data declares a policy class in app_private.managed_table');

select is_empty($$
  select m.table_name
  from app_private.managed_table m
  where not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = m.table_schema and c.relname = m.table_name and c.relkind = 'r'
  )
$$, 'P0b: every registry row names a table that exists');

-- ---------------------------------------------------------------------------
-- P1 — RLS enabled AND forced
--
-- `force` is the half that is forgotten. Without it the table owner is exempt,
-- which means a SECURITY DEFINER function running as that owner reads across
-- every tenant through any table it forgot to filter by hand.
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app_data' and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity)
$$, 'P1: every table in app_data has RLS enabled and forced');

-- ---------------------------------------------------------------------------
-- P2 — a policy for every command that is granted
--
-- The inverse of the usual worry. RLS enabled with no policy denies everything,
-- which is a correctness failure rather than a security one — unless the table
-- is deliberately unreachable, which is what the SERVER_ONLY class declares.
-- Checking the grant against the policies is what tells the two apart.
-- ---------------------------------------------------------------------------
select is_empty($$
  with granted as (
    select c.relname::text as table_name,
           upper(a.privilege_type) as privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'app_data' and c.relkind = 'r'
      and a.grantee = 'authenticated'::regrole
      and upper(a.privilege_type) in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  )
  select g.table_name || ':' || g.privilege
  from granted g
  where not exists (
    select 1 from pg_policies p
    where p.schemaname = 'app_data' and p.tablename = g.table_name
      and (p.cmd = 'ALL' or upper(p.cmd) = g.privilege)
  )
$$, 'P2: every command granted to authenticated on an app_data table has a policy');

select is_empty($$
  select m.table_name
  from app_private.managed_table m
  where m.policy_class = 'SERVER_ONLY'
    and exists (select 1 from pg_policies p
                where p.schemaname = m.table_schema and p.tablename = m.table_name)
$$, 'P2b: a SERVER_ONLY table has no policy at all — denial is its configuration');

-- ---------------------------------------------------------------------------
-- P3 — every UPDATE policy carries `with check`, not only `using`
--
-- `using` decides which rows may be modified. Without `with check` a user can
-- take a row they legitimately own and rewrite its tenant column to another
-- company's — producing a row they can no longer see, sitting in someone else's
-- data. Both clauses, on every table, always.
-- ---------------------------------------------------------------------------
select is_empty($$
  select p.schemaname || '.' || p.tablename || '.' || p.policyname
  from pg_policies p
  where p.schemaname = 'app_data'
    and p.cmd in ('UPDATE', 'ALL')
    and p.with_check is null
$$, 'P3: every UPDATE policy in app_data has a with_check expression');

-- ---------------------------------------------------------------------------
-- P4 — deletion is not a client capability, expressed as an absence
--
-- Data Model §10 and I14 already say a referenced record is deactivated, never
-- destroyed. Expressing that as the absence of a policy AND of a grant makes it
-- structural: no client request deletes a business row by any path.
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname = 'app_data'
    and a.grantee in ('authenticated'::regrole, 'anon'::regrole)
    and upper(a.privilege_type) = 'DELETE'
$$, 'P4a: no app_data table grants DELETE to a Data API role');

select is_empty($$
  select p.tablename || '.' || p.policyname
  from pg_policies p
  where p.schemaname = 'app_data' and p.cmd in ('DELETE', 'ALL')
$$, 'P4b: no app_data table has a DELETE policy');

-- ---------------------------------------------------------------------------
-- P5 — `anon` holds nothing, anywhere
--
-- There is no unauthenticated operation in this product. The assertion covers
-- schema USAGE as well as object privileges, because USAGE on `api` alone would
-- turn every "permission denied for schema" into a per-object question.
-- ---------------------------------------------------------------------------
select is_empty($$
  select n.nspname::text
  from pg_namespace n
  where n.nspname in ('api', 'app_data', 'app_private')
    and has_schema_privilege('anon', n.oid, 'USAGE')
$$, 'P5a: anon holds no USAGE on api, app_data or app_private');

select is_empty($$
  select n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname in ('api', 'app_data', 'app_private')
    and a.grantee = 'anon'::regrole
$$, 'P5b: anon holds no privilege on any table, view or sequence in the three schemas');

select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(p.proacl) a
  where n.nspname in ('api', 'app_data', 'app_private')
    and a.grantee = 'anon'::regrole
$$, 'P5c: anon holds EXECUTE on no function in the three schemas');

-- ---------------------------------------------------------------------------
-- P6 — every view in `api` is security_invoker
--
-- A PostgreSQL view executes with the privileges of its OWNER by default. These
-- views are owned by `postgres`, which bypasses RLS, so one missing option
-- turns a decimal-casting projection into a complete tenant leak — returned
-- successfully, silently, with no error anywhere. Supabase lint 0010.
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'api' and c.relkind = 'v'
    and coalesce(array_position(c.reloptions, 'security_invoker=on'), 0) = 0
$$, 'P6: every view in api is created with security_invoker = on');

-- ---------------------------------------------------------------------------
-- P7 — an api view never reaches a table that P1 does not protect
--
-- A view is a projection and a cast. If it can read an unprotected table it is
-- something else.
-- ---------------------------------------------------------------------------
select is_empty($$
  select distinct vn.nspname || '.' || v.relname || ' -> ' || tn.nspname || '.' || t.relname
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid
  join pg_class v on v.oid = r.ev_class
  join pg_namespace vn on vn.oid = v.relnamespace
  join pg_class t on t.oid = d.refobjid
  join pg_namespace tn on tn.oid = t.relnamespace
  where vn.nspname = 'api' and v.relkind = 'v'
    and d.classid = 'pg_rewrite'::regclass
    and d.refclassid = 'pg_class'::regclass
    and t.relkind = 'r'
    and t.oid <> v.oid
    and not (t.relrowsecurity and t.relforcerowsecurity)
$$, 'P7: every table an api view reads has RLS enabled and forced');

-- ---------------------------------------------------------------------------
-- P8 — EXECUTE is never left with its PUBLIC default
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC automatically, and both
-- `anon` and `authenticated` are members of PUBLIC. A null `proacl` means that
-- default is still in force, which is why it fails here as loudly as an
-- explicit grant to PUBLIC would.
-- ---------------------------------------------------------------------------
select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('api', 'app_private')
    and p.prokind = 'f'
    and (
      p.proacl is null
      or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    )
$$, 'P8: every function in api and app_private has EXECUTE revoked from PUBLIC');

-- ---------------------------------------------------------------------------
-- P9 — search_path is pinned on every function, not only the definers
--
-- The canonical rule requires it on SECURITY DEFINER functions, where an
-- unpinned path is the standard privilege-escalation route: a caller creates an
-- object that shadows an unqualified name and has it executed with the owner's
-- privileges. This asserts it on the INVOKER functions too, because the cost is
-- one line and the alternative is a reviewer having to check the security mode
-- before knowing whether a missing line matters.
-- ---------------------------------------------------------------------------
select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('api', 'app_private')
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
      where cfg like 'search_path=%'
    )
$$, 'P9: every function in api and app_private pins search_path');

-- ---------------------------------------------------------------------------
-- P10 — the two-sided helper assertion
--
-- It fails if an RLS helper is over-granted to `anon` (covered by P5c) AND it
-- fails if an RLS helper is NOT granted to `authenticated` — because the second
-- case is a real defect too. An ungranted RLS helper does not leak; it makes
-- every authenticated query on every protected table return
-- `permission denied for function`, which is a totally broken application.
-- Both directions, one test.
-- ---------------------------------------------------------------------------
select is_empty($$
  select fn from unnest(array[
    'app_private.current_org_ids()',
    'app_private.has_org_role(uuid,text[])',
    'app_private.shares_active_organization(uuid)'
  ]) as fn
  where not has_function_privilege('authenticated', fn, 'EXECUTE')
$$, 'P10a: every RLS helper is EXECUTEable by authenticated — policy evaluation requires it');

select is_empty($$
  select fn from unnest(array[
    'app_private.stamp_row()',
    'app_private.stamp_row_unversioned()',
    'app_private.touch_updated_at()',
    'app_private.assert_tenant_immutable()',
    'app_private.assert_append_only()',
    'app_private.assert_write_allowed(uuid)',
    'app_private.write_gate()',
    'app_private.assert_org_administrator(uuid,uuid)',
    'app_private.bootstrap_organization(text,uuid,text)'
  ]) as fn
  where has_function_privilege('authenticated', fn, 'EXECUTE')
     or has_function_privilege('service_role', fn, 'EXECUTE')
$$, 'P10b: no trigger, gate or operator helper is EXECUTEable by a Data API role');

-- ---------------------------------------------------------------------------
-- P11 — the shape rules of §11, per declared class
-- ---------------------------------------------------------------------------
select is_empty($$
  select m.table_name
  from app_private.managed_table m
  where m.policy_class in ('TENANT_READONLY', 'TENANT_EDITABLE', 'TENANT_APPEND_ONLY', 'TENANT_SERVER_WRITTEN', 'SERVER_ONLY')
    and m.table_name <> 'organizations'
    and not exists (
      select 1 from information_schema.columns c
      where c.table_schema = m.table_schema and c.table_name = m.table_name
        and c.column_name = 'organization_id' and c.is_nullable = 'NO'
    )
$$, 'P11a: every organisation-scoped table has organization_id NOT NULL');

select is_empty($$
  select m.table_name
  from app_private.managed_table m
  where m.policy_class in ('TENANT_READONLY', 'TENANT_EDITABLE', 'IDENTITY_SELF')
    and not exists (
      select 1 from information_schema.columns c
      where c.table_schema = m.table_schema and c.table_name = m.table_name
        and c.column_name = 'version'
    )
$$, 'P11b: every optimistically-concurrent table carries a version column');

select is_empty($$
  select m.table_name
  from app_private.managed_table m
  where m.policy_class in ('TENANT_READONLY', 'TENANT_EDITABLE', 'IDENTITY_SELF', 'SERVER_ONLY')
    and not exists (
      select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      where n.nspname = m.table_schema and c.relname = m.table_name
        and not t.tgisinternal
        and p.proname in ('stamp_row', 'stamp_row_unversioned')
    )
$$, 'P11c: every audited table has a stamping trigger — attribution is not optional');

select is_empty($$
  select m.table_name
  from app_private.managed_table m
  where m.policy_class = 'TENANT_APPEND_ONLY'
    and (
      exists (select 1 from information_schema.columns c
              where c.table_schema = m.table_schema and c.table_name = m.table_name
                and c.column_name in ('version', 'updated_at'))
      or not exists (
        select 1 from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_proc p on p.oid = t.tgfoid
        where n.nspname = m.table_schema and c.relname = m.table_name
          and not t.tgisinternal and p.proname = 'assert_append_only'
      )
    )
$$, 'P11d: an append-only table has no version or updated_at, and does have the guard trigger');

-- ---------------------------------------------------------------------------
-- P12 — INSERT exists only where the declared class permits append/create
--
-- Phase 11 introduces client-created catalogue masters and one tightly-policy-
-- guarded import audit event. INSERT is valid only for TENANT_EDITABLE or
-- TENANT_APPEND_ONLY tables; every actual grant still needs its policy (P2).
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.relname || ':' || upper(a.privilege_type)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname = 'app_data' and c.relkind = 'r'
    and a.grantee = 'authenticated'::regrole
    and upper(a.privilege_type) = 'INSERT'
    and not exists (
      select 1 from app_private.managed_table m
      where m.table_schema = n.nspname and m.table_name = c.relname
        and m.policy_class in ('TENANT_EDITABLE', 'TENANT_APPEND_ONLY')
    )
$$, 'P12: only TENANT_EDITABLE or TENANT_APPEND_ONLY tables grant INSERT to authenticated');

-- ---------------------------------------------------------------------------
-- P13 — `api` holds no base table
--
-- The exposed schema is a surface, not a store. A canonical table created in it
-- — or moved into it — would be directly addressable over HTTP, which is the
-- single move that undoes §7, §8, §9 and §10 simultaneously.
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'api' and c.relkind in ('r', 'p', 'f')
$$, 'P13: api contains no base tables — only views and functions');

-- ---------------------------------------------------------------------------
-- P14 — the private schemas stay private in intent as well as in configuration
--
-- `app_data` and `app_private` hold no view, because a view is API-surface
-- shaped: if one appeared there it would mean somebody intended it to be read
-- directly, and the next step in that direction is adding the schema to the
-- exposure list.
-- ---------------------------------------------------------------------------
select is_empty($$
  select n.nspname || '.' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('app_data', 'app_private') and c.relkind in ('v', 'm')
$$, 'P14: app_data and app_private contain no views');

-- ---------------------------------------------------------------------------
-- P15 — the exact-decimal forward guard
--
-- Phase 10 has no financial column, so there is no value to round-trip yet and
-- the hostile-precision fixture belongs to Phase 11 where the first `numeric`
-- appears. What CAN be established now is the rule that makes that fixture pass:
-- PostgREST serialises `numeric` as a JSON NUMBER, and `JSON.parse` turns a JSON
-- number into an IEEE-754 float64 — so `12345678901234567890.0047` comes back as
-- `12345678901234567000`, wrong in the integer part with all four decimals gone.
--
-- This assertion fails the day an `api` view or RPC exposes a column of an
-- inexact or number-serialised type without casting it to text. It is a guard
-- pointed at a phase that has not happened, which is the only moment a guard is
-- cheap.
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.table_name || '.' || c.column_name || ' (' || c.data_type || ')'
  from information_schema.columns c
  where c.table_schema = 'api'
    and c.data_type in ('numeric', 'real', 'double precision', 'money')
$$, 'P15a: no api view exposes numeric, float or money — decimals reach the client as text');

select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api'
    and (
      p.prorettype in ('numeric'::regtype, 'real'::regtype, 'float8'::regtype)
      or exists (
        select 1 from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) t
        where t in ('numeric'::regtype, 'real'::regtype, 'float8'::regtype)
      )
    )
$$, 'P15b: no api function takes or returns a numeric or float — the wire format is a canonical decimal string');

select is_empty($$
  select c.table_name || '.' || c.column_name
  from information_schema.columns c
  where c.table_schema = 'app_data'
    and c.data_type in ('real', 'double precision', 'money')
$$, 'P15c: no app_data column is float, double or money — exact source precision is the storage rule');

-- ---------------------------------------------------------------------------
-- P16 — `public` holds no LandedCompare object
--
-- `public` is an exposed schema by Supabase default, and this configuration
-- removes it from the list. Both halves matter: a business object placed there
-- would be one dashboard edit away from a live route.
-- ---------------------------------------------------------------------------
select is_empty($$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
    and c.relname not in ('pg_stat_statements', 'pg_stat_statements_info')
$$, 'P16: the public schema holds no LandedCompare table or view');

-- ---------------------------------------------------------------------------
-- P17 — the one assumption this design makes about a role attribute
--
-- `app_private.shares_active_organization` must read a DIFFERENT user's
-- membership rows to answer "may I see this person's display name", and it does
-- so as its owner. That works because the owner bypasses RLS. Every other
-- helper would still be correct without this, and the failure mode here is a
-- narrowing — fewer profiles visible — rather than a leak. It is asserted
-- because an assumption nobody checks is an assumption nobody knows they made.
-- ---------------------------------------------------------------------------
select ok(
  (select r.rolbypassrls or r.rolsuper
     from pg_proc p
     join pg_roles r on r.oid = p.proowner
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'shares_active_organization'),
  'P17: the SECURITY DEFINER helper owner bypasses RLS, which is what lets it read another user''s membership'
);

select * from finish();
rollback;
