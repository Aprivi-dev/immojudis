begin;

select plan(47);

-- 20261027100000 : la visibilité publique ne lit plus raw_payload. Ce test prouve que l'ancien
-- prédicat (sale_catalogue_entry_is_live_materialized + raw_payload->>'publication_quarantine') et le
-- nouveau (sale_catalogue_projection_is_live + catalogue_quarantined) retiennent exactement les mêmes
-- annonces, sur tous les cas : quarantaine, sans date, date passée, date future, procédure de vente.
-- Les lignes insérées sont annulées en fin de test.

-- Structure et droits -------------------------------------------------------------------------

select has_column('public', 'auction_sales', 'catalogue_expiry_fallback', 'la valeur de repli est matérialisée');
select has_column('public', 'auction_sales', 'catalogue_state_observed_at', 'la date d''observation de la fiche de l''État est matérialisée');
select has_column('public', 'auction_sales', 'catalogue_state_end_estimate', 'la fin de publication estimée est matérialisée');

select ok(
  has_column_privilege('authenticated', 'public.auction_sales', 'catalogue_quarantined', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'catalogue_expiry_fallback', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'catalogue_state_observed_at', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'catalogue_state_end_estimate', 'select')
  and not has_table_privilege('authenticated', 'public.auction_sales', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'retention_deadline', 'select'),
  'authenticated lit les colonnes matérialisées (vue invoker) sans retrouver de lecture de table entière'
);

select ok(
  has_function_privilege('anon', 'app_private.sale_catalogue_projection_is_live(boolean,timestamptz,timestamptz,timestamptz,timestamptz,date)', 'execute')
  and has_function_privilege('authenticated', 'app_private.sale_catalogue_projection_is_live(boolean,timestamptz,timestamptz,timestamptz,timestamptz,date)', 'execute')
  and has_function_privilege('service_role', 'app_private.sale_catalogue_projection_is_live(boolean,timestamptz,timestamptz,timestamptz,timestamptz,date)', 'execute')
  and has_function_privilege('anon', 'app_private.sale_catalogue_entry_is_live_materialized(boolean,timestamptz,timestamptz,jsonb,jsonb)', 'execute')
  and has_function_privilege('authenticated', 'app_private.sale_catalogue_entry_is_live_materialized(boolean,timestamptz,timestamptz,jsonb,jsonb)', 'execute'),
  'le nouveau prédicat a les droits de l''ancien (anon, authenticated, service_role)'
);

select ok(
  not has_function_privilege('anon', 'app_private.catalogue_visibility_projection(boolean,timestamptz,timestamptz,jsonb,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.catalogue_visibility_projection(boolean,timestamptz,timestamptz,jsonb,jsonb)', 'execute')
  and has_function_privilege('service_role', 'app_private.catalogue_visibility_projection(boolean,timestamptz,timestamptz,jsonb,jsonb)', 'execute')
  and not has_function_privilege('anon', 'app_private.sync_auction_sale_catalogue_visibility()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.sync_auction_sale_catalogue_visibility()', 'execute'),
  'le calcul de la projection et son déclencheur restent fermés aux rôles du navigateur'
);

select ok(
  (select count(*) = 2
   from pg_trigger trigger_row
   where trigger_row.tgrelid = 'public.auction_sales'::regclass
     and trigger_row.tgname in (
       'zzzzz_auction_sales_catalogue_visibility_insert',
       'zzzzz_auction_sales_catalogue_visibility_update'
     )
     and trigger_row.tgenabled = 'O'),
  'les déclencheurs de la projection sont actifs'
);

-- Plus aucune lecture de raw_payload dans les prédicats de visibilité ----------------------------

select ok(
  not exists (
    select 1
    from unnest(array['public.v_auction_sales_app', 'public.v_auction_sales_discovery']) as view_name
    where pg_get_viewdef(view_name::regclass) ~* 'publication_quarantine'
       or pg_get_viewdef(view_name::regclass) ~* 'sale_catalogue_entry_is_live'
  )
  and pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 'sale_catalogue_projection_is_live\('
  and pg_get_viewdef('public.v_auction_sales_discovery'::regclass) ~ 'sale_catalogue_projection_is_live\(',
  'les vues app et discovery ne relisent plus ni la quarantaine ni la visibilité dans raw_payload'
);

