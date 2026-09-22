-- ===========================================================================
-- Phase 10 security suite, 6/6 — server-owned fields, append-only history,
-- the restore write gate, and the own-profile RPC
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §8, §9, §16, §21;
-- threat model 8, 9, 9b and 22.
--
-- The write gate is the only Phase 10 mechanism built for a phase that has not
-- happened. Phase 21 owns the restore that acquires and releases it; what is
-- built here is the ENFORCEMENT — the columns, the helper and the trigger —
-- because Phase 11 attaches that trigger to every business table it creates,
-- and a gate designed after the tables it must gate is a migration over live
-- company data.
--
-- So it is tested now, exhaustively, against the one organisation-scoped table
-- Phase 10 has. The case that matters most is threat 22, and it is the one an
-- earlier design got wrong: the person running a restore is an OWNER, and so is
-- the browser tab they left open on another screen.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(16);

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '6a6a6a6a-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'gate-owner@example.test',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', '6a6a6a6a-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'gate-member@example.test', now(), now());

insert into app_data.organizations (id, name) values
  ('6f6f6f6f-0000-4000-8000-00000000000a', 'Gate Org A'),
  ('6f6f6f6f-0000-4000-8000-00000000000b', 'Gate Org B');

insert into app_data.profiles (user_id, display_name) values
  ('6a6a6a6a-0000-4000-8000-000000000001', 'Gate Owner'),
  ('6a6a6a6a-0000-4000-8000-000000000002', 'Gate Member');

insert into app_data.memberships (organization_id, user_id, role, status) values
  ('6f6f6f6f-0000-4000-8000-00000000000a', '6a6a6a6a-0000-4000-8000-000000000001', 'OWNER',  'ACTIVE'),
  ('6f6f6f6f-0000-4000-8000-00000000000a', '6a6a6a6a-0000-4000-8000-000000000002', 'MEMBER', 'ACTIVE');

-- ===========================================================================
-- The write gate
-- ===========================================================================

select lives_ok(
  $$ insert into app_data.counters (organization_id, key, next_value)
     values ('6f6f6f6f-0000-4000-8000-00000000000a', 'PURCHASE_ORDER', 1) $$,
  'with no gate held, an organisation-scoped write proceeds normally'
);

-- The gate is acquired. In Phase 21 this happens in TX1, a SHORT transaction
-- that COMMITS before the destructive one begins — which is the entire reason
-- it is three transactions and not one flag. A flag set inside the destructive
-- transaction is invisible to every other transaction until it commits, so for
-- the whole duration of the restore, the only time the gate matters, it would
-- not be there.
update app_data.organizations
   set write_locked_at = now(),
       write_locked_by = '6a6a6a6a-0000-4000-8000-000000000001',
       write_lock_reason = 'RESTORE'
 where id = '6f6f6f6f-0000-4000-8000-00000000000a';

-- Sessions below are identified by their JWT subject, which is what
-- `assert_write_allowed` reads.
select set_config('request.jwt.claims',
  '{"sub":"6a6a6a6a-0000-4000-8000-000000000002","role":"authenticated"}', true);

select throws_ok(
  $$ update app_data.counters set next_value = 2
      where organization_id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  '55006',
  null,
  'an ordinary member''s write is refused while the gate is held'
);

-- THREAT 22 — the case an earlier design got wrong.
--
-- The lock holder is an OWNER. So is every other session that OWNER has open.
-- A role exemption would have let the one user guaranteed to be active during a
-- restore write straight through it.
select set_config('request.jwt.claims',
  '{"sub":"6a6a6a6a-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok(
  $$ update app_data.counters set next_value = 2
      where organization_id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  '55006',
  null,
  'threat 22: the LOCK HOLDER''S OWN second session is refused — being the holder is necessary and not sufficient'
);

-- The restore's own transaction satisfies both conditions. `is_local = true`
-- means this setting exists for this transaction and nowhere else, and nothing
-- a client can send through PostgREST sets it.
select set_config('app.restore_in_progress', '6f6f6f6f-0000-4000-8000-00000000000a', true);

select lives_ok(
  $$ update app_data.counters set next_value = 3
      where organization_id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  'the restore''s own transaction — holder AND app.restore_in_progress — writes through the gate'
);

-- A different organisation's restore does not unlock this one.
select set_config('app.restore_in_progress', '6f6f6f6f-0000-4000-8000-00000000000b', true);

select throws_ok(
  $$ update app_data.counters set next_value = 4
      where organization_id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  '55006',
  null,
  'the exemption names ONE organisation: a restore of another company does not open this one''s gate'
);

-- The non-holder cannot borrow the exemption by guessing the setting, because
-- setting it is not something a client can do — and even if it were, the holder
-- condition still fails.
select set_config('app.restore_in_progress', '6f6f6f6f-0000-4000-8000-00000000000a', true);
select set_config('request.jwt.claims',
  '{"sub":"6a6a6a6a-0000-4000-8000-000000000002","role":"authenticated"}', true);

