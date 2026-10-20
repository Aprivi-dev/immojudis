-- Envoi à la liste d'attente (migration 20261031100300, chantier R1 point 5) :
--   * les demandes dont le compte n'a pas d'adresse confirmée sont écartées de la file EN AMONT : elles
--     ne prennent plus de place dans un lot ;
--   * une demande jamais essayée passe avant une demande déjà essayée ; les plus anciennes d'abord ;
--   * une demande essayée moins de 3 fois, le premier essai datant de moins de 23 h, reste envoyable (la
--     clé d'idempotence de Resend vaut 24 h) ; au-delà, ou après 3 essais, elle n'est plus relancée toute
--     seule : elle est comptée dans needs_review (vérification du journal d'envoi) ;
--   * une demande retirée ou déjà prévenue n'y figure pas ;
--   * p_limit borne le lot (1 à 200) ; aucune adresse ne sort ; seule service_role exécute la fonction.
-- Les écritures sont annulées en fin de test.
begin;

select plan(11);

select has_column('public', 'offer_opening_notifications', 'notify_attempts', 'the attempt counter exists');
select has_column('public', 'offer_opening_notifications', 'notify_attempted_at', 'the first attempt date exists');

select ok(
  not has_function_privilege('anon', 'public.get_offer_opening_queue(integer, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_offer_opening_queue(integer, timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.get_offer_opening_queue(integer, timestamptz)', 'execute'),
  'only the server (service role) reads the queue'
);

-- Fixtures -------------------------------------------------------------------------------------
delete from public.offer_opening_notifications;

-- 01, 06 : adresse non confirmée ; 02 : un essai il y a 2 h ; 03 : un essai il y a 30 h ;
-- 04 : trois essais récents ; 05, 07 : jamais essayées ; 08 : déjà prévenue ; 09 : demande retirée.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  ('c6530000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'queue-' || n || '@example.test',
  '',
  case when n in (1, 6) then null else now() end,
  now(), now(), '{}'::jsonb, '{}'::jsonb
from generate_series(1, 9) n;

insert into public.offer_opening_notifications (
  user_id, notify_enabled, consented_at, revoked_at, notified_at, consent_text_version,
  notify_attempts, notify_attempted_at
)
select
  ('c6530000-0000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  f.enabled,
  now() - (20 - f.n) * interval '1 day',
  case when f.enabled then null else now() end,
  f.notified,
  'v-test',
  f.attempts,
  f.attempted
from (
  values
    (1, true, null::timestamptz, 0, null::timestamptz),
    (2, true, null, 1, now() - interval '2 hours'),
    (3, true, null, 1, now() - interval '30 hours'),
    (4, true, null, 3, now() - interval '1 hour'),
    (5, true, null, 0, null),
    (6, true, null, 0, null),
    (7, true, null, 0, null),
    (8, true, now() - interval '1 day', 1, now() - interval '1 day'),
    (9, false, null, 0, null)
) as f(n, enabled, notified, attempts, attempted);

-- La file -------------------------------------------------------------------------------------------
select is(
  (select array_agg(right(r ->> 'user_id', 2) order by ord)
     from jsonb_array_elements(public.get_offer_opening_queue(200) -> 'recipients')
          with ordinality as t(r, ord)),
  array['05', '07', '02'],
  'unconfirmed accounts, withdrawn and notified requests are out; never-tried requests come first, then the attempt still inside the window'
);
select is(
  (public.get_offer_opening_queue(200) ->> 'total')::integer,
  3,
  'total is the number of sendable requests'
);
select is(
  (public.get_offer_opening_queue(200) ->> 'needs_review')::integer,
  2,
  'a confirmed request tried more than 23 hours ago, or three times, needs a look at the send log'
);
select is(
  (select (r ->> 'attempts')::integer
     from jsonb_array_elements(public.get_offer_opening_queue(200) -> 'recipients') as t(r)
    where r ->> 'user_id' = 'c6530000-0000-4000-8000-000000000002'),
  1,
  'the attempt count comes out so the sender can count the next one'
);
select is(
  jsonb_array_length(public.get_offer_opening_queue(1) -> 'recipients'),
  1,
  'p_limit bounds the batch'
);
select is(
  (public.get_offer_opening_queue(1) ->> 'total')::integer,
  3,
  'while total still counts every sendable request'
);
select is(
  (select count(*) from jsonb_array_elements(public.get_offer_opening_queue(200) -> 'recipients') as t(r)
    where r::text ~ '@'),
  0::bigint,
  'no email address comes out of the queue'
);

-- Une demande remise à zéro après vérification du journal revient dans la file ------------------------
update public.offer_opening_notifications
  set notify_attempts = 0, notify_attempted_at = null
  where user_id = 'c6530000-0000-4000-8000-000000000003';
select is(
  (public.get_offer_opening_queue(200) ->> 'needs_review')::integer,
  1,
  'once reset by the administrator after checking the log, a request is sendable again'
);

select * from finish();
rollback;
