-- Plafonds d'enchère calculés pour la page « Pilotage » (20261101160000) : service_role seul, comptes
-- distincts, ventes distinctes et occurrences sur 7 et 30 jours, administrateurs exclus, autres
-- événements ignorés, aucun nom ni identifiant de vente dans la réponse. Les chiffres sont comparés à un
-- relevé pris avant les données de test (écarts), pour ne pas dépendre de ce que la base contient.
begin;

select plan(8);

-- Structure et droits ------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_pilotage_bid_ceilings(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_bid_ceilings(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_bid_ceilings(timestamptz)', 'EXECUTE'),
  'the indicator is for the server (service role) only'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_pilotage_bid_ceilings(timestamptz)'::regprocedure),
  true,
  'the indicator is stable, security definer and has an empty search_path'
);
set local role anon;
select throws_ok(
  $$select public.admin_pilotage_bid_ceilings()$$, '42501', null, 'anon cannot read the indicator'
);
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c6900000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.admin_pilotage_bid_ceilings()$$, '42501', null,
  'a signed-in account cannot read the indicator'
);
reset role;

-- Relevé avant les données de test ---------------------------------------------------------------------
create temporary table pgtap_690_summary (label text, body jsonb) on commit drop;
grant all on table pgtap_690_summary to public;

insert into pgtap_690_summary
select 'before', public.admin_pilotage_bid_ceilings('2026-11-10T12:00:00Z'::timestamptz);

-- Données de test ------------------------------------------------------------------------------------
--   1, 2 comptes ordinaires ; 3 administrateur (compté nulle part). Deux ventes.
--   Plafonds calculés : compte 1 : vente 1 le 09/11, vente 2 le 09/11, vente 1 le 08/11 ; compte 2 :
--   vente 1 le 09/11 (4 occurrences, 2 comptes, 2 ventes sur 7 jours) ; compte 2 : vente 2 le 25/10
--   (30 jours seulement) ; compte 1 : vente 1 le 01/08 (hors fenêtre) ; compte 3 (administrateur) :
--   vente 1 le 09/11. Un déblocage du compte 1 n'est pas un plafond.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c6900000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ceilings-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c6900000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ceilings-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c6900000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ceilings-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c6900000-0000-4000-8000-000000000003';

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c6900000-1000-4000-8000-000000000001', 'ceilings-690', 'https://example.test/s690/1',
   'Ceilings sale one', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c6900000-1000-4000-8000-000000000002', 'ceilings-690', 'https://example.test/s690/2',
   'Ceilings sale two', 'upcoming', '2099-01-02 12:00:00Z');

insert into public.account_product_events (user_id, event_type, detail, sale_id, occurred_at)
values
  ('c6900000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c6900000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c6900000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c6900000-1000-4000-8000-000000000002', '2026-11-09T10:00:00Z'),
  ('c6900000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c6900000-1000-4000-8000-000000000001', '2026-11-08T10:00:00Z'),
  ('c6900000-0000-4000-8000-000000000002', 'bid_ceiling_calculated', null, 'c6900000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c6900000-0000-4000-8000-000000000002', 'bid_ceiling_calculated', null, 'c6900000-1000-4000-8000-000000000002', '2026-10-25T10:00:00Z'),
  ('c6900000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c6900000-1000-4000-8000-000000000001', '2026-08-01T10:00:00Z'),
  ('c6900000-0000-4000-8000-000000000003', 'bid_ceiling_calculated', null, 'c6900000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c6900000-0000-4000-8000-000000000001', 'sale_unlocked', null, 'c6900000-1000-4000-8000-000000000002', '2026-11-09T10:00:00Z');

insert into pgtap_690_summary
select 'after', public.admin_pilotage_bid_ceilings('2026-11-10T12:00:00Z'::timestamptz);

-- Lecture d'un entier d'une fenêtre : 'after' moins 'before'.
create function pg_temp.delta(p_days integer, p_key text)
returns bigint
language sql
as $$
  select (
    select (w ->> p_key)::bigint
    from pgtap_690_summary t, jsonb_array_elements(t.body -> 'windows') w
    where t.label = 'after' and (w ->> 'days')::integer = p_days
  ) - (
    select (w ->> p_key)::bigint
    from pgtap_690_summary t, jsonb_array_elements(t.body -> 'windows') w
    where t.label = 'before' and (w ->> 'days')::integer = p_days
  );
$$;

-- Les chiffres -----------------------------------------------------------------------------------------
select is(
  (select array_agg((w ->> 'days')::integer order by (w ->> 'days')::integer)
     from pgtap_690_summary t, jsonb_array_elements(t.body -> 'windows') w
    where t.label = 'after'),
  array[7, 30],
  'the windows are the 7 and 30 days'
);
select is(
  array[
    pg_temp.delta(7, 'accounts'),
    pg_temp.delta(7, 'sales'),
    pg_temp.delta(7, 'occurrences')
  ],
  array[2::bigint, 2, 4],
  '7 days: 2 accounts, 2 sales, 4 occurrences (the administrator and the unlock are out)'
);
select is(
  array[
    pg_temp.delta(30, 'accounts'),
    pg_temp.delta(30, 'sales'),
    pg_temp.delta(30, 'occurrences')
  ],
  array[2::bigint, 2, 5],
  '30 days: 2 accounts, 2 sales, 5 occurrences (the August one is out)'
);
select is(
  (select body::text ~ '(c6900000|@example\.test|ceilings-)' from pgtap_690_summary where label = 'after'),
  false,
  'no account, no email address and no sale identifier in the answer'
);

select * from finish();
rollback;
