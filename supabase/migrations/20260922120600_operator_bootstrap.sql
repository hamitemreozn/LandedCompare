-- ===========================================================================
-- Phase 10 — Cloud Foundation, 7/7: the operator bootstrap
--
-- A chicken-and-egg problem with exactly one honest answer.
--
-- `admin-provision-user` requires the caller to be an ACTIVE OWNER or ADMIN of
-- the organisation named in the request. On a brand-new project no organisation
-- exists and no membership exists, so there is no caller who can pass that
-- check — and there must not be, because a "first user becomes OWNER
-- automatically" rule is a self-service registration path wearing a different
-- name, on a project where public sign-up is disabled precisely to prevent one.
--
-- So the first organisation and its first OWNER are created by an OPERATOR,
-- holding the database connection string, running this function once. That is a
-- deliberate, out-of-band, non-repeatable act — the same category as setting the
-- Edge Function secret.
--
-- It is a function in a migration rather than a row typed into the Supabase
-- Table Editor because the dashboard is not a schema-change mechanism and is
-- not a data-entry mechanism either: what this function does — normalise, check
-- the auth user exists, create the profile, create the membership, record the
-- admin event — is five statements that must agree, and five statements typed
-- by hand at midnight are four statements and a mistake.
--
-- EXECUTE is revoked from every role including `service_role`. It is reachable
-- only from a superuser connection, which is exactly the audience.
-- ===========================================================================

create function app_private.bootstrap_organization(
  p_organization_name text,
  p_owner_user_id     uuid,
  p_owner_display_name text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_name            text := btrim(coalesce(p_organization_name, ''));
  v_display_name    text := btrim(coalesce(p_owner_display_name, ''));
begin
  if v_name = '' then
    raise exception 'organization name is required';
  end if;

  if v_display_name = '' then
    raise exception 'owner display name is required';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_owner_user_id) then
    raise exception 'no auth user with id %; create the account first', p_owner_user_id;
  end if;

  -- The operator is acting on behalf of the owner they are installing, so the
  -- audit columns name that person rather than a null. `is_local = true`: it
  -- exists for this transaction and nowhere else.
  perform set_config('app.actor_user_id', p_owner_user_id::text, true);

  insert into app_data.organizations (name)
  values (v_name)
  returning id into v_organization_id;

  insert into app_data.profiles (user_id, display_name, must_change_password)
  values (p_owner_user_id, v_display_name, true)
  on conflict (user_id) do update
    set display_name = excluded.display_name;

  insert into app_data.memberships (organization_id, user_id, role, status)
  values (v_organization_id, p_owner_user_id, 'OWNER', 'ACTIVE');

  insert into app_data.admin_events
    (organization_id, event_type, actor_user_id, subject_user_id, details)
  values (
    v_organization_id,
    'MEMBER_PROVISIONED',
    p_owner_user_id,
    p_owner_user_id,
    jsonb_build_object('role', 'OWNER', 'bootstrap', true)
  );

  return v_organization_id;
end $$;

comment on function app_private.bootstrap_organization(text, uuid, text) is
  'Operator-only. Creates the first organisation and its first OWNER on a new project. Not callable by any Data API role; run it from a superuser connection, once.';

revoke execute on function app_private.bootstrap_organization(text, uuid, text)
  from public, anon, authenticated, service_role;
