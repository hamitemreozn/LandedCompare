-- ===========================================================================
-- Phase 10 — Cloud Foundation, 3/7: app_private helpers and shared triggers
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7, §16.
--
-- Two classes of function live here and they look identical in a source tree,
-- which is why the difference is stated at the top rather than discovered:
--
--   RLS / membership helpers   called from inside a policy expression.
--                              PostgreSQL adds policy expressions to the user's
--                              query and runs them WITH THE RIGHTS OF THAT USER,
--                              so the CALLER must hold EXECUTE or every query
--                              against every protected table fails with
--                              `permission denied for function`. These are
--                              granted to `authenticated`, and they are still
--                              not callable, because `app_private` has no route.
--
--   trigger helpers            invoked by the system when DML fires. PostgreSQL
--                              checks EXECUTE on a trigger function at CREATE
--                              TRIGGER, against the creator — not at DML, against
--                              the writer. These are granted to NOBODY.
--
-- Every function below pins `search_path = ''` and schema-qualifies every name.
-- Without a pinned search path a caller can create an object that shadows an
-- unqualified name and have it executed with the function owner's privileges,
-- which is the standard privilege-escalation route through SECURITY DEFINER.
-- It is closed by one line, so it is on every function here regardless of
-- security mode.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Why no policy in this system is recursive
--
-- A policy on `products` that reads `memberships` makes `memberships`' own
-- policy evaluate, which reads `memberships` again: PostgreSQL raises 42P17,
-- `infinite recursion detected in policy`, and every query in the application
-- fails. The usual escape is a SECURITY DEFINER helper, which runs as its owner
-- and therefore breaks the cycle — but only because that owner holds BYPASSRLS,
-- which is a property of a role rather than of this design.
--
-- This schema does not depend on that. `memberships` — the one table every
-- helper below reads — has a policy that calls NO helper at all: a user sees
-- their own membership rows and nothing else. So the cycle does not exist to be
-- broken, and the recursion cannot occur whatever the owner's attributes are.
--
-- The helpers are still SECURITY DEFINER, because `shares_active_organization`
-- genuinely must read a DIFFERENT user's membership rows to answer "may I see
-- this person's display name". That is the single assumption about BYPASSRLS in
-- the system, it is asserted in the pgTAP suite, and its failure mode is a
-- narrowing (fewer profiles visible) rather than a leak.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- current_org_ids — the organisations the caller is an ACTIVE member of
--
-- Returns an array and is `stable`, so a policy written as
--   organization_id = any ((select app_private.current_org_ids())::uuid[])
-- is evaluated by PostgreSQL as an InitPlan: once for the whole statement,
-- not once per row. A per-row membership lookup is the classic RLS performance
-- cliff, and it is avoided by the shape of the call rather than by a cache.
--
-- The trailing `::uuid[]` is load-bearing and is a correction to the snippet in
-- the canonical document. `x = any ((select f()))` is parsed as the SUBQUERY
-- form of ANY — PostgreSQL expects the parenthesised select to yield a SET of
-- uuid and instead receives one value of type uuid[], so the expression fails
-- to compile with `operator does not exist: uuid = uuid[]`. The cast makes the
-- operand an ordinary array expression, which selects the array form of ANY
-- while keeping the sub-select that produces the InitPlan. Writing
-- `any (app_private.current_org_ids())` would also compile and would silently
-- give up the once-per-statement evaluation.
--
-- It knows nothing about maintenance or restore, deliberately. An earlier
-- design filtered out write-locked organisations here, which put a write
-- concern on the read path: it blinded readers for no safety benefit (a SELECT
-- cannot corrupt a restore) and then needed an OWNER exemption that left that
-- OWNER able to mutate company data from a second tab. The gate belongs on the
-- write path and nowhere else.
-- ---------------------------------------------------------------------------
create function app_private.current_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
  from app_data.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'ACTIVE';
$$;

comment on function app_private.current_org_ids() is
  'RLS helper. Requires EXECUTE by the CALLER because policy expressions run with the rights of the user running the query. Executable by authenticated; not callable, because app_private has no Data API route.';

-- ---------------------------------------------------------------------------
-- has_org_role — ACTIVE membership of one organisation, in one of these roles
--
-- The role is resolved from the database on every request and never from a JWT
-- claim. That is the control for "a removed member keeps a valid token":
-- setting `status = 'DISABLED'` takes effect on the very next statement even
-- though the access token is still unexpired and still verifies.
-- ---------------------------------------------------------------------------
create function app_private.has_org_role(p_organization_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app_data.memberships m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'ACTIVE'
      and m.role = any (p_roles)
  );
$$;

comment on function app_private.has_org_role(uuid, text[]) is
  'RLS and RPC helper. Live database state, never a JWT claim — which is what makes disabling a membership take effect on the next request.';

