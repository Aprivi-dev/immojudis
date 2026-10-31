-- 20261110120300 (n° 3 et purge du n° 2) : quatre purges ajoutées à public.run_data_retention, chacune isolée.
--   * captures HTML Licitor : 90 jours après la dernière observation ;
--   * motifs libres d'une prolongation d'essai et d'une attribution manuelle d'accès : 24 mois après la fin de la
--     prolongation ou de l'accès (à défaut de fin, après la décision) ;
--   * cache des analyses LLM : 180 jours.
-- Les durées sont celles de la migration, à confirmer par juridique-rgpd.
begin;

select plan(20);

-- Les fonctions ----------------------------------------------------------------------------------------------

select ok(
  (
    select bool_and(
      procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    )
    from pg_proc procedure_row
    where procedure_row.oid in (
      'app_private.purge_licitor_captures(timestamptz)'::regprocedure,
      'app_private.purge_trial_extension_notes(timestamptz)'::regprocedure,
      'app_private.purge_manual_grant_notes(timestamptz)'::regprocedure,
      'app_private.purge_llm_analysis_cache(timestamptz)'::regprocedure
    )
  ),
  'the four purges are security definer, with an empty search_path, and reserved to service_role'
);

select ok(
  app_private.licitor_capture_retention() = interval '90 days'
  and app_private.admin_grant_note_retention() = interval '24 months'
  and app_private.llm_analysis_cache_retention() = interval '180 days',
  'the durations are 90 days, 24 months and 180 days, each in its own function'
);

select ok(
  (
    select bool_and(position(purge in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0)
    from unnest(array[
      'purge_licitor_captures', 'purge_trial_extension_notes', 'purge_manual_grant_notes',
      'purge_llm_analysis_cache'
    ]) as purge
  ),
  'run_data_retention runs the four new purges'
);

select ok(
  (
    select bool_and(position(purge in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0)
    from unnest(array[
      'purge_expired_operational_data', 'purge_information_agent_data', 'purge_offer_opening_notifications',
      'purge_sale_unlocks', 'purge_account_product_events', 'purge_followed_sale_snapshots',
      'purge_sale_reminder_dispatches', 'purge_sale_signal_feedback', 'purge_weekly_digest_dispatches',
      'purge_sale_result_dispatches', 'purge_market_estimate_snapshots', 'purge_errors'
    ]) as purge
  ),
  'it keeps its eleven other purges and purge_errors'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.run_data_retention(timestamptz)'::regprocedure
  ),
  'run_data_retention stays security definer, search_path empty and service-only'
);

-- Jeu d'essai (instant de la purge : 2026-12-01) -----------------------------------------------------------
-- 90 jours avant : 2026-09-02. 180 jours avant : 2026-06-04. 24 mois avant : 2024-12-01.

insert into licitor_ingestion.captures (url, sha256, kind, first_seen_at, last_seen_at, html_gzip)
values
  ('https://example.test/832/old', repeat('a', 64), 'detail', '2026-05-01T00:00:00Z', '2026-09-01T00:00:00Z',
   '\x1f8b'::bytea),
  ('https://example.test/832/seen-again', repeat('b', 64), 'detail', '2026-05-01T00:00:00Z', '2026-09-03T00:00:00Z',
   '\x1f8b'::bytea),
  ('https://example.test/832/recent', repeat('c', 64), 'index', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z',
   '\x1f8b'::bytea);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '83200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'retention-832@example.test', '', now(), now(), now(),
  '{}'::jsonb, '{}'::jsonb
);

-- Prolongations : t1 terminée il y a plus de 24 mois ; t2 décidée il y a plus de 24 mois mais encore en cours
-- (la fin de la prolongation fait foi) ; t3 récente.
insert into app_private.trial_extension_notes (user_id, granted_by, ends_at, note, created_at)
values
  ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', '2024-11-30T00:00:00Z',
   'Motif t1 ancien', '2024-11-01T00:00:00Z'),
  ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', '2026-12-31T00:00:00Z',
   'Motif t2 encore en cours', '2024-10-01T00:00:00Z'),
  ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', '2026-11-30T00:00:00Z',
   'Motif t3 récent', '2026-11-10T00:00:00Z');

-- Attributions : g1 terminée il y a plus de 24 mois ; g2 sans fin, décidée il y a plus de 24 mois ; g3 sans fin,
-- décidée récemment ; g4 décidée il y a plus de 24 mois mais encore en cours.
insert into app_private.manual_grant_notes
  (user_id, granted_by, plan_code, status, current_period_end, note, created_at)
values
  ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', 'analyse', 'active',
   '2024-11-30T00:00:00Z', 'Motif g1 ancien', '2024-06-01T00:00:00Z'),
  ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', 'analyse', 'active',
   null, 'Motif g2 sans fin ancien', '2024-11-01T00:00:00Z'),
  ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', 'analyse', 'active',
   null, 'Motif g3 sans fin récent', '2026-11-10T00:00:00Z'),
  ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', 'analyse', 'active',
   '2027-06-30T00:00:00Z', 'Motif g4 encore en cours', '2024-10-01T00:00:00Z');

insert into public.llm_analysis_cache (cache_key, stage, result, model, created_at)
values
  (repeat('1', 64), 'extract', '{}'::jsonb, 'model-832', '2026-06-03T00:00:00Z'),
  (repeat('2', 64), 'extract', '{}'::jsonb, 'model-832', '2026-06-05T00:00:00Z');

