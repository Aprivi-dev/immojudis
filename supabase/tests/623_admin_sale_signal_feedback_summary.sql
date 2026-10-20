-- Agrégat admin des retours sur les signaux d'une vente (20261030110300) : service_role seul, nombres exacts
-- par signal (total, utiles, pas pertinents, comptes distincts, motifs), les deux signaux toujours rendus,
-- fenêtre de 90 jours, administrateurs exclus, aucun nom ni identifiant de vente dans la réponse. Les
-- chiffres sont comparés à un relevé pris avant les données de test (écarts), pour ne pas dépendre de ce que
-- la base contient.
begin;

select plan(13);

-- Structure et droits ------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_sale_signal_feedback_summary(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_sale_signal_feedback_summary(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_sale_signal_feedback_summary(timestamptz)', 'EXECUTE'),
  'the summary is for the server (service role) only'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_sale_signal_feedback_summary(timestamptz)'::regprocedure),
  true,
  'the summary is stable, security definer and has an empty search_path'
);
set local role anon;
select throws_ok(
  $$select public.admin_sale_signal_feedback_summary()$$, '42501', null, 'anon cannot read the summary'
);
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c6230000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.admin_sale_signal_feedback_summary()$$, '42501', null,
  'a signed-in account cannot read the summary'
);
reset role;

-- Relevé avant les données de test ---------------------------------------------------------------------
create temporary table pgtap_623_summary (label text, body jsonb) on commit drop;
grant all on table pgtap_623_summary to public;

insert into pgtap_623_summary
select 'before', public.admin_sale_signal_feedback_summary('2026-11-10T12:00:00Z'::timestamptz);

-- Données de test ------------------------------------------------------------------------------------
--   1, 2 comptes ordinaires ; 3 administrateur (compté nulle part).
--   market_gap_band : compte 1 utile + pas pertinent (trop haute) ; compte 2 pas pertinent (trop basse) ;
--                     compte 3 (administrateur) utile ; un retour de 100 jours (hors fenêtre).
--   points_to_verify : compte 1 utile ; compte 2 pas pertinent (point faux) ; compte 2 pas pertinent
--                      (point manquant).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c6230000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'summary-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c6230000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'summary-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c6230000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'summary-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c6230000-0000-4000-8000-000000000003';

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c6230000-1000-4000-8000-000000000001', 'summary-623', 'https://example.test/s623/1',
   'Summary sale one', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c6230000-1000-4000-8000-000000000002', 'summary-623', 'https://example.test/s623/2',
   'Summary sale two', 'upcoming', '2099-01-02 12:00:00Z');

insert into public.sale_signal_feedback (user_id, sale_id, signal, value, reason, feedback_day, created_at)
values
  ('c6230000-0000-4000-8000-000000000001', 'c6230000-1000-4000-8000-000000000001',
   'market_gap_band', 'useful', null, '2026-11-08', '2026-11-08T10:00:00Z'),
  ('c6230000-0000-4000-8000-000000000001', 'c6230000-1000-4000-8000-000000000002',
   'market_gap_band', 'not_relevant', 'estimate_too_high', '2026-11-08', '2026-11-08T10:00:00Z'),
  ('c6230000-0000-4000-8000-000000000002', 'c6230000-1000-4000-8000-000000000001',
   'market_gap_band', 'not_relevant', 'estimate_too_low', '2026-11-09', '2026-11-09T10:00:00Z'),
  ('c6230000-0000-4000-8000-000000000003', 'c6230000-1000-4000-8000-000000000001',
   'market_gap_band', 'useful', null, '2026-11-09', '2026-11-09T10:00:00Z'),
  ('c6230000-0000-4000-8000-000000000002', 'c6230000-1000-4000-8000-000000000002',
   'market_gap_band', 'useful', null, '2026-08-01', '2026-08-01T10:00:00Z'),
  ('c6230000-0000-4000-8000-000000000001', 'c6230000-1000-4000-8000-000000000001',
   'points_to_verify', 'useful', null, '2026-11-08', '2026-11-08T10:00:00Z'),
  ('c6230000-0000-4000-8000-000000000002', 'c6230000-1000-4000-8000-000000000001',
   'points_to_verify', 'not_relevant', 'point_wrong', '2026-11-09', '2026-11-09T10:00:00Z'),
  ('c6230000-0000-4000-8000-000000000002', 'c6230000-1000-4000-8000-000000000002',
   'points_to_verify', 'not_relevant', 'point_missing', '2026-11-09', '2026-11-09T11:00:00Z');

