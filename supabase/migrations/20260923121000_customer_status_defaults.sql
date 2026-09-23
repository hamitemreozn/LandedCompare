-- ===========================================================================
-- Phase 11 — Organisation-owned customer-status defaults
--
-- Product Scope decision 19 requires the pilot grading vocabulary to be seeded
-- for each organisation.  The rows remain ordinary tenant data: an OWNER can
-- rename, add, reorder or deactivate them through the Phase 11 catalogue API.
-- ===========================================================================

create function app_private.seed_customer_status_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into app_data.customer_statuses (organization_id, code, sort_order)
  values
    (new.id, 'C',   10),
    (new.id, 'A',   20),
    (new.id, 'A+',  30),
    (new.id, 'A++', 40)
  on conflict do nothing;

  return new;
end $$;

revoke execute on function app_private.seed_customer_status_defaults()
  from public, anon, authenticated, service_role;

create trigger organizations_seed_customer_status_defaults
after insert on app_data.organizations
for each row execute function app_private.seed_customer_status_defaults();

-- Cover organisations created before this migration (including a Phase 10
-- pilot project upgraded in place).  The unique index makes the backfill safe
-- to repeat when a company already created one of these labels itself.
insert into app_data.customer_statuses (organization_id, code, sort_order)
select o.id, defaults.code, defaults.sort_order
from app_data.organizations o
cross join (values
  ('C'::text,   10),
  ('A'::text,   20),
  ('A+'::text,  30),
  ('A++'::text, 40)
) as defaults(code, sort_order)
on conflict do nothing;
