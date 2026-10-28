-- 20261108202200 : cache des annonces refusées par la règle de minimum.
--   * table privée : ni anon ni authenticated n'y touchent, service_role la lit et l'écrit, RLS activée ;
--   * une URL n'y figure qu'une fois, la date et l'empreinte se rafraîchissent ;
--   * la purge supprime les refus de plus de 30 jours et garde les autres ; un délai trop court est refusé.
begin;

select plan(11);

select has_table('app_private', 'rejected_listings', 'the rejected listings cache exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.rejected_listings'::regclass),
  'row level security is enabled on the cache'
);
select ok(
  not has_table_privilege('anon', 'app_private.rejected_listings', 'SELECT')
  and not has_table_privilege('anon', 'app_private.rejected_listings', 'INSERT')
  and not has_table_privilege('authenticated', 'app_private.rejected_listings', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.rejected_listings', 'INSERT')
  and not has_table_privilege('authenticated', 'app_private.rejected_listings', 'DELETE'),
  'neither a visitor nor an account holds any right on the cache'
);
select ok(
  has_table_privilege('service_role', 'app_private.rejected_listings', 'SELECT')
  and has_table_privilege('service_role', 'app_private.rejected_listings', 'INSERT')
  and has_table_privilege('service_role', 'app_private.rejected_listings', 'UPDATE')
  and has_table_privilege('service_role', 'app_private.rejected_listings', 'DELETE'),
  'service_role reads, writes and purges the cache'
);

insert into app_private.rejected_listings (source_url, source_name, rejected_at, fingerprint) values
  ('https://www.vench.fr/vente-794-1', 'vench', '2026-11-09 12:00:00Z', 'sig-1'),
  ('https://www.vench.fr/vente-794-2', 'vench', '2026-10-05 12:00:00Z', 'sig-2'),
  ('https://www.vench.fr/vente-794-3', 'vench', '2026-09-01 12:00:00Z', null);

select throws_ok(
  $$insert into app_private.rejected_listings (source_url, source_name) values ('https://www.vench.fr/vente-794-1', 'vench')$$,
  '23505',
  null,
  'a listing is remembered once'
);
select lives_ok(
  $$insert into app_private.rejected_listings (source_url, source_name, fingerprint)
    values ('https://www.vench.fr/vente-794-1', 'vench', 'sig-new')
    on conflict (source_url) do update set fingerprint = excluded.fingerprint, rejected_at = now()$$,
  'a new refusal refreshes the date and the fingerprint'
);
select throws_ok(
  $$insert into app_private.rejected_listings (source_url, source_name, reason) values ('https://x.test/1', 'vench', 'other')$$,
  '23514',
  null,
  'the reason comes from a closed list'
);

select is(
  (app_private.purge_rejected_listings('2026-11-10 12:00:00Z') ->> 'rejected_listings')::integer,
  2,
  'the purge deletes the refusals older than 30 days (a missing fingerprint does not protect them)'
);
select is(
  (select array_agg(source_url order by source_url) from app_private.rejected_listings
    where source_url like 'https://www.vench.fr/vente-794-%'),
  array['https://www.vench.fr/vente-794-1']::text[],
  'a recent refusal stays'
);
select throws_ok(
  $$select app_private.purge_rejected_listings('2026-11-10 12:00:00Z', interval '1 hour')$$,
  '22023',
  null,
  'a purge delay under one day is refused'
);
select ok(
  not has_function_privilege('anon', 'app_private.purge_rejected_listings(timestamptz, interval)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.purge_rejected_listings(timestamptz, interval)', 'execute')
  and has_function_privilege('service_role', 'app_private.purge_rejected_listings(timestamptz, interval)', 'execute'),
  'the purge is closed to the browser roles'
);

select * from finish();
rollback;
