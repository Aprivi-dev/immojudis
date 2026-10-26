-- Migration 20261103110000 : sale_conditions (liste blanche des conditions d'une vente notariale) dans la vue de
-- la fiche (Analyse) et dans la vue des ventes débloquées, jamais dans la vue « découverte ».
begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(41);

-- Projection ---------------------------------------------------------------------------------------
select is(
  app_private.public_sale_conditions(
    '{"starting_price_nature":"first_offer_possible",
      "source_property_features":{"sale_conditions":{
        "procedure":"online_tender","first_offer_eur":200000,"last_offer_eur":900000,
        "negotiation_fee_rate":0.045,"negotiation_fee_payer":"acquereur","advertising_fees_eur":1200,
        "adjudication_price_eur":250000,"floor_price_eur":100000,"offer_step_eur":5000,
        "closes_at":"2026-11-17T12:00:00Z","private_sale":false,"result":"Vendu"}}}'
  ),
  '{"procedure":"online_tender","price_nature":"first_offer_possible","first_offer_eur":200000,
    "advertising_fees_eur":1200,"negotiation_fee_rate":0.045,"negotiation_fee_payer":"ACQUEREUR"}'::jsonb,
  'an interactive sale keeps its allow-listed conditions and nothing else'
);
select is(
  app_private.public_sale_conditions(
    '{"starting_price_nature":"mise_a_prix",
      "source_property_features":{"sale_conditions":{
        "procedure":"notarial_auction","adjudication_type":"volontaire","origin":"adjudication","deposit_eur":12000,
        "overbid_allowed":true,"session_at":"2026-11-05T13:30:00Z","deposit_transfer_terms":"3 jours avant",
        "price_reduction":"faculté de baisse","starting_price_nature":"FACULTE_BAISSE"}}}'
  ),
  '{"procedure":"notarial_auction","adjudication_type":"VOLONTAIRE","origin":"ADJUDICATION","deposit_eur":12000,
    "price_nature":"mise_a_prix","overbid_allowed":true}'::jsonb,
  'a candle sale keeps its allow-listed conditions and nothing else'
);
select is(
  app_private.public_sale_conditions(
    '{"source_property_features":{"sale_conditions":{
        "procedure":"other","first_offer_eur":-5,"deposit_eur":"12000","negotiation_fee_rate":6000,
        "negotiation_fee_payer":"AUTRE","overbid_allowed":"oui","advertising_fees_eur":0}}}'
  ),
  null::jsonb,
  'invalid values (unknown procedure, negative or text amounts, rate above 100 %, unknown payer) are omitted'
);
select ok(
  app_private.public_sale_conditions(null) is null
  and app_private.public_sale_conditions('[]') is null
  and app_private.public_sale_conditions('{}') is null
  and app_private.public_sale_conditions('"text"') is null
  and app_private.public_sale_conditions('{"source_property_features":[]}') is null,
  'a payload without conditions, or of an unexpected shape, gives null'
);
select ok(
  not (
    app_private.public_sale_conditions(
      '{"starting_price_nature":"first_offer_possible",
        "source_property_features":{"sale_conditions":{
          "procedure":"online_tender","first_offer_eur":200000,"last_offer_eur":900000,
          "adjudication_price_eur":250000,"floor_price_eur":100000,"price_reduction":"x",
          "deposit_transfer_terms":"x","deposit_deadline_time":"x","session_at":"x","closes_at":"x",
          "opens_at":"x","offer_step_eur":5000,"result":"Vendu","negotiation_fee_amount_eur":15000}}}'
    ) ?| array[
      'adjudication_price_eur', 'floor_price_eur', 'last_offer_eur', 'price_reduction',
      'deposit_transfer_terms', 'deposit_deadline_time', 'session_at', 'closes_at', 'opens_at',
      'offer_step_eur', 'result', 'negotiation_fee_amount_eur'
    ]
  ),
  'the reserved conditions (adjudication price, floor price, last offer, deposit terms, dates, fee amount) are never copied'
);

