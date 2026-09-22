-- ===========================================================================
-- Phase 10 — Cloud Foundation, 5/7: the api schema — the entire client surface
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7, §8, §10.
--
--   READ    a security_invoker view. A projection and a cast, never a way to
--           read something.
--   WRITE   a small, typed function with `p_expected_version` in its signature.
--
-- `api` holds no base table. `\dv api.*` and `\df api.*` list the entire client
-- surface of this product, which is a property worth having at an audit and the
-- reason adding an object here is a visible act with a review attached.
--
-- ---------------------------------------------------------------------------
-- security_invoker is not optional, and this is why
--
-- A PostgreSQL view executes with the privileges of ITS OWNER, not its caller.
-- These views are created by `postgres`, which bypasses RLS — so without
-- `security_invoker = on` every one of them would return EVERY TENANT'S ROWS,
-- successfully and silently, through a projection written to make decimals
-- safe. That is Supabase lint 0010, and it is the shortest path from a correct
-- RLS design to a total leak. Migration 1 asserted PostgreSQL 15 or later
-- before reaching this file, because on 14 the option does not exist and the
-- fallback is a different design.
--
-- ---------------------------------------------------------------------------
-- Timestamps are cast here, in one place, and so are decimals
--
-- PostgreSQL returns `timestamptz` as `2026-09-21T15:04:05.123456+00:00`, which
-- the application's existing `expectInstant` validator rejects — it expects
-- milliseconds and a literal `Z`. The normalisation is `to_char(...)` in the
-- view rather than a fix-up in the client gateway, for the same reason decimals
-- will be cast here in Phase 11: one place, no second route, nothing to
-- remember.
--
-- The `to_char` is written out on every column rather than hidden behind a
-- helper function. A helper would have to be granted EXECUTE to `authenticated`
-- — because a security_invoker view evaluates as the caller — and that would
-- add a third class to a privilege taxonomy whose whole value is that it has
-- exactly two.
--
-- No view below exposes a `numeric` column, because Phase 10 has none. The
-- pgTAP suite asserts that as a forward guard: the day Phase 11 adds a decimal
-- column to an `api` view without `::text`, the build fails rather than the
-- value quietly becoming a float64 in the browser.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- api.organizations
--
-- `write_locked_at` is projected as a boolean plus a reason rather than as a
-- raw lock record, because what a screen has to say is "this company is
-- read-only for maintenance" (§17 ORGANIZATION_LOCKED) — and the OWNER panel
-- that names the holder is Phase 21, built with the restore UI it belongs to.
-- ---------------------------------------------------------------------------
create view api.organizations with (security_invoker = on) as
select
  o.id,
  o.name,
  (o.write_locked_at is not null)                as write_locked,
  o.write_lock_reason,
  to_char(o.write_locked_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as write_locked_at,
  o.version,
  to_char(o.created_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as created_at,
  to_char(o.updated_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as updated_at
from app_data.organizations o;

-- ---------------------------------------------------------------------------
-- api.memberships — the caller's own memberships
--
-- This is what the boot sequence reads to resolve "which company am I in, and
-- as what" before it lets a single business screen render (§13).
-- ---------------------------------------------------------------------------
create view api.memberships with (security_invoker = on) as
select
  m.organization_id,
  m.user_id,
  m.role,
  m.status,
  m.version,
  to_char(m.created_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as created_at,
  to_char(m.updated_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as updated_at
from app_data.memberships m;

-- ---------------------------------------------------------------------------
-- api.profiles
--
-- No e-mail column, and there never will be one. `auth.users` holds the address
-- and is not exposed to the Data API; projecting it here would publish every
-- user's e-mail to every colleague, which is the exact thing §5 says profiles
-- exist to avoid.
-- ---------------------------------------------------------------------------
create view api.profiles with (security_invoker = on) as
select
  p.user_id,
  p.display_name,
  p.must_change_password,
  p.version,
  to_char(p.created_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as created_at,
  to_char(p.updated_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as updated_at
from app_data.profiles p;

-- ---------------------------------------------------------------------------
-- api.provisioning_attempts — so a stuck IN_FLIGHT attempt is visible
-- ---------------------------------------------------------------------------
create view api.provisioning_attempts with (security_invoker = on) as
select
  a.request_id,
  a.organization_id,
  a.email,
  a.requested_role,
  a.status,
  a.subject_user_id,
  a.actor_user_id,
  a.failure_reason,
  to_char(a.created_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as created_at,
  to_char(a.updated_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as updated_at
from app_data.provisioning_attempts a;

-- ---------------------------------------------------------------------------
-- api.admin_events
-- ---------------------------------------------------------------------------
create view api.admin_events with (security_invoker = on) as
select
  e.id,
  e.organization_id,
  e.event_type,
  e.actor_user_id,
  e.subject_user_id,
  e.details,
  to_char(e.occurred_at at time zone 'utc',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')       as occurred_at
from app_data.admin_events e;

-- ---------------------------------------------------------------------------
-- Grants, on the view and on the table underneath
--
-- `security_invoker` makes the caller's policies apply, which also means the
-- caller needs privileges on the UNDERLYING table, not only on the view. Both
-- sides are granted explicitly; the table side is in migration 4.
--
-- The table grant looks alarming and is not: `app_data` has no route, so it is
-- a privilege that creates no reachability. Reads arrive only through these
-- views; writes only through the functions below.
-- ---------------------------------------------------------------------------
revoke all on api.organizations         from public, anon, authenticated;
revoke all on api.memberships           from public, anon, authenticated;
revoke all on api.profiles              from public, anon, authenticated;
revoke all on api.provisioning_attempts from public, anon, authenticated;
revoke all on api.admin_events          from public, anon, authenticated;

grant select on api.organizations         to authenticated;
grant select on api.memberships           to authenticated;
grant select on api.profiles              to authenticated;
grant select on api.provisioning_attempts to authenticated;
grant select on api.admin_events          to authenticated;

-- ===========================================================================
-- Mutation RPCs
--
-- SECURITY INVOKER, which is the PostgreSQL default and the correct choice:
-- these functions need no privilege the caller lacks. What is being taken out
-- of the client's hands is the SHAPE OF THE STATEMENT, not the authorisation.
-- RLS evaluates inside them exactly as it would outside.
--
-- Both return `setof api.profiles` — the VIEW, never the table. A function
-- returning `app_data.profiles` would hand PostgREST a row straight from the
-- canonical table, which in Phase 11 means a `numeric` serialised as a JSON
-- number: the one door that would still be open after the schema split. Every
-- RPC that returns business data returns the api projection, so there is a
-- single place where a value is serialised and no way to route around it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- api.update_own_profile
--
-- `p_expected_version` is a required argument with no default and no overload
-- without it. Omitting it is a type error at the API boundary rather than a
-- silently weaker write — which is the entire reason this is a function and not
-- a PATCH against a table: a statement a client composes is a statement a
-- client can compose differently, and `and version = $2` is exactly the clause
-- a modified client would drop.
--
-- Zero rows is an error, not a success. The `STALE_WRITE` detail is what the
-- gateway maps to the code `src/i18n/persistenceText.ts` already translates, so
-- the sentence the user reads is the one they read today.
-- ---------------------------------------------------------------------------
create function api.update_own_profile(
  p_display_name     text,
  p_expected_version integer
)
returns setof api.profiles
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if btrim(coalesce(p_display_name, '')) = '' then
    raise exception 'display name is required'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  update app_data.profiles p
     set display_name = btrim(p_display_name)
   where p.user_id = (select auth.uid())
     and p.version = p_expected_version
  returning p.user_id into v_user_id;

  if not found then
    raise exception 'stale write or missing profile'
      using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;

  return query select * from api.profiles where user_id = v_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- api.acknowledge_password_change
--
-- Clears the forced-change flag after the client has called
-- `supabase.auth.updateUser({ password })` successfully.
--
-- HONEST SCOPE, and it is recorded rather than implied: this is the user
-- asserting about their own account. Nothing in PostgreSQL can observe that the
-- Auth service accepted a new password, so a user who calls this without
-- changing anything keeps a password their administrator knows — which harms
-- exactly one person, themselves. Making it a real guarantee needs an Auth hook
-- the Free plan pilot does not have, and pretending otherwise would be worse
-- than saying so.
-- ---------------------------------------------------------------------------
create function api.acknowledge_password_change(
  p_expected_version integer
)
returns setof api.profiles
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  update app_data.profiles p
     set must_change_password = false
   where p.user_id = (select auth.uid())
     and p.version = p_expected_version
  returning p.user_id into v_user_id;

  if not found then
    raise exception 'stale write or missing profile'
      using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;

  return query select * from api.profiles where user_id = v_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- EXECUTE is revoked before it is granted
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC automatically, and both
-- `anon` and `authenticated` are members of PUBLIC. Granting without revoking
-- first leaves that default underneath: `anon` keeps the privilege and the
-- explicit grant reads like a control while enforcing nothing.
-- ---------------------------------------------------------------------------
revoke execute on function api.update_own_profile(text, integer)   from public, anon;
revoke execute on function api.acknowledge_password_change(integer) from public, anon;

grant execute on function api.update_own_profile(text, integer)    to authenticated;
grant execute on function api.acknowledge_password_change(integer) to authenticated;