-- ---------------------------------------------------------------------------
-- shares_active_organization — may the caller see this person at all
--
-- §5: a profile is visible only to users who share an ACTIVE membership with
-- it. This is the one helper that must read another user's membership rows,
-- and therefore the one place the SECURITY DEFINER owner's BYPASSRLS matters.
-- ---------------------------------------------------------------------------
create function app_private.shares_active_organization(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app_data.memberships them
    where them.user_id = p_user_id
      and them.status = 'ACTIVE'
      and them.organization_id = any ((select app_private.current_org_ids())::uuid[])
  );
$$;

comment on function app_private.shares_active_organization(uuid) is
  'RLS helper for app_data.profiles. Answers "do we share a company", which is the only reason one user may read another''s display name.';

-- ---------------------------------------------------------------------------
-- Fail closed, then grant exactly what policy evaluation needs
--
-- The order is the whole technique. PostgreSQL grants EXECUTE on a new function
-- to PUBLIC automatically, and `anon` and `authenticated` are members of
-- PUBLIC — so a function is callable by everyone the moment it exists unless
-- something says otherwise. Granting without revoking first leaves that default
-- in place underneath: `anon` keeps the privilege, and the explicit grant reads
-- like a control while enforcing nothing.
-- ---------------------------------------------------------------------------
revoke execute on function app_private.current_org_ids()                from public, anon;
revoke execute on function app_private.has_org_role(uuid, text[])       from public, anon;
revoke execute on function app_private.shares_active_organization(uuid) from public, anon;

grant execute on function app_private.current_org_ids()                to authenticated;
grant execute on function app_private.has_org_role(uuid, text[])       to authenticated;
grant execute on function app_private.shares_active_organization(uuid) to authenticated;

-- ===========================================================================
-- Trigger helpers. Granted to nobody, now or ever.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- stamp_row — attribution and time are server facts
--
-- This trigger OVERWRITES rather than validates. A client that sends
-- `created_by: '<someone else>'` does not get an error, it gets its value
-- silently replaced by the truth — which is the correct outcome, because the
-- value was never an input in the first place. The same applies to created_at,
-- updated_at and version.
--
-- The actor is normally `auth.uid()`. The one exception is a SECURITY DEFINER
-- RPC called by the Edge Function with the secret key, where there is no user
-- JWT and `auth.uid()` is null: those functions set `app.actor_user_id`
-- transaction-locally to the actor they have already verified. A client cannot
-- set that GUC — there is no route through PostgREST that executes
-- `set_config` — which is the same technique §16 uses for the restore gate.
-- ---------------------------------------------------------------------------
create function app_private.stamp_row()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(
    nullif(current_setting('app.actor_user_id', true), '')::uuid,
    (select auth.uid())
  );
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := v_actor;
    new.updated_at := new.created_at;
    new.updated_by := v_actor;
    new.version    := 1;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := v_actor;
    new.version    := old.version + 1;
  end if;
  return new;
end $$;

-- `counters` carries created_at/updated_at/created_by/updated_by but no
-- `version`: there is no optimistic concurrency on a sequence allocated from a
-- row locked FOR UPDATE, and a token nothing reads is a token that will be
-- wrong without anyone noticing.
create function app_private.stamp_row_unversioned()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(
    nullif(current_setting('app.actor_user_id', true), '')::uuid,
    (select auth.uid())
  );
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := v_actor;
    new.updated_at := new.created_at;
    new.updated_by := v_actor;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := v_actor;
  end if;
  return new;
end $$;

-- `provisioning_attempts` has no actor columns of its own — it names its actor
-- explicitly, because the actor is an argument to the workflow rather than
-- ambient context. All it needs is an honest `updated_at`.
create function app_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- assert_tenant_immutable — a row may not change organisation
--
-- The INSERT/UPDATE `with check` policies already prevent moving a row into an
-- organisation the caller does not belong to. This prevents moving it at all,
-- which is a different guarantee and starts mattering the moment a user is an
-- ACTIVE member of two organisations — at which point the policy would happily
-- allow the move and the row would simply appear in the other company's data.
-- ---------------------------------------------------------------------------
create function app_private.assert_tenant_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable'
      using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- assert_append_only — history is not editable, and not by anyone