-- Avant l'instant de la purge -----------------------------------------------------------------------------

select is(
  (app_private.purge_licitor_captures('2026-09-01T00:00:00Z'::timestamptz) ->> 'licitor_captures')::integer,
  0,
  'nothing is purged while the oldest capture is under 90 days old'
);

-- La purge isolée de chaque table --------------------------------------------------------------------------

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'licitor_captures')::integer,
  1,
  'the retention report counts the capture last seen more than 90 days ago'
);

select is(
  (select array_agg(url order by url) from licitor_ingestion.captures where url like 'https://example.test/832/%'),
  array['https://example.test/832/recent', 'https://example.test/832/seen-again'],
  'a capture seen again within 90 days and a recent one are kept'
);

select is(
  (select array_agg(note order by note) from app_private.trial_extension_notes
    where user_id = '83200000-0000-4000-8000-000000000001'),
  array['Motif t2 encore en cours', 'Motif t3 récent'],
  'the trial extension note ended more than 24 months ago is purged, the running and the recent ones are kept'
);

select is(
  (select array_agg(note order by note) from app_private.manual_grant_notes
    where user_id = '83200000-0000-4000-8000-000000000001'),
  array['Motif g3 sans fin récent', 'Motif g4 encore en cours'],
  'the grant notes over 24 months old (ended, or open-ended and decided long ago) are purged, the others are kept'
);

select is(
  (select array_agg(cache_key order by cache_key) from public.llm_analysis_cache
    where model = 'model-832'),
  array[repeat('2', 64)],
  'the LLM cache entry older than 180 days is purged, the recent one is kept'
);

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ? 'purge_errors'),
  false,
  'a healthy run reports no purge error'
);

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'trial_extension_notes')::integer,
  0,
  'a second run finds nothing more to purge (idempotent)'
);

-- Les comptes rendus des trois autres purges ---------------------------------------------------------------

insert into app_private.trial_extension_notes (user_id, granted_by, ends_at, note, created_at)
values ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', '2024-01-31T00:00:00Z',
  'Motif t4 ancien', '2024-01-01T00:00:00Z');
insert into app_private.manual_grant_notes
  (user_id, granted_by, plan_code, status, current_period_end, note, created_at)
values ('83200000-0000-4000-8000-000000000001', '83200000-0000-4000-8000-0000000000a1', 'analyse', 'active',
  '2024-01-31T00:00:00Z', 'Motif g5 ancien', '2024-01-01T00:00:00Z');
insert into public.llm_analysis_cache (cache_key, stage, result, model, created_at)
values (repeat('3', 64), 'extract', '{}'::jsonb, 'model-832', '2026-01-01T00:00:00Z');

select is(
  (
    select jsonb_build_object(
      'trial', report ->> 'trial_extension_notes',
      'grant', report ->> 'manual_grant_notes',
      'cache', report ->> 'llm_analysis_cache'
    )
    from (select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) as report) run
  ),
  '{"trial": "1", "grant": "1", "cache": "1"}'::jsonb,
  'the report names the three other purges with their counts'
);

-- Une purge qui échoue n'arrête pas les autres ---------------------------------------------------------------

create or replace function app_private.purge_licitor_captures(p_now timestamptz default statement_timestamp())
returns jsonb
language plpgsql
as $$
begin
  raise exception 'forced failure of the capture purge' using errcode = 'P0001';
end;
$$;

select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'purge_errors',
  '{"purge_licitor_captures": "P0001"}'::jsonb,
  'a failing capture purge is reported under purge_errors with its SQLSTATE'
);

select ok(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'llm_analysis_cache'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'manual_grant_notes'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'trial_extension_notes'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'sale_market_estimate_snapshots',
  'and the other purges still ran and reported'
);

create or replace function app_private.purge_manual_grant_notes(p_now timestamptz default statement_timestamp())
returns jsonb
language plpgsql
as $$
begin
  raise exception 'forced failure of the grant note purge' using errcode = 'P0001';
end;
$$;

select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'purge_errors',
  '{"purge_licitor_captures": "P0001", "purge_manual_grant_notes": "P0001"}'::jsonb,
  'two failing purges are both reported and the run still returns'
);

select ok(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'trial_extension_notes'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'llm_analysis_cache',
  'the trial note and cache purges are not stopped by them'
);

-- Les tables restent privées ----------------------------------------------------------------------------------

select ok(
  not has_table_privilege('anon', 'licitor_ingestion.captures', 'select')
  and not has_table_privilege('authenticated', 'licitor_ingestion.captures', 'select')
  and not has_table_privilege('authenticated', 'app_private.trial_extension_notes', 'select')
  and not has_table_privilege('authenticated', 'app_private.manual_grant_notes', 'select')
  and not has_table_privilege('authenticated', 'public.llm_analysis_cache', 'select')
  and not has_table_privilege('anon', 'public.llm_analysis_cache', 'select'),
  'none of the four tables is readable by anon or authenticated'
);

select ok(
  has_function_privilege('service_role', 'app_private.licitor_capture_retention()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.licitor_capture_retention()', 'execute')
  and not has_function_privilege('anon', 'app_private.admin_grant_note_retention()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.llm_analysis_cache_retention()', 'execute'),
  'the duration functions are reserved to service_role'
);

select * from finish();
rollback;
