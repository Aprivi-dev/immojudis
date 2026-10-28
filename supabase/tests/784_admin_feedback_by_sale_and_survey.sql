-- Retours négatifs par vente et réponses du questionnaire de la liste d'attente (migrations 20261108180100 et
-- 20261108180200) :
--   * les deux fonctions sont pour le serveur seul (service_role), SECURITY DEFINER à search_path vide ;
--   * admin_sale_signal_feedback_by_sale compte les « Pas pertinent » par vente, signal et motif sur 90 jours,
--     sans les utiles, sans les administrateurs, sans les retours plus vieux, et ne rend aucun compte ;
--   * admin_sale_signal_feedback_summary joint la version de la règle aux retours « pepite » ;
--   * admin_offer_opening_survey_summary rend les profils, masque la médiane sous 10 réponses et ne rend
--     aucune ligne individuelle.
-- Les agrégats sont comparés par la clé des ventes et des comptes de test, pour ne pas dépendre de ce que la base
-- contient.
begin;

select plan(15);

-- Droits ----------------------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_sale_signal_feedback_by_sale(timestamptz, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_sale_signal_feedback_by_sale(timestamptz, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_sale_signal_feedback_by_sale(timestamptz, integer)', 'EXECUTE'),
  'the feedback by sale is for the server (service role) only'
);
select ok(
  not has_function_privilege('anon', 'public.admin_offer_opening_survey_summary(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_offer_opening_survey_summary(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_offer_opening_survey_summary(timestamptz)', 'EXECUTE'),
  'the survey summary is for the server (service role) only'
);
select is(
  (select bool_and(p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""'])
     from pg_proc p
    where p.oid in (
      'public.admin_sale_signal_feedback_by_sale(timestamptz, integer)'::regprocedure,
      'public.admin_offer_opening_survey_summary(timestamptz)'::regprocedure)),
  true,
  'both are stable, security definer and have an empty search_path'
);
set local role authenticated;
select throws_ok(
  $$select public.admin_sale_signal_feedback_by_sale()$$, '42501', null,
  'a signed-in account cannot read the feedback by sale'
);
select throws_ok(
  $$select public.admin_offer_opening_survey_summary()$$, '42501', null,
  'a signed-in account cannot read the survey summary'
);
reset role;

-- Données de test ------------------------------------------------------------------------------------
--   comptes 1 et 2 ordinaires, 3 administrateur (compté nulle part) ;
--   ventes A et B ; A a une ligne de pépite en pepite-v1 ;
--   retours « Pas pertinent » : pepite/criterion_wrong sur A par 1 et 2 (2), points_to_verify/point_wrong sur A
--   par 1 (1), pepite sur B sans motif par 2 (1) ; hors compte : un « Utile » sur B, l'administrateur sur B,
--   un retour de 100 jours sur B.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7810000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bysale-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c7810000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bysale-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c7810000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bysale-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c7810000-0000-4000-8000-000000000003';

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c7810000-1000-4000-8000-00000000000a', 'bysale-781', 'https://example.test/s781/a',
   'By sale A', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c7810000-1000-4000-8000-00000000000b', 'bysale-781', 'https://example.test/s781/b',
   'By sale B', 'upcoming', '2099-01-02 12:00:00Z');

insert into public.auction_sale_pepites (sale_id, rule_version, engine_version, status)
values ('c7810000-1000-4000-8000-00000000000a', 'pepite-v1-test', 'engine-test', 'pepite');

insert into public.sale_signal_feedback (user_id, sale_id, signal, value, reason, feedback_day, created_at)
values
  ('c7810000-0000-4000-8000-000000000001', 'c7810000-1000-4000-8000-00000000000a',
   'pepite', 'not_relevant', 'criterion_wrong', '2026-11-08', '2026-11-08T10:00:00Z'),
  ('c7810000-0000-4000-8000-000000000002', 'c7810000-1000-4000-8000-00000000000a',
   'pepite', 'not_relevant', 'criterion_wrong', '2026-11-09', '2026-11-09T10:00:00Z'),
  ('c7810000-0000-4000-8000-000000000001', 'c7810000-1000-4000-8000-00000000000a',
   'points_to_verify', 'not_relevant', 'point_wrong', '2026-11-08', '2026-11-08T11:00:00Z'),
  ('c7810000-0000-4000-8000-000000000002', 'c7810000-1000-4000-8000-00000000000b',
   'pepite', 'not_relevant', null, '2026-11-09', '2026-11-09T12:00:00Z'),
  ('c7810000-0000-4000-8000-000000000001', 'c7810000-1000-4000-8000-00000000000b',
   'pepite', 'useful', null, '2026-11-09', '2026-11-09T12:30:00Z'),
  ('c7810000-0000-4000-8000-000000000003', 'c7810000-1000-4000-8000-00000000000b',
   'points_to_verify', 'not_relevant', 'point_wrong', '2026-11-09', '2026-11-09T13:00:00Z'),
  ('c7810000-0000-4000-8000-000000000002', 'c7810000-1000-4000-8000-00000000000b',
   'points_to_verify', 'not_relevant', 'point_missing', '2026-08-01', '2026-08-01T10:00:00Z');

create temporary table pgtap_781_rows (body jsonb) on commit drop;
grant all on table pgtap_781_rows to public;
insert into pgtap_781_rows
select public.admin_sale_signal_feedback_by_sale('2026-11-10T12:00:00Z'::timestamptz, 500);

create function pg_temp.row_count(p_sale text, p_signal text, p_reason text)
returns bigint
language sql
as $$
  select coalesce(sum((r ->> 'count')::bigint), 0)
  from pgtap_781_rows t, jsonb_array_elements(t.body -> 'rows') r
  where r ->> 'sale_id' = p_sale and r ->> 'signal' = p_signal and r ->> 'reason' = p_reason;
$$;

-- Retours par vente ----------------------------------------------------------------------------------
select is(
  pg_temp.row_count('c7810000-1000-4000-8000-00000000000a', 'pepite', 'criterion_wrong'),
  2::bigint,
  'two accounts said a criterion is wrong on sale A: one row, count 2'
);
select is(
  pg_temp.row_count('c7810000-1000-4000-8000-00000000000a', 'points_to_verify', 'point_wrong'),
  1::bigint,
  'one wrong point on sale A'
);
select is(
  pg_temp.row_count('c7810000-1000-4000-8000-00000000000b', 'pepite', 'none'),
  1::bigint,
  'a « not relevant » without reason is counted under « none »'
);
select is(
  (select coalesce(sum((r ->> 'count')::bigint), 0)::bigint
     from pgtap_781_rows t, jsonb_array_elements(t.body -> 'rows') r
    where r ->> 'sale_id' = 'c7810000-1000-4000-8000-00000000000b'),
  1::bigint,
  'on sale B only the one « not relevant » of a regular account in the window counts (useful, administrator and 100-day-old are out)'
);
select is(
  (select r ->> 'rule_version'
     from pgtap_781_rows t, jsonb_array_elements(t.body -> 'rows') r
    where r ->> 'sale_id' = 'c7810000-1000-4000-8000-00000000000a' and r ->> 'signal' = 'pepite'),
  'pepite-v1-test',
  'the rule version of the sale is joined to the pepite rows'
);
select is(
  (select body::text ~ '(c7810000-0000|@example\.test|bysale-one|user_id)' from pgtap_781_rows),
  false,
  'no account, no email address and no user key in the answer'
);

-- Version de la règle dans l'agrégat des retours pepite ------------------------------------------------
select is(
  (select (s -> 'rule_versions' ->> 'pepite-v1-test')::bigint
     from jsonb_array_elements(
            public.admin_sale_signal_feedback_summary('2026-11-10T12:00:00Z'::timestamptz) -> 'signals') s
    where s ->> 'signal' = 'pepite'),
  2::bigint,
  'the pepite aggregate counts the feedbacks of the sales ruled by pepite-v1-test (the two on sale A, any value)'
);

-- Questionnaire de la liste d'attente --------------------------------------------------------------------
-- Aucune réponse de test n'atteint 10 prix : la médiane doit rester nulle quoi que contienne la base pour les
-- autres comptes ; on ne contrôle donc que la forme et l'absence de ligne individuelle.
select is(
  (select array_agg(k order by k)
     from jsonb_object_keys(public.admin_offer_opening_survey_summary('2026-11-10T12:00:00Z'::timestamptz)) k),
  array['answered', 'generated_at', 'interview_accepted', 'min_median_answers', 'price_cheap',
        'price_too_expensive', 'profiles'],
  'the survey summary holds only counts, the two price blocks and the profiles'
);
select is(
  (select (public.admin_offer_opening_survey_summary('2026-11-10T12:00:00Z'::timestamptz)
             ->> 'min_median_answers')::integer),
  10,
  'the median is withheld under 10 answers'
);
select is(
  (select public.admin_offer_opening_survey_summary('2026-11-10T12:00:00Z'::timestamptz)::text
          ~ '(c7810000|@example\.test|user_id)'),
  false,
  'no account and no email address in the survey summary'
);

select * from finish();
rollback;
