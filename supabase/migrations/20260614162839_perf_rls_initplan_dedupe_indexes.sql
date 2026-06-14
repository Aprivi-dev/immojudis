begin;

-- 1) Drop duplicate index (identical definition to idx_auction_sales_investment_score)
drop index if exists public.idx_auction_sales_score;

-- 2) Index the previously unindexed FK auction_observations.canonical_source_url
create index if not exists idx_auction_observations_canonical_source_url
  on public.auction_observations (canonical_source_url);

-- 3) Fix auth_rls_initplan: wrap auth.uid()/auth.jwt() in scalar subqueries so
--    they are evaluated once per statement instead of once per row. Predicates
--    are otherwise identical to the previous policies.

-- user_favorites
drop policy if exists favorites_select_own on public.user_favorites;
create policy favorites_select_own on public.user_favorites
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists favorites_insert_own on public.user_favorites;
create policy favorites_insert_own on public.user_favorites
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists favorites_delete_own on public.user_favorites;
create policy favorites_delete_own on public.user_favorites
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- user_alerts
drop policy if exists alerts_select_own on public.user_alerts;
create policy alerts_select_own on public.user_alerts
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists alerts_insert_own on public.user_alerts;
create policy alerts_insert_own on public.user_alerts
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists alerts_update_own on public.user_alerts;
create policy alerts_update_own on public.user_alerts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists alerts_delete_own on public.user_alerts;
create policy alerts_delete_own on public.user_alerts
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- user_profiles: consolidate the two permissive SELECT policies into one
-- (fixes multiple_permissive_policies) and fix initplan on the update policy.
drop policy if exists user_profiles_select_own on public.user_profiles;
drop policy if exists user_profiles_select_admin on public.user_profiles;
drop policy if exists user_profiles_select_authorized on public.user_profiles;
create policy user_profiles_select_authorized on public.user_profiles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com'
  );

drop policy if exists user_profiles_update_own_limited on public.user_profiles;
create policy user_profiles_update_own_limited on public.user_profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

notify pgrst, 'reload schema';

commit;
