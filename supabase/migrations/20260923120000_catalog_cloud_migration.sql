-- ===========================================================================
-- Phase 11 — Catalog cloud migration
--
-- PostgreSQL is authoritative for products, suppliers, customers and the
-- organisation-configurable customer-status list.  Canonical tables remain in
-- app_data; api contains read-only security-invoker projections and small,
-- typed mutation functions only.
-- ===========================================================================

-- Phase 10 had no client-editable business table, so its registry did not yet
-- need this class.  Phase 11 introduces it explicitly rather than mislabelling
-- catalog tables as read-only metadata.
alter table app_private.managed_table
  drop constraint managed_table_policy_class_known;
alter table app_private.managed_table
  add constraint managed_table_policy_class_known
  check (policy_class in (
    'TENANT_READONLY',
    'TENANT_EDITABLE',
    'TENANT_APPEND_ONLY',
    'TENANT_SERVER_WRITTEN',
    'IDENTITY_SELF',
    'SERVER_ONLY'
  ));

create table app_data.products (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references app_data.organizations (id) on delete restrict,
  sku                      text not null,
  name                     text not null,
  description              text,
  stock_unit               text not null,
  default_purchase_unit    text,
  units_per_purchase_unit  numeric,
  manufacturer             text,
  manufacturer_ref         text,
  active                   boolean not null default true,
  note                     text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references auth.users (id) on delete set null,
  updated_by               uuid references auth.users (id) on delete set null,
  version                  integer not null default 1,
  unique (id, organization_id),
  constraint products_sku_valid check (btrim(sku) <> '' and length(sku) <= 100),
  constraint products_name_valid check (btrim(name) <> '' and length(name) <= 300),
  constraint products_description_valid check (description is null or (btrim(description) <> '' and length(description) <= 4000)),
  constraint products_stock_unit_valid check (btrim(stock_unit) <> '' and length(stock_unit) <= 100),
  constraint products_purchase_unit_valid check (default_purchase_unit is null or (btrim(default_purchase_unit) <> '' and length(default_purchase_unit) <= 100)),
  constraint products_pack_factor_positive check (units_per_purchase_unit is null or units_per_purchase_unit > 0),
  constraint products_manufacturer_valid check (manufacturer is null or (btrim(manufacturer) <> '' and length(manufacturer) <= 300)),
  constraint products_manufacturer_ref_valid check (manufacturer_ref is null or (btrim(manufacturer_ref) <> '' and length(manufacturer_ref) <= 300)),
  constraint products_note_valid check (note is null or (btrim(note) <> '' and length(note) <= 4000))
);

create unique index products_org_sku_key
  on app_data.products (organization_id, lower(btrim(sku)));
create index products_org_name_idx
  on app_data.products (organization_id, lower(btrim(name)));

create table app_data.suppliers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references app_data.organizations (id) on delete restrict,
  display_name     text not null,
  external_ref     text,
  active           boolean not null default true,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  unique (id, organization_id),
  constraint suppliers_name_valid check (btrim(display_name) <> '' and length(display_name) <= 300),
  constraint suppliers_external_ref_valid check (external_ref is null or (btrim(external_ref) <> '' and length(external_ref) <= 300)),
  constraint suppliers_note_valid check (note is null or (btrim(note) <> '' and length(note) <= 4000))
);

create index suppliers_org_name_idx
  on app_data.suppliers (organization_id, lower(btrim(display_name)));

create table app_data.customer_statuses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references app_data.organizations (id) on delete restrict,
  code             text not null,
  sort_order       integer not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  unique (id, organization_id),
  constraint customer_statuses_code_valid check (btrim(code) <> '' and length(code) <= 100),
  constraint customer_statuses_sort_order_safe check (sort_order between -1000000 and 1000000)
);

create unique index customer_statuses_org_code_key
  on app_data.customer_statuses (organization_id, lower(btrim(code)));
