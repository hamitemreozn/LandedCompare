-- Phase 11 catalogue schema, exact-number boundary and mutation behaviour.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, pg_catalog, public;

select plan(35);

select has_table('app_data', 'products', 'catalog has canonical products');
select has_table('app_data', 'suppliers', 'catalog has canonical suppliers');
select has_table('app_data', 'customers', 'catalog has canonical customers');
select has_table('app_data', 'customer_statuses', 'customer statuses are configurable rows, not an enum');

select has_view('api', 'products', 'products are read through api');
select has_view('api', 'suppliers', 'suppliers are read through api');
select has_view('api', 'customers', 'customers are read through api');
select has_view('api', 'customer_statuses', 'customer statuses are read through api');

select col_type_is('api', 'products', 'units_per_purchase_unit', 'text', 'api decimal is text');
select col_type_is('app_data', 'products', 'units_per_purchase_unit', 'numeric', 'canonical decimal is numeric');
select col_type_is('app_data', 'suppliers', 'external_ref', 'text', 'supplier external reference is opaque text');
select col_type_is('app_data', 'customers', 'external_ref', 'text', 'customer external reference is opaque text');
select has_fk('app_data', 'customers', 'customer status relationship is a foreign key');

select is_empty($$
  select table_name from app_private.managed_table
  where table_name in ('products','suppliers','customers','customer_statuses')
    and policy_class <> 'TENANT_EDITABLE'
$$, 'all catalogue tables declare the editable tenant policy class');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app_data' and c.relname in ('products','suppliers','customers','customer_statuses')
    and not (c.relrowsecurity and c.relforcerowsecurity)
$$, 'all catalogue tables enable and force RLS');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'api' and c.relname in ('products','suppliers','customers','customer_statuses')
    and coalesce(array_position(c.reloptions, 'security_invoker=on'), 0) = 0
$$, 'all catalogue views are security invoker');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname = 'app_data' and c.relname in ('products','suppliers','customers','customer_statuses')
    and a.grantee in ('authenticated'::regrole, 'anon'::regrole)
    and upper(a.privilege_type) = 'DELETE'
$$, 'catalogue rows cannot be deleted by a client');

select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname in (
     'create_product','update_product','set_product_active',
     'create_supplier','update_supplier','set_supplier_active',
     'create_customer','update_customer','set_customer_active',
     'create_customer_status','update_customer_status','set_customer_status_active','import_catalog'
   )),
  13,
  'all twelve typed catalogue mutations and the one-time import RPC exist'
);

select ok(
  (select not p.prosecdef
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname = 'import_catalog'),
  'the authenticated catalogue import runs with invoker privileges'
);

select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'app_data'
      and tablename = 'admin_events'
      and policyname = 'admin_events_catalog_import_insert'
      and cmd = 'INSERT'
      and roles = array['authenticated']::name[]
  ),
  'the catalogue import has one named authenticated audit insert policy'
);

select is(
  app_private.catalog_decimal('12345678901234567890.0047')::text,
  '12345678901234567890.0047',
  'hostile precision survives server parsing exactly'
);

select throws_ok(
  $$ select app_private.catalog_decimal('1,5') $$,
  'P0001',
  'invalid positive canonical decimal',
  'locale-formatted decimals are refused at the server boundary'
);

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '7a7a7a7a-0000-4000-8000-000000000001',
        'authenticated', 'authenticated', 'catalog-owner@example.test', now(), now());
insert into app_data.organizations (id, name) values
  ('7f7f7f7f-0000-4000-8000-00000000000a', 'Catalog Org A'),
  ('7f7f7f7f-0000-4000-8000-00000000000b', 'Catalog Org B');

select is(
  (select count(*)::integer from app_data.customer_statuses
   where organization_id = '7f7f7f7f-0000-4000-8000-00000000000a'),
  0,
  'a new organization starts with no customer statuses'
);

-- Org B must actually HOLD a product, or "A cannot see B's catalogue" is
-- vacuously true — the Audit A finding (A-M5) against the earlier version of
-- the last assertion in this file, which counted an empty organisation.
insert into app_data.products (id, organization_id, sku, name, stock_unit)
values ('70000000-0000-4000-8000-0000000000b1', '7f7f7f7f-0000-4000-8000-00000000000b', 'B-ONLY', 'Org B product', 'PIECE');

select is(
  (select count(*)::integer from app_data.products
    where organization_id = '7f7f7f7f-0000-4000-8000-00000000000b'),
  1,
  'fixture: organisation B really holds a product, so the isolation assertion below can fail'
);

insert into app_data.profiles (user_id, display_name)
values ('7a7a7a7a-0000-4000-8000-000000000001', 'Catalog Owner');
insert into app_data.memberships (organization_id, user_id, role, status)
values ('7f7f7f7f-0000-4000-8000-00000000000a', '7a7a7a7a-0000-4000-8000-000000000001', 'OWNER', 'ACTIVE');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"7a7a7a7a-0000-4000-8000-000000000001","role":"authenticated"}', true);

