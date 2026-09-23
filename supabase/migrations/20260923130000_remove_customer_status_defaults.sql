-- ===========================================================================
-- Phase 11 correction — customer statuses start empty
--
-- Customer classifications belong to each organisation.  The historical
-- 20260923121000 migration incorrectly treated one pilot company's labels as
-- product defaults.  Keep that applied migration in history and remove only
-- its active automation going forward.
--
-- Existing rows are deliberately preserved: there is no reliable way to
-- distinguish an untouched historical default from a label an organisation
-- intentionally adopted or edited.  The linked hosted project has no real
-- organisation or customer-status rows, so this correction needs no cleanup.
-- ===========================================================================

drop trigger if exists organizations_seed_customer_status_defaults
  on app_data.organizations;

drop function if exists app_private.seed_customer_status_defaults();