create index customer_statuses_order_idx
  on app_data.customer_statuses (organization_id, sort_order, lower(btrim(code)));

create table app_data.customers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references app_data.organizations (id) on delete restrict,
  display_name        text not null,
  external_ref        text,
  customer_status_id  uuid,
  active              boolean not null default true,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,
  unique (id, organization_id),
  constraint customers_status_fk
    foreign key (customer_status_id, organization_id)
    references app_data.customer_statuses (id, organization_id) on delete restrict,
  constraint customers_name_valid check (btrim(display_name) <> '' and length(display_name) <= 300),
  constraint customers_external_ref_valid check (external_ref is null or (btrim(external_ref) <> '' and length(external_ref) <= 300)),
  constraint customers_note_valid check (note is null or (btrim(note) <> '' and length(note) <= 4000))
);

create index customers_org_name_idx
  on app_data.customers (organization_id, lower(btrim(display_name)));
create index customers_status_idx
  on app_data.customers (organization_id, customer_status_id);

comment on column app_data.suppliers.external_ref is
  'Opaque external-system code. Stored exactly as entered; deliberately not parsed, generated, normalised or made unique.';
comment on column app_data.customers.external_ref is
  'Opaque external-system code. Stored exactly as entered; deliberately not parsed, generated, normalised or made unique.';

insert into app_private.managed_table (table_schema, table_name, policy_class, note) values
  ('app_data', 'products', 'TENANT_EDITABLE', 'Phase 11 catalog master. Read through api.products; writes through typed RPCs.'),
  ('app_data', 'suppliers', 'TENANT_EDITABLE', 'Phase 11 supplier master. external_ref is opaque.'),
  ('app_data', 'customers', 'TENANT_EDITABLE', 'Phase 11 customer master. Tenant-safe optional status reference.'),
  ('app_data', 'customer_statuses', 'TENANT_EDITABLE', 'Organisation-configurable customer classification; not an enum.');

-- Shared lifecycle, audit and restore-gate triggers.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['products', 'suppliers', 'customers', 'customer_statuses'] loop
    execute format(
      'create trigger %I before insert or update on app_data.%I for each row execute function app_private.stamp_row()',
      v_table || '_stamp', v_table
    );
    execute format(
      'create trigger %I before update on app_data.%I for each row execute function app_private.assert_tenant_immutable()',
      v_table || '_tenant_immutable', v_table
    );
    execute format(
      'create trigger %I before insert or update on app_data.%I for each row execute function app_private.write_gate()',
      v_table || '_write_gate', v_table
    );
  end loop;
end $$;

-- RLS: live database membership on every statement; no JWT tenant claims.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['products', 'suppliers', 'customers', 'customer_statuses'] loop
    execute format('alter table app_data.%I enable row level security', v_table);
    execute format('alter table app_data.%I force row level security', v_table);
    execute format(
      'create policy %I on app_data.%I for select to authenticated using (organization_id = any ((select app_private.current_org_ids())::uuid[]))',
      v_table || '_select', v_table
    );
    execute format(
      'create policy %I on app_data.%I for insert to authenticated with check (organization_id = any ((select app_private.current_org_ids())::uuid[]))',
      v_table || '_insert', v_table
    );
    execute format(
      'create policy %I on app_data.%I for update to authenticated using (organization_id = any ((select app_private.current_org_ids())::uuid[])) with check (organization_id = any ((select app_private.current_org_ids())::uuid[]))',
      v_table || '_update', v_table
    );
    execute format('revoke all on app_data.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update on app_data.%I to authenticated', v_table);
  end loop;
end $$;

