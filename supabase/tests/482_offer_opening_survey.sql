-- Liste d'attente qualifiée : trois questions facultatives et une case « entretien de 20 minutes »
-- ajoutées à offer_opening_notifications. Facultatif, borné, lisible par son propriétaire seulement,
-- écrit par le serveur seulement, conservé et effacé comme la demande elle-même.
begin;

select plan(16);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c4820000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'survey-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4820000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'survey-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4820000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'survey-three@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

select has_column(
  'public', 'offer_opening_notifications', 'survey_profile',
  'the survey answers live on the opening request row'
);
select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'offer_opening_notifications'
     and column_name = 'survey_interview_accepted'),
  'false',
  'the interview box is never ticked by default'
);

select lives_ok(
  $$insert into public.offer_opening_notifications (user_id, consent_text_version)
    values ('c4820000-0000-4000-8000-000000000001', '2026-10-21')$$,
  'joining the list needs none of the survey answers'
);
select lives_ok(
  $$update public.offer_opening_notifications
    set survey_profile = 'avocat', survey_sales_per_month = 12,
        survey_price_too_expensive_eur = 60, survey_price_cheap_eur = 15,
        survey_text_version = '2026-10-28', survey_answered_at = now()
    where user_id = 'c4820000-0000-4000-8000-000000000001'$$,
  'the three optional questions are stored'
);
select throws_ok(
  $$update public.offer_opening_notifications set survey_profile = 'banquier'
    where user_id = 'c4820000-0000-4000-8000-000000000001'$$,
  '23514', null, 'an unknown profile is refused'
);
select throws_ok(
  $$update public.offer_opening_notifications set survey_sales_per_month = 501
    where user_id = 'c4820000-0000-4000-8000-000000000001'$$,
  '23514', null, 'an absurd number of sales per month is refused'
);
select throws_ok(
  $$update public.offer_opening_notifications set survey_price_cheap_eur = 1001
    where user_id = 'c4820000-0000-4000-8000-000000000001'$$,
  '23514', null, 'an absurd price is refused'
);
select throws_ok(
  $$update public.offer_opening_notifications set survey_interview_accepted = true
    where user_id = 'c4820000-0000-4000-8000-000000000001'$$,
  '23514', null, 'the interview agreement cannot exist without its date'
);
select throws_ok(
  $$update public.offer_opening_notifications set survey_interview_consented_at = now()
    where user_id = 'c4820000-0000-4000-8000-000000000001'$$,
  '23514', null, 'the interview date cannot exist without the agreement'
);
select lives_ok(
  $$update public.offer_opening_notifications
    set survey_interview_accepted = true, survey_interview_consented_at = now()
    where user_id = 'c4820000-0000-4000-8000-000000000001'$$,
  'the interview agreement is stored with its date'
);

insert into public.offer_opening_notifications (user_id, consent_text_version)
values ('c4820000-0000-4000-8000-000000000002', '2026-10-21');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4820000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select count(*) from public.offer_opening_notifications where survey_profile = 'avocat'),
  1::bigint,
  'the owner reads their own answers'
);
set local "request.jwt.claims" = '{"sub":"c4820000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  (select count(*) from public.offer_opening_notifications where survey_profile = 'avocat'),
  0::bigint,
  'another account reads nobody else''s answers'
);
select throws_ok(
  $$update public.offer_opening_notifications set survey_interview_accepted = true,
      survey_interview_consented_at = now()
    where user_id = 'c4820000-0000-4000-8000-000000000002'$$,
  '42501', null, 'a browser role cannot forge the interview agreement'
);
reset role;

-- Conservation : les réponses suivent la demande (purge de la demande jamais suivie d'une ouverture).
update public.offer_opening_notifications
set consented_at = '2020-01-01T00:00:00Z'
where user_id = 'c4820000-0000-4000-8000-000000000001';
select lives_ok(
  $$select app_private.purge_offer_opening_notifications('2026-10-28T00:00:00Z'::timestamptz)$$,
  'the retention purge runs'
);
select is(
  (select count(*) from public.offer_opening_notifications
   where user_id = 'c4820000-0000-4000-8000-000000000001'),
  0::bigint,
  'the purge removes the request together with its survey answers'
);

-- Effacement du compte : la ligne, réponses comprises, disparaît avec lui.
insert into public.offer_opening_notifications (user_id, consent_text_version, survey_profile)
values ('c4820000-0000-4000-8000-000000000003', '2026-10-21', 'particulier');
delete from auth.users where id = 'c4820000-0000-4000-8000-000000000003';
select is(
  (select count(*) from public.offer_opening_notifications
   where user_id = 'c4820000-0000-4000-8000-000000000003'),
  0::bigint,
  'deleting the account deletes the answers with it'
);

select * from finish();
rollback;
