-- ===========================================================================
-- Phase 10 security suite, 5/6 — provisioning idempotency and authority
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4, including the five
-- failure cases A–E; threat model 19 and 24.
--
-- What is being tested here is the DATABASE half of a workflow that spans a
-- boundary no transaction covers. `auth.admin.createUser()` is an HTTP call and
-- these are PostgreSQL writes; they do not commit together, and the whole point
-- of `provisioning_attempts` is that running the workflow twice converges on
-- one valid final state instead of producing a second one.
--
-- The Edge Function's own end-to-end behaviour — that it authorises before
-- touching the Auth Admin API, and that it deletes ONLY an auth user the same
-- attempt created — is exercised over HTTP in
-- `src/cloud/security/provisioning.security.test.ts`. Neither suite is
-- sufficient alone: this one cannot create an auth user, and that one cannot
-- see whether four writes committed together.
--
-- ---------------------------------------------------------------------------
-- Why this file switches roles constantly
--
-- The RPCs run as `service_role`, which is the Edge Function's identity. The
-- verification queries CANNOT run as `service_role`, because it holds no USAGE
-- on `app_data` and no privilege on any table there — which is the posture on
-- purpose (§7): the most dangerous credential in the system can execute five
-- named functions and cannot compose a single statement against a business
-- table. So each call is made as `service_role` and each assertion about what
-- it wrote is made as the owner. The interleaving is noise; the reason for it
-- is a control.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(23);

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '5a5a5a5a-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'prov-owner@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5a5a5a5a-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'prov-admin@example.test',    now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5a5a5a5a-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'prov-member@example.test',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5a5a5a5a-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'prov-new@example.test',      now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5b5b5b5b-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'prov-outsider@example.test', now(), now());

insert into app_data.organizations (id, name) values
  ('5f5f5f5f-0000-4000-8000-00000000000a', 'Provisioning Org A'),
  ('5f5f5f5f-0000-4000-8000-00000000000b', 'Provisioning Org B');

insert into app_data.profiles (user_id, display_name) values
  ('5a5a5a5a-0000-4000-8000-000000000001', 'Prov Owner'),
  ('5a5a5a5a-0000-4000-8000-000000000002', 'Prov Admin'),
  ('5a5a5a5a-0000-4000-8000-000000000003', 'Prov Member'),
  ('5b5b5b5b-0000-4000-8000-000000000001', 'Prov Outsider');

insert into app_data.memberships (organization_id, user_id, role, status) values
  ('5f5f5f5f-0000-4000-8000-00000000000a', '5a5a5a5a-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE'),
  ('5f5f5f5f-0000-4000-8000-00000000000a', '5a5a5a5a-0000-4000-8000-000000000002', 'ADMIN',  'ACTIVE'),
  ('5f5f5f5f-0000-4000-8000-00000000000a', '5a5a5a5a-0000-4000-8000-000000000003', 'MEMBER', 'ACTIVE'),
  ('5f5f5f5f-0000-4000-8000-00000000000b', '5b5b5b5b-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE');

-- ===========================================================================
-- Authority, re-proved by the database rather than taken on trust
--
-- The Edge Function verifies the caller's JWT and their OWNER/ADMIN membership
-- before it reaches here. These functions verify it again, because a control
-- that exists in exactly one place is a control a rewrite of that place removes
-- without anybody noticing.
-- ===========================================================================
set local role service_role;

select throws_ok(
  $$ select api.begin_provisioning(
       '50000000-0000-4000-8000-000000000001',
       '5f5f5f5f-0000-4000-8000-00000000000a',
       'victim@example.test', 'MEMBER',
       '5a5a5a5a-0000-4000-8000-000000000003') $$,
  '42501',
  null,
  'a MEMBER named as the actor cannot provision — the role is read from memberships, not from the request'
);