select throws_ok(
  $$ update app_data.counters set next_value = 5
      where organization_id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  '55006',
  null,
  'both conditions are required: the restore marker alone, held by a non-holder, opens nothing'
);

-- Releasing is TX3. The data is whatever the restore committed; the gate simply
-- stops being held. A stuck gate is released explicitly by an OWNER and NEVER
-- by a timeout — a lock a slow restore outlives is a lock that releases while
-- the data is half-replaced.
select set_config('app.restore_in_progress', '', true);
update app_data.organizations
   set write_locked_at = null, write_locked_by = null, write_lock_reason = null
 where id = '6f6f6f6f-0000-4000-8000-00000000000a';

select lives_ok(
  $$ update app_data.counters set next_value = 6
      where organization_id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  'releasing the gate restores normal writes'
);

-- A half-set gate would make "is this organisation locked?" a question with two
-- answers, and the trigger asks it on every write.
select throws_ok(
  $$ update app_data.organizations set write_locked_at = now()
      where id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  '23514',
  null,
  'a gate cannot be half-set: a timestamp with no holder is refused by a check constraint'
);

-- ===========================================================================
-- Append-only history
-- ===========================================================================

insert into app_data.admin_events (organization_id, event_type, actor_user_id, subject_user_id, details)
values ('6f6f6f6f-0000-4000-8000-00000000000a', 'MEMBER_PROVISIONED',
        '6a6a6a6a-0000-4000-8000-000000000001', '6a6a6a6a-0000-4000-8000-000000000002',
        '{"role":"MEMBER"}');

-- Running as the OWNER of the tables, which is the case the grants and policies
-- cannot cover. A SECURITY DEFINER function written in a future phase runs like
-- this, and would otherwise be able to edit history.
select throws_ok(
  $$ update app_data.admin_events set event_type = 'MEMBER_DISABLED' $$,
  '42501',
  null,
  'an admin event cannot be edited even by the table owner — the guarantee is structural, not a grant'
);

select throws_ok(
  $$ delete from app_data.admin_events $$,
  '42501',
  null,
  '…and cannot be deleted either'
);

-- ===========================================================================
-- Tenant immutability
-- ===========================================================================

select throws_ok(
  $$ update app_data.counters
        set organization_id = '6f6f6f6f-0000-4000-8000-00000000000b'
      where organization_id = '6f6f6f6f-0000-4000-8000-00000000000a' $$,
  '42501',
  null,
  'a row cannot change organisation — the with_check stops a move INTO a foreign tenant, this stops the move at all'
);

-- ===========================================================================
-- api.update_own_profile — the version predicate is not a clause the client
-- can omit, because the client does not write the statement
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"6a6a6a6a-0000-4000-8000-000000000002","role":"authenticated"}', true);

select results_eq(
  $$ select display_name, version from api.update_own_profile('Gate Member Renamed', 1) $$,
  $$ values ('Gate Member Renamed', 2) $$,
  'update_own_profile writes the name and the trigger increments the version'
);

select throws_ok(
  $$ select api.update_own_profile('Renamed Again', 1) $$,
  'P0001',
  'stale write or missing profile',
  'threat 9: the same expected_version a second time is refused as a stale write, not silently applied'
);

select throws_ok(
  $$ select api.update_own_profile('   ', 3) $$,
  'P0001',
  'display name is required',
  'a blank display name is refused by the RPC rather than stored'
);

-- There is no path by which one user renames another. The policy is
-- `user_id = auth.uid()` and the RPC does not take a user id at all, so the
-- parameter that would carry the attack does not exist.
select is(
  (select display_name from api.profiles
    where user_id = '6a6a6a6a-0000-4000-8000-000000000001'),
  'Gate Owner',
  'the colleague''s profile is untouched — update_own_profile has no parameter naming a subject'
);

-- And a direct UPDATE at the table changes nothing. Note the SHAPE of the
-- refusal: the `using` clause matches no row, so PostgreSQL reports success
-- with zero rows affected rather than raising. That is the correct behaviour
-- and it is also precisely why every mutation goes through an RPC: a client
-- composing its own statement could not tell this apart from a successful
-- write, whereas `api.update_own_profile` turns zero rows into a raised
-- STALE_WRITE the gateway can map to a sentence.
with attempted as (
  update app_data.profiles set display_name = 'Hijacked'
   where user_id = '6a6a6a6a-0000-4000-8000-000000000001'
  returning 1
)
select is(
  (select count(*)::integer from attempted),
  0,
  'a direct UPDATE against a colleague''s profile row affects nothing — the policy makes it invisible to the statement'
);

reset role;

select * from finish();
rollback;