insert into pgtap_623_summary
select 'after', public.admin_sale_signal_feedback_summary('2026-11-10T12:00:00Z'::timestamptz);

-- Lecture d'un entier d'un signal : 'after' moins 'before'.
create function pg_temp.delta(p_signal text, p_path text[])
returns bigint
language sql
as $$
  select (
    select (s #>> p_path)::bigint
    from pgtap_623_summary t, jsonb_array_elements(t.body -> 'signals') s
    where t.label = 'after' and s ->> 'signal' = p_signal
  ) - (
    select (s #>> p_path)::bigint
    from pgtap_623_summary t, jsonb_array_elements(t.body -> 'signals') s
    where t.label = 'before' and s ->> 'signal' = p_signal
  );
$$;

-- Les chiffres -----------------------------------------------------------------------------------------
select is(
  (select jsonb_array_length(body -> 'signals') from pgtap_623_summary where label = 'after'),
  2,
  'both signals are always returned'
);
select is(
  (select array_agg(s ->> 'signal' order by s ->> 'signal')
     from pgtap_623_summary t, jsonb_array_elements(t.body -> 'signals') s
    where t.label = 'after'),
  array['market_gap_band', 'points_to_verify'],
  'the signals are the two of the closed list'
);
select is(
  array[
    pg_temp.delta('market_gap_band', array['total']),
    pg_temp.delta('market_gap_band', array['useful']),
    pg_temp.delta('market_gap_band', array['not_relevant']),
    pg_temp.delta('market_gap_band', array['accounts'])
  ],
  array[3::bigint, 1, 2, 2],
  'market gap band: 3 feedbacks in the window (the admin and the 100-day-old one are out), 1 useful, 2 not relevant, 2 accounts'
);
select is(
  array[
    pg_temp.delta('market_gap_band', array['reasons', 'estimate_too_high']),
    pg_temp.delta('market_gap_band', array['reasons', 'estimate_too_low'])
  ],
  array[1::bigint, 1],
  'market gap band reasons: one too high, one too low'
);
select is(
  array[
    pg_temp.delta('points_to_verify', array['total']),
    pg_temp.delta('points_to_verify', array['useful']),
    pg_temp.delta('points_to_verify', array['not_relevant']),
    pg_temp.delta('points_to_verify', array['accounts'])
  ],
  array[3::bigint, 1, 2, 2],
  'points to verify: 3 feedbacks, 1 useful, 2 not relevant, 2 accounts'
);
select is(
  array[
    pg_temp.delta('points_to_verify', array['reasons', 'point_wrong']),
    pg_temp.delta('points_to_verify', array['reasons', 'point_missing'])
  ],
  array[1::bigint, 1],
  'points to verify reasons: one wrong point, one missing point'
);
select is(
  (select (body ->> 'window_days')::integer from pgtap_623_summary where label = 'after'),
  90,
  'the window is the 90 days of the retention'
);
select is(
  (select body::text ~ '(c6230000|@example\.test|summary-)' from pgtap_623_summary where label = 'after'),
  false,
  'no account, no email address and no sale identifier in the answer'
);
select is(
  (select array_agg(k order by k) from pgtap_623_summary t, jsonb_object_keys(t.body) k where t.label = 'after'),
  array['generated_at', 'signals', 'window_days'],
  'the answer holds only the date, the window and the signals'
);

select * from finish();
rollback;
