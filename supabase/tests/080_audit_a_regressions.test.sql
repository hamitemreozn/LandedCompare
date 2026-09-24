-- ===========================================================================
-- Audit A remediation — the regressions Audit A reproduced, made to fail loudly
--
-- Every assertion below is executed by a real `authenticated` session through
-- the typed `api` RPCs, and each would have passed — or not existed — while the
-- defect it names was live:
--
--   A-M5  a stale write, and a stale lifecycle change, on EVERY catalogue entity
--         (only products were covered); update_customer's status assignability
--   A-L3  import_catalog accepting a JSON number or object as text, falling
--         through three-valued logic on a missing `active`, and a checksum the
--         function silently truncated
--   A-L4  required identifiers made only of invisible characters
--
-- `pg_temp.failure_of` runs one statement and reports `SQLSTATE:DETAIL`, so an
-- assertion names the EXACT refusal — not merely that something failed.
-- ===========================================================================

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(30);

create function pg_temp.failure_of(p_statement text)
returns text
language plpgsql
as $$
declare
  v_detail text;
begin
  execute p_statement;
  return 'NO ERROR';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlstate || ':' || coalesce(v_detail, '');
end $$;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '8a8a8a8a-0000-4000-8000-000000000001',
        'authenticated', 'authenticated', 'regression-owner@example.test', now(), now());
insert into app_data.organizations (id, name) values
  ('8f8f8f8f-0000-4000-8000-00000000000a', 'Regression Org A'),
  ('8f8f8f8f-0000-4000-8000-00000000000b', 'Regression Org B'),
  ('8f8f8f8f-0000-4000-8000-00000000000c', 'Regression Import Org');
insert into app_data.profiles (user_id, display_name)
values ('8a8a8a8a-0000-4000-8000-000000000001', 'Regression Owner');
insert into app_data.memberships (organization_id, user_id, role, status) values
  ('8f8f8f8f-0000-4000-8000-00000000000a', '8a8a8a8a-0000-4000-8000-000000000001', 'OWNER', 'ACTIVE'),
  ('8f8f8f8f-0000-4000-8000-00000000000c', '8a8a8a8a-0000-4000-8000-000000000001', 'OWNER', 'ACTIVE');
-- A status in organisation B, which the caller is NOT a member of.
insert into app_data.customer_statuses (id, organization_id, code)
values ('80000000-0000-4000-8000-0000000000b1', '8f8f8f8f-0000-4000-8000-00000000000b', 'FOREIGN');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"8a8a8a8a-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Fixtures, all at version 1.
select api.create_supplier('80000000-0000-4000-8000-000000000001', '8f8f8f8f-0000-4000-8000-00000000000a', 'Supplier', '0001', '');
select api.create_customer_status('80000000-0000-4000-8000-000000000002', '8f8f8f8f-0000-4000-8000-00000000000a', 'GOLD', 10);
select api.create_customer_status('80000000-0000-4000-8000-000000000003', '8f8f8f8f-0000-4000-8000-00000000000a', 'RETIRED', 20);
select api.create_customer('80000000-0000-4000-8000-000000000004', '8f8f8f8f-0000-4000-8000-00000000000a', 'Customer', '120-34-00-11-001', null, '');
select api.set_customer_status_active('80000000-0000-4000-8000-000000000003', '8f8f8f8f-0000-4000-8000-00000000000a', 1, false);

-- ---------------------------------------------------------------------------
-- A-M5 — stale update and stale lifecycle change, per entity
-- ---------------------------------------------------------------------------
select is(pg_temp.failure_of($$ select api.update_supplier('80000000-0000-4000-8000-000000000001', '8f8f8f8f-0000-4000-8000-00000000000a', 1, 'Supplier v2', '0001', '') $$),
  'NO ERROR', 'supplier: the first update with the version it read succeeds');
select is(pg_temp.failure_of($$ select api.update_supplier('80000000-0000-4000-8000-000000000001', '8f8f8f8f-0000-4000-8000-00000000000a', 1, 'Stale overwrite', '0001', '') $$),
  'P0001:STALE_WRITE', 'supplier: a second update carrying the old version is a STALE_WRITE');
select is(pg_temp.failure_of($$ select api.set_supplier_active('80000000-0000-4000-8000-000000000001', '8f8f8f8f-0000-4000-8000-00000000000a', 1, false) $$),
  'P0001:STALE_WRITE', 'supplier: a lifecycle change carrying the old version is a STALE_WRITE');
