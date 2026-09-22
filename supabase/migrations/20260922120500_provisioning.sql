-- ===========================================================================
-- Phase 10 — Cloud Foundation, 6/7: the transactional half of provisioning
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4.
--
-- Creating a user crosses a boundary a database transaction cannot span.
-- `auth.admin.createUser()` is an HTTP call to the Auth service; the profile
-- and membership rows are a PostgreSQL write. Between them sit a network, a
-- timeout, and an Edge Function that can be killed mid-execution. They do not
-- commit together, and this file does not pretend they do.
--
-- What it provides instead is the part that IS transactional, with an
-- idempotency claim in front of it:
--
--   begin_provisioning    claims `request_id`, or reports what already happened
--   complete_provisioning  profile + membership + admin event + attempt status,
--                          in ONE transaction
--   fail_provisioning      marks the attempt failed after the Edge Function has
--                          compensated
--
-- ---------------------------------------------------------------------------
-- Why these are SECURITY DEFINER, and why only `service_role` may call them
--
-- The caller is the Edge Function, authenticating with the secret key, so
-- `auth.uid()` is null and there is no session whose privileges could be used.
-- DEFINER lets `service_role` hold EXECUTE on five functions and NO privilege
-- on any table in `app_data` — which matters, because the secret key is the
-- most dangerous credential in the system and the smaller the set of statements
-- it can express, the better.
--
-- ---------------------------------------------------------------------------
-- The database re-proves the actor's authority. It does not take the Edge
-- Function's word for it.
--
-- The Edge Function verifies the caller's JWT and their OWNER/ADMIN membership
-- before it touches the Auth Admin API. These functions verify the same thing
-- again, from `app_data.memberships`, because a control that exists in exactly
-- one place is a control that a rewrite of that place removes silently.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Shared authority check
--
-- Raises rather than returning false: every caller's correct response to "you
-- are not an administrator here" is to stop, and a boolean is a value someone
-- eventually forgets to read.
-- ---------------------------------------------------------------------------
create function app_private.assert_org_administrator(
  p_organization_id uuid,
  p_actor_user_id   uuid
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_role text;
begin
  select m.role into v_role
  from app_data.memberships m
  where m.organization_id = p_organization_id
    and m.user_id = p_actor_user_id
    and m.status = 'ACTIVE';

  if v_role is null or v_role not in ('OWNER', 'ADMIN') then
    raise exception 'actor is not an active OWNER or ADMIN of this organization'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  return v_role;
end $$;

revoke execute on function app_private.assert_org_administrator(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- begin_provisioning — claim the attempt, or report what already happened
--
-- `provisioning_attempts.request_id` is the primary key and the whole
-- idempotency mechanism. The client generates it once per press of the button
-- and reuses it on retry, exactly as it already generates entity UUIDs.
--
-- Four outcomes, and each one is a decision the Edge Function makes differently:
--
--   CLAIMED           this call owns the attempt; continue to the Auth API
--   ALREADY_SUCCEEDED the stored outcome, returned again. Nothing is created,
--                     and no password is returned — the original one was shown
--                     once and this is not that moment
--   BUSY              an attempt with this request_id is IN_FLIGHT. Refused
--                     rather than raced, because two concurrent runs of step 2
--                     is exactly how a duplicate auth user appears
--   CLAIMED (retry)   the previous attempt with this id FAILED, which means the
--                     Edge Function already compensated and left nothing
--                     behind, so the id is safe to reuse
-- ---------------------------------------------------------------------------
create function api.begin_provisioning(
  p_request_id      uuid,
  p_organization_id uuid,
  p_email           text,
  p_requested_role  text,
  p_actor_user_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_existing app_data.provisioning_attempts%rowtype;
  v_claimed  boolean := false;
begin
  perform app_private.assert_org_administrator(p_organization_id, p_actor_user_id);

  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'a valid e-mail address is required'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  if p_requested_role not in ('OWNER', 'ADMIN', 'MEMBER') then
    raise exception 'unknown role'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  -- Only an OWNER may mint another OWNER. An ADMIN who could would be able to
  -- grant themselves, through a second account, the one capability the OWNER
  -- role exists to withhold: restoring over the company's data.
  if p_requested_role = 'OWNER'
     and app_private.assert_org_administrator(p_organization_id, p_actor_user_id) <> 'OWNER' then
    raise exception 'only an OWNER may grant the OWNER role'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  insert into app_data.provisioning_attempts
    (request_id, organization_id, email, requested_role, status, actor_user_id)
  values
    (p_request_id, p_organization_id, v_email, p_requested_role, 'IN_FLIGHT', p_actor_user_id)
  on conflict (request_id) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed then
    return jsonb_build_object('status', 'CLAIMED');
  end if;

  select * into v_existing
  from app_data.provisioning_attempts a
  where a.request_id = p_request_id
  for update;

  -- A request_id is a claim on one specific invitation. Reusing it for a
  -- different organisation or address would make the idempotency record lie
  -- about what converged.
  if v_existing.organization_id <> p_organization_id or v_existing.email <> v_email then
    raise exception 'request_id was already used for a different invitation'
      using errcode = 'P0001', detail = 'DUPLICATE_KEY';
  end if;

  if v_existing.status = 'SUCCEEDED' then
    return jsonb_build_object(
      'status',  'ALREADY_SUCCEEDED',
      'user_id', v_existing.subject_user_id
    );
  end if;

  if v_existing.status = 'IN_FLIGHT' then
    return jsonb_build_object('status', 'BUSY');
  end if;

  update app_data.provisioning_attempts a
     set status = 'IN_FLIGHT',
         failure_reason = null,
         created_here = null,
         requested_role = p_requested_role,
         actor_user_id = p_actor_user_id
   where a.request_id = p_request_id;

  return jsonb_build_object('status', 'CLAIMED');
end $$;

-- ---------------------------------------------------------------------------
-- complete_provisioning — one transaction, four writes
--
-- profile, membership, admin event, attempt status. Either all of them are
-- there or none of them is, which is the half of §4 a database can actually
-- promise.
--
-- `on conflict do update` on both the profile and the membership is what makes
-- case D work: re-inviting a disabled colleague sets the role and re-activates
-- the membership, which is the behaviour an administrator expects from pressing
-- the same button again.
-- ---------------------------------------------------------------------------
create function api.complete_provisioning(
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
  v_subject_role text;
  v_name         text := btrim(coalesce(p_display_name, ''));
begin
  select * into v_attempt
  from app_data.provisioning_attempts a
  where a.request_id = p_request_id
  for update;

  if not found then
    raise exception 'unknown provisioning attempt'
      using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;

  -- Idempotent by the same rule as begin_provisioning: a retry that reaches
  -- here after the transaction already committed gets the stored outcome, not
  -- a second set of writes.
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

  v_actor_role := app_private.assert_org_administrator(
    v_attempt.organization_id, v_attempt.actor_user_id
  );

  if v_name = '' then
    raise exception 'display name is required'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  -- An ADMIN may not re-role an existing OWNER. Without this, "invite" becomes
  -- a demotion primitive that the one role above ADMIN cannot defend against.
  select m.role into v_subject_role
  from app_data.memberships m
  where m.organization_id = v_attempt.organization_id
    and m.user_id = p_user_id;

  if v_subject_role = 'OWNER' and v_actor_role <> 'OWNER' then
    raise exception 'only an OWNER may change an OWNER''s membership'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  -- Attribution for the stamping trigger. `is_local = true`, so it exists for
  -- this transaction and nowhere else; there is no route through PostgREST that
  -- lets a client set it (§7).
  perform set_config('app.actor_user_id', v_attempt.actor_user_id::text, true);

  insert into app_data.profiles (user_id, display_name, must_change_password)
  values (p_user_id, v_name, coalesce(p_created_here, false))
  on conflict (user_id) do update
    set display_name = excluded.display_name;

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
    jsonb_build_object(
      'role',            v_attempt.requested_role,
      'email',           v_attempt.email,
      'auth_user_created', coalesce(p_created_here, false),
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

-- ---------------------------------------------------------------------------
-- fail_provisioning — called after the Edge Function has compensated
--
-- Deliberately does NOT delete anything. Compensation is the Edge Function's
-- job because the thing that may need deleting is an auth user, which lives
-- behind an HTTP API this database cannot call. Recording the outcome here and
-- performing it there keeps each side responsible for what it can actually do.
-- ---------------------------------------------------------------------------
create function api.fail_provisioning(
  p_request_id uuid,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  update app_data.provisioning_attempts a
     set status = 'FAILED',
         failure_reason = left(coalesce(btrim(p_reason), 'UNSPECIFIED'), 200)
   where a.request_id = p_request_id
     and a.status = 'IN_FLIGHT'
  returning a.status into v_status;

  if v_status is null then
    return jsonb_build_object('status', 'NOT_IN_FLIGHT');
  end if;

  return jsonb_build_object('status', 'FAILED');
end $$;

-- ---------------------------------------------------------------------------
-- Password reset, in two halves around the Auth Admin API call
--
-- Split deliberately, and not folded into provisioning. §4 case C: an
-- administrator who re-enters an existing colleague's address must LINK that
-- account, never re-credential it. Resetting a password is a separate, explicit
-- action, so it is a separate, explicit pair of functions.
-- ---------------------------------------------------------------------------
create function api.begin_password_reset(
  p_organization_id uuid,
  p_actor_user_id   uuid,
  p_subject_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role   text;
  v_subject_role text;
begin
  v_actor_role := app_private.assert_org_administrator(p_organization_id, p_actor_user_id);

  select m.role into v_subject_role
  from app_data.memberships m
  where m.organization_id = p_organization_id
    and m.user_id = p_subject_user_id
    and m.status = 'ACTIVE';

  -- The subject must be a member of the organisation the actor administers.
  -- Without this, an ADMIN of any organisation could reset the password of any
  -- account in the entire system by naming its uuid.
  if v_subject_role is null then
    raise exception 'subject is not an active member of this organization'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  if v_subject_role = 'OWNER' and v_actor_role <> 'OWNER' then
    raise exception 'only an OWNER may reset an OWNER''s password'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  return jsonb_build_object('status', 'AUTHORIZED');
end $$;

create function api.complete_password_reset(
  p_organization_id uuid,
  p_actor_user_id   uuid,
  p_subject_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_org_administrator(p_organization_id, p_actor_user_id);

  perform set_config('app.actor_user_id', p_actor_user_id::text, true);

  update app_data.profiles p
     set must_change_password = true
   where p.user_id = p_subject_user_id;

  insert into app_data.admin_events
    (organization_id, event_type, actor_user_id, subject_user_id, details)
  values (
    p_organization_id,
    'PASSWORD_RESET_BY_ADMIN',
    p_actor_user_id,
    p_subject_user_id,
    -- The password itself is never recorded, not here and not anywhere. What is
    -- worth knowing a year from now is that it happened, and who did it.
    '{}'::jsonb
  );

  return jsonb_build_object('status', 'RECORDED');
end $$;

-- ---------------------------------------------------------------------------
-- Callable by the server, and by nothing else
--
-- These live in `api` because that is the only schema PostgREST routes, and the
-- Edge Function reaches PostgreSQL through PostgREST. They are revoked from
-- PUBLIC, `anon` and `authenticated` first, then granted to `service_role`
-- alone — so a signed-in user calling `POST /rest/v1/rpc/begin_provisioning`
-- with their own access token is refused by privilege, not by the function
-- deciding to be polite about it.
-- ---------------------------------------------------------------------------
revoke execute on function api.begin_provisioning(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function api.complete_provisioning(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function api.fail_provisioning(uuid, text)                    from public, anon, authenticated;
revoke execute on function api.begin_password_reset(uuid, uuid, uuid)           from public, anon, authenticated;
revoke execute on function api.complete_password_reset(uuid, uuid, uuid)        from public, anon, authenticated;

grant execute on function api.begin_provisioning(uuid, uuid, text, text, uuid) to service_role;
grant execute on function api.complete_provisioning(uuid, uuid, text, boolean) to service_role;
grant execute on function api.fail_provisioning(uuid, text)                    to service_role;
grant execute on function api.begin_password_reset(uuid, uuid, uuid)           to service_role;
grant execute on function api.complete_password_reset(uuid, uuid, uuid)        to service_role;
