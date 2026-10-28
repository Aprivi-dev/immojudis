-- 20261108100100 (n° 41) : nombre de ventes à venir en attente de réobservation d'inondation (failure_count > 0),
-- lu par /admin/pepites.
--   * service_role seul peut appeler la fonction ; ni anon ni authenticated ;
--   * seules comptent les ventes à venir, datées dans le futur, dont la dernière tentative a échoué ;
--   * une vente réobservée avec succès (failure_count = 0) sort du compte.
begin;

select plan(7);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type
) values
  ('c7620000-1000-4000-8000-000000000001', 'flood-count-test', 'https://example.test/flood-count/1',
   'Pending sale', 'upcoming', '2099-01-01 12:00:00Z', 100000, 'tribunal'),
  ('c7620000-1000-4000-8000-000000000002', 'flood-count-test', 'https://example.test/flood-count/2',
   'Recovered sale', 'upcoming', '2099-01-02 12:00:00Z', 100000, 'tribunal'),
  ('c7620000-1000-4000-8000-000000000003', 'flood-count-test', 'https://example.test/flood-count/3',
   'Past sale', 'past', '2000-01-02 12:00:00Z', 100000, 'tribunal'),
  ('c7620000-1000-4000-8000-000000000004', 'flood-count-test', 'https://example.test/flood-count/4',
   'Stale date sale', 'upcoming', '2000-01-03 12:00:00Z', 100000, 'tribunal');

select ok(
  not has_function_privilege('anon', 'public.admin_count_flood_reobservation_pending(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_count_flood_reobservation_pending(timestamptz)', 'EXECUTE'),
  'neither a visitor nor an account can read the count'
);
select ok(
  has_function_privilege('service_role', 'public.admin_count_flood_reobservation_pending(timestamptz)', 'EXECUTE'),
  'service_role can read the count'
);

select is(
  public.admin_count_flood_reobservation_pending('2026-10-28T12:00:00Z'),
  0,
  'no stored verdict: nothing waits for a new observation'
);

insert into public.auction_sale_flood_risk (
  sale_id, verdict, derive_version, position_key, position_kind, observed_at, failure_count, last_failure
) values
  -- Jamais observée, tentative en échec.
  ('c7620000-1000-4000-8000-000000000001', 'unknown', 'flood-v1', 'point:address:abc', 'point', null, 2, 'network_econnreset'),
  -- Observée avec succès.
  ('c7620000-1000-4000-8000-000000000002', 'none_found', 'flood-v1', 'point:address:abc', 'point', now(), 0, null);
insert into public.auction_sale_flood_risk (
  sale_id, verdict, derive_version, position_key, position_kind, observed_at, failure_count, last_failure
) values
  -- Vente passée et vente à date dépassée : jamais comptées.
  ('c7620000-1000-4000-8000-000000000003', 'unknown', 'flood-v1', 'point:address:abc', 'point', null, 3, 'http_503'),
  ('c7620000-1000-4000-8000-000000000004', 'unknown', 'flood-v1', 'point:address:abc', 'point', null, 1, 'timeout');

select is(
  public.admin_count_flood_reobservation_pending('2026-10-28T12:00:00Z'),
  1,
  'only the upcoming sale whose last attempt failed is waiting'
);

update public.auction_sale_flood_risk
   set failure_count = 1, last_failure = 'http_503'
 where sale_id = 'c7620000-1000-4000-8000-000000000002';
select is(
  public.admin_count_flood_reobservation_pending('2026-10-28T12:00:00Z'),
  2,
  'a second upcoming sale with a failed attempt is counted'
);

update public.auction_sale_flood_risk
   set failure_count = 0, last_failure = null
 where sale_id in (
   'c7620000-1000-4000-8000-000000000001', 'c7620000-1000-4000-8000-000000000002'
 );
select is(
  public.admin_count_flood_reobservation_pending('2026-10-28T12:00:00Z'),
  0,
  'sales observed again successfully leave the count'
);

select is(
  public.admin_count_flood_reobservation_pending('2100-01-01T00:00:00Z'),
  0,
  'a sale whose date has passed is no longer upcoming'
);

select * from finish();
rollback;