-- Valeurs et bornes ---------------------------------------------------------------------------------------
select is(
  app_private.public_sale_conditions(
    '{"source_property_features":{"sale_conditions":{
        "procedure":"notarial_auction","overbid_allowed":false}}}'
  ),
  '{"procedure":"notarial_auction","overbid_allowed":false}'::jsonb,
  'overbid_allowed = false is kept (a sale that forbids the overbid is not a sale without information)'
);
select is(
  app_private.public_sale_conditions(
    '{"source_property_features":{"sale_conditions":{
        "procedure":{"a":1},"adjudication_type":["VOLONTAIRE"],"origin":{"a":1},"first_offer_eur":[1],
        "deposit_eur":{"a":1},"advertising_fees_eur":[5],"negotiation_fee_rate":{"a":0.05},
        "negotiation_fee_payer":["ACQUEREUR"],"overbid_allowed":{"a":true}}}}'
  ),
  null::jsonb,
  'an object or an array given for a field of the allow-list is omitted, never copied'
);
select is(
  app_private.public_sale_conditions(
    jsonb_build_object('source_property_features', jsonb_build_object('sale_conditions', jsonb_build_object(
      'procedure', 'notarial_auction',
      'adjudication_type', repeat('A', 10000),
      'origin', repeat('A', 10000),
      'negotiation_fee_payer', repeat('A', 10000)
    )))
  ),
  '{"procedure":"notarial_auction"}'::jsonb,
  'a text of 10 000 characters in a text field is omitted, never copied'
);
select is(
  app_private.public_sale_conditions(
    '{"source_property_features":{"sale_conditions":{
        "procedure":"notarial_auction","adjudication_type":"VOLONTAIRE2","origin":"ADJUDICATIÓN"}}}'
  ),
  '{"procedure":"notarial_auction"}'::jsonb,
  'a digit or an accent in adjudication_type or origin omits the value'
);
select is(
  app_private.public_sale_conditions(
    '{"source_property_features":{"sale_conditions":{"adjudication_type":"JUDICIAIRE 2","origin":"SAISIE IMMOBILIERE"}}}'
  ),
  null::jsonb,
  'a space or a word outside A-Z and underscore omits adjudication_type and origin'
);
select is(
  (select jsonb_agg(app_private.public_sale_conditions(
     jsonb_build_object('source_property_features', jsonb_build_object('sale_conditions',
       jsonb_build_object('first_offer_eur', amount, 'deposit_eur', amount, 'advertising_fees_eur', amount)))
   ) order by amount)
     from unnest(array[-1, 0, 0.01, 1000000000, 1000000001]::numeric[]) as amount),
  '[null,null,
    {"first_offer_eur":0.01,"deposit_eur":0.01,"advertising_fees_eur":0.01},
    {"first_offer_eur":1000000000,"deposit_eur":1000000000,"advertising_fees_eur":1000000000},
    null]'::jsonb,
  'the amounts are kept from more than 0 up to 1 000 000 000 inclusive, and omitted outside'
);
select is(
  (select jsonb_agg(app_private.public_sale_conditions(
     jsonb_build_object('source_property_features', jsonb_build_object('sale_conditions',
       jsonb_build_object('negotiation_fee_rate', rate)))
   ) -> 'negotiation_fee_rate' order by rate)
     from unnest(array[0.005, 0.0099, 0.01, 0.20, 0.2001, 0.21, 1]::numeric[]) as rate),
  '[null,null,0.01,0.2,null,null,null]'::jsonb,
  'the negotiation fee rate is kept from 1 % to 20 % inclusive (0.005, 0.0099, 0.2001, 0.21 and 1 are omitted)'
);
select is(
  (select jsonb_agg(app_private.public_sale_conditions(
     jsonb_build_object('source_property_features', jsonb_build_object('sale_conditions',
       jsonb_build_object('negotiation_fee_rate', rate)))
   ) -> 'negotiation_fee_rate' order by rate)
     from unnest(array[0.01, 0.0124, 0.0125, 0.0462, 0.045, 0.0476, 0.1999, 0.2]::numeric[]) as rate),
  '[0.01,0.01,0.015,0.045,0.045,0.05,0.2,0.2]'::jsonb,
  'the negotiation fee rate is rounded to the half point (0.005), halves rounded up: it no longer tells the reserve price'
);
select is(
  (select jsonb_agg(app_private.public_sale_conditions(
     jsonb_build_object('source_property_features', jsonb_build_object('sale_conditions',
       jsonb_build_object('origin', origin)))
   ) -> 'origin' order by position)
     from unnest(array['adjudication', 'LICITATION', ' saisie ', 'EXPROPRIATION', '']::text[])
       with ordinality as candidates(origin, position)),
  '["ADJUDICATION","LICITATION","SAISIE",null,null]'::jsonb,
  'origin keeps only the values the pipeline writes (ADJUDICATION, LICITATION, SAISIE), upper-cased'
);
select ok(
  (select provolatile = 's' and proparallel = 's' and prosecdef = false
     from pg_proc where oid = 'app_private.public_sale_conditions(jsonb)'::regprocedure),
  'the projection is STABLE (it reads a changing payload), parallel safe and SECURITY INVOKER'
);

-- Droits ---------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'app_private.public_sale_conditions(jsonb)', 'execute')
  and has_function_privilege('service_role', 'app_private.public_sale_conditions(jsonb)', 'execute')
  and not has_function_privilege('anon', 'app_private.public_sale_conditions(jsonb)', 'execute'),
  'the projection is executable by authenticated and service_role, never by anon'
);