--
-- The absence of an UPDATE/DELETE grant and of an UPDATE/DELETE policy already
-- closes every client path. This closes the other one: a SECURITY DEFINER
-- function written in a future phase, running as an owner who bypasses both,
-- still cannot edit a posted event. The rule becomes structural rather than
-- something a code review has to catch.
-- ---------------------------------------------------------------------------
create function app_private.assert_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------
-- assert_write_allowed — the restore write gate (§16)
--
-- The exemption is TWO conditions, both required: the caller must be the lock
-- holder AND be executing inside the restore function's own transaction. An
-- OWNER's second browser tab satisfies the first and cannot satisfy the second,
-- because `app.restore_in_progress` is set with is_local = true by the restore
-- RPC alone and exists for the duration of that one transaction and nowhere
-- else. Nothing a client can send through PostgREST sets it.
--
-- A role exemption — "OWNERs may write during a restore" — was the earlier,
-- broken design: the one user guaranteed to be active during a restore is an
-- OWNER, and an exemption granted to a role is granted to every session that
-- role has.
--
-- The `FOR SHARE` is the drain barrier and is the reason this is not merely a
-- flag. Every writer holds a shared lock on the organisation row until it
-- commits, so the restore's `FOR UPDATE` cannot be granted until they have all
-- released: acquiring it PROVES no writer is in flight. Without it, a statement
-- that had already passed the check when the gate committed could still commit
-- across the restore boundary. Lock ordering is consistent — organisation row
-- first, then business rows — so this introduces no deadlock cycle.
--
-- SECURITY INVOKER: it is called from `write_gate` below, which runs as the
-- owner, so it needs no privilege of its own.
-- ---------------------------------------------------------------------------
create function app_private.assert_write_allowed(p_organization_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_locked_by uuid;
begin
  perform 1 from app_data.organizations o where o.id = p_organization_id for share;

  select o.write_locked_by into v_locked_by
  from app_data.organizations o
  where o.id = p_organization_id;

  if v_locked_by is null then
    return;
  end if;

  if v_locked_by = (select auth.uid())
     and current_setting('app.restore_in_progress', true) = p_organization_id::text then
    return;
  end if;

  raise exception 'organization is locked for maintenance'
    using errcode = '55006';
end $$;

-- The trigger side of the gate. SECURITY DEFINER for one narrow reason: it must
-- be able to take the shared lock and read `write_locked_by` on the organisation
-- row, and to call `assert_write_allowed`, without the writer holding any
-- privilege on either — which keeps both revoked from every role.
create function app_private.write_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_write_allowed(new.organization_id);
  return new;
end $$;

comment on function app_private.write_gate() is
  'BEFORE INSERT OR UPDATE gate for the restore lock (§16). Attached to every organisation-scoped business table; Phase 11 onward attaches it with the table.';

-- ---------------------------------------------------------------------------
-- Trigger helpers are granted to NOBODY
--
-- PostgreSQL checks EXECUTE on a trigger function when the trigger is created,
-- against the creator, not when DML fires it against the writer. So these need
-- no grant to work, and giving them one would create a privilege with no
-- purpose — which is the kind of thing that is only ever noticed when it is
-- being exploited.
-- ---------------------------------------------------------------------------
revoke execute on function app_private.stamp_row()                  from public, anon, authenticated, service_role;
revoke execute on function app_private.stamp_row_unversioned()      from public, anon, authenticated, service_role;
revoke execute on function app_private.touch_updated_at()           from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_tenant_immutable()    from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_append_only()         from public, anon, authenticated, service_role;
revoke execute on function app_private.assert_write_allowed(uuid)   from public, anon, authenticated, service_role;
revoke execute on function app_private.write_gate()                 from public, anon, authenticated, service_role;

-- ===========================================================================
-- Attach the triggers
-- ===========================================================================

create trigger organizations_stamp
  before insert or update on app_data.organizations
  for each row execute function app_private.stamp_row();

create trigger profiles_stamp
  before insert or update on app_data.profiles
  for each row execute function app_private.stamp_row();

create trigger memberships_stamp
  before insert or update on app_data.memberships
  for each row execute function app_private.stamp_row();

create trigger memberships_tenant_immutable
  before update on app_data.memberships
  for each row execute function app_private.assert_tenant_immutable();

create trigger provisioning_attempts_touch
  before update on app_data.provisioning_attempts
  for each row execute function app_private.touch_updated_at();

create trigger provisioning_attempts_tenant_immutable
  before update on app_data.provisioning_attempts
  for each row execute function app_private.assert_tenant_immutable();

create trigger admin_events_append_only
  before update or delete on app_data.admin_events
  for each row execute function app_private.assert_append_only();

create trigger counters_stamp
  before insert or update on app_data.counters
  for each row execute function app_private.stamp_row_unversioned();

create trigger counters_tenant_immutable
  before update on app_data.counters
  for each row execute function app_private.assert_tenant_immutable();

-- The write gate, on the one organisation-scoped table Phase 10 has that a
-- restore would replace. `counters` is part of an organisation's portable
-- export, so replacing an organisation's data replaces its sequences, and a
-- code allocated across the restore boundary would be a duplicate the unique
-- index catches far too late.
--
-- `organizations`, `memberships` and `profiles` deliberately do NOT carry the
-- gate: they are identity and tenancy, not business data, a restore does not
-- touch them (§16-A), and gating them would make a stuck lock un-fixable by the
-- very administration path that has to clear it.
create trigger counters_write_gate
  before insert or update on app_data.counters
  for each row execute function app_private.write_gate();