select ok(
  not exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
    where schema_row.nspname = 'app_private'
      and procedure_row.proname in (
        'auction_sale_is_publicly_visible', 'search_auction_sales_preview',
        'search_auction_sales_preview_v2', 'search_auction_sales_preview_v3',
        'search_auction_sales_preview_v4', 'list_public_sale_sitemap_entries',
        'get_public_sale_summary', 'get_public_sale_details', 'get_public_tribunal_activity',
        'get_public_sale_indexability', 'get_public_sale_calendar_event', 'sale_photo_mirrors'
      )
      and (
        pg_get_functiondef(procedure_row.oid) ~* 'publication_quarantine'
        or pg_get_functiondef(procedure_row.oid) ~* 'sale_catalogue_entry_is_live_materialized\('
        or pg_get_functiondef(procedure_row.oid) !~ 'sale_catalogue_projection_is_live\('
        or pg_get_functiondef(procedure_row.oid) !~ 'catalogue_quarantined'
      )
  ),
  'les fonctions publiques de visibilité lisent les colonnes matérialisées, plus raw_payload'
);

select ok(
  exists (
    select 1
    from pg_policy policy_row
    where policy_row.polrelid = 'public.auction_sales'::regclass
      and policy_row.polname = 'auction_sales_authenticated_read'
      and pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%is_admin%'
      and pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%catalogue_quarantined%'
      and pg_get_expr(policy_row.polqual, policy_row.polrelid) not like '%publication_quarantine%'
  ),
  'la politique des comptes connectés garde l''accès administrateur et lit la colonne de quarantaine'
);

-- La réécriture des définitions garde SECURITY DEFINER et le search_path vide de chaque fonction.
select ok(
  (select count(*) >= 10
   from pg_proc procedure_row
   join pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
   where schema_row.nspname = 'app_private'
     and procedure_row.proname in (
       'auction_sale_is_publicly_visible', 'search_auction_sales_preview',
       'search_auction_sales_preview_v2', 'search_auction_sales_preview_v3',
       'search_auction_sales_preview_v4', 'list_public_sale_sitemap_entries',
       'get_public_sale_summary', 'get_public_sale_details', 'get_public_tribunal_activity',
       'get_public_sale_indexability', 'get_public_sale_calendar_event', 'sale_photo_mirrors'
     ))
  and not exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
    where schema_row.nspname = 'app_private'
      and procedure_row.proname in (
        'auction_sale_is_publicly_visible', 'search_auction_sales_preview',
        'search_auction_sales_preview_v2', 'search_auction_sales_preview_v3',
        'search_auction_sales_preview_v4', 'list_public_sale_sitemap_entries',
        'get_public_sale_summary', 'get_public_sale_details', 'get_public_tribunal_activity',
        'get_public_sale_indexability', 'get_public_sale_calendar_event', 'sale_photo_mirrors'
      )
      and (
        not procedure_row.prosecdef
        or procedure_row.proconfig is null
        or not (procedure_row.proconfig @> array['search_path=""'])
      )
  ),
  'les fonctions publiques de visibilité restent SECURITY DEFINER avec search_path vide'
);