-- Forme des vues ---------------------------------------------------------------------------------------
select is(
  (select array_agg(view_name order by view_name)
     from (
       select table_name::text as view_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('v_auction_sales_app', 'v_auction_sales_unlocked')
          and column_name = 'sale_conditions'
          and data_type = 'jsonb'
          and ordinal_position = (
            select max(other.ordinal_position)
              from information_schema.columns other
             where other.table_schema = 'public' and other.table_name = columns.table_name
          )
     ) last_columns),
  array['v_auction_sales_app', 'v_auction_sales_unlocked']::text[],
  'sale_conditions is the last column, of type jsonb, in the fiche view and in the unlocked view'
);
select hasnt_column(
  'public', 'v_auction_sales_discovery', 'sale_conditions',
  'the discovery view (account without an unlock) has no sale_conditions column'
);
select hasnt_column(
  'public', 'v_auction_sales_discovery_search', 'sale_conditions',
  'the discovery search view has no sale_conditions column'
);
select hasnt_column(
  'public', 'v_auction_sales_app_search', 'sale_conditions',
  'the fiche search view keeps its own column list'
);
select hasnt_column(
  'public', 'v_auction_sales_app_preview', 'sale_conditions',
  'the public preview view keeps its own column list'
);
select ok(
  (select pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 'source_name = ''notaires''::text\) THEN app_private\.public_sale_conditions\((s\.)?raw_payload\)[^,]*AS sale_conditions')
  and (select pg_get_viewdef('public.v_auction_sales_unlocked'::regclass) ~ 'source_name = ''notaires''::text\) THEN app_private\.public_sale_conditions\((s\.)?raw_payload\)[^,]*AS sale_conditions')
  and not (select pg_get_viewdef('public.v_auction_sales_discovery'::regclass) ~ 'sale_conditions'),
  'only the fiche view and the unlocked view project the conditions, through the allow-list function and only for the notaires source'
);
select ok(
  obj_description('public.v_auction_sales_unlocked'::regclass, 'pg_class') is not null
  and obj_description('public.v_auction_sales_discovery'::regclass, 'pg_class') is not null,
  'the comments of the unlocked view and of the discovery view are kept'
);
select ok(
  (select reloptions @> array['security_invoker=false', 'security_barrier=true']
     from pg_class where oid = 'public.v_auction_sales_unlocked'::regclass)
  and (select reloptions @> array['security_invoker=false', 'security_barrier=true']
     from pg_class where oid = 'public.v_auction_sales_discovery'::regclass)
  and (select reloptions @> array['security_invoker=true']
     from pg_class where oid = 'public.v_auction_sales_app'::regclass),
  'the views keep their security options'
);
select ok(
  has_table_privilege('authenticated', 'public.v_auction_sales_discovery', 'select')
  and has_table_privilege('authenticated', 'public.v_auction_sales_unlocked', 'select')
  and has_table_privilege('authenticated', 'public.v_auction_sales_app', 'select')
  and not has_table_privilege('anon', 'public.v_auction_sales_unlocked', 'select'),
  'the view grants are unchanged'
);
select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_text', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'content_hash', 'select'),
  'no column of auction_sales was opened by the migration'
);

-- Comportement -------------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7410000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'conditions-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c7410000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'conditions-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c7410000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c7410000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