select is((select display_name || ' v' || version || ' active=' || active from api.suppliers where id = '80000000-0000-4000-8000-000000000001'),
  'Supplier v2 v2 active=true', 'supplier: the stale writes changed nothing and the version moved exactly once');

select is(pg_temp.failure_of($$ select api.update_customer('80000000-0000-4000-8000-000000000004', '8f8f8f8f-0000-4000-8000-00000000000a', 1, 'Customer v2', '120-34-00-11-001', null, '') $$),
  'NO ERROR', 'customer: the first update with the version it read succeeds');
select is(pg_temp.failure_of($$ select api.update_customer('80000000-0000-4000-8000-000000000004', '8f8f8f8f-0000-4000-8000-00000000000a', 1, 'Stale overwrite', '120-34-00-11-001', null, '') $$),
  'P0001:STALE_WRITE', 'customer: a second update carrying the old version is a STALE_WRITE');
select is(pg_temp.failure_of($$ select api.set_customer_active('80000000-0000-4000-8000-000000000004', '8f8f8f8f-0000-4000-8000-00000000000a', 1, false) $$),
  'P0001:STALE_WRITE', 'customer: a lifecycle change carrying the old version is a STALE_WRITE');

select is(pg_temp.failure_of($$ select api.update_customer_status('80000000-0000-4000-8000-000000000002', '8f8f8f8f-0000-4000-8000-00000000000a', 1, 'GOLD+', 11) $$),
  'NO ERROR', 'customer status: the first update with the version it read succeeds');
select is(pg_temp.failure_of($$ select api.update_customer_status('80000000-0000-4000-8000-000000000002', '8f8f8f8f-0000-4000-8000-00000000000a', 1, 'STALE', 12) $$),
  'P0001:STALE_WRITE', 'customer status: a second update carrying the old version is a STALE_WRITE');
select is(pg_temp.failure_of($$ select api.set_customer_status_active('80000000-0000-4000-8000-000000000002', '8f8f8f8f-0000-4000-8000-00000000000a', 1, false) $$),
  'P0001:STALE_WRITE', 'customer status: a lifecycle change carrying the old version is a STALE_WRITE');
select is(pg_temp.failure_of($$ select api.update_supplier('80000000-0000-4000-8000-000000000001', '8f8f8f8f-0000-4000-8000-00000000000a', null, 'x', '', '') $$),
  'P0001:STALE_WRITE', 'a NULL expected version never matches: it is refused, not treated as "any version"');

-- ---------------------------------------------------------------------------
-- A-M5 — update_customer cannot assign a status it may not assign
-- ---------------------------------------------------------------------------
select is(pg_temp.failure_of($$ select api.update_customer('80000000-0000-4000-8000-000000000004', '8f8f8f8f-0000-4000-8000-00000000000a', 2, 'Customer', '', '80000000-0000-4000-8000-000000000003', '') $$),
  'P0001:RECORD_INVALID', 'update_customer refuses a newly assigned INACTIVE status');
select is(pg_temp.failure_of($$ select api.update_customer('80000000-0000-4000-8000-000000000004', '8f8f8f8f-0000-4000-8000-00000000000a', 2, 'Customer', '', '80000000-0000-4000-8000-0000000000b1', '') $$),
  'P0001:RECORD_INVALID', 'update_customer refuses a status belonging to another organisation');
select is((select coalesce(customer_status_id::text, 'none') || ' v' || version from api.customers where id = '80000000-0000-4000-8000-000000000004'),
  'none v2', 'the refused assignments changed nothing');

