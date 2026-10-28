-- Écriture des correspondances d'alertes sans attente de verrou (migration 20261108110200) :
--   * fonction réservée au rôle de service, enveloppe `security invoker` ;
--   * elle écrit et rend les lignes, met à jour une ligne existante sans toucher `read_at` ni `dismissed_at` ;
--   * une vente disparue est sautée (absente du résultat) au lieu de faire échouer l'appel (23503).
-- Le saut d'une vente verrouillée par une autre transaction se vérifie à deux sessions (pgTAP n'en a qu'une).
begin;

select plan(9);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7720000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alert-matches-772@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c7720000-0000-4000-8000-0000000000a1', 'decouverte', 'active', null);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type
) values
  ('c7720000-1000-4000-8000-000000000001', 'alert-test', 'https://example.test/alert/1', 'Alert 1', 'upcoming',
   '2099-01-01 12:00:00Z', 100000, 'tribunal'),
  ('c7720000-1000-4000-8000-000000000002', 'alert-test', 'https://example.test/alert/2', 'Alert 2', 'upcoming',
   '2099-01-02 12:00:00Z', 100000, 'tribunal');

-- Un compte Découverte n'a droit qu'à une alerte hebdomadaire (même fixture que 475).
insert into public.user_alerts (id, user_id, name, alert_frequency)
values ('c7720000-2000-4000-8000-000000000001', 'c7720000-0000-4000-8000-0000000000a1', 'Alert 772', 'weekly');

select ok(
  not has_function_privilege('anon', 'public.upsert_user_alert_matches(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.upsert_user_alert_matches(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.upsert_user_alert_matches(jsonb)', 'EXECUTE'),
  'only service_role writes alert matches through the function'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.upsert_user_alert_matches(jsonb)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'public.upsert_user_alert_matches(jsonb)'::regprocedure),
  'the function is security invoker with an empty search_path'
);

create temporary table pgtap_772_results (label text, sale_id uuid, reasons text[], read_at timestamptz)
  on commit drop;
grant all on pgtap_772_results to public;

set local role service_role;
insert into pgtap_772_results
select 'first', sale_id, match_reasons, read_at
  from public.upsert_user_alert_matches(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', 'c7720000-0000-4000-8000-0000000000a1',
        'alert_id', 'c7720000-2000-4000-8000-000000000001',
        'sale_id', 'c7720000-1000-4000-8000-000000000001',
        'match_reasons', jsonb_build_array('first'),
        'matched_at', '2026-11-01T10:00:00Z',
        'match_snapshot', jsonb_build_object('k', 1)
      ),
      jsonb_build_object(
        'user_id', 'c7720000-0000-4000-8000-0000000000a1',
        'alert_id', 'c7720000-2000-4000-8000-000000000001',
        'sale_id', 'c7720000-1000-4000-8000-000000000002',
        'match_reasons', jsonb_build_array('second')
      ),
      jsonb_build_object(
        'user_id', 'c7720000-0000-4000-8000-0000000000a1',
        'alert_id', 'c7720000-2000-4000-8000-000000000001',
        'sale_id', 'c7720000-1000-4000-8000-0000000000ff',
        'match_reasons', jsonb_build_array('vanished')
      )
    )
  );
reset role;

select is(
  (select array_agg(sale_id::text order by sale_id) from pgtap_772_results where label = 'first'),
  array['c7720000-1000-4000-8000-000000000001', 'c7720000-1000-4000-8000-000000000002']::text[],
  'the written lines come back and the vanished sale is skipped without an error'
);
select is(
  (select count(*) from public.user_alert_matches where alert_id = 'c7720000-2000-4000-8000-000000000001'),
  2::bigint,
  'two lines are stored'
);
select is(
  (select match_snapshot -> 'k' from public.user_alert_matches
    where sale_id = 'c7720000-1000-4000-8000-000000000001'),
  '1'::jsonb,
  'the snapshot is stored'
);
select is(
  (select match_snapshot from public.user_alert_matches where sale_id = 'c7720000-1000-4000-8000-000000000002'),
  '{}'::jsonb,
  'an absent snapshot takes the column default, not NULL'
);

update public.user_alert_matches set read_at = '2026-11-01T11:00:00Z'
 where sale_id = 'c7720000-1000-4000-8000-000000000001';

set local role service_role;
insert into pgtap_772_results
select 'second', sale_id, match_reasons, read_at
  from public.upsert_user_alert_matches(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', 'c7720000-0000-4000-8000-0000000000a1',
        'alert_id', 'c7720000-2000-4000-8000-000000000001',
        'sale_id', 'c7720000-1000-4000-8000-000000000001',
        'match_reasons', jsonb_build_array('changed'),
        'matched_at', '2026-11-02T10:00:00Z'
      )
    )
  );
reset role;

select is(
  (select reasons from pgtap_772_results where label = 'second'),
  array['changed']::text[],
  'a second write of the same line replaces its reasons'
);
select ok(
  (select read_at is not null from pgtap_772_results where label = 'second'),
  'and keeps the read date of the account holder'
);
select is(
  (select count(*) from public.user_alert_matches where alert_id = 'c7720000-2000-4000-8000-000000000001'),
  2::bigint,
  'and creates no duplicate'
);

select * from finish();

rollback;
