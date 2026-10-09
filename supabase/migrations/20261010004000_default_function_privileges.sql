-- P4-07: new functions must not be executable by PUBLIC (hence by anon/authenticated through
-- the Data API) unless a migration grants that explicitly.
--
-- * Default privileges: functions created by the migration role no longer receive the implicit
--   PUBLIC EXECUTE in any schema (the previous default only covered `public`), and functions in
--   `public` are granted to service_role by default.
-- * Three admin-only SECURITY DEFINER review RPCs are not called from the browser (the app and
--   the pipeline use the service role), so authenticated loses EXECUTE on them.
--
-- Not changed here, because the objects belong to supabase_admin and the project role cannot alter
-- or revoke them (see 20260826100218_guard_managed_postgis_data_api_objects.sql, which blocks
-- Data API access to st_estimatedextent and spatial_ref_sys through a pre-request hook):
--   * EXECUTE on public.st_estimatedextent(...) for anon/authenticated,
--   * RLS on public.spatial_ref_sys,
--   * moving postgis / pg_net out of the public schema (needs supabase_admin and a branch test).
begin;
set local lock_timeout = '5s';

alter default privileges revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to service_role;

revoke execute on function public.decide_outcome_claim_eligibility(uuid, text, text, uuid[], text, uuid)
  from public, anon, authenticated;
grant execute on function public.decide_outcome_claim_eligibility(uuid, text, text, uuid[], text, uuid)
  to service_role;

revoke execute on function public.review_judilibre_match_candidate(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.review_judilibre_match_candidate(uuid, text, text)
  to service_role;

revoke execute on function public.review_outcome_evidence(uuid, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.review_outcome_evidence(uuid, text, text, jsonb, text)
  to service_role;

commit;