-- Read projections.  Exact decimals and timestamps are normalised here so no
-- client-visible route can return a PostgreSQL numeric as a JSON number.
create view api.products with (security_invoker = on) as
select
  p.id, p.organization_id, p.sku, p.name, p.description, p.stock_unit,
  p.default_purchase_unit,
  p.units_per_purchase_unit::text as units_per_purchase_unit,
  p.manufacturer, p.manufacturer_ref, p.active, p.note,
  p.created_by, p.updated_by, p.version,
  to_char(p.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  to_char(p.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
from app_data.products p;

create view api.suppliers with (security_invoker = on) as
select
  s.id, s.organization_id, s.display_name, s.external_ref, s.active, s.note,
  s.created_by, s.updated_by, s.version,
  to_char(s.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  to_char(s.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
from app_data.suppliers s;

create view api.customers with (security_invoker = on) as
select
  c.id, c.organization_id, c.display_name, c.external_ref, c.customer_status_id,
  c.active, c.note, c.created_by, c.updated_by, c.version,
  to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  to_char(c.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
from app_data.customers c;

create view api.customer_statuses with (security_invoker = on) as
select
  s.id, s.organization_id, s.code, s.sort_order, s.active,
  s.created_by, s.updated_by, s.version,
  to_char(s.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  to_char(s.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
from app_data.customer_statuses s;

do $$
declare
  v_view text;
begin
  foreach v_view in array array['products', 'suppliers', 'customers', 'customer_statuses'] loop
    execute format('revoke all on api.%I from public, anon, authenticated', v_view);
    execute format('grant select on api.%I to authenticated', v_view);
  end loop;
end $$;

-- Small helpers used by typed RPCs.  They raise stable detail codes rather
-- than making the client parse PostgreSQL prose.
create function app_private.assert_catalog_member(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.has_org_role(p_organization_id, array['OWNER','ADMIN','MEMBER']) then
    raise exception 'not an active member of this organization'
      using errcode = '42501', detail = 'FORBIDDEN';
  end if;
end $$;

create function app_private.catalog_decimal(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := nullif(p_value, '');
begin
  if v_value is null then
    return null;
  end if;
  if v_value !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' or v_value::numeric <= 0 then
    raise exception 'invalid positive canonical decimal'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;
  return v_value::numeric;
end $$;

revoke execute on function app_private.assert_catalog_member(uuid) from public, anon;
revoke execute on function app_private.catalog_decimal(text) from public, anon;
grant execute on function app_private.assert_catalog_member(uuid) to authenticated;
grant execute on function app_private.catalog_decimal(text) to authenticated;

-- Products -----------------------------------------------------------------
create function api.create_product(
  p_id uuid, p_organization_id uuid, p_sku text, p_name text,
  p_description text, p_stock_unit text, p_default_purchase_unit text,
  p_units_per_purchase_unit text, p_manufacturer text,
  p_manufacturer_ref text, p_note text
)
returns setof api.products
language plpgsql
set search_path = ''
as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  insert into app_data.products (
    id, organization_id, sku, name, description, stock_unit,
    default_purchase_unit, units_per_purchase_unit, manufacturer,
    manufacturer_ref, note
  ) values (
    p_id, p_organization_id, btrim(p_sku), btrim(p_name), nullif(btrim(p_description), ''),
    btrim(p_stock_unit), nullif(btrim(p_default_purchase_unit), ''),
    app_private.catalog_decimal(p_units_per_purchase_unit),
    nullif(btrim(p_manufacturer), ''), nullif(btrim(p_manufacturer_ref), ''),
    nullif(btrim(p_note), '')
  ) returning id into v_id;
  return query select * from api.products where id = v_id;
end $$;

create function api.update_product(
  p_id uuid, p_organization_id uuid, p_expected_version integer,
  p_sku text, p_name text, p_description text, p_stock_unit text,
  p_default_purchase_unit text, p_units_per_purchase_unit text,
  p_manufacturer text, p_manufacturer_ref text, p_note text
)
returns setof api.products
language plpgsql
set search_path = ''
as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  if not exists (select 1 from app_data.products p where p.id = p_id and p.organization_id = p_organization_id) then
    raise exception 'product not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;
  update app_data.products p set
    sku = btrim(p_sku), name = btrim(p_name), description = nullif(btrim(p_description), ''),
    stock_unit = btrim(p_stock_unit), default_purchase_unit = nullif(btrim(p_default_purchase_unit), ''),
    units_per_purchase_unit = app_private.catalog_decimal(p_units_per_purchase_unit),
    manufacturer = nullif(btrim(p_manufacturer), ''), manufacturer_ref = nullif(btrim(p_manufacturer_ref), ''),
    note = nullif(btrim(p_note), '')
  where p.id = p_id and p.organization_id = p_organization_id and p.version = p_expected_version
  returning p.id into v_id;
  if not found then
    raise exception 'stale product' using errcode = 'P0001', detail = 'STALE_WRITE';
  end if;
  return query select * from api.products where id = v_id;
end $$;

create function api.set_product_active(
  p_id uuid, p_organization_id uuid, p_expected_version integer, p_active boolean
)
returns setof api.products
language plpgsql
set search_path = ''
as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  if not exists (select 1 from app_data.products p where p.id = p_id and p.organization_id = p_organization_id) then
    raise exception 'product not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;
  update app_data.products p set active = p_active
  where p.id = p_id and p.organization_id = p_organization_id and p.version = p_expected_version
  returning p.id into v_id;
  if not found then raise exception 'stale product' using errcode = 'P0001', detail = 'STALE_WRITE'; end if;
  return query select * from api.products where id = v_id;
end $$;

-- Suppliers ----------------------------------------------------------------
create function api.create_supplier(
  p_id uuid, p_organization_id uuid, p_display_name text, p_external_ref text, p_note text
)
returns setof api.suppliers language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  insert into app_data.suppliers (id, organization_id, display_name, external_ref, note)
  values (p_id, p_organization_id, btrim(p_display_name), nullif(btrim(p_external_ref), ''), nullif(btrim(p_note), ''))
  returning id into v_id;
  return query select * from api.suppliers where id = v_id;
end $$;

create function api.update_supplier(
  p_id uuid, p_organization_id uuid, p_expected_version integer,
  p_display_name text, p_external_ref text, p_note text
)
returns setof api.suppliers language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  if not exists (select 1 from app_data.suppliers s where s.id = p_id and s.organization_id = p_organization_id) then
    raise exception 'supplier not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;
  update app_data.suppliers s set display_name = btrim(p_display_name),
    external_ref = nullif(btrim(p_external_ref), ''), note = nullif(btrim(p_note), '')
  where s.id = p_id and s.organization_id = p_organization_id and s.version = p_expected_version
  returning s.id into v_id;
  if not found then raise exception 'stale supplier' using errcode = 'P0001', detail = 'STALE_WRITE'; end if;
  return query select * from api.suppliers where id = v_id;
end $$;

create function api.set_supplier_active(
  p_id uuid, p_organization_id uuid, p_expected_version integer, p_active boolean
)
returns setof api.suppliers language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  if not exists (select 1 from app_data.suppliers s where s.id = p_id and s.organization_id = p_organization_id) then
    raise exception 'supplier not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;
  update app_data.suppliers s set active = p_active
  where s.id = p_id and s.organization_id = p_organization_id and s.version = p_expected_version
  returning s.id into v_id;
  if not found then raise exception 'stale supplier' using errcode = 'P0001', detail = 'STALE_WRITE'; end if;
  return query select * from api.suppliers where id = v_id;
end $$;

-- Customer statuses ---------------------------------------------------------
create function api.create_customer_status(
  p_id uuid, p_organization_id uuid, p_code text, p_sort_order integer
)
returns setof api.customer_statuses language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  insert into app_data.customer_statuses (id, organization_id, code, sort_order)
  values (p_id, p_organization_id, btrim(p_code), p_sort_order) returning id into v_id;
  return query select * from api.customer_statuses where id = v_id;
end $$;

create function api.update_customer_status(
  p_id uuid, p_organization_id uuid, p_expected_version integer, p_code text, p_sort_order integer
)
returns setof api.customer_statuses language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  if not exists (select 1 from app_data.customer_statuses s where s.id = p_id and s.organization_id = p_organization_id) then
    raise exception 'customer status not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;
  update app_data.customer_statuses s set code = btrim(p_code), sort_order = p_sort_order
  where s.id = p_id and s.organization_id = p_organization_id and s.version = p_expected_version
  returning s.id into v_id;
  if not found then raise exception 'stale customer status' using errcode = 'P0001', detail = 'STALE_WRITE'; end if;
  return query select * from api.customer_statuses where id = v_id;
end $$;

create function api.set_customer_status_active(
  p_id uuid, p_organization_id uuid, p_expected_version integer, p_active boolean
)
returns setof api.customer_statuses language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  if not exists (select 1 from app_data.customer_statuses s where s.id = p_id and s.organization_id = p_organization_id) then
    raise exception 'customer status not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;
  update app_data.customer_statuses s set active = p_active
  where s.id = p_id and s.organization_id = p_organization_id and s.version = p_expected_version
  returning s.id into v_id;
  if not found then raise exception 'stale customer status' using errcode = 'P0001', detail = 'STALE_WRITE'; end if;
  return query select * from api.customer_statuses where id = v_id;
end $$;

-- Customers ----------------------------------------------------------------
create function app_private.assert_assignable_customer_status(
  p_organization_id uuid, p_customer_status_id uuid
)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_customer_status_id is not null and not exists (
    select 1 from app_data.customer_statuses s
    where s.id = p_customer_status_id and s.organization_id = p_organization_id and s.active
  ) then
    raise exception 'customer status is not active in this organization'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;
end $$;
revoke execute on function app_private.assert_assignable_customer_status(uuid, uuid) from public, anon;
grant execute on function app_private.assert_assignable_customer_status(uuid, uuid) to authenticated;

create function api.create_customer(
  p_id uuid, p_organization_id uuid, p_display_name text,
  p_external_ref text, p_customer_status_id uuid, p_note text
)
returns setof api.customers language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  perform app_private.assert_assignable_customer_status(p_organization_id, p_customer_status_id);
  insert into app_data.customers (id, organization_id, display_name, external_ref, customer_status_id, note)
  values (p_id, p_organization_id, btrim(p_display_name), nullif(btrim(p_external_ref), ''), p_customer_status_id, nullif(btrim(p_note), ''))
  returning id into v_id;
  return query select * from api.customers where id = v_id;
end $$;

create function api.update_customer(
  p_id uuid, p_organization_id uuid, p_expected_version integer,
  p_display_name text, p_external_ref text, p_customer_status_id uuid, p_note text
)
returns setof api.customers language plpgsql set search_path = '' as $$
declare v_id uuid; v_old_status uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  select c.customer_status_id into v_old_status from app_data.customers c
  where c.id = p_id and c.organization_id = p_organization_id;
  if not found then raise exception 'customer not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND'; end if;
  if p_customer_status_id is distinct from v_old_status then
    perform app_private.assert_assignable_customer_status(p_organization_id, p_customer_status_id);
  end if;
  update app_data.customers c set display_name = btrim(p_display_name),
    external_ref = nullif(btrim(p_external_ref), ''), customer_status_id = p_customer_status_id,
    note = nullif(btrim(p_note), '')
  where c.id = p_id and c.organization_id = p_organization_id and c.version = p_expected_version
  returning c.id into v_id;
  if not found then raise exception 'stale customer' using errcode = 'P0001', detail = 'STALE_WRITE'; end if;
  return query select * from api.customers where id = v_id;
end $$;

create function api.set_customer_active(
  p_id uuid, p_organization_id uuid, p_expected_version integer, p_active boolean
)
returns setof api.customers language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_catalog_member(p_organization_id);
  if not exists (select 1 from app_data.customers c where c.id = p_id and c.organization_id = p_organization_id) then
    raise exception 'customer not found' using errcode = 'P0001', detail = 'RECORD_NOT_FOUND';
  end if;
  update app_data.customers c set active = p_active
  where c.id = p_id and c.organization_id = p_organization_id and c.version = p_expected_version
  returning c.id into v_id;
  if not found then raise exception 'stale customer' using errcode = 'P0001', detail = 'STALE_WRITE'; end if;
  return query select * from api.customers where id = v_id;
end $$;

-- One-time local catalog import --------------------------------------------
--
-- The legacy payload is untrusted.  Unknown keys, oversized strings, invalid
-- UUIDs/instants/decimals and duplicates are rejected before insertion.  The
-- organization comes exclusively from the authenticated OWNER argument; no
-- organization id is accepted in the payload.  A committed admin-event row is
-- the retry token: the same request id returns the same result after a lost
-- HTTP response, while any different request is refused once catalog data
-- exists.  The entire import is one database transaction.
create unique index admin_events_catalog_import_request_key
  on app_data.admin_events (organization_id, ((details ->> 'request_id')))
  where event_type = 'ORGANIZATION_DATA_IMPORTED' and details ? 'request_id';

create function api.import_catalog(
  p_request_id uuid,
  p_organization_id uuid,
  p_payload_checksum text,
  p_products jsonb,
  p_suppliers jsonb,
  p_customers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_item jsonb;
  v_factor text;
  v_product_count integer;
  v_supplier_count integer;
  v_customer_count integer;
begin
  if not app_private.has_org_role(p_organization_id, array['OWNER']) then
    raise exception 'catalog import requires OWNER' using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  -- Serialises imports for one tenant and also participates in the restore
  -- write-gate lock order (organisation row before business rows).
  perform 1 from app_data.organizations o where o.id = p_organization_id for update;

  select e.details into v_existing from app_data.admin_events e
  where e.organization_id = p_organization_id
    and e.event_type = 'ORGANIZATION_DATA_IMPORTED'
    and e.details ->> 'request_id' = p_request_id::text;
  if found then
    if v_existing ->> 'payload_checksum' is distinct from p_payload_checksum then
      raise exception 'request id reused with different payload' using errcode = 'P0001', detail = 'DUPLICATE_KEY';
    end if;
    return v_existing -> 'counts';
  end if;

  if jsonb_typeof(p_products) <> 'array' or jsonb_typeof(p_suppliers) <> 'array' or jsonb_typeof(p_customers) <> 'array' then
    raise exception 'catalog payload sections must be arrays' using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;
  if jsonb_array_length(p_products) > 10000 or jsonb_array_length(p_suppliers) > 10000 or jsonb_array_length(p_customers) > 10000 then
    raise exception 'catalog payload is too large' using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  if exists (select 1 from app_data.products where organization_id = p_organization_id)
     or exists (select 1 from app_data.suppliers where organization_id = p_organization_id)
     or exists (select 1 from app_data.customers where organization_id = p_organization_id) then
    raise exception 'catalog import target is not empty' using errcode = 'P0001', detail = 'DUPLICATE_KEY';
  end if;

  for v_item in select value from jsonb_array_elements(p_products) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in (
         'id','sku','name','description','stockUnit','defaultPurchaseUnit','unitsPerPurchaseUnit',
         'manufacturer','manufacturerRef','active','note','createdAt','updatedAt'
       ))
       or coalesce(v_item->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or btrim(coalesce(v_item->>'sku','')) = '' or length(v_item->>'sku') > 100
       or btrim(coalesce(v_item->>'name','')) = '' or length(v_item->>'name') > 300
       or btrim(coalesce(v_item->>'stockUnit','')) = '' or length(v_item->>'stockUnit') > 100
       or jsonb_typeof(v_item->'active') <> 'boolean'
       or coalesce(v_item->>'createdAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or coalesce(v_item->>'updatedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or length(coalesce(v_item->>'description','')) > 4000
       or length(coalesce(v_item->>'defaultPurchaseUnit','')) > 100
       or length(coalesce(v_item->>'manufacturer','')) > 300
       or length(coalesce(v_item->>'manufacturerRef','')) > 300
       or length(coalesce(v_item->>'note','')) > 4000 then
      raise exception 'invalid legacy product' using errcode = 'P0001', detail = 'RECORD_INVALID';
    end if;
    if v_item ? 'unitsPerPurchaseUnit' then
      if jsonb_typeof(v_item->'unitsPerPurchaseUnit') <> 'object'
         or exists (select 1 from jsonb_object_keys(v_item->'unitsPerPurchaseUnit') k where k <> 'value') then
        raise exception 'invalid legacy product decimal' using errcode = 'P0001', detail = 'RECORD_INVALID';
      end if;
      v_factor := v_item->'unitsPerPurchaseUnit'->>'value';
    else
      v_factor := null;
    end if;
    insert into app_data.products (
      id, organization_id, sku, name, description, stock_unit,
      default_purchase_unit, units_per_purchase_unit, manufacturer,
      manufacturer_ref, active, note
    ) values (
      (v_item->>'id')::uuid, p_organization_id, btrim(v_item->>'sku'), btrim(v_item->>'name'),
      nullif(btrim(v_item->>'description'), ''), btrim(v_item->>'stockUnit'),
      nullif(btrim(v_item->>'defaultPurchaseUnit'), ''), app_private.catalog_decimal(v_factor),
      nullif(btrim(v_item->>'manufacturer'), ''), nullif(btrim(v_item->>'manufacturerRef'), ''),
      (v_item->>'active')::boolean, nullif(btrim(v_item->>'note'), '')
    );
  end loop;

  for v_item in select value from jsonb_array_elements(p_suppliers) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id','displayName','externalRef','active','note','createdAt','updatedAt'))
       or coalesce(v_item->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or btrim(coalesce(v_item->>'displayName','')) = '' or length(v_item->>'displayName') > 300
       or jsonb_typeof(v_item->'active') <> 'boolean'
       or coalesce(v_item->>'createdAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or coalesce(v_item->>'updatedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or length(coalesce(v_item->>'externalRef','')) > 300 or length(coalesce(v_item->>'note','')) > 4000 then
      raise exception 'invalid legacy supplier' using errcode = 'P0001', detail = 'RECORD_INVALID';
    end if;
    insert into app_data.suppliers (id, organization_id, display_name, external_ref, active, note)
    values ((v_item->>'id')::uuid, p_organization_id, btrim(v_item->>'displayName'),
      nullif(btrim(v_item->>'externalRef'), ''), (v_item->>'active')::boolean,
      nullif(btrim(v_item->>'note'), ''));
  end loop;

  for v_item in select value from jsonb_array_elements(p_customers) loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id','displayName','externalRef','active','note','createdAt','updatedAt'))
       or coalesce(v_item->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or btrim(coalesce(v_item->>'displayName','')) = '' or length(v_item->>'displayName') > 300
       or jsonb_typeof(v_item->'active') <> 'boolean'
       or coalesce(v_item->>'createdAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or coalesce(v_item->>'updatedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       or length(coalesce(v_item->>'externalRef','')) > 300 or length(coalesce(v_item->>'note','')) > 4000 then
      raise exception 'invalid legacy customer' using errcode = 'P0001', detail = 'RECORD_INVALID';
    end if;
    insert into app_data.customers (id, organization_id, display_name, external_ref, active, note)
    values ((v_item->>'id')::uuid, p_organization_id, btrim(v_item->>'displayName'),
      nullif(btrim(v_item->>'externalRef'), ''), (v_item->>'active')::boolean,
      nullif(btrim(v_item->>'note'), ''));
  end loop;

  select count(*) into v_product_count from app_data.products where organization_id = p_organization_id;
  select count(*) into v_supplier_count from app_data.suppliers where organization_id = p_organization_id;
  select count(*) into v_customer_count from app_data.customers where organization_id = p_organization_id;
  if v_product_count <> jsonb_array_length(p_products)
     or v_supplier_count <> jsonb_array_length(p_suppliers)
     or v_customer_count <> jsonb_array_length(p_customers) then
    raise exception 'catalog import verification failed' using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  v_existing := jsonb_build_object(
    'products', v_product_count, 'suppliers', v_supplier_count, 'customers', v_customer_count
  );
  insert into app_data.admin_events (organization_id, event_type, actor_user_id, details)
  values (
    p_organization_id, 'ORGANIZATION_DATA_IMPORTED', (select auth.uid()),
    jsonb_build_object(
      'request_id', p_request_id::text,
      'payload_checksum', left(coalesce(p_payload_checksum, ''), 128),
      'counts', v_existing,
      'scope', 'CATALOG_PHASE_11'
    )
  );
  return v_existing;
end $$;

-- Every newly published function starts executable by PUBLIC in PostgreSQL.
-- Revoke first, then grant exactly authenticated (the import is definer but
-- re-proves OWNER itself).
revoke execute on function api.create_product(uuid,uuid,text,text,text,text,text,text,text,text,text) from public, anon;
revoke execute on function api.update_product(uuid,uuid,integer,text,text,text,text,text,text,text,text,text) from public, anon;
revoke execute on function api.set_product_active(uuid,uuid,integer,boolean) from public, anon;
revoke execute on function api.create_supplier(uuid,uuid,text,text,text) from public, anon;
revoke execute on function api.update_supplier(uuid,uuid,integer,text,text,text) from public, anon;
revoke execute on function api.set_supplier_active(uuid,uuid,integer,boolean) from public, anon;
revoke execute on function api.create_customer(uuid,uuid,text,text,uuid,text) from public, anon;
revoke execute on function api.update_customer(uuid,uuid,integer,text,text,uuid,text) from public, anon;
revoke execute on function api.set_customer_active(uuid,uuid,integer,boolean) from public, anon;
revoke execute on function api.create_customer_status(uuid,uuid,text,integer) from public, anon;
revoke execute on function api.update_customer_status(uuid,uuid,integer,text,integer) from public, anon;
revoke execute on function api.set_customer_status_active(uuid,uuid,integer,boolean) from public, anon;
revoke execute on function api.import_catalog(uuid,uuid,text,jsonb,jsonb,jsonb) from public, anon;

grant execute on function api.create_product(uuid,uuid,text,text,text,text,text,text,text,text,text) to authenticated;
grant execute on function api.update_product(uuid,uuid,integer,text,text,text,text,text,text,text,text,text) to authenticated;
grant execute on function api.set_product_active(uuid,uuid,integer,boolean) to authenticated;
grant execute on function api.create_supplier(uuid,uuid,text,text,text) to authenticated;
grant execute on function api.update_supplier(uuid,uuid,integer,text,text,text) to authenticated;
grant execute on function api.set_supplier_active(uuid,uuid,integer,boolean) to authenticated;
grant execute on function api.create_customer(uuid,uuid,text,text,uuid,text) to authenticated;
grant execute on function api.update_customer(uuid,uuid,integer,text,text,uuid,text) to authenticated;
grant execute on function api.set_customer_active(uuid,uuid,integer,boolean) to authenticated;
grant execute on function api.create_customer_status(uuid,uuid,text,integer) to authenticated;
grant execute on function api.update_customer_status(uuid,uuid,integer,text,integer) to authenticated;
grant execute on function api.set_customer_status_active(uuid,uuid,integer,boolean) to authenticated;
grant execute on function api.import_catalog(uuid,uuid,text,jsonb,jsonb,jsonb) to authenticated;
