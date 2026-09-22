-- ===========================================================================
-- Phase 10 — Cloud Foundation, 1/7: the three schemas, and the posture
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7.
--
--   api          the ONLY business schema PostgREST is allowed to route.
--                security_invoker read views and typed RPCs. No base tables.
--   app_data     canonical business tables. No route. RLS enabled AND forced.
--   app_private   security helpers and trigger functions. No route.
--
-- Exposure is decided by `[api] schemas = ["api"]` in supabase/config.toml, not
-- by anything in this file. The distinction this whole architecture turns on:
-- a database privilege is not an HTTP route, and an HTTP route is not a
-- privilege. `authenticated` must hold privileges inside `app_data` for the
-- security_invoker views to work at all, and holding them grants no
-- reachability whatsoever.
--
-- Nothing here grants anything to `anon`. There is no unauthenticated
-- operation anywhere in this product.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The server version, asserted before a single view exists
--
-- `security_invoker` on views arrived in PostgreSQL 15. On 14 the option is not
-- recognised, and a view created without it executes with its OWNER's
-- privileges — which for a view created by `postgres` over an RLS-protected
-- table means every tenant's rows, returned successfully and silently. That is
-- Supabase lint 0010 and the shortest path from a correct RLS design to a total
-- leak, so the version is a precondition rather than an assumption. The
-- fallback (no views; cast inside RPCs) is a different design and must be
-- chosen deliberately, not discovered.
-- ---------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception
      'LandedCompare requires PostgreSQL 15 or later for security_invoker views; this server is %',
      current_setting('server_version');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The schemas
-- ---------------------------------------------------------------------------
create schema if not exists api;
create schema if not exists app_data;
create schema if not exists app_private;

comment on schema api is
  'The entire client surface. Exposed through the Data API. security_invoker views and typed RPCs only; no base tables.';
comment on schema app_data is
  'Canonical business tables. NOT exposed through the Data API. RLS enabled and forced on every table.';
comment on schema app_private is
  'Security helpers and trigger functions. NOT exposed through the Data API. EXECUTE here is a privilege, never a route.';

-- Fail closed first. `CREATE SCHEMA` grants PUBLIC nothing by default, but
-- stating it means a future `grant ... to public` has to overwrite an explicit
-- revoke rather than fill a silence.
revoke all on schema api         from public;
revoke all on schema app_data    from public;
revoke all on schema app_private from public;

-- ---------------------------------------------------------------------------
-- Schema USAGE, per role, explicitly
--
-- `authenticated` needs USAGE on all three:
--   api          — to reach the views and RPCs that are the client surface;
--   app_data     — because a security_invoker view checks permissions against
--                  the CALLER, so without it the view returns a permission
--                  error rather than data;
--   app_private  — because PostgreSQL evaluates policy expressions with the
--                  rights of the user running the query, so a policy calling
--                  app_private.current_org_ids() requires the caller to hold
--                  USAGE here and EXECUTE on the function. Without these the
--                  architecture does not fail open, it fails shut: every
--                  authenticated query returns `permission denied for function`.
--
-- `service_role` needs USAGE on `api` only, and EXECUTE on exactly the three
-- provisioning RPCs. It is deliberately given no privilege on any table in
-- `app_data`: it holds BYPASSRLS, so table grants would be the one credential
-- in the system able to write business rows directly, and the Edge Function has
-- no need for that.
--
-- `anon` receives nothing, here or anywhere else.
-- ---------------------------------------------------------------------------
grant usage on schema api         to authenticated;
grant usage on schema app_data    to authenticated;
grant usage on schema app_private to authenticated;

grant usage on schema api         to service_role;

-- ---------------------------------------------------------------------------
-- No default privileges, on purpose
--
-- Supabase's own custom-schema guide demonstrates
--   grant all on all tables in schema … to anon, authenticated, service_role
--   alter default privileges in schema … grant all on tables to …
-- That pattern is written for a schema you intend to publish. Running it here
-- would hand `anon` every table and pre-authorise every table a future phase
-- adds — the exact opposite of this posture. Grants in this system are always
-- per object, per role, in the migration that creates the object, so a table
-- created without that block is unreachable from `api` on the day it exists.
--
-- `[api] auto_expose_new_tables = false` in config.toml switches off the
-- equivalent Supabase event trigger for `public`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The managed-table registry
--
-- The highest-likelihood security failure in this design is an object added by
-- a future phase without the posture applied to it: a table with RLS forgotten,
-- a view without security_invoker, a function left callable by PUBLIC. Lint and
-- review catch some of that. What catches it a year from now is a test that
-- fails the day the object appears.
--
-- Every table in `app_data` must declare which policy class it belongs to, in
-- the same migration that creates it. The pgTAP suite asserts the registry and
-- the catalogue agree in BOTH directions — an unregistered table fails, and a
-- registration pointing at nothing fails — and then asserts the class's rules
-- against the catalogue. A developer who adds a table and skips this does not
-- get a passing build with a quiet hole; they get a failing test naming the
-- table.
--
-- The classes, and what each one promises:
--
--   TENANT_READONLY       organisation-scoped; the client may read it under an
--                         organisation-membership policy and may not write it
--                         by any path. Carries the full audit/version columns.
--   TENANT_APPEND_ONLY    organisation-scoped; readable by OWNER/ADMIN; rows
--                         are never updated or deleted, enforced by a trigger
--                         as well as by the absence of grants and policies.
--                         Has no `version` and no `updated_at`, because there
--                         is no update.
--   TENANT_SERVER_WRITTEN organisation-scoped; readable by OWNER/ADMIN; written
--                         only by SECURITY DEFINER functions, never by a client.
--   IDENTITY_SELF         not organisation-scoped; a row belongs to one user,
--                         who may read and update their own through an `api`
--                         RPC.
--   SERVER_ONLY           no client access of any kind: RLS on and forced, zero
--                         policies, zero grants. Reachable only from a
--                         SECURITY DEFINER function.
--
-- A class is a promise about a table, and the suite is what makes it one.
-- ---------------------------------------------------------------------------
create table app_private.managed_table (
  table_schema text not null,
  table_name   text not null,
  policy_class text not null,
  note         text not null,
  primary key (table_schema, table_name),
  constraint managed_table_schema_is_app_data
    check (table_schema = 'app_data'),
  constraint managed_table_policy_class_known
    check (policy_class in (
      'TENANT_READONLY',
      'TENANT_APPEND_ONLY',
      'TENANT_SERVER_WRITTEN',
      'IDENTITY_SELF',
      'SERVER_ONLY'
    ))
);

comment on table app_private.managed_table is
  'Declares the policy class of every table in app_data. The pgTAP suite asserts registry and catalogue agree in both directions, so a table added without a posture fails the build.';

-- The registry is metadata about security, so it is itself server-only: RLS on
-- and forced, no policy, no grant. Nothing outside a superuser connection or a
-- SECURITY DEFINER function can read it, and nothing needs to.
alter table app_private.managed_table enable row level security;
alter table app_private.managed_table force  row level security;
revoke all on table app_private.managed_table from public, anon, authenticated, service_role;
