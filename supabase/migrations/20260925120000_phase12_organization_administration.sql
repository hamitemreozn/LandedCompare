-- ===========================================================================
-- Phase 12 — Organisation administration, and the provisioned-user lifecycle
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4, §5, §6, §8, §31.
--
-- Forward-only. The twelve applied migrations are not edited; the one existing
-- function whose behaviour changes (`api.complete_provisioning`) is replaced
-- here with `create or replace`, which keeps its grants.
--
-- ---------------------------------------------------------------------------
-- What this adds
--
--   READ    api.list_organization_members     OWNER/ADMIN — the colleague list,
--                                              with e-mail, for the admin screen
--                                              and the backup members manifest
--   WRITE   api.set_member_role               OWNER/ADMIN, version-checked
--           api.set_member_status             OWNER/ADMIN, version-checked
--           api.clear_provisioning_attempt    OWNER — §4 case E, "cleared
--                                              explicitly, never by a timeout"
--   OPERATOR app_private.orphaned_auth_identities      read-only report
--           app_private.purge_orphaned_auth_identity   narrowly bounded delete
--
-- What this changes (security correction pass, before any deployment)
--
--   api.complete_provisioning   OWNER grant re-authorised after the lock
--                               (P12-H1); an existing global profile is never
--                               overwritten (P12-M1); the onboarding flag of a
--                               new profile is derived from the Auth record,
--                               not from whether this attempt created it
--   api.begin_password_reset,   DROPPED — no organisation may replace the
--   api.complete_password_reset password of an existing global identity
--                               (P12-B1)
--   api.profiles                a colleague's onboarding flag and profile
--                               timestamps are no longer projected (final
--                               correction: no account-existence oracle)
--
-- No table, column or policy is added. `memberships` keeps its helper-free
-- `user_id = auth.uid()` policy and still has no write grant; `admin_events`
-- keeps exactly one INSERT policy (pgTAP P12b).
--
-- ---------------------------------------------------------------------------
-- Security mode, and why it is split across two schemas
--
-- Listing a colleague's membership and changing one both need a privilege no
-- client holds: reading other users' `memberships` rows and writing a table
-- with no client write path. §8 permits SECURITY DEFINER exactly there, and
-- §28 said this screen would reach the table "through a function that
-- re-proves OWNER/ADMIN, not by widening the policy".
--
-- The privileged body therefore lives in `app_private` (no Data API route) as
-- SECURITY DEFINER, and its FIRST statements re-prove the caller's live
-- OWNER/ADMIN membership from `auth.uid()` — a value PostgREST derives from the
-- verified JWT and no request parameter can supply. The `api` function a
-- client calls is a SECURITY INVOKER wrapper with typed arguments and nothing
-- else. Stated honestly: the wrapper does not reduce who can REACH the
-- definer body — any authenticated caller can, through it — so the control is
-- the in-body authority check, which the pgTAP and HTTP suites exercise for
-- OWNER, ADMIN, MEMBER, disabled and cross-tenant callers. What the split buys
-- is that no SECURITY DEFINER function sits in an exposed schema, which keeps
-- the hosted security advisor's WARN gate meaningful rather than waived.
--
-- Every definer body filters by the organisation it was given: the owner
-- holds BYPASSRLS, so FORCE RLS is not its safety net (Audit A, A-L8).
--
-- ---------------------------------------------------------------------------
-- The role rules (unchanged from Phase 10, now enforced on two more paths)
--
--   OWNER  may change any other member's role or status, including another
--          OWNER's, and may grant OWNER.
--   ADMIN  may change MEMBER and ADMIN memberships; may not touch an OWNER's
--          membership and may not grant OWNER.
--   MEMBER may do none of it.
--   Nobody changes their OWN membership through these functions — which is
--   also what makes "demote or disable the last OWNER" unreachable; a
--   last-owner guard is kept anyway, as a second line.
--
-- Membership administration for one organisation is serialised by a
-- transaction advisory lock, so two OWNERs demoting each other at the same
-- moment cannot both succeed and leave the company with none.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- One lock key per organisation for every path that changes a membership's
-- role or status: the two admin functions below and complete_provisioning.
-- Invoked only from inside SECURITY DEFINER bodies, so it is granted to nobody.
create function app_private.lock_membership_administration(p_organization_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('landedcompare.membership-administration:' || p_organization_id::text, 0)
  );
