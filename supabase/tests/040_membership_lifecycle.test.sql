-- ===========================================================================
-- Phase 10 security suite, 4/6 — authorisation is live database state
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §6, §22 threat 3.
--
-- The claim being tested is narrow and is the reason no organisation claim is
-- ever read from a token:
--
--   > Every policy resolves membership from the `memberships` table AT QUERY
--   > TIME. `status = 'DISABLED'` takes effect on the very next request, even
--   > though the access token is unexpired and still verifies.
--
-- Within a database session the equivalent of "the same JWT" is "the same
-- `request.jwt.claims` setting, untouched" — and that is exactly what these
-- assertions keep constant while the membership changes underneath them. The
-- end-to-end form of the same proof, with a real access token issued by GoTrue
-- and reused across an HTTP request boundary, is in the behavioural suite
-- (`src/cloud/security/membershipDisable.security.test.ts`); both exist because
-- each one is blind to something the other sees.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(11);

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '4a4a4a4a-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'life-owner@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', '4a4a4a4a-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'life-member@example.test', now(), now());

insert into app_data.organizations (id, name)
values ('4f4f4f4f-0000-4000-8000-00000000000a', 'Lifecycle Org');

insert into app_data.profiles (user_id, display_name) values
  ('4a4a4a4a-0000-4000-8000-000000000001', 'Lifecycle Owner'),
  ('4a4a4a4a-0000-4000-8000-000000000002', 'Lifecycle Member');

insert into app_data.memberships (organization_id, user_id, role, status) values
  ('4f4f4f4f-0000-4000-8000-00000000000a', '4a4a4a4a-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE'),
  ('4f4f4f4f-0000-4000-8000-00000000000a', '4a4a4a4a-0000-4000-8000-000000000002', 'MEMBER', 'ACTIVE');

-- ---------------------------------------------------------------------------
-- The session is established once, here, and its claims are NEVER rewritten
-- below. Everything that changes from this point changes in the database.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"4a4a4a4a-0000-4000-8000-000000000002","role":"authenticated"}', true);

select is(
  (select count(*)::integer from api.organizations),
  1,
  'with an ACTIVE membership, the member reads their organisation'
);

select ok(
  (select app_private.has_org_role('4f4f4f4f-0000-4000-8000-00000000000a', array['MEMBER'])),
  'has_org_role agrees: the member is an ACTIVE MEMBER'
);

select ok(
  not (select app_private.has_org_role('4f4f4f4f-0000-4000-8000-00000000000a', array['OWNER','ADMIN'])),
  'a MEMBER is not an OWNER or ADMIN — the role predicate is not merely a membership predicate'
);

-- ---------------------------------------------------------------------------
-- The membership is disabled. The session is not touched.
-- ---------------------------------------------------------------------------
reset role;
update app_data.memberships
   set status = 'DISABLED'
 where organization_id = '4f4f4f4f-0000-4000-8000-00000000000a'
   and user_id = '4a4a4a4a-0000-4000-8000-000000000002';
set local role authenticated;

select is(
  (select count(*)::integer from api.organizations),
  0,
  'threat 3: the SAME session, with the SAME claims, now reads no organisation — disabling took effect on the next statement'
);

-- The disabled membership row itself stays readable BY ITS OWNER, and that is
-- deliberate rather than a leak. §17 requires three different sentences for
-- three different states, and "your account is attached to this company but has
-- been deactivated — talk to your administrator" is not derivable from an empty
-- result set. The row carries no access to anything: every organisation-scoped
-- policy asks `current_org_ids()`, which filters on `status = 'ACTIVE'`, so
-- what the user can SEE here and what they can DO are decided separately.
select results_eq(
  $$ select status from api.memberships $$,
  $$ values ('DISABLED') $$,
  '…while the membership row itself stays visible to its owner as DISABLED, which is what lets the UI say why rather than showing an empty product'
);

select is(
  (select array_length(app_private.current_org_ids(), 1)),
  null,
  'current_org_ids returns the empty array: authorisation was withdrawn, not merely hidden by a view'
);

select is(
  (select count(*)::integer from api.profiles
    where user_id = '4a4a4a4a-0000-4000-8000-000000000001'),
  0,
  'threat 18: a disabled member immediately stops seeing colleagues'' profiles — the shared-company predicate is the same live state'
);

select results_eq(
  $$ select display_name from api.profiles $$,
  $$ values ('Lifecycle Member') $$,
  '…while still reading their own profile, which is the row the sign-in screen needs to name the state'
);

-- ---------------------------------------------------------------------------
-- Re-enabling is the same mechanism in reverse, and needs no new token
-- ---------------------------------------------------------------------------
reset role;
update app_data.memberships
   set status = 'ACTIVE'
 where organization_id = '4f4f4f4f-0000-4000-8000-00000000000a'
   and user_id = '4a4a4a4a-0000-4000-8000-000000000002';
set local role authenticated;

select is(
  (select count(*)::integer from api.organizations),
  1,
  're-enabling restores access on the next statement, with the same session and no new sign-in'
);

-- ---------------------------------------------------------------------------
-- A member cannot rewrite the row that decides what they may do
--
-- The absence of an UPDATE grant on `app_data.memberships` is what makes the
-- role system an authorisation model rather than a suggestion. There is no
-- statement a client can compose that reaches this table.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update app_data.memberships set role = 'OWNER'
      where user_id = '4a4a4a4a-0000-4000-8000-000000000002' $$,
  '42501',
  null,
  'a member cannot promote themselves: no UPDATE privilege on app_data.memberships exists to be policy-checked'
);

select throws_ok(
  $$ insert into app_data.memberships (organization_id, user_id, role, status)
     values ('4f4f4f4f-0000-4000-8000-00000000000a',
             '4a4a4a4a-0000-4000-8000-000000000002', 'OWNER', 'ACTIVE') $$,
  '42501',
  null,
  '…and cannot grant themselves a second membership either'
);

reset role;

select * from finish();
rollback;
