begin;

set local lock_timeout = '5s';

-- This SECURITY DEFINER helper is called by private trigger/procedure paths and
-- returns only a reconciliation boolean. Keep it out of the default PUBLIC
-- execute ACL so a future schema/grant change cannot expose the private
-- decision predicate through a direct RPC call.
revoke all on function app_private.catalogue_bridge_court_is_reconcilable(
  uuid,
  uuid
) from public, anon, authenticated, service_role;
grant execute on function app_private.catalogue_bridge_court_is_reconcilable(
  uuid,
  uuid
) to service_role;

commit;
