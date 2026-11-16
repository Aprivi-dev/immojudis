-- Activation (20261110180000) et comptes Découverte : déblocage gratuit et achats à l'unité (20261124100000,
-- qui remplace la part des comptes Découverte à 3 déblocages) pour la page « Pilotage » : service_role seul,
-- administrateurs exclus, activation indépendante du quota (fiche ouverte, favori ou alerte), aucun nom ni
-- identifiant dans la réponse. Les chiffres sont comparés à des relevés pris entre les étapes des données de
-- test (écarts), pour ne pas dépendre de ce que la base contient.
begin;

select plan(16);

-- Structure et droits ------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_pilotage_activation(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_activation(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_activation(timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_pilotage_discovery_unlocks(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_discovery_unlocks(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_discovery_unlocks(timestamptz)', 'EXECUTE'),
  'both indicators are for the server (service role) only'
);
select is(
  (select bool_and(p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""'])
     from pg_proc p
    where p.oid in (
      'public.admin_pilotage_activation(timestamptz)'::regprocedure,
      'public.admin_pilotage_discovery_unlocks(timestamptz)'::regprocedure
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
  $$select public.admin_pilotage_discovery_unlocks()$$, '42501', null,
  'a signed-in account cannot read the Discovery unlocks and purchases'
);
reset role;
-- Sans compte connecté pour la suite : sinon auth.uid() reste le compte 1 et les déclencheurs des
-- favoris et des alertes refusent d'écrire pour un autre (« Favorite owner mismatch. »).
set local "request.jwt.claims" = '';

select ok(
  to_regprocedure('public.admin_pilotage_unlock_threshold(timestamptz)') is null,
  'the 3-unlock threshold indicator is gone'
);

-- Relevés ---------------------------------------------------------------------------------------------
-- before        : avant les données de test ;
-- counted       : après les déblocages gratuits et les achats payés qui doivent compter ;
-- excluded      : après ceux des comptes administrateur, Analyse et à adresse non confirmée ;
-- other_unlocks : après les déblocages hors des deux mois et les déblocages achetés ou par crédit ;
-- after         : après les achats non payés (en attente, expiré, remboursé, contesté, litige perdu)
--                 et un achat payé après p_now.
create temporary table pgtap_861_summary (label text, activation jsonb, discovery jsonb) on commit drop;
grant all on table pgtap_861_summary to public;

create function pg_temp.snapshot(p_label text)
returns void
language sql
as $$
  insert into pgtap_861_summary
  select p_label,
    public.admin_pilotage_activation('2026-11-10T12:00:00Z'::timestamptz),
    public.admin_pilotage_discovery_unlocks('2026-11-10T12:00:00Z'::timestamptz);
$$;

select pg_temp.snapshot('before');

-- Données de test ------------------------------------------------------------------------------------
--   Comptes créés le 08/11 (dans les 7 jours) : 1 ouvre une fiche (bid_ceiling_calculated), 2 pose un
--   favori, 3 crée une alerte, 4 ne fait rien, 5 est administrateur et ouvre une fiche (compté nulle part).
--   Compte 6 créé le 25/10 (30 jours seulement) : ouvre une fiche. Aucun compte n'a débloqué de vente :
--   l'activation ne dépend pas du déblocage.
--   Comptes Découverte créés le 05/01/2026 (adresse confirmée, ni essai ni abonnement) : 7, 8, 9, 10 et 13.
--   11 est administrateur, 12 est abonné Analyse, 14 n'a pas confirmé son adresse.
--   p_now = 10/11/2026 12:00 UTC : mois en cours depuis le 01/11 00:00 à Paris (31/10 23:00 UTC), mois
--   précédent depuis le 01/10 00:00 à Paris (30/09 22:00 UTC).
--   Tous les comptes de test sauf le 4 et le 14 ont confirmé leur adresse le 05/01/2026 : leur essai de
--   7 jours est fini quelle que soit la date d'exécution du test (seule leur date de création varie).
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
   'authenticated', 'authenticated', 'discovery-seven@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'discovery-eight@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'discovery-nine@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'discovery-ten@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'discovery-admin@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'discovery-analyse@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'discovery-thirteen@example.test', '', '2026-01-05T08:00:00Z',
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8610000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'discovery-unconfirmed@example.test', '', null,
   '2026-01-05T08:00:00Z', now(), '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id in ('c8610000-0000-4000-8000-000000000005', 'c8610000-0000-4000-8000-000000000011');

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c8610000-0000-4000-8000-000000000012', 'analyse', 'active', now() + interval '30 days');

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select format('c8610000-1000-4000-8000-%s', lpad(n::text, 12, '0'))::uuid, 'activation-861',
  'https://example.test/s861/' || n, 'Activation sale ' || n, 'upcoming', '2099-01-01 12:00:00Z'
from generate_series(1, 4) as n;

-- Activation : fiche ouverte (estimation servie), administrateur, compte plus ancien.
insert into public.account_product_events (user_id, event_type, detail, sale_id, occurred_at)
values
  ('c8610000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c8610000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000005', 'bid_ceiling_calculated', null, 'c8610000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000006', 'pepite_detail_served', null, 'c8610000-1000-4000-8000-000000000001', '2026-10-26T10:00:00Z');

insert into public.user_favorites (user_id, sale_id, created_at)
values ('c8610000-0000-4000-8000-000000000002', 'c8610000-1000-4000-8000-000000000001', '2026-11-09T09:00:00Z');

-- Compte Découverte : l'alerte gratuite est hebdomadaire et sans critère réservé à Analyse.
insert into public.user_alerts (user_id, name, department, alert_frequency, created_at)
values (
  'c8610000-0000-4000-8000-000000000003', 'Activation alert', '33', 'weekly', '2026-11-09T09:00:00Z'
);

-- Ce qui compte : déblocages gratuits (7 en novembre, 8 le 01/11 à 00:30 à Paris, 9 le 31/10 à 23:30 à
-- Paris) et achats payés (7 deux en novembre, 8 le 31/10 à 23:30 à Paris, 9 un en octobre et un en
-- novembre).
insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source)
values
  ('c8610000-0000-4000-8000-000000000007', 'c8610000-1000-4000-8000-000000000001', '2026-11-02T10:00:00Z', 'free'),
  ('c8610000-0000-4000-8000-000000000008', 'c8610000-1000-4000-8000-000000000001', '2026-10-31T23:30:00Z', 'free'),
  ('c8610000-0000-4000-8000-000000000009', 'c8610000-1000-4000-8000-000000000001', '2026-10-31T22:30:00Z', 'free');

insert into public.sale_unlock_purchases (
  id, user_id, sale_id, payment_intent_id, amount_cents, currency, state, outcome, paid_at
) values
  ('c8610000-3000-4000-8000-000000000071', 'c8610000-0000-4000-8000-000000000007',
   'c8610000-1000-4000-8000-000000000002', 'pi_861_71', 1900, 'eur', 'paid', 'unlocked', '2026-11-03T10:00:00Z'),
  ('c8610000-3000-4000-8000-000000000072', 'c8610000-0000-4000-8000-000000000007',
   'c8610000-1000-4000-8000-000000000003', 'pi_861_72', 1900, 'eur', 'paid', 'credit', '2026-11-04T10:00:00Z'),
  ('c8610000-3000-4000-8000-000000000081', 'c8610000-0000-4000-8000-000000000008',
   'c8610000-1000-4000-8000-000000000002', 'pi_861_81', 1900, 'eur', 'paid', 'credit', '2026-10-31T22:30:00Z'),
  ('c8610000-3000-4000-8000-000000000091', 'c8610000-0000-4000-8000-000000000009',
   'c8610000-1000-4000-8000-000000000002', 'pi_861_91', 1900, 'eur', 'paid', 'credit', '2026-10-05T10:00:00Z'),
  ('c8610000-3000-4000-8000-000000000092', 'c8610000-0000-4000-8000-000000000009',
   'c8610000-1000-4000-8000-000000000003', 'pi_861_92', 1900, 'eur', 'paid', 'credit', '2026-11-05T10:00:00Z');

select pg_temp.snapshot('counted');

-- Exclus : administrateur (11), abonné Analyse (12), adresse non confirmée (14), chacun avec un déblocage
-- gratuit et un achat payé en novembre.
insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source)
values
  ('c8610000-0000-4000-8000-000000000011', 'c8610000-1000-4000-8000-000000000001', '2026-11-02T10:00:00Z', 'free'),
  ('c8610000-0000-4000-8000-000000000012', 'c8610000-1000-4000-8000-000000000001', '2026-11-02T10:00:00Z', 'free'),
  ('c8610000-0000-4000-8000-000000000014', 'c8610000-1000-4000-8000-000000000001', '2026-11-02T10:00:00Z', 'free');

insert into public.sale_unlock_purchases (
  user_id, sale_id, payment_intent_id, amount_cents, currency, state, outcome, paid_at
) values
  ('c8610000-0000-4000-8000-000000000011', 'c8610000-1000-4000-8000-000000000002', 'pi_861_111', 1900, 'eur', 'paid', 'credit', '2026-11-03T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000012', 'c8610000-1000-4000-8000-000000000002', 'pi_861_121', 1900, 'eur', 'paid', 'credit', '2026-11-03T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000014', 'c8610000-1000-4000-8000-000000000002', 'pi_861_141', 1900, 'eur', 'paid', 'credit', '2026-11-03T10:00:00Z');

select pg_temp.snapshot('excluded');

-- Autres déblocages : 10 a pris son déblocage gratuit le 30/09 à 23:30 à Paris (avant le mois précédent) ;
-- 7 a une vente achetée et 9 une vente ouverte par crédit, en novembre.
insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source, purchase_id)
values
  ('c8610000-0000-4000-8000-000000000010', 'c8610000-1000-4000-8000-000000000001', '2026-09-30T21:30:00Z', 'free', null),
  ('c8610000-0000-4000-8000-000000000007', 'c8610000-1000-4000-8000-000000000002', '2026-11-03T10:00:00Z', 'purchase',
   'c8610000-3000-4000-8000-000000000071'),
  ('c8610000-0000-4000-8000-000000000009', 'c8610000-1000-4000-8000-000000000004', '2026-11-06T10:00:00Z', 'credit',
   'c8610000-3000-4000-8000-000000000091');

select pg_temp.snapshot('other_unlocks');

-- Achats non payés de 13 (en attente, expiré, remboursé, contesté, litige perdu) et achat payé de 10 après
-- p_now.
insert into public.sale_unlock_purchases (
  user_id, sale_id, payment_intent_id, amount_cents, currency, state, outcome, paid_at
) values
  ('c8610000-0000-4000-8000-000000000013', 'c8610000-1000-4000-8000-000000000001', null, 1900, 'eur', 'pending', null, null),
  ('c8610000-0000-4000-8000-000000000013', 'c8610000-1000-4000-8000-000000000002', null, 1900, 'eur', 'expired', null, null),
  ('c8610000-0000-4000-8000-000000000013', 'c8610000-1000-4000-8000-000000000002', 'pi_861_131', 1900, 'eur', 'refunded', 'unlocked', '2026-11-03T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000013', 'c8610000-1000-4000-8000-000000000003', 'pi_861_132', 1900, 'eur', 'disputed', 'unlocked', '2026-11-04T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000013', 'c8610000-1000-4000-8000-000000000004', 'pi_861_133', 1900, 'eur', 'dispute_lost', 'credit', '2026-10-04T10:00:00Z'),
  ('c8610000-0000-4000-8000-000000000010', 'c8610000-1000-4000-8000-000000000002', 'pi_861_101', 1900, 'eur', 'paid', 'credit', '2026-11-11T10:00:00Z');

select pg_temp.snapshot('after');

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

-- Les six nombres des deux mois (index 0 : mois en cours, puis mois précédent) : p_to moins p_from.
create function pg_temp.month_deltas(p_from text, p_to text)
returns bigint[]
language sql
as $$
  select array_agg(
    (t_to.discovery -> 'months' -> m.idx ->> k.key)::bigint
      - (t_from.discovery -> 'months' -> m.idx ->> k.key)::bigint
    order by m.idx, k.ord
  )
  from pgtap_861_summary t_from
  cross join pgtap_861_summary t_to
  cross join (values (0), (1)) as m(idx)
  cross join (values (1, 'unlocked_free'), (2, 'purchased_one'), (3, 'purchases')) as k(ord, key)
  where t_from.label = p_from and t_to.label = p_to;
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
  '30 days: the older account that opened a detail counts, without any unlock'
);
select is(
  (select array[
     (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(t.discovery) k),
     (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(t.discovery -> 'months' -> 0) k),
     (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(t.discovery -> 'months' -> 1) k),
     t.discovery -> 'months' -> 0 ->> 'partial',
     t.discovery -> 'months' -> 1 ->> 'partial',
     jsonb_array_length(t.discovery -> 'months')::text
   ] from pgtap_861_summary t where t.label = 'after'),
  array[
    'discovery_accounts,generated_at,months',
    'month_start,partial,purchased_one,purchases,unlocked_free',
    'month_start,partial,purchased_one,purchases,unlocked_free',
    'true',
    'false',
    '2'
  ],
  'the answer holds the current (partial) month then the previous one, with three counts each'
);
select is(
  (select array[
     (t.discovery -> 'months' -> 0 ->> 'month_start')::timestamptz,
     (t.discovery -> 'months' -> 1 ->> 'month_start')::timestamptz
   ] from pgtap_861_summary t where t.label = 'after'),
  array['2026-10-31T23:00:00Z'::timestamptz, '2026-09-30T22:00:00Z'::timestamptz],
  'months start on the 1st at midnight in Paris'
);
select is(
  array[
    (pg_temp.month_deltas('before', 'counted'))[1],
    (pg_temp.month_deltas('before', 'counted'))[4]
  ],
  array[2::bigint, 1],
  'free unlock: 2 accounts in November (one at 00:30 on the 1st in Paris), 1 in October (23:30 on the 31st)'
);
select is(
  array[
    (pg_temp.month_deltas('before', 'counted'))[2],
    (pg_temp.month_deltas('before', 'counted'))[3],
    (pg_temp.month_deltas('before', 'counted'))[5],
    (pg_temp.month_deltas('before', 'counted'))[6]
  ],
  array[2::bigint, 3, 2, 2],
  'purchases: 2 accounts and 3 paid purchases in November, 2 accounts and 2 purchases in October'
);
select is(
  pg_temp.month_deltas('counted', 'excluded'),
  array[0::bigint, 0, 0, 0, 0, 0],
  'administrator, Analyse and unconfirmed accounts are not counted'
);
select is(
  pg_temp.month_deltas('excluded', 'other_unlocks'),
  array[0::bigint, 0, 0, 0, 0, 0],
  'a free unlock before the previous month, a bought unlock and a credit unlock are not free unlocks of the month'
);
select is(
  pg_temp.month_deltas('other_unlocks', 'after'),
  array[0::bigint, 0, 0, 0, 0, 0],
  'pending, expired, refunded, disputed or lost purchases, and a purchase paid after p_now, are not counted'
);
select is(
  (select (discovery ->> 'discovery_accounts')::bigint from pgtap_861_summary where label = 'after')
    - (select (discovery ->> 'discovery_accounts')::bigint from pgtap_861_summary where label = 'before'),
  9::bigint,
  'the Discovery accounts are the confirmed, non-administrator accounts without Analyse access'
);
select is(
  (select bool_or((activation::text || discovery::text) ~ '(c8610000|@example\.test|activation-|discovery-|pi_861)')
     from pgtap_861_summary),
  false,
  'no account, no email address, no sale and no payment identifier in the answers'
);

select * from finish();
rollback;
