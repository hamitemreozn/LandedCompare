-- ===========================================================================
-- Audit A remediation, pass 1 — forward-only corrections
--
-- Phase 10 and Phase 11 migrations are applied on the hosted project and are
-- never rewritten. Everything below replaces or tightens behaviour going
-- forward.
--
--   A-L3  `api.import_catalog` validates every JSON value by TYPE as well as
--         by content. A number or an object sent where a string belongs is
--         refused instead of being coerced to text; a missing `active` is
--         refused explicitly instead of falling through three-valued logic to
--         a NOT NULL violation; the payload checksum must be the lowercase hex
--         SHA-256 the client computes and is stored exactly, so a retry of the
--         same request can never be refused because the stored copy was
--         truncated.
--
--   A-L4  Required human/business identifiers (SKU, product name, stock unit,
--         supplier and customer display name, customer-status code) must
--         contain at least one visible character. `btrim()` removes ASCII
--         spaces only, so a tab, a no-break space or a zero-width character
--         alone previously satisfied "not blank". Opaque optional fields —
--         external system codes above all — are deliberately NOT touched:
--         leading zeros and literal business codes stay exactly as entered.
--
-- A correction to a statement repeated in earlier migration comments:
-- `force row level security` does NOT subject the `postgres` owner to RLS,
-- because that role holds BYPASSRLS, which overrides FORCE. A SECURITY
-- DEFINER function owned by `postgres` therefore reads across tenants unless
-- its own SQL filters by organisation. Every DEFINER function in this schema
-- filters explicitly; future ones must too.
-- ===========================================================================

-- The one definition of "visible", shared by the table constraints and the
-- import validation below and mirrored by `hasVisibleText` in
-- src/cloud/catalogRules.ts. ASCII whitespace and controls are matched by the
-- POSIX classes; the explicit ranges cover Unicode spaces, C1 controls and
-- zero-width/format characters so the rule does not depend on a collation's
-- ctype.
--
--   [^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]

alter table app_data.products
  add constraint products_identifiers_visible check (
    sku ~ '[^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]'
    and name ~ '[^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]'
    and stock_unit ~ '[^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]'
  );

alter table app_data.suppliers
  add constraint suppliers_display_name_visible check (
    display_name ~ '[^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]'
  );

alter table app_data.customers
  add constraint customers_display_name_visible check (
    display_name ~ '[^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]'
  );

alter table app_data.customer_statuses
  add constraint customer_statuses_code_visible check (
    code ~ '[^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]'
  );

