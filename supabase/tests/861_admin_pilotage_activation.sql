-- Activation et part des comptes Découverte à 3 déblocages pour la page « Pilotage » (20261110180000) :
-- service_role seul, administrateurs exclus, activation indépendante du quota (fiche ouverte, favori
-- ou alerte), aucun nom ni identifiant dans la réponse. Les chiffres sont comparés à un relevé pris
-- avant les données de test (écarts), pour ne pas dépendre de ce que la base contient.
begin;

select plan(9);

-- Structure et droits ------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_pilotage_activation(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_activation(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_activation(timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_pilotage_unlock_threshold(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_unlock_threshold(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_unlock_threshold(timestamptz)', 'EXECUTE'),
  'both indicators are for the server (service role) only'
);
select is(
  (select bool_and(p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""'])
     from pg_proc p
    where p.oid in (
      'public.admin_pilotage_activation(timestamptz)'::regprocedure,
      'public.admin_pilotage_unlock_threshold(timestamptz)'::regprocedure
    )),
  true,
  'both indicators are stable, security definer and have an empty search_path'
);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c8610000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.admin_pilotage_activation()$$, '42501', null,
  'a signed-in account cannot read the activation'
);
select throws_ok(
  $$select public.admin_pilotage_unlock_threshold()$$, '42501', null,
  'a signed-in account cannot read the unlock threshold'
);
reset role;
-- Sans compte connecté pour la suite : sinon auth.uid() reste le compte 1 et les déclencheurs des
-- favoris et des alertes refusent d'écrire pour un autre (« Favorite owner mismatch. »).
set local "request.jwt.claims" = '';

-- Relevé avant les données de test ---------------------------------------------------------------------
create temporary table pgtap_861_summary (label text, activation jsonb, threshold jsonb) on commit drop;
grant all on table pgtap_861_summary to public;

insert into pgtap_861_summary
select 'before',
  public.admin_pilotage_activation('2026-11-10T12:00:00Z'::timestamptz),
  public.admin_pilotage_unlock_threshold('2026-11-10T12:00:00Z'::timestamptz);

-- Données de test ------------------------------------------------------------------------------------
--   Comptes créés le 08/11 (dans les 7 jours) : 1 ouvre une fiche (bid_ceiling_calculated), 2 pose un
--   favori, 3 crée une alerte, 4 ne fait rien, 5 est administrateur et ouvre une fiche (compté nulle part).
--   Compte 6 créé le 25/10 (30 jours seulement) : ouvre une fiche. Aucun compte n'a débloqué de vente par
--   le quota : l'activation ne dépend pas de lui.
--   Seuil : comptes 7 (3 déblocages de 3 ventes en novembre), 8 (2 déblocages en novembre, 3 en octobre)
--   et 9 (1 déblocage en novembre) sont des comptes Découverte (adresse confirmée, ni essai ni abonnement).
--   Tous les comptes de test sauf le 4 ont confirmé leur adresse le 05/01/2026 : leur essai de 7 jours
--   est fini quelle que soit la date d'exécution du test (seule leur date de création varie).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8610000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'activation-one@example.test', '', '2026-01-05T08:00:00Z',
   '2026-11-08T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'activation-two@example.test', '', '2026-01-05T08:00:00Z',
   '2026-11-08T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'activation-three@example.test', '', '2026-01-05T08:00:00Z',
   '2026-11-08T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'activation-four@example.test', '', null,
   '2026-11-08T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'activation-admin@example.test', '', '2026-01-05T08:00:00Z',
   '2026-11-08T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'activation-six@example.test', '', '2026-01-05T08:00:00Z',
   '2026-10-25T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'threshold-seven@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'threshold-eight@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'threshold-nine@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c8610000-0000-4000-8000-000000000005';

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select format('c8610000-1000-4000-8000-%s', lpad(n::text, 12, '0'))::uuid, 'activation-861',
  'https://example.test/s861/' || n, 'Activation sale ' || n, 'upcoming', '2099-01-01 12:00:00Z'
from generate_series(1, 4) as n;

insert into public.account_product_events (user_id, event_type, detail, sale_id, occurred_at)
values
  -- Activation : fiche ouverte (estimation servie), administrateur, compte plus ancien.
  ('c8610000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c8610000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000005', 'bid_ceiling_calculated', null, 'c8610000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000006', 'pepite_detail_served', null, 'c8610000-1000-4000-8000-000000000001', '2026-10-26T10:00:00Z'),
  -- Seuil : compte 7, 3 ventes en novembre ; compte 8, 2 en novembre et 3 en octobre ; compte 9, 1.
  ('c8610000-0000-4000-8000-000000000007', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000001', '2026-11-02T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000007', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000002', '2026-11-03T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000007', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000003', '2026-11-04T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000008', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000001', '2026-11-02T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000008', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000002', '2026-11-03T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000008', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000001', '2026-10-02T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000008', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000002', '2026-10-03T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000008', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000003', '2026-10-04T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000009', 'sale_unlocked', null, 'c8610000-1000-4000-8000-000000000004', '2026-11-05T10:00:00Z');

insert into public.user_favorites (user_id, sale_id, created_at)
values ('c8610000-0000-4000-8000-000000000002', 'c8610000-1000-4000-8000-000000000001', '2026-11-09T09:00:00Z');

-- Compte Découverte : l'alerte gratuite est hebdomadaire et sans critère réservé à Analyse.
insert into public.user_alerts (user_id, name, department, alert_frequency, created_at)
values (
  'c8610000-0000-4000-8000-000000000003', 'Activation alert', '33', 'weekly', '2026-11-09T09:00:00Z'
);

insert into pgtap_861_summary
select 'after',
  public.admin_pilotage_activation('2026-11-10T12:00:00Z'::timestamptz),
  public.admin_pilotage_unlock_threshold('2026-11-10T12:00:00Z'::timestamptz);

-- Lecture d'un entier d'une fenêtre d'activation : 'after' moins 'before'.
create function pg_temp.delta(p_days integer, p_key text)
returns bigint
language sql
as $$
  select (
    select (w ->> p_key)::bigint
    from pgtap_861_summary t, jsonb_array_elements(t.activation -> 'windows') w
    where t.label = 'after' and (w ->> 'days')::integer = p_days
  ) - (
    select (w ->> p_key)::bigint
    from pgtap_861_summary t, jsonb_array_elements(t.activation -> 'windows') w
    where t.label = 'before' and (w ->> 'days')::integer = p_days
  );
$$;

-- Lecture d'un entier d'un mois du seuil : 'after' moins 'before' (index 0 : mois en cours).
create function pg_temp.month_delta(p_index integer, p_key text)
returns bigint
language sql
as $$
  select (
    select (t.threshold -> 'months' -> p_index ->> p_key)::bigint
    from pgtap_861_summary t where t.label = 'after'
  ) - (
    select (t.threshold -> 'months' -> p_index ->> p_key)::bigint
    from pgtap_861_summary t where t.label = 'before'
  );
$$;

-- Les chiffres -----------------------------------------------------------------------------------------
select is(
  array[
    pg_temp.delta(7, 'signups'),
    pg_temp.delta(7, 'confirmed'),
    pg_temp.delta(7, 'activated'),
    pg_temp.delta(7, 'opened_detail'),
    pg_temp.delta(7, 'added_favorite'),
    pg_temp.delta(7, 'created_alert')
  ],
  array[4::bigint, 3, 3, 1, 1, 1],
  '7 days: 4 sign-ups (administrator out), 3 confirmed, 3 activated by one gesture each'
);
select is(
  array[
    pg_temp.delta(30, 'signups'),
    pg_temp.delta(30, 'activated'),
    pg_temp.delta(30, 'opened_detail')
  ],
  array[5::bigint, 4, 2],
  '30 days: the older account that opened a detail counts, without any unlock quota'
);
select is(
  array[
    pg_temp.month_delta(0, 'unlocked_one'),
    pg_temp.month_delta(0, 'reached_three'),
    pg_temp.month_delta(1, 'unlocked_one'),
    pg_temp.month_delta(1, 'reached_three')
  ],
  array[3::bigint, 1, 1, 1],
  'unlocks: 3 accounts unlocked one sale in November and 1 reached three; in October 1 and 1'
);
select is(
  (select (threshold ->> 'discovery_accounts')::bigint from pgtap_861_summary where label = 'after')
    - (select (threshold ->> 'discovery_accounts')::bigint from pgtap_861_summary where label = 'before'),
  7::bigint,
  'the Discovery accounts are the confirmed, non-administrator accounts without Analyse access'
);
select is(
  (select (activation::text || threshold::text) ~ '(c8610000|@example\.test|activation-|threshold-)'
     from pgtap_861_summary where label = 'after'),
  false,
  'no account, no email address and no sale identifier in the answers'
);

select * from finish();
rollback;
