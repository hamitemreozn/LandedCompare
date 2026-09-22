-- ===========================================================================
-- Local development seed — SYNTHETIC DATA ONLY
--
-- Runs on `supabase db reset` against the local Docker stack. It is NOT pushed
-- to the hosted project: `supabase db push` applies migrations and nothing
-- else, which is the property that keeps the pilot project empty until a real
-- organisation is bootstrapped deliberately.
--
-- Two organisations, four users, and not one fact about Akgün Medikal. The
-- point of two is that tenant isolation cannot be tested with one: a suite that
-- proves a member sees their own data proves nothing until there is other data
-- for them to fail to see.
--
--   Deneme Şirketi A    owner-a@example.test    OWNER
--                       member-a@example.test   MEMBER
--   Deneme Şirketi B    owner-b@example.test    OWNER
--                       member-b@example.test   MEMBER   (DISABLED by the
--                                                         membership-disable
--                                                         test, then restored)
--
-- Every password is `LandedLocal!1`. It is in a file in a public repository on
-- purpose: it opens a throwaway database that listens on 127.0.0.1 and holds
-- nothing. A seed password that had to be kept secret would be a secret in the
-- repository, which is the thing §19 forbids.
-- ===========================================================================

do $seed$
declare
  v_org_a uuid := '11111111-1111-4111-8111-111111111111';
  v_org_b uuid := '22222222-2222-4222-8222-222222222222';
  v_password text := 'LandedLocal!1';
  v_user record;
begin
  -- -----------------------------------------------------------------------
  -- Auth users, written directly
  --
  -- The Auth Admin API is the right way to create a user and is not available
  -- from inside a SQL seed. Writing `auth.users` by hand is acceptable here and
  -- nowhere else: this database is rebuilt from empty by every `db reset`, and
  -- the rows below are shaped to match what GoTrue writes — a bcrypt hash, a
  -- confirmed address, and a matching `auth.identities` row, without which a
  -- password sign-in fails to resolve the account.
  -- -----------------------------------------------------------------------
  for v_user in
    select *
    from (values
      ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'owner-a@example.test',  'Ayşe Yılmaz',  v_org_a, 'OWNER'),
      ('aaaaaaaa-0000-4000-8000-000000000002'::uuid, 'member-a@example.test', 'Berk Demir',   v_org_a, 'MEMBER'),
      ('bbbbbbbb-0000-4000-8000-000000000001'::uuid, 'owner-b@example.test',  'Cem Kaya',     v_org_b, 'OWNER'),
      ('bbbbbbbb-0000-4000-8000-000000000002'::uuid, 'member-b@example.test', 'Deniz Aydın',  v_org_b, 'MEMBER')
    ) as t(user_id, email, display_name, organization_id, role)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user.user_id,
      'authenticated',
      'authenticated',
      v_user.email,
      extensions.crypt(v_password, extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      '', '', '', ''
    );

    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_user.user_id::text,
      v_user.user_id,
      jsonb_build_object('sub', v_user.user_id::text, 'email', v_user.email, 'email_verified', true),
      'email',
      now(), now(), now()
    );
  end loop;

  -- -----------------------------------------------------------------------
  -- Organisations, profiles and memberships
  --
  -- Written through the same tables the application uses, with the stamping
  -- trigger doing what it does in production. `app.actor_user_id` names the
  -- owner so `created_by` is a person rather than a null, which is what makes
  -- the seeded data a realistic fixture rather than a special case the tests
  -- would then be proving things about.
  -- -----------------------------------------------------------------------
  perform set_config('app.actor_user_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
  insert into app_data.organizations (id, name) values (v_org_a, 'Deneme Şirketi A');

  perform set_config('app.actor_user_id', 'bbbbbbbb-0000-4000-8000-000000000001', true);
  insert into app_data.organizations (id, name) values (v_org_b, 'Deneme Şirketi B');

  for v_user in
    select *
    from (values
      ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'Ayşe Yılmaz', v_org_a, 'OWNER'),
      ('aaaaaaaa-0000-4000-8000-000000000002'::uuid, 'Berk Demir',  v_org_a, 'MEMBER'),
      ('bbbbbbbb-0000-4000-8000-000000000001'::uuid, 'Cem Kaya',    v_org_b, 'OWNER'),
      ('bbbbbbbb-0000-4000-8000-000000000002'::uuid, 'Deniz Aydın', v_org_b, 'MEMBER')
    ) as t(user_id, display_name, organization_id, role)
  loop
    perform set_config('app.actor_user_id', v_user.user_id::text, true);

    insert into app_data.profiles (user_id, display_name, must_change_password)
    values (v_user.user_id, v_user.display_name, false);

    insert into app_data.memberships (organization_id, user_id, role, status)
    values (v_user.organization_id, v_user.user_id, v_user.role, 'ACTIVE');
  end loop;

  -- A counter per organisation, so the write-gate and server-only assertions
  -- have a row to be about rather than an empty table that would pass either
  -- way.
  perform set_config('app.actor_user_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
  insert into app_data.counters (organization_id, key, next_value) values (v_org_a, 'PURCHASE_ORDER', 1);

  perform set_config('app.actor_user_id', 'bbbbbbbb-0000-4000-8000-000000000001', true);
  insert into app_data.counters (organization_id, key, next_value) values (v_org_b, 'PURCHASE_ORDER', 1);
end
$seed$;
