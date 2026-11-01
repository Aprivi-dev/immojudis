-- Liste des personnes ayant accepté un entretien (20261110180100) : service_role seul, demandes actives
-- seulement, administrateurs exclus, date de l'accord, profil et email, rien d'autre. Les comptes sont
-- comparés à un relevé pris avant les données de test (écarts).
begin;

select plan(8);

-- Structure et droits ------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_offer_opening_interviewees(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_offer_opening_interviewees(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_offer_opening_interviewees(integer)', 'EXECUTE'),
  'the list is for the server (service role) only'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_offer_opening_interviewees(integer)'::regprocedure),
  true,
  'the list is stable, security definer and has an empty search_path'
);
set local role anon;
select throws_ok(
  $$select public.admin_offer_opening_interviewees()$$, '42501', null, 'anon cannot read the list'
);
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c8630000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.admin_offer_opening_interviewees()$$, '42501', null,
  'a signed-in account cannot read the list'
);
reset role;

-- Relevé avant les données de test ---------------------------------------------------------------------
create temporary table pgtap_863_list (label text, body jsonb) on commit drop;
grant all on table pgtap_863_list to public;
insert into pgtap_863_list select 'before', public.admin_offer_opening_interviewees(500);

-- Données de test ------------------------------------------------------------------------------------
--   1 accepte l'entretien le 05/11 ; 2 l'accepte le 07/11 ; 3 a répondu sans accepter ; 4 a retiré sa
--   demande après avoir accepté ; 5 est administrateur et a accepté.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select format('c8630000-0000-4000-8000-%s', lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'interview-' || n || '@example.test', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from generate_series(1, 5) as n;

update public.user_profiles set user_role = 'admin'
where user_id = 'c8630000-0000-4000-8000-000000000005';

insert into public.offer_opening_notifications (
  user_id, consent_text_version, consented_at, notify_enabled, revoked_at, survey_profile,
  survey_answered_at, survey_interview_accepted, survey_interview_consented_at
) values
  ('c8630000-0000-4000-8000-000000000001', 'test', '2026-11-05T09:00:00Z', true, null, 'avocat',
   '2026-11-05T09:00:00Z', true, '2026-11-05T09:00:00Z'),
  ('c8630000-0000-4000-8000-000000000002', 'test', '2026-11-07T09:00:00Z', true, null, 'marchand_de_biens',
   '2026-11-07T09:00:00Z', true, '2026-11-07T09:00:00Z'),
  ('c8630000-0000-4000-8000-000000000003', 'test', '2026-11-06T09:00:00Z', true, null, 'particulier',
   '2026-11-06T09:00:00Z', false, null),
  ('c8630000-0000-4000-8000-000000000004', 'test', '2026-11-06T09:00:00Z', false, '2026-11-08T09:00:00Z', 'autre',
   '2026-11-06T09:00:00Z', true, '2026-11-06T09:00:00Z'),
  ('c8630000-0000-4000-8000-000000000005', 'test', '2026-11-06T09:00:00Z', true, null, 'autre',
   '2026-11-06T09:00:00Z', true, '2026-11-06T09:00:00Z');

create temporary table pgtap_863_after on commit drop as
select public.admin_offer_opening_interviewees(500) as body;

select is(
  (select (a.body ->> 'total')::integer from pgtap_863_after a)
    - (select (b.body ->> 'total')::integer from pgtap_863_list b where b.label = 'before'),
  2,
  'only the two active acceptances count (no refusal, no withdrawal, no administrator)'
);
select is(
  (select array_agg(i ->> 'email' order by i ->> 'email')
     from pgtap_863_after a, jsonb_array_elements(a.body -> 'interviewees') i
    where i ->> 'email' like 'interview-%@example.test'),
  array['interview-1@example.test', 'interview-2@example.test'],
  'the list names the two accounts that accepted an interview'
);
select is(
  (select (i ->> 'profile') || '|' || ((i ->> 'consented_at')::timestamptz = '2026-11-07T09:00:00Z')::text
     from pgtap_863_after a, jsonb_array_elements(a.body -> 'interviewees') i
    where i ->> 'email' = 'interview-2@example.test'),
  'marchand_de_biens|true',
  'each line carries the declared profile and the date of the consent'
);
select is(
  (select array_agg(k order by k)
     from pgtap_863_after a, jsonb_array_elements(a.body -> 'interviewees') i,
          jsonb_object_keys(i) k
    where i ->> 'email' = 'interview-1@example.test'),
  array['consented_at', 'email', 'profile'],
  'a line holds nothing else: no identifier, no price, no sales per month'
);

select * from finish();
rollback;