-- 1 : vente interactive, 2 : vente à la bougie (garantie lue), 3 : vente sans conditions (tribunal),
-- 4 : conditions dans raw_payload mais d'une autre source que « notaires » (la fonction n'est pas appelée).
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, raw_payload
) values
  ('c7410000-1000-4000-8000-000000000001', 'notaires', 'https://example.test/conditions/1',
   'Conditions test 1', 'upcoming', '2099-01-01 12:00:00Z',
   '{"starting_price_nature":"first_offer_possible",
     "source_property_features":{"sale_conditions":{
       "procedure":"online_tender","first_offer_eur":200000,"negotiation_fee_rate":0.045,
       "negotiation_fee_payer":"ACQUEREUR","advertising_fees_eur":1200,
       "adjudication_price_eur":250000,"last_offer_eur":900000}}}'),
  ('c7410000-1000-4000-8000-000000000002', 'notaires', 'https://example.test/conditions/2',
   'Conditions test 2', 'upcoming', '2099-01-01 12:00:00Z',
   '{"starting_price_nature":"mise_a_prix",
     "source_property_features":{"sale_conditions":{
       "procedure":"notarial_auction","adjudication_type":"VOLONTAIRE","deposit_eur":12000,
       "overbid_allowed":true,"floor_price_eur":90000,"adjudication_price_eur":130000}}}'),
  ('c7410000-1000-4000-8000-000000000003', 'conditions-test', 'https://example.test/conditions/3',
   'Conditions test 3', 'upcoming', '2099-01-01 12:00:00Z', '{}'),
  ('c7410000-1000-4000-8000-000000000004', 'conditions-test', 'https://example.test/conditions/4',
   'Conditions test 4', 'upcoming', '2099-01-01 12:00:00Z',
   '{"starting_price_nature":"mise_a_prix",
     "source_property_features":{"sale_conditions":{
       "procedure":"notarial_auction","adjudication_type":"VOLONTAIRE","deposit_eur":8000}}}');

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c7410000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.v_auction_sales_unlocked),
  0,
  'a free account that unlocked nothing receives no conditions'
);
select is(
  (select count(*)::integer from public.v_auction_sales_app
    where id in ('c7410000-1000-4000-8000-000000000001', 'c7410000-1000-4000-8000-000000000002',
                 'c7410000-1000-4000-8000-000000000003', 'c7410000-1000-4000-8000-000000000004')),
  0,
  'a free account (launch offer off) receives no row of the fiche view, so no conditions'
);
select is(
  (select (public.unlock_sale('c7410000-1000-4000-8000-000000000001') ->> 'unlocked')::boolean),
  true,
  'the free account unlocks the interactive sale'
);
select is(
  (select (public.unlock_sale('c7410000-1000-4000-8000-000000000002') ->> 'unlocked')::boolean),
  true,
  'the free account unlocks the candle sale'
);
select is(
  (select (public.unlock_sale('c7410000-1000-4000-8000-000000000004') ->> 'unlocked')::boolean),
  true,
  'the free account unlocks the sale of another source'
);
select is(
  (select sale_conditions from public.v_auction_sales_unlocked
    where id = 'c7410000-1000-4000-8000-000000000004'),
  null::jsonb,
  'the unlocked view serves no conditions for a sale whose source is not notaires, whatever its payload'
);
select is(
  (select sale_conditions from public.v_auction_sales_unlocked
    where id = 'c7410000-1000-4000-8000-000000000001'),
  '{"procedure":"online_tender","price_nature":"first_offer_possible","first_offer_eur":200000,
    "advertising_fees_eur":1200,"negotiation_fee_rate":0.045,"negotiation_fee_payer":"ACQUEREUR"}'::jsonb,
  'the unlocked view serves the conditions of the unlocked interactive sale'
);
select is(
  (select sale_conditions ->> 'deposit_eur' from public.v_auction_sales_unlocked
    where id = 'c7410000-1000-4000-8000-000000000002'),
  '12000',
  'the unlocked view serves the deposit read in the announcement'
);
select ok(
  (select not (sale_conditions ?| array['adjudication_price_eur', 'floor_price_eur', 'last_offer_eur'])
     from public.v_auction_sales_unlocked
    where id = 'c7410000-1000-4000-8000-000000000002')
  and (select adjudication_price_eur is null from public.v_auction_sales_unlocked
    where id = 'c7410000-1000-4000-8000-000000000002'),
  'the unlocked view keeps the adjudication price and the floor price reserved'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c7410000-0000-4000-8000-000000000002';
select is(
  (select sale_conditions ->> 'deposit_eur' from public.v_auction_sales_app
    where id = 'c7410000-1000-4000-8000-000000000002'),
  '12000',
  'the fiche view serves the same deposit to an Analyse account'
);
select is(
  (select sale_conditions from public.v_auction_sales_app
    where id = 'c7410000-1000-4000-8000-000000000001'),
  '{"procedure":"online_tender","price_nature":"first_offer_possible","first_offer_eur":200000,
    "advertising_fees_eur":1200,"negotiation_fee_rate":0.045,"negotiation_fee_payer":"ACQUEREUR"}'::jsonb,
  'the fiche view serves an interactive sale the same conditions as the unlocked view'
);
select ok(
  (select sale_conditions is null from public.v_auction_sales_app
    where id = 'c7410000-1000-4000-8000-000000000003'),
  'a sale without conditions has null sale_conditions'
);
select ok(
  (select sale_conditions is null from public.v_auction_sales_app
    where id = 'c7410000-1000-4000-8000-000000000004'),
  'the fiche view serves no conditions for a sale whose source is not notaires, whatever its payload'
);
reset role;

-- Un compte Découverte n'a aucune colonne sale_conditions : le test se fait sur le catalogue ouvert
-- (la vue découverte), qui ne la porte pas.
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c7410000-0000-4000-8000-000000000001';
select lives_ok(
  $$select id from public.v_auction_sales_discovery where id = 'c7410000-1000-4000-8000-000000000001'$$,
  'the discovery view still serves the sale to the free account'
);
select throws_ok(
  $$select sale_conditions from public.v_auction_sales_discovery$$,
  '42703',
  null,
  'the free account cannot read sale_conditions from the discovery view'
);
reset role;

select * from finish();
rollback;
