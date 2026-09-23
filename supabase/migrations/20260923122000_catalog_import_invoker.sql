-- ===========================================================================
-- Phase 11 — Keep the one-time catalogue import inside the invoker boundary
--
-- Supabase's hosted security advisor correctly treats any SECURITY DEFINER
-- function callable by `authenticated` as review-worthy.  The import does not
-- need to bypass RLS: its target rows belong to the caller's live OWNER
-- membership.  Run it as the caller, serialize with a transaction advisory
-- lock, and permit exactly its append-only audit event through a narrow policy.
-- ===========================================================================

grant insert on table app_data.admin_events to authenticated;

create policy admin_events_catalog_import_insert on app_data.admin_events
  for insert to authenticated
  with check (
    event_type = 'ORGANIZATION_DATA_IMPORTED'
    and actor_user_id = (select auth.uid())
    and subject_user_id is null
    and (select app_private.has_org_role(organization_id, array['OWNER']))
    and details ->> 'scope' = 'CATALOG_PHASE_11'
    and coalesce(details ->> 'request_id', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and length(coalesce(details ->> 'payload_checksum', '')) between 1 and 128
    and jsonb_typeof(details -> 'counts') = 'object'
    and not exists (
      select 1 from jsonb_object_keys(details) key
      where key not in ('request_id', 'payload_checksum', 'counts', 'scope')
    )
    and not exists (
      select 1 from jsonb_object_keys(details -> 'counts') key
      where key not in ('products', 'suppliers', 'customers')
    )
    and coalesce(details -> 'counts' ->> 'products', '') ~ '^\d+$'
    and coalesce(details -> 'counts' ->> 'suppliers', '') ~ '^\d+$'
    and coalesce(details -> 'counts' ->> 'customers', '') ~ '^\d+$'
  );

update app_private.managed_table
set note = 'Readable by OWNER/ADMIN. Append-only; the Phase 11 invoker import has one strict OWNER insert policy and no direct API route.'
where table_schema = 'app_data' and table_name = 'admin_events';

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
  v_factor text;
  v_product_count integer;
  v_supplier_count integer;
  v_customer_count integer;
begin
  if not app_private.has_org_role(p_organization_id, array['OWNER']) then
    raise exception 'catalog import requires OWNER' using errcode = '42501', detail = 'FORBIDDEN';
  end if;

  -- One transaction-scoped lock per tenant. A hash collision can only make two
  -- unrelated imports wait; it cannot widen access or mix their transactions.
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

revoke execute on function api.import_catalog(uuid,uuid,text,jsonb,jsonb,jsonb)
  from public, anon;
grant execute on function api.import_catalog(uuid,uuid,text,jsonb,jsonb,jsonb)
  to authenticated;
