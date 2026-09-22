-- ===========================================================================
-- Phase 10 — Cloud Foundation, 4/7: RLS and grants
--
-- Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7.
--
-- Three independent layers, in this order, and each one alone would be enough
-- to make the mistake the other two catch survivable:
--
--   1 EXPOSURE  the canonical tables are in `app_data`, which PostgREST does
--               not serve. A table added here by a future phase has no route on
--               the day it is created and never acquires one by accident:
--               acquiring one means writing a view or a function IN `api`,
--               which is a visible, reviewable act.
--   2 GRANTS    `anon` receives no privilege on any business object anywhere.
--               `authenticated` receives exactly what the `api` layer needs it
--               to hold, named object by object, in this file. A table with no
--               grant block is unreachable even from `api`.
--   3 POLICIES  RLS is enabled AND FORCED on every table, so the table owner is
--               subject to it too and a SECURITY DEFINER function cannot
--               accidentally read across tenants through a table it forgot to
--               filter.
--
-- The `revoke` before every `grant` is not decoration. It removes whatever a
-- default left behind, so the grant that follows is the complete statement of
-- what the role holds rather than an addition to something unexamined.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- organizations — members read their own companies; nobody writes
--
-- There is no INSERT, UPDATE or DELETE grant and no policy for any of them.
-- Creating an organisation is an operator action during the pilot, renaming one
-- is Phase 12, and the `write_lock*` columns are Phase 21's restore RPC — so
-- every write path that does not exist yet is absent rather than open and
-- unused. `with check` clauses cannot be forgotten on policies that were never
-- written.
-- ---------------------------------------------------------------------------
alter table app_data.organizations enable row level security;
alter table app_data.organizations force  row level security;

revoke all on table app_data.organizations from public, anon, authenticated;
grant select on table app_data.organizations to authenticated;

create policy organizations_select on app_data.organizations
  for select to authenticated
  using (id = any ((select app_private.current_org_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- memberships — a user sees their own membership rows, and only those
--
-- This policy calls NO helper, and that is the load-bearing property of the
-- whole schema: `memberships` is the one table every helper reads, so a policy
-- here that called one would close the cycle PostgreSQL reports as 42P17 and
-- every query in the application would fail. Keeping it helper-free means the
-- recursion does not exist to be broken, rather than being broken by the
-- owner's BYPASSRLS attribute.
--
-- What a client actually needs from this table in Phase 10 is "which
-- organisations am I in, and as what" — which is exactly the caller's own rows.
-- Listing a colleague's role is the administration screen, which is Phase 12
-- and will reach it through a function that re-proves OWNER/ADMIN, not by
-- widening this policy.
--
-- No write grant: membership changes go through the provisioning RPCs, which
-- are SECURITY DEFINER and callable only by the Edge Function's role. A member
-- cannot promote themselves because there is no statement they can compose that
-- reaches this table.
-- ---------------------------------------------------------------------------
alter table app_data.memberships enable row level security;
alter table app_data.memberships force  row level security;

revoke all on table app_data.memberships from public, anon, authenticated;
grant select on table app_data.memberships to authenticated;

create policy memberships_select_own on app_data.memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- profiles — visible to colleagues, writable only by their owner
--
-- SELECT is two disjuncts and both are needed: a user must always be able to
-- read their own profile (including on the very first request, before any
-- membership exists, so the application can say "your account is not attached
-- to a company" rather than rendering nothing), and a user must be able to read
-- the display name of anyone they share an ACTIVE company with, because that is
-- what turns `updated_by` into a name on a screen.
--
-- UPDATE carries BOTH `using` and `with check`. `using` decides which rows may
-- be modified; without `with check` a user could take their own row and rewrite
-- `user_id` to someone else's — producing a row they can no longer see, sitting
-- on another person's identity. The second clause is the one that gets
-- forgotten, so it is on every UPDATE policy in this system, always.
--
-- The column-level restriction — that an update may change `display_name` and
-- `must_change_password` and nothing else — is not expressed here, because a
-- policy cannot express it. It is expressed by there being no route to this
-- table and exactly two RPCs that write it (§8).
-- ---------------------------------------------------------------------------
alter table app_data.profiles enable row level security;
alter table app_data.profiles force  row level security;

revoke all on table app_data.profiles from public, anon, authenticated;
grant select, update on table app_data.profiles to authenticated;

create policy profiles_select on app_data.profiles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select app_private.shares_active_organization(user_id))
  );

create policy profiles_update on app_data.profiles
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- provisioning_attempts — OWNER and ADMIN can see what they started
--
-- Readable rather than hidden for one concrete reason: §4 case E leaves an
-- attempt stuck `IN_FLIGHT` when the Edge Function dies between creating the
-- auth user and linking it. A stale attempt must be VISIBLE to an OWNER, who
-- clears it explicitly — never by a timeout, because a timeout is a rule a slow
-- run defeats at precisely the wrong moment.
--
-- A MEMBER sees nothing here: the table names e-mail addresses of people being
-- invited, which is administration, not shared business data.
-- ---------------------------------------------------------------------------
alter table app_data.provisioning_attempts enable row level security;
alter table app_data.provisioning_attempts force  row level security;

revoke all on table app_data.provisioning_attempts from public, anon, authenticated;
grant select on table app_data.provisioning_attempts to authenticated;

create policy provisioning_attempts_select on app_data.provisioning_attempts
  for select to authenticated
  using ((select app_private.has_org_role(organization_id, array['OWNER', 'ADMIN'])));

-- ---------------------------------------------------------------------------
-- admin_events — OWNER and ADMIN read; nobody writes through a policy
--
-- The append-only guarantee is stated three times, on purpose: no UPDATE or
-- DELETE grant, no UPDATE or DELETE policy, and a trigger that raises
-- unconditionally. The first two close every client path; the third closes the
-- path a future SECURITY DEFINER function would otherwise have.
-- ---------------------------------------------------------------------------
alter table app_data.admin_events enable row level security;
alter table app_data.admin_events force  row level security;

revoke all on table app_data.admin_events from public, anon, authenticated;
grant select on table app_data.admin_events to authenticated;

create policy admin_events_select on app_data.admin_events
  for select to authenticated
  using ((select app_private.has_org_role(organization_id, array['OWNER', 'ADMIN'])));

-- ---------------------------------------------------------------------------
-- counters — no client access of any kind
--
-- RLS enabled and forced with ZERO policies, which denies everything. For a
-- table a client must never reach that is the correct configuration rather than
-- an oversight: "RLS on, no policy" is a bug on a table the client needs and a
-- control on a table it does not, and the registry records which of the two
-- this is so the test suite can tell them apart.
-- ---------------------------------------------------------------------------
alter table app_data.counters enable row level security;
alter table app_data.counters force  row level security;

revoke all on table app_data.counters from public, anon, authenticated;