select results_eq(
  $$ select code, sort_order from (
       select code, sort_order from api.create_customer_status(
         '70000000-0000-4000-8000-000000000011',
         '7f7f7f7f-0000-4000-8000-00000000000a', 'C', 10)
       union all
       select code, sort_order from api.create_customer_status(
         '70000000-0000-4000-8000-000000000012',
         '7f7f7f7f-0000-4000-8000-00000000000a', 'A', 20)
       union all
       select code, sort_order from api.create_customer_status(
         '70000000-0000-4000-8000-000000000013',
         '7f7f7f7f-0000-4000-8000-00000000000a', 'A+', 30)
       union all
       select code, sort_order from api.create_customer_status(
         '70000000-0000-4000-8000-000000000014',
         '7f7f7f7f-0000-4000-8000-00000000000a', 'A++', 40)
     ) created order by sort_order $$,
  $$ values ('C'::text, 10), ('A'::text, 20), ('A+'::text, 30), ('A++'::text, 40) $$,
  'C, A, A+ and A++ are valid organization-created statuses, not product defaults'
);

select results_eq(
  $$ select sku, units_per_purchase_unit, version
       from api.create_product(
         '70000000-0000-4000-8000-000000000001',
         '7f7f7f7f-0000-4000-8000-00000000000a',
         'EXACT-1', 'Exact product', '', 'PIECE', 'BOX',
         '12345678901234567890.0047', '', '', '') $$,
  $$ values ('EXACT-1'::text, '12345678901234567890.0047'::text, 1) $$,
  'create_product returns the exact decimal text and initial version'
);

select is(
  (select pg_typeof(units_per_purchase_unit)::text from api.products where sku = 'EXACT-1'),
  'text',
  'the runtime product route exposes the decimal as text'
);

select matches(
  (select created_at from api.products where sku = 'EXACT-1'),
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$',
  'catalogue timestamps use the canonical millisecond UTC wire format'
);

select throws_ok(
  $$ select api.create_product(
       '70000000-0000-4000-8000-000000000002',
       '7f7f7f7f-0000-4000-8000-00000000000a',
       ' exact-1 ', 'Duplicate', '', 'PIECE', '', '', '', '', '') $$,
  '23505', null,
  'SKU uniqueness is tenant-local, trimmed and case-insensitive'
);

select results_eq(
  $$ select name, version from api.update_product(
       '70000000-0000-4000-8000-000000000001',
       '7f7f7f7f-0000-4000-8000-00000000000a', 1,
       'EXACT-1', 'Updated product', '', 'PIECE', 'BOX',
       '12345678901234567890.0047', '', '', '') $$,
  $$ values ('Updated product'::text, 2) $$,
  'an update requires and increments the optimistic version'
);

select throws_ok(
  $$ select api.update_product(
       '70000000-0000-4000-8000-000000000001',
       '7f7f7f7f-0000-4000-8000-00000000000a', 1,
       'EXACT-1', 'Stale overwrite', '', 'PIECE', 'BOX', '1', '', '', '') $$,
  'P0001', 'stale product',
  'a second session cannot overwrite a newer product version'
);

select results_eq(
  $$ select active, version from api.set_product_active(
       '70000000-0000-4000-8000-000000000001',
       '7f7f7f7f-0000-4000-8000-00000000000a', 2, false) $$,
  $$ values (false, 3) $$,
  'deactivation preserves the row and increments version'
);

select results_eq(
  $$ select code, sort_order, version from api.create_customer_status(
       '70000000-0000-4000-8000-000000000010',
       '7f7f7f7f-0000-4000-8000-00000000000a', 'PROSPECT', 10) $$,
  $$ values ('PROSPECT'::text, 10, 1) $$,
  'customer statuses are company-configurable records'
);

update app_data.customer_statuses set active = false
where id = '70000000-0000-4000-8000-000000000010';

select throws_ok(
  $$ select api.create_customer(
       '70000000-0000-4000-8000-000000000020',
       '7f7f7f7f-0000-4000-8000-00000000000a', 'New Customer', '0012',
       '70000000-0000-4000-8000-000000000010', '') $$,
  'P0001', 'customer status is not active in this organization',
  'an inactive status cannot be assigned to a new customer'
);

select is(
  (select count(*)::integer from api.products
    where organization_id = '7f7f7f7f-0000-4000-8000-00000000000b'
       or id = '70000000-0000-4000-8000-0000000000b1'),
  0,
  'a foreign-tenant catalogue that does hold a product remains invisible, by filter and by exact id'
);

reset role;
select * from finish();
rollback;