-- ---------------------------------------------------------------------------
-- app_private.catalog_import_text — one typed field check, NULL-safe
--
-- Returns true when `p_key` is acceptable on `p_item`:
--   absent            → acceptable only when not required
--   present           → must be a JSON STRING (never a number, object, array,
--                       boolean or null), no longer than `p_max_length`
--                       characters, and — when required — not blank and, for
--                       an identifier, visibly non-empty
--
-- Every branch returns a definite boolean, so a caller composing these with
-- AND can never be defeated by SQL's three-valued logic.
-- ---------------------------------------------------------------------------
create function app_private.catalog_import_text(
  p_item jsonb,
  p_key text,
  p_required boolean,
  p_max_length integer,
  p_identifier boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_item is null or jsonb_typeof(p_item) is distinct from 'object' then false
    when not (p_item ? p_key) then not coalesce(p_required, true)
    when jsonb_typeof(p_item -> p_key) is distinct from 'string' then false
    when length(p_item ->> p_key) > p_max_length then false
    when coalesce(p_required, true) and btrim(p_item ->> p_key) = '' then false
    when coalesce(p_identifier, false)
         and (p_item ->> p_key) !~ '[^[:space:][:cntrl:]\u0080-\u00A0\u00AD\u0600-\u0605\u061C\u06DD\u070F\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF\uFFF9-\uFFFB]'
      then false
    else true
  end;
$$;

comment on function app_private.catalog_import_text(jsonb, text, boolean, integer, boolean) is
  'Typed, NULL-safe field check for api.import_catalog. Called with the rights of the importing OWNER; no route, because app_private is not exposed.';

revoke execute on function app_private.catalog_import_text(jsonb, text, boolean, integer, boolean) from public, anon;
grant execute on function app_private.catalog_import_text(jsonb, text, boolean, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- app_private.catalog_import_record_ok — the shape shared by every record
--
-- An object, only the keys this section knows, a lowercase-or-uppercase UUID
-- `id`, a JSON boolean `active`, and the two millisecond-UTC instants the
-- legacy store always carries.
-- ---------------------------------------------------------------------------
create function app_private.catalog_import_record_ok(p_item jsonb, p_allowed_keys text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- CASE, not AND, guards the object test: PostgreSQL does not promise to
  -- evaluate AND operands left to right, and jsonb_object_keys raises on a
  -- scalar.
  select case when jsonb_typeof(p_item) is distinct from 'object' then false else coalesce(
    not exists (
      select 1 from jsonb_object_keys(p_item) as k(key)
      where k.key <> all (p_allowed_keys)
    )
    and jsonb_typeof(p_item -> 'id') = 'string'
    and (p_item ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(p_item -> 'active') = 'boolean'
    and jsonb_typeof(p_item -> 'createdAt') = 'string'
    and (p_item ->> 'createdAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    and jsonb_typeof(p_item -> 'updatedAt') = 'string'
    and (p_item ->> 'updatedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$',
    false
  ) end;
$$;

comment on function app_private.catalog_import_record_ok(jsonb, text[]) is
  'Typed, NULL-safe record-shape check for api.import_catalog. Always returns a definite boolean.';

revoke execute on function app_private.catalog_import_record_ok(jsonb, text[]) from public, anon;
grant execute on function app_private.catalog_import_record_ok(jsonb, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- api.import_catalog — same signature, same invoker boundary, strict input
-- ---------------------------------------------------------------------------
create or replace function api.import_catalog(
  p_request_id uuid,
  p_organization_id uuid,
  p_payload_checksum text,
  p_products jsonb,
  p_suppliers jsonb,
  p_customers jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_item jsonb;
  v_index integer;
  v_factor text;
  v_product_count integer;
  v_supplier_count integer;
  v_customer_count integer;
  c_product_keys constant text[] := array[
    'id','sku','name','description','stockUnit','defaultPurchaseUnit','unitsPerPurchaseUnit',
    'manufacturer','manufacturerRef','active','note','createdAt','updatedAt'];
  c_party_keys constant text[] := array['id','displayName','externalRef','active','note','createdAt','updatedAt'];
begin
  if not app_private.has_org_role(p_organization_id, array['OWNER']) then
    raise exception 'catalog import requires OWNER' using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  if p_request_id is null then
    raise exception 'catalog import requires a request id' using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  -- The client sends the backup envelope's integrity value: lowercase hex
  -- SHA-256. Anything else is refused before any work, and what is accepted
  -- is stored verbatim, so an honest retry always compares equal.
  if p_payload_checksum is null or p_payload_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'catalog payload checksum must be a lowercase hex SHA-256'
      using errcode = 'P0001', detail = 'RECORD_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text, 0)
  );

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

  if jsonb_typeof(p_products) is distinct from 'array'
     or jsonb_typeof(p_suppliers) is distinct from 'array'
     or jsonb_typeof(p_customers) is distinct from 'array' then
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

  for v_item, v_index in select value, ordinality::integer from jsonb_array_elements(p_products) with ordinality loop
    if not (
      app_private.catalog_import_record_ok(v_item, c_product_keys)
      and app_private.catalog_import_text(v_item, 'sku', true, 100, true)
      and app_private.catalog_import_text(v_item, 'name', true, 300, true)
      and app_private.catalog_import_text(v_item, 'stockUnit', true, 100, true)
      and app_private.catalog_import_text(v_item, 'description', false, 4000, false)
      and app_private.catalog_import_text(v_item, 'defaultPurchaseUnit', false, 100, false)
      and app_private.catalog_import_text(v_item, 'manufacturer', false, 300, false)
      and app_private.catalog_import_text(v_item, 'manufacturerRef', false, 300, false)
      and app_private.catalog_import_text(v_item, 'note', false, 4000, false)
    ) then
      raise exception 'invalid legacy product' using errcode = 'P0001', detail = 'RECORD_INVALID',
        hint = format('products[%s]', v_index - 1);
    end if;
    if v_item ? 'unitsPerPurchaseUnit' then
      -- Nested, so jsonb_object_keys only ever sees an object.
      if jsonb_typeof(v_item -> 'unitsPerPurchaseUnit') is distinct from 'object' then
        raise exception 'invalid legacy product decimal' using errcode = 'P0001', detail = 'RECORD_INVALID',
          hint = format('products[%s].unitsPerPurchaseUnit', v_index - 1);
      end if;
      if exists (select 1 from jsonb_object_keys(v_item -> 'unitsPerPurchaseUnit') k where k <> 'value')
         or jsonb_typeof(v_item -> 'unitsPerPurchaseUnit' -> 'value') is distinct from 'string' then
        raise exception 'invalid legacy product decimal' using errcode = 'P0001', detail = 'RECORD_INVALID',
          hint = format('products[%s].unitsPerPurchaseUnit', v_index - 1);
      end if;
      v_factor := v_item -> 'unitsPerPurchaseUnit' ->> 'value';
    else
      v_factor := null;
    end if;
    insert into app_data.products (
      id, organization_id, sku, name, description, stock_unit,
      default_purchase_unit, units_per_purchase_unit, manufacturer,
      manufacturer_ref, active, note
    ) values (
      (v_item ->> 'id')::uuid, p_organization_id, btrim(v_item ->> 'sku'), btrim(v_item ->> 'name'),
      nullif(btrim(v_item ->> 'description'), ''), btrim(v_item ->> 'stockUnit'),
      nullif(btrim(v_item ->> 'defaultPurchaseUnit'), ''), app_private.catalog_decimal(v_factor),
      nullif(btrim(v_item ->> 'manufacturer'), ''), nullif(btrim(v_item ->> 'manufacturerRef'), ''),
      (v_item ->> 'active')::boolean, nullif(btrim(v_item ->> 'note'), '')
    );
  end loop;

  for v_item, v_index in select value, ordinality::integer from jsonb_array_elements(p_suppliers) with ordinality loop
    if not (
      app_private.catalog_import_record_ok(v_item, c_party_keys)
      and app_private.catalog_import_text(v_item, 'displayName', true, 300, true)
      and app_private.catalog_import_text(v_item, 'externalRef', false, 300, false)
      and app_private.catalog_import_text(v_item, 'note', false, 4000, false)
    ) then
      raise exception 'invalid legacy supplier' using errcode = 'P0001', detail = 'RECORD_INVALID',
        hint = format('suppliers[%s]', v_index - 1);
    end if;
    insert into app_data.suppliers (id, organization_id, display_name, external_ref, active, note)
    values ((v_item ->> 'id')::uuid, p_organization_id, btrim(v_item ->> 'displayName'),
      nullif(btrim(v_item ->> 'externalRef'), ''), (v_item ->> 'active')::boolean,
      nullif(btrim(v_item ->> 'note'), ''));
  end loop;

  for v_item, v_index in select value, ordinality::integer from jsonb_array_elements(p_customers) with ordinality loop
    if not (
      app_private.catalog_import_record_ok(v_item, c_party_keys)
      and app_private.catalog_import_text(v_item, 'displayName', true, 300, true)
      and app_private.catalog_import_text(v_item, 'externalRef', false, 300, false)
      and app_private.catalog_import_text(v_item, 'note', false, 4000, false)
    ) then
      raise exception 'invalid legacy customer' using errcode = 'P0001', detail = 'RECORD_INVALID',
        hint = format('customers[%s]', v_index - 1);
    end if;
    insert into app_data.customers (id, organization_id, display_name, external_ref, active, note)
    values ((v_item ->> 'id')::uuid, p_organization_id, btrim(v_item ->> 'displayName'),
      nullif(btrim(v_item ->> 'externalRef'), ''), (v_item ->> 'active')::boolean,
      nullif(btrim(v_item ->> 'note'), ''));
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
      'payload_checksum', p_payload_checksum,
      'counts', v_existing,
      'scope', 'CATALOG_PHASE_11'
    )
  );
  return v_existing;
end $$;

revoke execute on function api.import_catalog(uuid,uuid,text,jsonb,jsonb,jsonb) from public, anon;
grant execute on function api.import_catalog(uuid,uuid,text,jsonb,jsonb,jsonb) to authenticated;