-- La fonction dormante de l'étape 2 de P4-01 recolle un prédicat de visibilité dans un texte SQL : elle
-- doit lire la colonne, comme les vues (sinon l'ancien prédicat reviendrait en l'activant).
select ok(
  pg_get_functiondef('app_private.set_catalogue_raw_columns_hidden(boolean)'::regprocedure)
    !~* 'publication_quarantine'
  and pg_get_functiondef('app_private.set_catalogue_raw_columns_hidden(boolean)'::regprocedure)
    ~ 's\.catalogue_quarantined'
  and (select proconfig @> array['search_path=""'] and not prosecdef
       from pg_proc
       where oid = 'app_private.set_catalogue_raw_columns_hidden(boolean)'::regprocedure),
  'set_catalogue_raw_columns_hidden lit catalogue_quarantined (plus raw_payload) et garde ses réglages'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------

create function pg_temp.iso(p_at timestamptz) returns text language sql as
  $$ select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') $$;

insert into public.auction_sales (id, source_name, source_url, status, sale_date, raw_payload, sale_procedure)
values
  -- 01 date future, 02 date passée, 03 date future mais quarantaine, 04 ni date ni fiche de l'État
  ('c4700000-0000-4000-8000-000000000001', 'licitor', 'https://example.test/470/01', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000002', 'licitor', 'https://example.test/470/02', 'upcoming',
    current_timestamp - interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000003', 'licitor', 'https://example.test/470/03', 'upcoming',
    current_timestamp + interval '3 days', '{"publication_quarantine": "operator_hold"}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000004', 'licitor', 'https://example.test/470/04', 'upcoming',
    null, '{}'::jsonb, '{}'::jsonb),
  -- 05 à 11 : sans date, fiche de l'État (fraîche, périmée, avec fin future, fin passée, fin aujourd'hui,
  -- format invalide, autre source)
  ('c4700000-0000-4000-8000-000000000005', 'cessions_etat', 'https://example.test/470/05', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '1 day'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000006', 'cessions_etat', 'https://example.test/470/06', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '30 days'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000007', 'cessions_etat', 'https://example.test/470/07', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '1 day'),
      'listing_end_estimate', to_char(current_date + 20, 'YYYY-MM-DD'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000008', 'cessions_etat', 'https://example.test/470/08', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '1 day'),
      'listing_end_estimate', to_char(current_date - 3, 'YYYY-MM-DD'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000009', 'cessions_etat', 'https://example.test/470/09', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '1 day'),
      'listing_end_estimate', to_char((current_timestamp at time zone 'Europe/Paris')::date, 'YYYY-MM-DD'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000010', 'cessions_etat', 'https://example.test/470/10', 'upcoming', null,
    '{"source_name": "cessions_etat", "state_listing": {"active": true, "observed_at": "hier"}}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000011', 'licitor', 'https://example.test/470/11', 'upcoming', null,
    jsonb_build_object('source_name', 'licitor', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '1 day'))), '{}'::jsonb),
  -- 12 et 13 : vente reportée (date limite matérialisée nulle), date future puis passée
  ('c4700000-0000-4000-8000-000000000012', 'licitor', 'https://example.test/470/12', 'postponed',
    current_timestamp + interval '10 days', '{"status": "postponed"}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000013', 'licitor', 'https://example.test/470/13', 'postponed',
    current_timestamp - interval '3 days', '{"status": "postponed"}'::jsonb, '{}'::jsonb),
  -- 14 et 15 : conflit de dates, date future puis passée
  ('c4700000-0000-4000-8000-000000000014', 'licitor', 'https://example.test/470/14', 'upcoming',
    current_timestamp + interval '5 days', '{"source_conflicts": [{"field": "sale_date"}]}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000015', 'licitor', 'https://example.test/470/15', 'upcoming',
    current_timestamp - interval '5 days', '{"source_conflicts": [{"field": "sale_date"}]}'::jsonb, '{}'::jsonb),
  -- 16 et 17 : conflit de dates et calendrier en ligne (sale_procedure) qui se ferme dans le futur, puis
  -- dans le passé, alors que sale_date est à l'inverse
  ('c4700000-0000-4000-8000-000000000016', 'licitor', 'https://example.test/470/16', 'upcoming',
    current_timestamp - interval '10 days', '{"source_conflicts": [{"field": "sale_date"}]}'::jsonb,
    jsonb_build_object('sale_window', jsonb_build_object(
      'opens_at', pg_temp.iso(current_timestamp - interval '12 days'),
      'closes_at', pg_temp.iso(current_timestamp + interval '2 days')))),
  ('c4700000-0000-4000-8000-000000000017', 'licitor', 'https://example.test/470/17', 'upcoming',
    current_timestamp + interval '5 days', '{"source_conflicts": [{"field": "sale_date"}]}'::jsonb,
    jsonb_build_object('sale_window', jsonb_build_object(
      'opens_at', pg_temp.iso(current_timestamp - interval '3 days'),
      'closes_at', pg_temp.iso(current_timestamp - interval '1 day')))),
  -- 18 et 19 : calendrier en ligne illisible (la date limite reste nulle), date future puis passée
  ('c4700000-0000-4000-8000-000000000018', 'licitor', 'https://example.test/470/18', 'upcoming',
    current_timestamp + interval '4 days', '{}'::jsonb,
    jsonb_build_object('sale_window', jsonb_build_object('opens_at', pg_temp.iso(current_timestamp)))),
  ('c4700000-0000-4000-8000-000000000019', 'licitor', 'https://example.test/470/19', 'upcoming',
    current_timestamp - interval '4 days', '{}'::jsonb,
    jsonb_build_object('sale_window', jsonb_build_object('opens_at', pg_temp.iso(current_timestamp)))),
  -- 20 date infinie, 21 statut passé, 22 statut en quarantaine (écartés par le statut ou la date)
  ('c4700000-0000-4000-8000-000000000020', 'licitor', 'https://example.test/470/20', 'upcoming',
    'infinity'::timestamptz, '{}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000021', 'licitor', 'https://example.test/470/21', 'past',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000022', 'licitor', 'https://example.test/470/22', 'quarantined',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  -- 23 et 24 : date seule (sans heure), aujourd'hui puis hier, à minuit à Paris
  ('c4700000-0000-4000-8000-000000000023', 'licitor', 'https://example.test/470/23', 'upcoming',
    ((current_timestamp at time zone 'Europe/Paris')::date::timestamp at time zone 'Europe/Paris'),
    jsonb_build_object('sale_date', to_char((current_timestamp at time zone 'Europe/Paris')::date, 'YYYY-MM-DD')),
    '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000024', 'licitor', 'https://example.test/470/24', 'upcoming',
    (((current_timestamp at time zone 'Europe/Paris')::date - 1)::timestamp at time zone 'Europe/Paris'),
    jsonb_build_object('sale_date', to_char((current_timestamp at time zone 'Europe/Paris')::date - 1, 'YYYY-MM-DD')),
    '{}'::jsonb),
  -- 25 calendrier en ligne valide : la date limite matérialisée est la clôture, malgré sale_date passée
  ('c4700000-0000-4000-8000-000000000025', 'licitor', 'https://example.test/470/25', 'upcoming',
    current_timestamp - interval '2 days', '{}'::jsonb,
    jsonb_build_object('sale_window', jsonb_build_object(
      'opens_at', pg_temp.iso(current_timestamp - interval '3 days'),
      'closes_at', pg_temp.iso(current_timestamp + interval '2 days')))),
  -- 26 propre, que le test met en quarantaine puis relève ; 27 marqueur vide ; 28 marqueur nul
  ('c4700000-0000-4000-8000-000000000026', 'licitor', 'https://example.test/470/26', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000027', 'licitor', 'https://example.test/470/27', 'upcoming',
    current_timestamp + interval '3 days', '{"publication_quarantine": ""}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000028', 'licitor', 'https://example.test/470/28', 'upcoming',
    current_timestamp + interval '3 days', '{"publication_quarantine": null}'::jsonb, '{}'::jsonb),
  -- 29 à 32 : bornes de la fiche de l'État. 29 observée dans plus d'un jour dans le futur (masquée : c'est
  -- la condition « au plus un jour dans le futur »), 30 dans 23 h (visible), 31 il y a 13 jours et 23 h
  -- (visible), 32 il y a 14 jours et 1 minute (masquée : fenêtre de 14 jours)
  ('c4700000-0000-4000-8000-000000000029', 'cessions_etat', 'https://example.test/470/29', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp + interval '2 days'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000030', 'cessions_etat', 'https://example.test/470/30', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp + interval '23 hours'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000031', 'cessions_etat', 'https://example.test/470/31', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '13 days 23 hours'))), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000032', 'cessions_etat', 'https://example.test/470/32', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '14 days 1 minute'))), '{}'::jsonb),
  -- 33 : conflit de dates, date future, calendrier en ligne absent ; le test change ensuite sa seule
  -- sale_procedure. 34 : à venir, date future, date limite matérialisée ; le test la passe ensuite en
  -- « postponed » sans toucher à sale_date.
  ('c4700000-0000-4000-8000-000000000033', 'licitor', 'https://example.test/470/33', 'upcoming',
    current_timestamp + interval '6 days', '{"source_conflicts": [{"field": "sale_date"}]}'::jsonb, '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000034', 'licitor', 'https://example.test/470/34', 'upcoming',
    current_timestamp + interval '7 days', '{}'::jsonb, '{}'::jsonb);

-- Les valeurs matérialisées ---------------------------------------------------------------------------

select is(
  (select array_agg(id::text order by id) from public.auction_sales
    where id::text like 'c4700000-%' and catalogue_expiry_deadline is null and catalogue_expiry_materialized),
  array[
    'c4700000-0000-4000-8000-000000000004', 'c4700000-0000-4000-8000-000000000005',
    'c4700000-0000-4000-8000-000000000006', 'c4700000-0000-4000-8000-000000000007',
    'c4700000-0000-4000-8000-000000000008', 'c4700000-0000-4000-8000-000000000009',
    'c4700000-0000-4000-8000-000000000010', 'c4700000-0000-4000-8000-000000000011',
    'c4700000-0000-4000-8000-000000000012', 'c4700000-0000-4000-8000-000000000013',
    'c4700000-0000-4000-8000-000000000014', 'c4700000-0000-4000-8000-000000000015',
    'c4700000-0000-4000-8000-000000000016', 'c4700000-0000-4000-8000-000000000017',
    'c4700000-0000-4000-8000-000000000018', 'c4700000-0000-4000-8000-000000000019',
    'c4700000-0000-4000-8000-000000000020', 'c4700000-0000-4000-8000-000000000029',
    'c4700000-0000-4000-8000-000000000030', 'c4700000-0000-4000-8000-000000000031',
    'c4700000-0000-4000-8000-000000000032', 'c4700000-0000-4000-8000-000000000033'
  ],
  'le jeu d''essai couvre bien les annonces sans date limite matérialisée (le repli exercé)'
);

select is(
  (select count(*) from public.auction_sales
    where id::text like 'c4700000-%'
      and catalogue_expiry_deadline is not null
      and (catalogue_expiry_fallback is not null
        or catalogue_state_observed_at is not null
        or catalogue_state_end_estimate is not null)),
  0::bigint,
  'une date limite matérialisée laisse les trois colonnes de repli nulles'
);

select ok(
  (select catalogue_state_observed_at is not null and catalogue_state_end_estimate is null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000005')
  and (select catalogue_state_end_estimate = current_date + 20
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000007')
  and (select catalogue_state_observed_at is null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000010')
  and (select catalogue_state_observed_at is null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000011')
  and (select catalogue_expiry_fallback is not null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000012'),
  'la fiche de l''État valide est matérialisée ; format invalide et autre source ne le sont pas'
);

select is(
  (select count(*) from public.auction_sales
    where catalogue_quarantined is distinct from (coalesce(raw_payload ->> 'publication_quarantine', '') <> '')),
  0::bigint,
  'catalogue_quarantined est partout égale à coalesce(raw_payload->>''publication_quarantine'', '''') <> '''''
);

-- Équivalence ancien / nouveau prédicat -----------------------------------------------------------------

create temp table old_visible on commit drop as
select s.id
from public.auction_sales s
where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
  and coalesce(app_private.sale_catalogue_entry_is_live_materialized(
    s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date, s.raw_payload, s.sale_procedure
  ), false)
  and coalesce(s.raw_payload ->> 'publication_quarantine', '') = '';

create temp table new_visible on commit drop as
select s.id
from public.auction_sales s
where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
  and app_private.sale_catalogue_projection_is_live(
    s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date,
    s.catalogue_expiry_fallback, s.catalogue_state_observed_at, s.catalogue_state_end_estimate
  )
  and not s.catalogue_quarantined;

select is(
  (select array_agg(id::text order by id) from old_visible where id::text like 'c4700000-%'),
  array[
    'c4700000-0000-4000-8000-000000000001', 'c4700000-0000-4000-8000-000000000005',
    'c4700000-0000-4000-8000-000000000007', 'c4700000-0000-4000-8000-000000000009',
    'c4700000-0000-4000-8000-000000000012', 'c4700000-0000-4000-8000-000000000014',
    'c4700000-0000-4000-8000-000000000016', 'c4700000-0000-4000-8000-000000000018',
    'c4700000-0000-4000-8000-000000000023', 'c4700000-0000-4000-8000-000000000025',
    'c4700000-0000-4000-8000-000000000026', 'c4700000-0000-4000-8000-000000000027',
    'c4700000-0000-4000-8000-000000000028', 'c4700000-0000-4000-8000-000000000030',
    'c4700000-0000-4000-8000-000000000031', 'c4700000-0000-4000-8000-000000000033',
    'c4700000-0000-4000-8000-000000000034'
  ],
  'l''ancien prédicat retient les annonces attendues du jeu d''essai'
);

select is(
  (select array_agg(id::text order by id) from new_visible where id::text like 'c4700000-%'),
  (select array_agg(id::text order by id) from old_visible where id::text like 'c4700000-%'),
  'le nouveau prédicat retient les mêmes annonces du jeu d''essai'
);

select is(
  (select count(*) from (select id from new_visible except select id from old_visible) x),
  0::bigint,
  'aucune annonce masquée par l''ancien prédicat ne devient visible'
);

select is(
  (select count(*) from (select id from old_visible except select id from new_visible) x),
  0::bigint,
  'aucune annonce visible ne disparaît'
);

-- Requête de contrôle de production (lecture seule, aucune colonne nouvelle) ------------------------------
-- Même corps que la requête fournie avec la migration : elle calcule à la volée les trois valeurs
-- matérialisées et compare les deux prédicats ligne à ligne. Ici, elle doit trouver les mêmes valeurs
-- que les colonnes matérialisées par le déclencheur, et aucune différence.

create temp table control_rows on commit drop as
with prep as (
  select
    s.id,
    coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed') as status_ok,
    s.catalogue_expiry_materialized as materialized,
    s.catalogue_expiry_deadline as deadline,
    s.sale_date,
    s.catalogue_quarantined as quarantined_column,
    coalesce(s.raw_payload ->> 'publication_quarantine', '') <> '' as quarantined_payload,
    coalesce(app_private.sale_catalogue_entry_is_live_materialized(
      s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date,
      s.raw_payload, s.sale_procedure
    ), false) as old_live,
    (s.catalogue_expiry_materialized and s.catalogue_expiry_deadline is not null) as fast_path,
    s.raw_payload,
    s.sale_procedure
  from public.auction_sales s
),
proj as (
  select
    p.*,
    case when not p.fast_path then app_private.sale_catalogue_expiry(
      p.sale_date,
      (case
        when jsonb_typeof(coalesce(p.raw_payload, '{}'::jsonb)) = 'object'
          then coalesce(p.raw_payload, '{}'::jsonb)
        else '{}'::jsonb
       end) || jsonb_build_object('sale_procedure', coalesce(p.sale_procedure, '{}'::jsonb))
    ) end as expiry_fallback,
    (not p.fast_path
      and p.sale_date is null
      and jsonb_typeof(p.raw_payload -> 'state_listing') = 'object'
      and coalesce(p.raw_payload ->> 'source_name', '') = 'cessions_etat'
      and coalesce(p.raw_payload -> 'state_listing' ->> 'active', '') = 'true'
      and coalesce(p.raw_payload -> 'state_listing' ->> 'observed_at', '')
        ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
      and coalesce(p.raw_payload -> 'state_listing' ->> 'listing_end_estimate', '')
        ~ '^(\d{4}-\d{2}-\d{2})?$') as state_ok
  from prep p
),
vals as (
  select
    q.*,
    case when q.state_ok then (q.raw_payload -> 'state_listing' ->> 'observed_at')::timestamptz end
      as state_observed_at,
    case when q.state_ok
      then nullif(q.raw_payload -> 'state_listing' ->> 'listing_end_estimate', '')::date end
      as state_end_estimate
  from proj q
),
final as (
  select
    v.*,
    case
      when not coalesce(v.materialized, false) then false
      when v.deadline is not null then v.deadline > current_timestamp
      when v.sale_date is null then coalesce(
        v.state_observed_at > current_timestamp - interval '14 days'
        and v.state_observed_at <= current_timestamp + interval '1 day'
        and (
          v.state_end_estimate is null
          or v.state_end_estimate >= (current_timestamp at time zone 'Europe/Paris')::date
        ),
        false
      )
      else coalesce(v.expiry_fallback > current_timestamp, false)
    end as new_live
  from vals v
)
select
  f.id, f.status_ok, f.materialized, f.deadline, f.sale_date,
  f.quarantined_column, f.quarantined_payload, f.old_live, f.new_live,
  f.expiry_fallback, f.state_observed_at, f.state_end_estimate,
  (f.status_ok and f.old_live and not f.quarantined_payload) as old_visible,
  (f.status_ok and f.new_live and not f.quarantined_column) as new_visible
from final f;

select is(
  (select count(*) from control_rows
    where old_visible is distinct from new_visible
       or quarantined_column is distinct from quarantined_payload
       or not materialized),
  0::bigint,
  'la requête de contrôle ne trouve aucune différence de visibilité, de quarantaine ni de matérialisation'
);

select is(
  (select count(*)
     from control_rows control
     join public.auction_sales s on s.id = control.id
    where control.expiry_fallback is distinct from s.catalogue_expiry_fallback
       or control.state_observed_at is distinct from s.catalogue_state_observed_at
       or control.state_end_estimate is distinct from s.catalogue_state_end_estimate),
  0::bigint,
  'les valeurs calculées à la volée par la requête de contrôle sont celles que le déclencheur matérialise'
);

-- Les objets publics suivent -----------------------------------------------------------------------------

select is(
  (select array_agg(id::text order by id) from public.auction_sales
    where id::text like 'c4700000-%' and app_private.auction_sale_is_publicly_visible(id)),
  (select array_agg(id::text order by id) from old_visible where id::text like 'c4700000-%'),
  'auction_sale_is_publicly_visible (aperçu anonyme, déblocage) retient les mêmes annonces'
);

select is(
  (select array_agg(id::text order by id) from public.v_auction_sales_app where id::text like 'c4700000-%'),
  (select array_agg(id::text order by id) from old_visible where id::text like 'c4700000-%'),
  'v_auction_sales_app retient les mêmes annonces'
);

select is(
  (select array_agg(id::text order by id) from public.v_auction_sales_discovery where id::text like 'c4700000-%'),
  (select array_agg(id::text order by id) from old_visible where id::text like 'c4700000-%'),
  'v_auction_sales_discovery retient les mêmes annonces'
);

select is(
  (select array_agg(id::text order by id)
     from app_private.search_auction_sales_preview_v3(p_limit => 100)
    where id::text like 'c4700000-%'),
  (select array_agg(id::text order by id) from old_visible where id::text like 'c4700000-%'),
  'la recherche publique v3 retient les mêmes annonces'
);

select is(
  (select array_agg(id::text order by id)
     from app_private.search_auction_sales_preview_v4(p_limit => 100)
    where id::text like 'c4700000-%'),
  (select array_agg(id::text order by id) from old_visible where id::text like 'c4700000-%'),
  'la recherche publique v4 retient les mêmes annonces'
);

-- La quarantaine suit raw_payload à l'écriture ---------------------------------------------------------

update public.auction_sales
set raw_payload = raw_payload || '{"publication_quarantine": "operator_hold"}'::jsonb
where id = 'c4700000-0000-4000-8000-000000000026';

select ok(
  (select catalogue_quarantined from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000026')
  and not app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000026')
  and not exists (select 1 from public.v_auction_sales_discovery where id = 'c4700000-0000-4000-8000-000000000026'),
  'un marqueur de quarantaine posé masque aussitôt l''annonce'
);

update public.auction_sales
set raw_payload = raw_payload - 'publication_quarantine'
where id = 'c4700000-0000-4000-8000-000000000026';

select ok(
  not (select catalogue_quarantined from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000026')
  and app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000026'),
  'le marqueur retiré, l''annonce redevient visible'
);

-- Une écriture directe de la colonne ne contourne rien : raw_payload reste la source de vérité, la
-- colonne est recalculée à chaque écriture, même si raw_payload ne change pas.
update public.auction_sales
set catalogue_quarantined = false
where id = 'c4700000-0000-4000-8000-000000000003';

update public.auction_sales
set catalogue_quarantined = true
where id = 'c4700000-0000-4000-8000-000000000001';

select ok(
  (select catalogue_quarantined from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000003')
  and not app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000003')
  and not exists (select 1 from public.v_auction_sales_discovery where id = 'c4700000-0000-4000-8000-000000000003'),
  'une annonce en quarantaine dont on écrit catalogue_quarantined = false reste masquée (colonne corrigée)'
);

select ok(
  not (select catalogue_quarantined from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000001')
  and app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000001'),
  'une annonce propre dont on écrit catalogue_quarantined = true reste visible (colonne corrigée)'
);

-- Les valeurs de repli suivent les écritures ---------------------------------------------------------

update public.auction_sales
set sale_date = current_timestamp - interval '2 days'
where id = 'c4700000-0000-4000-8000-000000000012';

select ok(
  (select catalogue_expiry_fallback < current_timestamp
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000012')
  and not app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000012'),
  'une vente reportée dont la date passe sort du catalogue sans relire raw_payload'
);

update public.auction_sales
set raw_payload = jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '1 hour')))
where id = 'c4700000-0000-4000-8000-000000000004';

select ok(
  (select catalogue_state_observed_at is not null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000004')
  and app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000004'),
  'une fiche de l''État posée sur une annonce sans date la rend visible'
);

update public.auction_sales
set sale_date = current_timestamp + interval '2 days'
where id = 'c4700000-0000-4000-8000-000000000004';

select ok(
  (select catalogue_state_observed_at is null and catalogue_expiry_deadline is not null
          and catalogue_expiry_fallback is null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000004')
  and app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000004'),
  'une date renseignée remplace la fiche : date limite matérialisée, colonnes de repli vidées'
);

-- Une écriture directe des colonnes matérialisées est recalculée : elle ne peut pas rendre visible.
update public.auction_sales
set catalogue_expiry_fallback = current_timestamp + interval '100 days',
    catalogue_state_observed_at = current_timestamp
where id = 'c4700000-0000-4000-8000-000000000013';

select ok(
  (select catalogue_expiry_fallback < current_timestamp and catalogue_state_observed_at is null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000013')
  and not app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000013'),
  'une écriture directe des colonnes de repli est recalculée par le déclencheur'
);

-- Changement de sale_procedure seul : sale_date et raw_payload ne bougent pas. Le calendrier en ligne se
-- ferme dans le passé, la valeur de repli suit et l'annonce sort du catalogue.
update public.auction_sales
set sale_procedure = jsonb_build_object('sale_window', jsonb_build_object(
      'opens_at', pg_temp.iso(current_timestamp - interval '12 days'),
      'closes_at', pg_temp.iso(current_timestamp - interval '1 day')))
where id = 'c4700000-0000-4000-8000-000000000033';

select ok(
  (select catalogue_expiry_deadline is null and catalogue_expiry_fallback < current_timestamp
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000033')
  and not app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000033'),
  'un changement de sale_procedure seul recalcule la valeur de repli'
);

-- Transition à venir -> reportée seule : sale_date ne bouge pas, mais la date limite matérialisée
-- disparaît. La valeur de repli prend le relais, l'annonce reste visible jusqu'à sa date.
select ok(
  (select catalogue_expiry_deadline is not null and catalogue_expiry_fallback is null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000034'),
  'avant la transition, l''annonce à venir a une date limite et aucune valeur de repli'
);

update public.auction_sales
set status = 'postponed'
where id = 'c4700000-0000-4000-8000-000000000034';

select ok(
  (select catalogue_expiry_deadline is null and catalogue_expiry_fallback > current_timestamp
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000034')
  and app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000034')
  and exists (select 1 from public.v_auction_sales_discovery where id = 'c4700000-0000-4000-8000-000000000034'),
  'la transition upcoming -> postponed seule matérialise la valeur de repli (annonce toujours visible)'
);

-- Valeurs que les formats acceptent mais que le calendrier refuse : jamais d'écriture refusée, l'annonce
-- est seulement masquée (l'ancien prédicat, lui, levait l'erreur à chaque lecture).
insert into public.auction_sales (id, source_name, source_url, status, sale_date, raw_payload, sale_procedure)
values
  -- 35 jour inexistant dans observed_at, 36 décalage horaire +99:00, 37 fin de publication au 30 février
  ('c4700000-0000-4000-8000-000000000035', 'cessions_etat', 'https://example.test/470/35', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', '2026-02-30T10:00:00+00:00')), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000036', 'cessions_etat', 'https://example.test/470/36', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', '2026-10-16T10:00:00+99:00')), '{}'::jsonb),
  ('c4700000-0000-4000-8000-000000000037', 'cessions_etat', 'https://example.test/470/37', 'upcoming', null,
    jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', pg_temp.iso(current_timestamp - interval '1 day'),
      'listing_end_estimate', '2026-02-30')), '{}'::jsonb);

select ok(
  (select count(*) = 3
     and bool_and(catalogue_state_observed_at is null and catalogue_state_end_estimate is null
                  and catalogue_expiry_materialized)
     from public.auction_sales
     where id in ('c4700000-0000-4000-8000-000000000035', 'c4700000-0000-4000-8000-000000000036',
                  'c4700000-0000-4000-8000-000000000037'))
  and not exists (
    select 1
    from public.auction_sales
    where id in ('c4700000-0000-4000-8000-000000000035', 'c4700000-0000-4000-8000-000000000036',
                 'c4700000-0000-4000-8000-000000000037')
      and (app_private.auction_sale_is_publicly_visible(id)
           or exists (select 1 from public.v_auction_sales_discovery d where d.id = auction_sales.id))
  ),
  'observed_at au 30 février, observed_at en +99:00 et fin au 30 février : insertion acceptée, annonce masquée'
);

-- Même chose en mise à jour : une fiche valide dont la date devient impossible n'empêche pas l'écriture.
update public.auction_sales
set raw_payload = jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
      'active', true, 'observed_at', '2026-10-16T10:00:00-99:00'))
where id = 'c4700000-0000-4000-8000-000000000007';

select ok(
  (select catalogue_state_observed_at is null and catalogue_state_end_estimate is null
     from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000007')
  and not app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000007'),
  'une mise à jour vers un décalage horaire impossible est acceptée et masque l''annonce'
);

-- Requête de dérive du runbook (docs/runbooks/catalogue-visibility-projection.md) : zéro ligne tant que
-- les déclencheurs sont actifs, une ligne dès qu'une écriture les contourne.
select is(
  (select count(*) from public.auction_sales
    where catalogue_quarantined is distinct from (coalesce(raw_payload ->> 'publication_quarantine', '') <> '')),
  0::bigint,
  'la requête de dérive ne trouve rien quand les déclencheurs ont fait leur travail'
);

alter table public.auction_sales disable trigger user;
update public.auction_sales
set raw_payload = raw_payload || '{"publication_quarantine": "operator_hold"}'::jsonb
where id = 'c4700000-0000-4000-8000-000000000026';
alter table public.auction_sales enable trigger user;

select is(
  (select array_agg(id::text order by id) from public.auction_sales
    where catalogue_quarantined is distinct from (coalesce(raw_payload ->> 'publication_quarantine', '') <> '')),
  array['c4700000-0000-4000-8000-000000000026'],
  'la requête de dérive repère une quarantaine écrite hors déclencheur'
);

-- Le rattrapage de la migration corrigerait cette ligne ; ici la réécriture de raw_payload la rattrape
-- par le déclencheur (le WHEN couvre raw_payload).
update public.auction_sales
set raw_payload = raw_payload || '{"touched": true}'::jsonb
where id = 'c4700000-0000-4000-8000-000000000026';

select ok(
  (select catalogue_quarantined from public.auction_sales where id = 'c4700000-0000-4000-8000-000000000026')
  and not app_private.auction_sale_is_publicly_visible('c4700000-0000-4000-8000-000000000026'),
  'une écriture suivante, déclencheurs actifs, corrige la dérive et masque l''annonce'
);

-- Le prédicat lui-même ----------------------------------------------------------------------------------

select ok(
  app_private.sale_catalogue_projection_is_live(true, current_timestamp + interval '1 day', null, null, null, null)
  and not app_private.sale_catalogue_projection_is_live(true, current_timestamp - interval '1 day', current_timestamp + interval '1 day', current_timestamp + interval '1 day', null, null),
  'la date limite matérialisée l''emporte sur tout le reste'
);

select is(
  app_private.sale_catalogue_projection_is_live(true, null, current_timestamp, null, null, null),
  false,
  'une date infinie ou un calcul impossible (valeur de repli nulle) donne faux, pas nul'
);

select is(
  app_private.sale_catalogue_projection_is_live(
    false, null, current_timestamp + interval '1 day', current_timestamp + interval '1 day', null, null
  ),
  false,
  'une ligne non matérialisée échoue fermée : jamais visible'
);

select is(
  (select count(*) from public.auction_sales
    where not catalogue_expiry_materialized),
  0::bigint,
  'toute ligne est matérialisée : le repli fermé ne masque aucune annonce'
);

select * from finish();
rollback;