$$;

revoke execute on function app_private.lock_membership_administration(uuid)
  from public, anon, authenticated, service_role;

-- The single projection of one member, shared by the list and by every
-- mutation's return value, so the client parses one shape. Timestamps use the
-- same millisecond-UTC form every `api` view uses. The e-mail comes from
-- `auth.users`, which is never exposed; only an OWNER/ADMIN of the member's
-- organisation ever receives it (the callers below prove that first).
create function app_private.member_json(p_organization_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'userId',      m.user_id,
    'displayName', p.display_name,
    'email',       u.email,
    'role',        m.role,
    'status',      m.status,
    'version',     m.version,
    'createdAt',   to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',   to_char(m.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  from app_data.memberships m
  left join app_data.profiles p on p.user_id = m.user_id
  left join auth.users u on u.id = m.user_id
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id;
$$;

revoke execute on function app_private.member_json(uuid, uuid)
  from public, anon, authenticated, service_role;

-- The caller, or a refusal. `auth.uid()` is null for a request without a user
-- JWT (the secret key, or no token at all): such a caller administers nothing.
create function app_private.require_caller()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'a signed-in caller is required'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;
  return v_actor;
end $$;

revoke execute on function app_private.require_caller()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The colleague list
--
-- Returns ONE jsonb array rather than a set of rows. PostgREST applies
-- `max_rows` to set-returning functions exactly as it does to views, and says
-- nothing when it truncates; a single value cannot be truncated. The members
-- manifest of the portable backup is built from this, so it must be whole.
-- ---------------------------------------------------------------------------
create function app_private.organization_members(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := app_private.require_caller();
begin
  perform app_private.assert_org_administrator(p_organization_id, v_actor);

  return coalesce(
    (select jsonb_agg(app_private.member_json(m.organization_id, m.user_id) order by m.user_id)
       from app_data.memberships m
      where m.organization_id = p_organization_id),
    '[]'::jsonb
  );
end $$;

comment on function app_private.organization_members(uuid) is
  'Phase 12. The members of one organisation, with e-mail, for an ACTIVE OWNER/ADMIN of THAT organisation only. Re-proves the caller from auth.uid() first. Reached through api.list_organization_members.';

-- ---------------------------------------------------------------------------
-- Change a member's role
-- ---------------------------------------------------------------------------
create function app_private.change_member_role(
  p_organization_id  uuid,
  p_user_id          uuid,
  p_expected_version integer,
  p_role             text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := app_private.require_caller();
  v_actor_role text;
  v_member     app_data.memberships%rowtype;
begin
  -- Authority before anything else, so a caller who is not an administrator
  -- here learns nothing — not even whether the subject exists (A-L5).
  v_actor_role := app_private.assert_org_administrator(p_organization_id, v_actor);

  if p_role is null or p_role not in ('OWNER', 'ADMIN', 'MEMBER') then
    raise exception 'unknown role'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  perform app_private.lock_membership_administration(p_organization_id);
  -- Re-proved after the lock: another transaction may have changed the
  -- caller's own membership while this one waited.
  v_actor_role := app_private.assert_org_administrator(p_organization_id, v_actor);

  if p_user_id = v_actor then
    raise exception 'administrators do not change their own membership'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  select * into v_member
  from app_data.memberships m
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id;

  if not found then
    raise exception 'no such member'
      using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;

  if v_actor_role <> 'OWNER' and (v_member.role = 'OWNER' or p_role = 'OWNER') then
    raise exception 'only an OWNER may change an OWNER''s membership or grant OWNER'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  if v_member.version <> p_expected_version then
    raise exception 'stale membership'
      using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;

  if v_member.role = p_role then
    return app_private.member_json(p_organization_id, p_user_id);
  end if;

  if v_member.role = 'OWNER' and v_member.status = 'ACTIVE' and not exists (
    select 1 from app_data.memberships o
    where o.organization_id = p_organization_id
      and o.role = 'OWNER' and o.status = 'ACTIVE'
      and o.user_id <> p_user_id
  ) then
    raise exception 'an organisation keeps at least one active OWNER'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  update app_data.memberships m
     set role = p_role
   where m.organization_id = p_organization_id
     and m.user_id = p_user_id
     and m.version = p_expected_version;

  if not found then
    raise exception 'stale membership'
      using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;

  insert into app_data.admin_events
    (organization_id, event_type, actor_user_id, subject_user_id, details)
  values (
    p_organization_id, 'MEMBER_ROLE_CHANGED', v_actor, p_user_id,
    jsonb_build_object('old_role', v_member.role, 'new_role', p_role)
  );

  return app_private.member_json(p_organization_id, p_user_id);
end $$;

-- ---------------------------------------------------------------------------
-- Disable or re-enable a member
--
-- DISABLED is the whole of "removing someone from this company". The row is
-- never deleted: it is what lets the boot sequence tell that person "your
-- access was deactivated" instead of "you were never attached", it keeps the
-- audit trail readable, and re-enabling is one call. The Auth identity is
-- NOT touched — it may belong to another organisation (A-L6, §31).
-- ---------------------------------------------------------------------------
create function app_private.change_member_status(
  p_organization_id  uuid,
  p_user_id          uuid,
  p_expected_version integer,
  p_status           text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := app_private.require_caller();
  v_actor_role text;
  v_member     app_data.memberships%rowtype;
begin
  v_actor_role := app_private.assert_org_administrator(p_organization_id, v_actor);

  if p_status is null or p_status not in ('ACTIVE', 'DISABLED') then
    raise exception 'unknown status'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  perform app_private.lock_membership_administration(p_organization_id);
  v_actor_role := app_private.assert_org_administrator(p_organization_id, v_actor);

  if p_user_id = v_actor then
    raise exception 'administrators do not change their own membership'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  select * into v_member
  from app_data.memberships m
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id;

  if not found then
    raise exception 'no such member'
      using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;

  if v_actor_role <> 'OWNER' and v_member.role = 'OWNER' then
    raise exception 'only an OWNER may change an OWNER''s membership'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  if v_member.version <> p_expected_version then
    raise exception 'stale membership'
      using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;

  if v_member.status = p_status then
    return app_private.member_json(p_organization_id, p_user_id);
  end if;

  if p_status = 'DISABLED' and v_member.role = 'OWNER' and not exists (
    select 1 from app_data.memberships o
    where o.organization_id = p_organization_id
      and o.role = 'OWNER' and o.status = 'ACTIVE'
      and o.user_id <> p_user_id
  ) then
    raise exception 'an organisation keeps at least one active OWNER'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  update app_data.memberships m
     set status = p_status
   where m.organization_id = p_organization_id
     and m.user_id = p_user_id
     and m.version = p_expected_version;

  if not found then
    raise exception 'stale membership'
      using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;

  insert into app_data.admin_events
    (organization_id, event_type, actor_user_id, subject_user_id, details)
  values (
    p_organization_id,
    case p_status when 'DISABLED' then 'MEMBER_DISABLED' else 'MEMBER_REENABLED' end,
    v_actor, p_user_id,
    jsonb_build_object('role', v_member.role)
  );

  return app_private.member_json(p_organization_id, p_user_id);
end $$;

-- ---------------------------------------------------------------------------
-- Clear a stuck provisioning attempt (§4 case E)
--
-- An attempt left IN_FLIGHT by an Edge Function that died between creating
-- the Auth user and linking it blocks a retry with the SAME request id. It is
-- cleared by an OWNER, explicitly — never by a timeout, which a slow run could
-- trip. Clearing marks it FAILED and deletes nothing: an Auth account the
-- dead run created stays, and the next invitation for that address links it
-- (case C). If the "dead" run was in fact alive, its link step now finds the
-- attempt not in flight and fails; nothing is deleted — the Auth identity is
-- retained (reason LINK_FAILED), and the next invitation for that address
-- re-invites and links it, the same convergence the design relies on.
-- ---------------------------------------------------------------------------
create function app_private.clear_provisioning_attempt(
  p_organization_id uuid,
  p_request_id      uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := app_private.require_caller();
begin
  if app_private.assert_org_administrator(p_organization_id, v_actor) <> 'OWNER' then
    raise exception 'only an OWNER clears a provisioning attempt'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  update app_data.provisioning_attempts a
     set status = 'FAILED',
         failure_reason = 'CLEARED_BY_OWNER'
   where a.request_id = p_request_id
     and a.organization_id = p_organization_id
     and a.status = 'IN_FLIGHT';

  if not found then
    raise exception 'no in-flight attempt with this request id in this organization'
      using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;

  return jsonb_build_object('status', 'CLEARED', 'request_id', p_request_id);
end $$;

-- The privileged bodies: EXECUTE for `authenticated`, because the invoker
-- wrappers run as the caller — and no route, because `app_private` is not
-- exposed. Revoked from `service_role`: the Edge Functions have no business
-- here.
revoke execute on function app_private.organization_members(uuid)                         from public, anon, service_role;
revoke execute on function app_private.change_member_role(uuid, uuid, integer, text)      from public, anon, service_role;
revoke execute on function app_private.change_member_status(uuid, uuid, integer, text)    from public, anon, service_role;
revoke execute on function app_private.clear_provisioning_attempt(uuid, uuid)             from public, anon, service_role;

grant execute on function app_private.organization_members(uuid)                          to authenticated;
grant execute on function app_private.change_member_role(uuid, uuid, integer, text)       to authenticated;
grant execute on function app_private.change_member_status(uuid, uuid, integer, text)     to authenticated;
grant execute on function app_private.clear_provisioning_attempt(uuid, uuid)              to authenticated;

-- ---------------------------------------------------------------------------
-- The client surface: typed SECURITY INVOKER wrappers
--
-- `p_expected_version integer`, no default, on both mutations — the same
-- contract as every other update RPC (pgTAP P20, extended to these names).
-- ---------------------------------------------------------------------------
create function api.list_organization_members(p_organization_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select app_private.organization_members(p_organization_id);
$$;

create function api.set_member_role(
  p_organization_id  uuid,
  p_user_id          uuid,
  p_expected_version integer,
  p_role             text
)
returns jsonb
language sql
set search_path = ''
as $$
  select app_private.change_member_role(p_organization_id, p_user_id, p_expected_version, p_role);
$$;

create function api.set_member_status(
  p_organization_id  uuid,
  p_user_id          uuid,
  p_expected_version integer,
  p_status           text
)
returns jsonb
language sql
set search_path = ''
as $$
  select app_private.change_member_status(p_organization_id, p_user_id, p_expected_version, p_status);
$$;

create function api.clear_provisioning_attempt(
  p_organization_id uuid,
  p_request_id      uuid
)
returns jsonb
language sql
set search_path = ''
as $$
  select app_private.clear_provisioning_attempt(p_organization_id, p_request_id);
$$;

revoke execute on function api.list_organization_members(uuid)                  from public, anon;
revoke execute on function api.set_member_role(uuid, uuid, integer, text)       from public, anon;
revoke execute on function api.set_member_status(uuid, uuid, integer, text)     from public, anon;
revoke execute on function api.clear_provisioning_attempt(uuid, uuid)           from public, anon;

grant execute on function api.list_organization_members(uuid)                   to authenticated;
grant execute on function api.set_member_role(uuid, uuid, integer, text)        to authenticated;
grant execute on function api.set_member_status(uuid, uuid, integer, text)      to authenticated;
grant execute on function api.clear_provisioning_attempt(uuid, uuid)            to authenticated;

-- ---------------------------------------------------------------------------
-- complete_provisioning — the third path that sets a role, brought under the
-- same rules
--
-- Re-inviting an existing member updates their role (§4 case D). Without the
-- guards below, an OWNER re-entering their OWN address with role MEMBER
-- demoted themselves — possibly the last OWNER — and an ADMIN could do the
-- same to themselves. The security correction pass adds two more: an OWNER
-- grant is re-authorised against the actor's role AFTER the lock (P12-H1),
-- and an existing global profile is never overwritten (P12-M1). The body is
-- otherwise unchanged from 20260922120500_provisioning.sql.
-- ---------------------------------------------------------------------------
create or replace function api.complete_provisioning(
  p_request_id   uuid,
  p_user_id      uuid,
  p_display_name text,
  p_created_here boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt      app_data.provisioning_attempts%rowtype;
  v_actor_role   text;
  v_subject      app_data.memberships%rowtype;
  v_name         text := btrim(coalesce(p_display_name, ''));
  v_requires_password_setup boolean;
begin
  select * into v_attempt
  from app_data.provisioning_attempts a
  where a.request_id = p_request_id
  for update;

  if not found then
    raise exception 'unknown provisioning attempt'
      using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;

  if v_attempt.status = 'SUCCEEDED' then
    return jsonb_build_object(
      'status',  'ALREADY_SUCCEEDED',
      'user_id', v_attempt.subject_user_id
    );
  end if;

  if v_attempt.status <> 'IN_FLIGHT' then
    raise exception 'provisioning attempt is not in flight'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  perform app_private.lock_membership_administration(v_attempt.organization_id);

  -- Authority is re-read AFTER the lock, from live membership: the claim in
  -- begin_provisioning may be minutes old, and the actor may have been
  -- demoted or disabled since.
  v_actor_role := app_private.assert_org_administrator(
    v_attempt.organization_id, v_attempt.actor_user_id
  );

  -- Phase 12 correction (P12-H1): an OWNER grant needs an actor who is an
  -- OWNER NOW. begin_provisioning checked this when the attempt was claimed;
  -- an OWNER demoted to ADMIN between the claim and this step must not
  -- complete the grant on the strength of the role they no longer hold.
  if v_attempt.requested_role = 'OWNER' and v_actor_role <> 'OWNER' then
    raise exception 'only an OWNER may grant the OWNER role'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  if v_name = '' then
    raise exception 'display name is required'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  select * into v_subject
  from app_data.memberships m
  where m.organization_id = v_attempt.organization_id
    and m.user_id = p_user_id;

  if found then
    if v_subject.role = 'OWNER' and v_actor_role <> 'OWNER' then
      raise exception 'only an OWNER may change an OWNER''s membership'
        using errcode = '42501', detail = 'FORBIDDEN';
    end if;

    -- Phase 12: an administrator does not change their own membership by
    -- re-inviting their own address.
    if p_user_id = v_attempt.actor_user_id
       and (v_subject.role <> v_attempt.requested_role or v_subject.status <> 'ACTIVE') then
      raise exception 'administrators do not change their own membership'
        using errcode = '42501', detail = 'FORBIDDEN';
    end if;

    -- Phase 12: never leave the organisation without an active OWNER.
    if v_subject.role = 'OWNER' and v_subject.status = 'ACTIVE'
       and v_attempt.requested_role <> 'OWNER'
       and not exists (
         select 1 from app_data.memberships o
         where o.organization_id = v_attempt.organization_id
           and o.role = 'OWNER' and o.status = 'ACTIVE'
           and o.user_id <> p_user_id
       ) then
      raise exception 'an organisation keeps at least one active OWNER'
        using errcode = '42501', detail = 'FORBIDDEN';
    end if;
  end if;

  perform set_config('app.actor_user_id', v_attempt.actor_user_id::text, true);

  -- Two facts that must not be confused (final onboarding correction):
  --
  --   p_created_here            IDENTITY LIFECYCLE — did this attempt create
  --                             the Auth account? Stored on the attempt row
  --                             (server-only column) and nothing else.
  --   v_requires_password_setup ONBOARDING — does the person still have to
  --                             choose a password in the application?
  --
  -- The second is read here, from the Auth record itself, never from the
  -- first. An invitation that created the account and whose link then FAILED
  -- leaves an orphan; the next request re-invites that same, still
  -- unaccepted account with `p_created_here = false` — and the person must
  -- still be asked for a password. So the requirement is:
  --
  --   the invitation has not been accepted yet   (email_confirmed_at is null)
  --   OR the account came into being by invitation   (invited_at is not null)
  --
  -- and it is applied ONLY when the profile is being created, i.e. the
  -- identity has never been onboarded in this product (onboarding happens in
  -- the application, after a profile exists). An established account —
  -- confirmed, not invitation-born, or already holding a profile — is never
  -- spuriously sent through onboarding. The value is not returned to anyone:
  -- it lands in the profile, which `api.profiles` shows to its owner only.
  --
  -- `must_change_password` is onboarding UX — never a security boundary;
  -- nothing on the server consults it (§31.7).
  select (u.email_confirmed_at is null or u.invited_at is not null)
    into v_requires_password_setup
  from auth.users u
  where u.id = p_user_id;

  if not found then
    raise exception 'no auth identity for this provisioning attempt'
      using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;

  -- Phase 12 correction (P12-M1): the profile is GLOBAL — one per identity,
  -- seen by every organisation the person belongs to. Provisioning creates it
  -- when it is missing and otherwise leaves it exactly as it is: organisation
  -- X re-inviting an address must not rename the person as organisation Y
  -- sees them, nor touch their onboarding flag.
  insert into app_data.profiles (user_id, display_name, must_change_password)
  values (p_user_id, v_name, coalesce(v_requires_password_setup, false))
  on conflict (user_id) do nothing;

  insert into app_data.memberships (organization_id, user_id, role, status)
  values (v_attempt.organization_id, p_user_id, v_attempt.requested_role, 'ACTIVE')
  on conflict (organization_id, user_id) do update
    set role = excluded.role,
        status = 'ACTIVE';

  insert into app_data.admin_events
    (organization_id, event_type, actor_user_id, subject_user_id, details)
  values (
    v_attempt.organization_id,
    'MEMBER_PROVISIONED',
    v_attempt.actor_user_id,
    p_user_id,
    -- Phase 12 final correction: no `auth_user_created`. This row is
    -- readable by the organisation's OWNER/ADMIN, and whether the address
    -- already had a global account is not theirs to learn. The attempt row
    -- (`created_here`, server-only column) keeps it for the operator.
    jsonb_build_object(
      'role',            v_attempt.requested_role,
      'email',           v_attempt.email,
      'request_id',      p_request_id
    )
  );

  update app_data.provisioning_attempts a
     set status = 'SUCCEEDED',
         subject_user_id = p_user_id,
         created_here = coalesce(p_created_here, false),
         failure_reason = null
   where a.request_id = p_request_id;

  return jsonb_build_object('status', 'SUCCEEDED', 'user_id', p_user_id);
end $$;

-- ===========================================================================
-- A-L6 — the Auth identity lifecycle, at the operator boundary
--
-- An Auth identity is GLOBAL; a membership is per organisation. So:
--
--   disabling membership in X   organisation-level; OWNER/ADMIN of X; the
--                               identity, its password, its sessions and its
--                               memberships elsewhere are untouched
--   removing membership in X    is the same act — DISABLED — never a DELETE
--   the profile                 one per identity, not per organisation; kept
--                               while the identity exists
--   deleting the Auth identity  NOT an organisation capability. Whether the
--                               identity belongs to another organisation is
--                               another tenant's fact, so no OWNER may ask it,
--                               and the Admin API it needs holds the secret
--                               key. It is an operator act, like bootstrap.
--   orphans                     an identity with no membership anywhere: an
--                               invited identity whose link step failed and
--                               was never re-invited (it is retained on
--                               purpose), or a hand-created mistake. Reported
--                               by one function, purged by another that
--                               refuses anything but a true orphan.
--
-- Both functions are revoked from every Data API role, `service_role`
-- included: they are reachable from a superuser connection only, exactly like
-- `app_private.bootstrap_organization`. Nothing here is in the browser path.
-- ===========================================================================

create function app_private.orphaned_auth_identities()
returns table (
  user_id                    uuid,
  email                      text,
  created_at                 timestamptz,
  has_profile                boolean,
  disabled_memberships       integer,
  in_flight_attempts         integer,
  eligible_for_purge         boolean
)
language sql
stable
set search_path = ''
as $$
  select
    u.id,
    u.email::text,
    u.created_at,
    exists (select 1 from app_data.profiles p where p.user_id = u.id),
    (select count(*)::integer from app_data.memberships m
      where m.user_id = u.id and m.status = 'DISABLED'),
    (select count(*)::integer from app_data.provisioning_attempts a
      where a.status = 'IN_FLIGHT' and a.email = lower(btrim(coalesce(u.email, '')))),
    not exists (select 1 from app_data.memberships m where m.user_id = u.id)
      and not exists (select 1 from app_data.provisioning_attempts a
                      where a.status = 'IN_FLIGHT' and a.email = lower(btrim(coalesce(u.email, ''))))
  from auth.users u
  where not exists (
    select 1 from app_data.memberships m
    where m.user_id = u.id and m.status = 'ACTIVE'
  )
  order by u.created_at, u.id;
$$;

comment on function app_private.orphaned_auth_identities() is
  'Operator-only report (A-L6). Every Auth identity with no ACTIVE membership anywhere, and whether it is a purgeable orphan: no membership of any status and no in-flight provisioning attempt for its address. Read-only.';

create function app_private.purge_orphaned_auth_identity(p_user_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_email text;
begin
  -- Lock the identity first. A provisioning run that links it after this
  -- point must take a key-share lock on the same row for its foreign keys and
  -- therefore waits for this transaction; one that linked it before is seen
  -- by the checks below, which run in fresh statements after the lock.
  select lower(btrim(coalesce(u.email::text, ''))) into v_email
  from auth.users u
  where u.id = p_user_id
  for update;

  if not found then
    raise exception 'no auth identity with id %', p_user_id;
  end if;

  if exists (select 1 from app_data.memberships m where m.user_id = p_user_id) then
    raise exception 'identity % still has a membership; disabling is the product lifecycle and purge is for orphans only', p_user_id;
  end if;

  if exists (select 1 from app_data.provisioning_attempts a
             where a.status = 'IN_FLIGHT'
               and (a.email = v_email or a.subject_user_id = p_user_id)) then
    raise exception 'identity % is the subject of an in-flight provisioning attempt', p_user_id;
  end if;

  -- Cascades to auth.identities / sessions / refresh tokens and to an
  -- orphan's profile; attribution columns elsewhere are `on delete set null`.
  delete from auth.users u where u.id = p_user_id;

  return 'PURGED';
end $$;

comment on function app_private.purge_orphaned_auth_identity(uuid) is
  'Operator-only (A-L6). Deletes an Auth identity ONLY when it has no membership of any status and no in-flight provisioning attempt. Not callable by any Data API role.';

revoke execute on function app_private.orphaned_auth_identities()          from public, anon, authenticated, service_role;
revoke execute on function app_private.purge_orphaned_auth_identity(uuid)  from public, anon, authenticated, service_role;

-- ===========================================================================
-- P12-B1 — no organisation may replace a global credential
--
-- `admin-reset-password` let an OWNER/ADMIN of organisation X set a new
-- password on an EXISTING Auth identity and receive it. The identity is
-- global: if the same person also belongs to organisation Y, X's
-- administrator could sign in as them and act inside Y. Membership in X is no
-- authority over a credential that opens Y.
--
-- The capability is removed, server-side, by removing the two functions the
-- Edge Function needs before it may touch the Auth Admin API. An
-- `admin-reset-password` deployment that outlives this migration fails at its
-- first RPC — before `updateUserById` — and so can change nothing. The Edge
-- Function source is removed from the repository in the same change, and the
-- hosted deployment removes the deployed function (docs/DEPLOYMENT.md).
--
-- What remains: no administrator credential path at all. A new address is
-- INVITED by Auth, by e-mail, and the person chooses their own password; an
-- existing account is linked untouched. A forgotten password is recovered by
-- a recovery e-mail the operator triggers, and again the person chooses the
-- password (docs/DEPLOYMENT.md).
--
-- `PASSWORD_RESET_BY_ADMIN` stays an allowed `admin_events` type: rows
-- written before this migration remain valid history.
-- ===========================================================================
drop function api.begin_password_reset(uuid, uuid, uuid);
drop function api.complete_password_reset(uuid, uuid, uuid);

-- ===========================================================================
-- Final credential correction — a colleague's profile says who they are,
-- not how new their account is
--
-- New accounts are now INVITED (the person sets their own password) and the
-- provisioning answer is identical for a new and an existing address. Two
-- columns of `api.profiles` would still tell a colleague which it was: the
-- forced-change flag (true for an invited account until its owner has chosen
-- a password), the profile timestamps (a profile created a moment ago) and
-- its version (which moves when onboarding completes). They are projected for
-- the caller's OWN row only — the only row any RPC updates; for anyone else
-- the flag reads false, the version 0 and the timestamps null. The display name — the reason a
-- colleague may read a profile at all (§5) — is unchanged.
--
-- `create or replace` keeps the column list, the grants and every function
-- that returns `setof api.profiles`; the option is restated so the view
-- cannot lose `security_invoker`.
-- ===========================================================================
create or replace view api.profiles with (security_invoker = on) as
select
  p.user_id,
  p.display_name,
  case when p.user_id = (select auth.uid()) then p.must_change_password else false end
                                                  as must_change_password,
  case when p.user_id = (select auth.uid()) then p.version else 0 end
                                                  as version,
  case when p.user_id = (select auth.uid())
       then to_char(p.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
                                                  as created_at,
  case when p.user_id = (select auth.uid())
       then to_char(p.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
                                                  as updated_at
from app_data.profiles p;

comment on column app_data.profiles.must_change_password is
  'Onboarding UX only, never a security control: set for an account a provisioning request INVITED (the person has no password yet) or by the operator before a recovery e-mail, so the application asks the person to choose a password. Nothing on the server consults it; it is projected to its owner only (api.profiles).';