select throws_ok(
  $$ select api.begin_provisioning(
       '50000000-0000-4000-8000-000000000002',
       '5f5f5f5f-0000-4000-8000-00000000000a',
       'victim@example.test', 'MEMBER',
       '5b5b5b5b-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'threat 19: an OWNER of ANOTHER organisation cannot provision into this one'
);

select throws_ok(
  $$ select api.begin_provisioning(
       '50000000-0000-4000-8000-000000000003',
       '5f5f5f5f-0000-4000-8000-00000000000a',
       'escalate@example.test', 'OWNER',
       '5a5a5a5a-0000-4000-8000-000000000002') $$,
  '42501',
  null,
  'an ADMIN cannot mint an OWNER — otherwise "invite" is a route to the one capability ADMIN is denied'
);

select throws_ok(
  $$ select api.begin_provisioning(
       '50000000-0000-4000-8000-000000000004',
       '5f5f5f5f-0000-4000-8000-00000000000a',
       'not-an-email', 'MEMBER',
       '5a5a5a5a-0000-4000-8000-000000000001') $$,
  'P0001',
  null,
  'a malformed address is refused before an attempt row exists'
);

reset role;
-- Scoped to the four request_ids just attempted, NOT a count of the whole
-- table. The property is "none of THOSE refusals left an attempt behind", and a
-- global count says something else: it says the table is empty, which is only
-- true if nothing else has ever run. The HTTP suite leaves attempts behind by
-- design, so a global count here turns `npm run test:security && npm run
-- db:test` into a failure that reports an idempotency defect and means
-- "something else used the database first".
select is(
  (select count(*)::integer from app_data.provisioning_attempts a
    where a.request_id in (
      '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000004'
    )),
  0,
  'not one of those refusals left an attempt behind'
);

-- ===========================================================================
-- The normal path: claim, then link, in one transaction
-- ===========================================================================
set local role service_role;
select is(
  (select api.begin_provisioning(
     '51000000-0000-4000-8000-000000000001',
     '5f5f5f5f-0000-4000-8000-00000000000a',
     '  Prov-New@Example.Test  ', 'MEMBER',
     '5a5a5a5a-0000-4000-8000-000000000001') ->> 'status'),
  'CLAIMED',
  'a first call with a fresh request_id claims the attempt'
);

reset role;
select results_eq(
  $$ select email, status from app_data.provisioning_attempts
      where request_id = '51000000-0000-4000-8000-000000000001' $$,
  $$ values ('prov-new@example.test', 'IN_FLIGHT') $$,
  'the address is normalised on the way in, so case and whitespace cannot create two attempts for one person'
);

-- ---------------------------------------------------------------------------
-- CASE E — the Edge Function died between creating the auth user and linking it
--
-- A retry with the SAME request_id is refused as BUSY rather than raced. Two
-- concurrent runs of the create step is exactly how a duplicate auth user
-- appears, and "the first one is probably dead by now" is a guess.
-- ---------------------------------------------------------------------------
set local role service_role;
select is(
  (select api.begin_provisioning(
     '51000000-0000-4000-8000-000000000001',
     '5f5f5f5f-0000-4000-8000-00000000000a',
     'prov-new@example.test', 'MEMBER',
     '5a5a5a5a-0000-4000-8000-000000000001') ->> 'status'),
  'BUSY',
  'case E: retrying an IN_FLIGHT attempt with the same request_id is refused, not raced'
);

-- A request_id is a claim on one specific invitation. Reusing it for somebody
-- else would make the idempotency record lie about what converged.
select throws_ok(
  $$ select api.begin_provisioning(
       '51000000-0000-4000-8000-000000000001',
       '5f5f5f5f-0000-4000-8000-00000000000a',
       'someone-else@example.test', 'MEMBER',
       '5a5a5a5a-0000-4000-8000-000000000001') $$,
  'P0001',
  null,
  'a request_id cannot be reused for a different address'
);

-- ---------------------------------------------------------------------------
-- Link, transactionally: profile + membership + admin event + attempt status
-- ---------------------------------------------------------------------------
select is(
  (select api.complete_provisioning(
     '51000000-0000-4000-8000-000000000001',
     '5a5a5a5a-0000-4000-8000-000000000004',
     'Prov New', true) ->> 'status'),
  'SUCCEEDED',
  'complete_provisioning links the auth user to a profile and a membership'
);

reset role;
select results_eq(
  $$ select
       (select count(*)::integer from app_data.profiles
         where user_id = '5a5a5a5a-0000-4000-8000-000000000004'),
       (select count(*)::integer from app_data.memberships
         where user_id = '5a5a5a5a-0000-4000-8000-000000000004'
           and organization_id = '5f5f5f5f-0000-4000-8000-00000000000a'
           and role = 'MEMBER' and status = 'ACTIVE'),
       (select count(*)::integer from app_data.admin_events
         where subject_user_id = '5a5a5a5a-0000-4000-8000-000000000004'
           and event_type = 'MEMBER_PROVISIONED'),
       (select count(*)::integer from app_data.provisioning_attempts
         where request_id = '51000000-0000-4000-8000-000000000001' and status = 'SUCCEEDED') $$,
  $$ values (1, 1, 1, 1) $$,
  'all four writes are present — profile, membership, admin event and attempt status committed together'
);

select ok(
  (select must_change_password from app_data.profiles
    where user_id = '5a5a5a5a-0000-4000-8000-000000000004'),
  'an account THIS attempt created is flagged for a forced password change'
);

select is(
  (select created_by from app_data.profiles
    where user_id = '5a5a5a5a-0000-4000-8000-000000000004'),
  '5a5a5a5a-0000-4000-8000-000000000001'::uuid,
  'the stamping trigger attributes the row to the administrator, even though auth.uid() is null for service_role'
);

-- ---------------------------------------------------------------------------
-- CASE B — the request timed out after it had actually succeeded, and the
-- administrator pressed the button again with the same request_id
-- ---------------------------------------------------------------------------
set local role service_role;
select is(
  (select api.begin_provisioning(
     '51000000-0000-4000-8000-000000000001',
     '5f5f5f5f-0000-4000-8000-00000000000a',
     'prov-new@example.test', 'MEMBER',
     '5a5a5a5a-0000-4000-8000-000000000001') ->> 'status'),
  'ALREADY_SUCCEEDED',
  'case B: a retry after success returns the stored outcome and creates nothing'
);

reset role;
select is(
  (select count(*)::integer from app_data.admin_events
    where subject_user_id = '5a5a5a5a-0000-4000-8000-000000000004'),
  1,
  'case B: …and writes no second admin event, which is how a duplicate would show up'
);

-- ---------------------------------------------------------------------------
-- CASE C and D — the account already exists, and its membership was disabled
--
-- Re-inviting a disabled colleague is the same operation as inviting them,
-- which is what an administrator expects from pressing the same button. A NEW
-- request_id is required, because the old one has an outcome; `on conflict do
-- update` then sets the role and re-activates rather than duplicating.
-- ---------------------------------------------------------------------------
update app_data.memberships set status = 'DISABLED'
 where user_id = '5a5a5a5a-0000-4000-8000-000000000004';

-- The colleague has since signed in and chosen their own password, so the
-- forced-change flag is down. What happens to it during a re-invitation is the
-- observable difference between "linked" and "re-credentialled".
update app_data.profiles set must_change_password = false
 where user_id = '5a5a5a5a-0000-4000-8000-000000000004';

set local role service_role;
select is(
  (select api.begin_provisioning(
     '52000000-0000-4000-8000-000000000001',
     '5f5f5f5f-0000-4000-8000-00000000000a',
     'prov-new@example.test', 'ADMIN',
     '5a5a5a5a-0000-4000-8000-000000000001') ->> 'status'),
  'CLAIMED',
  'case C: a new request_id for an EXISTING account is claimed rather than refused'
);

select is(
  (select api.complete_provisioning(
     '52000000-0000-4000-8000-000000000001',
     '5a5a5a5a-0000-4000-8000-000000000004',
     'Prov New', false) ->> 'status'),
  'SUCCEEDED',
  'case C: …and linked, with created_here = false because this attempt did not create the account'
);

reset role;
select results_eq(
  $$ select role, status from app_data.memberships
      where user_id = '5a5a5a5a-0000-4000-8000-000000000004' $$,
  $$ values ('ADMIN', 'ACTIVE') $$,
  'case D: the membership is re-activated and re-roled instead of duplicated'
);

select ok(
  not (select must_change_password from app_data.profiles
        where user_id = '5a5a5a5a-0000-4000-8000-000000000004'),
  'case C: linking an existing account leaves the forced-change flag alone — the account was not re-credentialled, so demanding a change would be a lie about a password the colleague still holds'
);

-- ---------------------------------------------------------------------------
-- CASE A — the link failed and the Edge Function compensated
--
-- `fail_provisioning` records the outcome and deletes nothing: the thing that
-- may need deleting is an auth user, which lives behind an HTTP API this
-- database cannot call. Each side does what it can actually do.
-- ---------------------------------------------------------------------------
set local role service_role;
select lives_ok(
  $$ select api.begin_provisioning(
       '53000000-0000-4000-8000-000000000001',
       '5f5f5f5f-0000-4000-8000-00000000000a',
       'doomed@example.test', 'MEMBER',
       '5a5a5a5a-0000-4000-8000-000000000001') $$,
  'case A: an attempt is claimed'
);

select is(
  (select api.fail_provisioning(
     '53000000-0000-4000-8000-000000000001', 'AUTH_CREATE_FAILED') ->> 'status'),
  'FAILED',
  'case A: the attempt is marked FAILED after the Edge Function has compensated'
);

select is(
  (select api.begin_provisioning(
     '53000000-0000-4000-8000-000000000001',
     '5f5f5f5f-0000-4000-8000-00000000000a',
     'doomed@example.test', 'MEMBER',
     '5a5a5a5a-0000-4000-8000-000000000001') ->> 'status'),
  'CLAIMED',
  'case A: …and the same request_id may then be retried, because a compensated attempt left nothing behind'
);

reset role;

-- ---------------------------------------------------------------------------
-- These RPCs are in `api`, which means they have an HTTP route. A signed-in
-- user hitting that route is refused by PRIVILEGE, not by the function choosing
-- to be polite about who called it.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"5a5a5a5a-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok(
  $$ select api.begin_provisioning(
       '54000000-0000-4000-8000-000000000001',
       '5f5f5f5f-0000-4000-8000-00000000000a',
       'self-invited@example.test', 'OWNER',
       '5a5a5a5a-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'even an OWNER''s own session cannot call the provisioning RPCs — EXECUTE is granted to service_role alone'
);

reset role;

select * from finish();
rollback;