-- ---------------------------------------------------------------------------
-- A-L4 — required identifiers must be visibly non-empty; opaque codes are not touched
-- ---------------------------------------------------------------------------
select is(pg_temp.failure_of(format($$ select api.create_product(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000a', %L, 'Name', '', 'PIECE', '', '', '', '', '') $$, U&'\200B')),
  '23514:', 'a zero-width-space SKU is refused by the table constraint');
select is(pg_temp.failure_of(format($$ select api.create_supplier(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000a', %L, '', '') $$, E'\t')),
  '23514:', 'a tab-only supplier name is refused');
select is(pg_temp.failure_of(format($$ select api.create_customer_status(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000a', %L, 1) $$, U&'\00A0')),
  '23514:', 'a no-break-space-only status code is refused');
select is((select external_ref from api.suppliers where id = '80000000-0000-4000-8000-000000000001'),
  '0001', 'an external system code keeps its leading zeros, exactly as entered');

-- ---------------------------------------------------------------------------
-- A-L3 — import_catalog validates JSON TYPES, NULL-safely, with an exact checksum
-- ---------------------------------------------------------------------------
select is(pg_temp.failure_of($$ select api.import_catalog(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000c', null, '[]', '[]', '[]') $$),
  'P0001:RECORD_INVALID', 'a missing checksum is refused before any work');
select is(pg_temp.failure_of($$ select api.import_catalog(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000c', repeat('a', 200), '[]', '[]', '[]') $$),
  'P0001:RECORD_INVALID', 'a checksum that is not a hex SHA-256 is refused rather than truncated');
select is(pg_temp.failure_of($$ select api.import_catalog(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000c', repeat('a', 64),
    '[{"id":"80000000-0000-4000-8000-0000000000c1","sku":12345,"name":"N","stockUnit":"PIECE","active":true,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]', '[]', '[]') $$),
  'P0001:RECORD_INVALID', 'a JSON number where a string belongs is refused, not coerced to text');
select is(pg_temp.failure_of($$ select api.import_catalog(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000c', repeat('a', 64),
    '[{"id":"80000000-0000-4000-8000-0000000000c1","sku":"S","name":{"evil":true},"stockUnit":"PIECE","active":true,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]', '[]', '[]') $$),
  'P0001:RECORD_INVALID', 'a JSON object where a string belongs is refused, not coerced to text');
select is(pg_temp.failure_of($$ select api.import_catalog(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000c', repeat('a', 64),
    '[]', '[{"id":"80000000-0000-4000-8000-0000000000c2","displayName":"No active flag","createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]', '[]') $$),
  'P0001:RECORD_INVALID', 'a missing active flag is an explicit refusal, not a NOT NULL violation');
select is(pg_temp.failure_of($$ select api.import_catalog(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000c', repeat('a', 64),
    '[{"id":"80000000-0000-4000-8000-0000000000c1","sku":"S","name":"N","stockUnit":"PIECE","unitsPerPurchaseUnit":5,"active":true,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]', '[]', '[]') $$),
  'P0001:RECORD_INVALID', 'a scalar where the decimal object belongs is refused, not a jsonb function error');
select is(pg_temp.failure_of($$ select api.import_catalog(gen_random_uuid(), '8f8f8f8f-0000-4000-8000-00000000000c', repeat('a', 64),
    '[]', '[]', '[{"id":"80000000-0000-4000-8000-0000000000c3","displayName":"C","externalRef":null,"active":true,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]') $$),
  'P0001:RECORD_INVALID', 'a JSON null optional field is refused: a legacy record omits absent fields');
select is((select count(*)::integer from api.products where organization_id = '8f8f8f8f-0000-4000-8000-00000000000c')
        + (select count(*)::integer from api.suppliers where organization_id = '8f8f8f8f-0000-4000-8000-00000000000c')
        + (select count(*)::integer from api.customers where organization_id = '8f8f8f8f-0000-4000-8000-00000000000c'),
  0, 'every refused import left nothing behind');

select is(
  api.import_catalog('80000000-0000-4000-8000-0000000000d1', '8f8f8f8f-0000-4000-8000-00000000000c', repeat('b', 64),
    '[{"id":"80000000-0000-4000-8000-0000000000c1","sku":"0001","name":"Imported","stockUnit":"PIECE","unitsPerPurchaseUnit":{"value":"12345678901234567890.0047"},"active":false,"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}]',
    '[]', '[]'),
  '{"products": 1, "suppliers": 0, "customers": 0}'::jsonb,
  'a well-typed import commits');
select is(
  api.import_catalog('80000000-0000-4000-8000-0000000000d1', '8f8f8f8f-0000-4000-8000-00000000000c', repeat('b', 64), '[]', '[]', '[]'),
  '{"products": 1, "suppliers": 0, "customers": 0}'::jsonb,
  'a retry of the same request with the same checksum returns the stored outcome');
select is(pg_temp.failure_of($$ select api.import_catalog('80000000-0000-4000-8000-0000000000d1', '8f8f8f8f-0000-4000-8000-00000000000c', repeat('c', 64), '[]', '[]', '[]') $$),
  'P0001:DUPLICATE_KEY', 'the same request with a different checksum is refused');
select is((select sku || ' ' || units_per_purchase_unit || ' active=' || active from api.products where id = '80000000-0000-4000-8000-0000000000c1'),
  '0001 12345678901234567890.0047 active=false', 'the import kept the exact decimal, the literal SKU and the inactive flag');

reset role;
select * from finish();
rollback;
