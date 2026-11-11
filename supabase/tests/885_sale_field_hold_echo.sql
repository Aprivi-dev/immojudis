-- 20261117100200 : retenue et projection, version 2 (lot R2a, étape A3).
--   * mémoire d'écho : une ancienne valeur tenue qui revient par un import commencé avant la décision est écartée
--     (retrait, remplacement, réglage « l'annonce l'emporte »), avec un évènement echo_suppressed par valeur et
--     par décision ; 7 jours hors opposition, vie de la vente après une opposition ou une autorisation retirée ;
--   * colonnes voisines (surface habitable et Carrez, terrain recopié en surface principale) : la valeur d'une
--     pièce n'y entre pas ;
--   * une valeur échue sort à l'écriture suivante, sans compter pour un changement dans la simulation ;
--   * annonce qui se tait : la valeur d'annonce mémorisée n'est pas vidée, l'entrée note le silence ;
--   * valeurs neutres dans les libellés de surface, updated_at monotone ;
--   * indices de fusion : valeur d'annonce de la vente absorbée, mémoire d'écho reprise.
begin;

set local timezone = 'UTC';

select plan(52);

-- Fonctions pures -------------------------------------------------------------------------------------------------
select is(app_private.sale_field_echo_memory(), interval '7 days', 'the echo memory lasts seven days');

select results_eq(
  $$select label, app_private.sale_field_incoming_class(
             'property.surface_m2', incoming, '54'::jsonb, '50'::jsonb,
             '[{"value": 56, "until": "2999-01-01T00:00:00+00:00"}, {"value": 60}]'::jsonb, 1, 0.02)
      from (values
        (1, 'null', null::jsonb), (2, 'zero', '0'::jsonb), (3, 'held', '54.5'::jsonb), (4, 'listing', '50'::jsonb),
        (5, 'echo with a term', '56'::jsonb), (6, 'echo without a term', '60.9'::jsonb), (7, 'new', '70'::jsonb)
      ) sample(position, label, incoming) order by position$$,
  $$values ('null', 'empty'), ('zero', 'empty'), ('held', 'held'), ('listing', 'listing'),
           ('echo with a term', 'echo'), ('echo without a term', 'echo'), ('new', 'changed')$$,
  'an incoming value is empty, the held value, the listing value, an echo, or a change, in that order'
);

select is(
  app_private.sale_field_echo_prune(
    '{
       "a": {"state": "held", "value": 4, "echo": [{"value": 3, "until": "2026-01-01T00:00:00+00:00"},
                                                   {"value": 2}]},
       "b": {"state": "held", "value": 4, "echo": [{"value": 3, "until": "2026-01-01T00:00:00+00:00"}]},
       "c": {"state": "released", "echo": [{"value": 3, "until": "2026-01-01T00:00:00+00:00"}]},
       "d": {"state": "released", "echo": [{"value": 3, "until": "2026-03-01T00:00:00+00:00"}]}
     }'::jsonb,
    '2026-02-01T00:00:00+00:00'),
  '{
     "a": {"state": "held", "value": 4, "echo": [{"value": 2}]},
     "b": {"state": "held", "value": 4},
     "d": {"state": "released", "echo": [{"value": 3, "until": "2026-03-01T00:00:00+00:00"}]}
   }'::jsonb,
  'pruning drops the expired echo values, keeps those without a term, and removes a released entry left empty'
);

select ok(
  app_private.sale_field_echo_prune(
    '{"c": {"state": "released", "echo": [{"value": 3, "until": "2026-01-01T00:00:00+00:00"}]}}'::jsonb,
    '2026-02-01T00:00:00+00:00') is null
  and app_private.sale_field_echo_prune(null, '2026-02-01T00:00:00+00:00') is null,
  'nothing is left of held_fields once its only released entry has expired'
);

select is(
  app_private.sale_field_echo_add(
    app_private.sale_field_echo_add(
      '[{"value": 54, "until": "2026-11-18T00:00:00+00:00"}, {"value": 60}]'::jsonb,
      'property.surface_m2', '54.4'::jsonb, '2026-11-20T00:00:00+00:00', 1, 0.02),
    'property.surface_m2', '60'::jsonb, '2026-11-20T00:00:00+00:00', 1, 0.02),
  '[{"value": 54, "until": "2026-11-20T00:00:00+00:00"}, {"value": 60}]'::jsonb,
  'a value already remembered keeps its place: its term is extended, and a value without a term never gets one'
);

select is(
  app_private.sale_field_echo_add(
    '[{"value": 54, "until": "2026-11-18T00:00:00+00:00"}]'::jsonb,
    'property.surface_m2', '54'::jsonb, null, 1, 0.02),
  '[{"value": 54}]'::jsonb,
  'an opposition removes the term of a value already remembered'
);

select is(
  (select jsonb_agg(item -> 'value')
     from jsonb_array_elements(app_private.sale_field_echo_add(
       '[{"value": 5, "until": "2999-01-01T00:00:00+00:00"}, {"value": 4, "until": "2999-01-01T00:00:00+00:00"},
         {"value": 3}, {"value": 2, "until": "2999-01-01T00:00:00+00:00"},
         {"value": 1, "until": "2999-01-01T00:00:00+00:00"}]'::jsonb,
       'property.rooms_count', '6'::jsonb, '2999-01-01T00:00:00+00:00', null, null)) item),
  '[6, 5, 4, 3, 2]'::jsonb,
  'the memory keeps five values: the oldest value with a term leaves first'
);

select is(
  (select jsonb_agg(item -> 'value')
     from jsonb_array_elements(app_private.sale_field_echo_add(
       '[{"value": 5, "until": "2999-01-01T00:00:00+00:00"}, {"value": 4}, {"value": 3}, {"value": 2},
         {"value": 1}]'::jsonb,
       'property.rooms_count', '6'::jsonb, '2999-01-01T00:00:00+00:00', null, null)) item),
  '[6, 4, 3, 2, 1]'::jsonb,
  'a value without a term (opposition) is never pushed out by a value with a term'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('88500000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('88500000-0000-4000-8000-0000000000a1', 'registre-admin-885@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

-- Ventes 1 à 4 et 7 à 9 : maison, annonce 50 m² (habitable 50), 2 pièces, 1 chambre, occupé.
-- Vente 5 : annonce sans aucune surface. Vente 6 : terrain de 750 m², recopié en surface principale.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, habitable_surface_m2,
  land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88500000-1000-4000-8000-00000000000' || sale.n)::uuid, 'licitor',
  'https://example.test/885/sale-' || sale.n, 'upcoming', current_timestamp + interval '20 days',
  'Alphaville', sale.property_type, 90000, '{}'::jsonb, '{}'::jsonb, 'tribunal',
  sale.surface_m2, sale.app_surface_m2, sale.app_surface_kind, sale.surface_source, sale.surface_confidence,
  sale.habitable_surface_m2, sale.land_surface_m2, 2, 1, 'occupied', '[]'::jsonb
from (values
  ('1', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('2', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('3', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('4', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('5', 'house', null, null, null, null, null, null, null),
  ('6', 'land', null, 750, 'land', 'listing_text', 0.7, null, 750),
  ('7', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('8', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('9', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('a', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null),
  ('b', 'house', 50, 50, 'habitable', 'listing_text', 0.7, 50, null)
) sale(n, property_type, surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
       habitable_surface_m2, land_surface_m2);

-- Pièces d'avocat (un dossier par vente). Identifiant : vente puis numéro de pièce.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88500000-2000-4000-8000-0000000000' || piece.code)::uuid,
  ('88500000-1000-4000-8000-00000000000' || left(piece.code, 1))::uuid,
  piece.field_key, piece.value_jsonb, 'professional_email',
  jsonb_build_object('case_id', '88500000-3000-4000-8000-00000000000' || left(piece.code, 1)),
  0.6, 'information_agent', 'v1', '88500000-0000-4000-8000-0000000000a1'
from (values
  ('11', 'property.surface_m2', '54'::jsonb), ('12', 'property.rooms_count', '3'::jsonb),
  ('21', 'property.rooms_count', '3'::jsonb), ('22', 'property.rooms_count', '4'::jsonb),
  ('31', 'property.rooms_count', '3'::jsonb), ('32', 'property.rooms_count', '4'::jsonb),
  ('41', 'property.surface_m2', '54'::jsonb),
  ('51', 'property.surface_m2', '54'::jsonb),
  ('61', 'property.land_surface_m2', '800'::jsonb),
  ('71', 'property.rooms_count', '3'::jsonb), ('72', 'property.occupancy_status', '"vacant"'::jsonb),
  ('73', 'property.land_surface_m2', '800'::jsonb),
  ('81', 'property.rooms_count', '3'::jsonb), ('82', 'property.rooms_count', '5'::jsonb),
  ('91', 'property.surface_m2', '54'::jsonb), ('92', 'property.occupancy_status', '"vacant"'::jsonb),
  ('a1', 'property.rooms_count', '4'::jsonb),
  ('b1', 'property.rooms_count', '6'::jsonb)
) piece(code, field_key, value_jsonb);

prepare decide(text, text, text, timestamptz) as
  insert into public.auction_fact_claim_decisions (
    claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code, recipient_kind,
    received_at
  )
  select claim.id, claim.auction_sale_id, claim.field_key, $2, 'single_lot', 'admin',
    '88500000-0000-4000-8000-0000000000a1', $3, 'source_lawyer', $4
  from public.auction_fact_claims claim
  where claim.id = ('88500000-2000-4000-8000-0000000000' || $1)::uuid;

create function pg_temp.project(p_sale text) returns jsonb
language sql as $$
  select app_private.project_sale_fields(('88500000-1000-4000-8000-00000000000' || p_sale)::uuid, null, true);
$$;

-- L'écriture de la collecte (insert … on conflict (source_url) do update), colonnes de la fiche concernées.
prepare reimport(text, numeric, numeric, text, text, numeric, numeric, numeric, numeric, integer, integer, text) as
  insert into public.auction_sales (
    source_name, source_url, status, city, property_type, starting_price_eur, raw_payload, sale_procedure,
    surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, habitable_surface_m2,
    carrez_surface_m2, land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates, updated_at
  ) values (
    'licitor', 'https://example.test/885/sale-' || $1, 'upcoming', 'Alphaville', 'house', 90000, '{}'::jsonb,
    '{}'::jsonb, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '[]'::jsonb, statement_timestamp()
  )
  on conflict (source_url) do update set
    surface_m2 = excluded.surface_m2, app_surface_m2 = excluded.app_surface_m2,
    app_surface_kind = excluded.app_surface_kind, surface_source = excluded.surface_source,
    surface_confidence = excluded.surface_confidence, habitable_surface_m2 = excluded.habitable_surface_m2,
    carrez_surface_m2 = excluded.carrez_surface_m2, land_surface_m2 = excluded.land_surface_m2,
    rooms_count = excluded.rooms_count, bedrooms_count = excluded.bedrooms_count,
    occupancy_status = excluded.occupancy_status, visit_dates = excluded.visit_dates,
    updated_at = excluded.updated_at;

-- Scénario A : retrait pendant un import (vente 1) --------------------------------------------------------------
execute decide('11', 'accepted', null, '2026-11-01 09:00:00+00');
execute decide('12', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('1') ->> 'changed';

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, rooms_count
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000001'$$,
  $$values (54::numeric, 54::numeric, 'built', 'fact_registry', 0.85::numeric, 3)$$,
  'a held surface is written with neutral labels: built, fact_registry'
);

select is(
  (select count(*)::integer from public.auction_sales
     where id::text like '88500000-1000-%'
       and (surface_source like 'fact\_registry\_%' or app_surface_kind like 'fact\_registry%')),
  0,
  'no label names the origin of the piece'
);

execute decide('11', 'withdrawn', 'entry_error', null);
execute decide('12', 'withdrawn', 'entry_error', null);
select pg_temp.project('1') ->> 'changed';

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, rooms_count,
           held_fields #>> '{property.surface_m2,state}', held_fields #> '{property.surface_m2,echo,0,value}',
           (held_fields #>> '{property.surface_m2,echo,0,until}')::timestamptz
             between statement_timestamp() + interval '6 days 23 hours'
                 and statement_timestamp() + interval '7 days 1 hour',
           (held_fields #> '{property.rooms_count,echo}') - 0 = '[]'::jsonb,
           held_fields #> '{property.rooms_count,echo,0,value}'
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000001'$$,
  $$values (50::numeric, 50::numeric, 'habitable', 'listing_text', 0.7::numeric, 2, 'released', '54'::jsonb,
            true, true, '3'::jsonb)$$,
  'withdrawal gives the listing values and its labels back; each released entry remembers its value for seven days'
);

-- L'import avait lu la vente avant le retrait : il renvoie les valeurs de la pièce.
set local role service_role;
execute reimport('1', 54, 54, 'built', 'fact_registry', 0.85, 50, null, null, 3, 1, 'occupied');
reset role;

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, rooms_count
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000001'$$,
  $$values (50::numeric, 50::numeric, 'habitable', 'listing_text', 0.7::numeric, 2)$$,
  'scenario A: the withdrawn values sent back by a stale import do not return, the whole surface group stays'
);

select results_eq(
  $$select event.field_key, event.event, event.held_value, event.listing_value, event.incoming_value,
           event.decision_id = (
             select decision.id from public.auction_fact_claim_decisions decision
             where decision.claim_id in (
               '88500000-2000-4000-8000-000000000011', '88500000-2000-4000-8000-000000000012')
               and decision.field_key = event.field_key and decision.decision = 'accepted')
      from public.auction_sale_field_hold_events event
      where event.sale_id = '88500000-1000-4000-8000-000000000001' and event.event = 'echo_suppressed'
      order by event.field_key$$,
  $$values
      ('property.rooms_count', 'echo_suppressed', null::jsonb, '2'::jsonb, '3'::jsonb, true),
      ('property.surface_m2', 'echo_suppressed', null::jsonb, '50'::jsonb, '54'::jsonb, true)$$,
  'scenario A: each suppressed echo is journaled with the current value, the returning value and the decision that held'
);

set local role service_role;
execute reimport('1', 54, 54, 'built', 'fact_registry', 0.85, 50, null, null, 3, 1, 'occupied');
execute reimport('1', 54.4, 54.4, 'built', 'fact_registry', 0.85, 50, null, null, 3, 1, 'occupied');
reset role;

select results_eq(
  $$select sale.surface_m2, sale.rooms_count,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'echo_suppressed'
                and event.field_key = 'property.rooms_count'),
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'echo_suppressed'
                and event.incoming_value = '54'::jsonb)
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000001'$$,
  $$values (50::numeric, 2, 1, 1)$$,
  'scenario A: the same echo repeated, exact or within tolerance, is still suppressed and journaled once per value'
);

select is(
  app_private.project_sale_fields('88500000-1000-4000-8000-000000000001') ->> 'changed',
  'false',
  'scenario A: the simulation has nothing to change after the suppressed echo'
);

-- Une vraie nouvelle valeur passe : le champ libéré est libre.
set local role service_role;
execute reimport('1', 61, 61, 'carrez', 'pdf', 0.9, 50, null, null, 5, 1, 'occupied');
reset role;

select results_eq(
  $$select surface_m2, app_surface_kind, rooms_count from public.auction_sales
      where id = '88500000-1000-4000-8000-000000000001'$$,
  $$values (61::numeric, 'carrez', 5)$$,
  'a released field is free: a value that is not in the echo memory passes'
);

-- Scénario B : remplacement pendant un import, réglage par défaut (vente 2) ------------------------------------
execute decide('21', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('2') ->> 'changed';
execute decide('22', 'accepted', null, '2026-11-02 09:00:00+00');
select pg_temp.project('2') ->> 'changed';

select results_eq(
  $$select rooms_count, held_fields #> '{property.rooms_count,value}',
           held_fields #> '{property.rooms_count,listing}',
           held_fields #> '{property.rooms_count,echo,0,value}',
           jsonb_array_length(held_fields #> '{property.rooms_count,echo}')
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000002'$$,
  $$values (4, '4'::jsonb, '{"rooms_count": 2}'::jsonb, '3'::jsonb, 1)$$,
  'a replaced piece leaves its value in the echo memory of the held entry'
);

set local role service_role;
execute reimport('2', 50, 50, 'habitable', 'listing_text', 0.7, 50, null, null, 3, 1, 'occupied');
execute reimport('2', 50, 50, 'habitable', 'listing_text', 0.7, 50, null, null, 3, 1, 'occupied');
reset role;

select results_eq(
  $$select sale.rooms_count, sale.held_fields #> '{property.rooms_count,listing}',
           (select array_agg(event.event || ':' || event.held_value || ':' || event.listing_value || ':'
                             || event.incoming_value order by event.seq)
              from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event not like 'projection%')
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000002'$$,
  $$values (4, '{"rooms_count": 2}'::jsonb, array['echo_suppressed:4:2:3'])$$,
  'scenario B: the echo of the replaced value keeps the piece, leaves the listing value untouched, one event'
);

execute decide('21', 'withdrawn', 'entry_error', null);
execute decide('22', 'withdrawn', 'entry_error', null);
select pg_temp.project('2') ->> 'changed';

select is(
  (select rooms_count from public.auction_sales where id = '88500000-1000-4000-8000-000000000002'),
  2,
  'scenario B: once both pieces are withdrawn the sale shows what the listing really says'
);

-- Scénario C : remplacement pendant un import, réglage « l'annonce l'emporte » (vente 3) ---------------------
update public.auction_fact_fields set on_listing_change = 'listing_wins_and_review'
where field_key = 'property.rooms_count';
execute decide('31', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('3') ->> 'changed';
execute decide('32', 'accepted', null, '2026-11-02 09:00:00+00');
select pg_temp.project('3') ->> 'changed';

set local role service_role;
execute reimport('3', 50, 50, 'habitable', 'listing_text', 0.7, 50, null, null, 3, 1, 'occupied');
reset role;

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           (select array_agg(event.event order by event.seq)
              from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event not like 'projection%'),
           app_private.project_sale_fields(sale.id, null, true) #>> '{fields,property.rooms_count,state}'
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000003'$$,
  $$values (4, 'held', array['echo_suppressed'], 'unchanged')$$,
  'scenario C: with the listing-wins setting, an echo does not release the field nor undo the decision'
);

-- Écho avec des chambres plus nombreuses que les pièces tenues : l'écrivain n'échoue pas, le champ reste tenu.
-- (écriture partielle : une ligne « 3 pièces, 5 chambres » ne peut pas être proposée à l'insertion d'un upsert.)
set local role service_role;
select lives_ok(
  $$update public.auction_sales set rooms_count = 3, bedrooms_count = 5
      where id = '88500000-1000-4000-8000-000000000003'$$,
  'an echo that comes with more bedrooms than the held room count does not fail the writer'
);
reset role;

select results_eq(
  $$select rooms_count, bedrooms_count, held_fields #>> '{property.rooms_count,state}'
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000003'$$,
  $$values (4, 1, 'held')$$,
  'and neither releases the field nor takes the bedroom count that came with it'
);

-- Retour au réglage par défaut ; l'entrée de la vente 3 le recopie à la projection suivante.
update public.auction_fact_fields set on_listing_change = 'keep_and_review'
where field_key = 'property.rooms_count';
select pg_temp.project('3') ->> 'changed';

-- Colonnes voisines d'une surface tenue (vente 4) --------------------------------------------------------------
execute decide('41', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('4') ->> 'changed';

set local role service_role;
execute reimport('4', 54, 54, 'built', 'fact_registry', 0.85, 54, 54.3, null, 2, 1, 'occupied');
reset role;

select results_eq(
  $$select sale.surface_m2, sale.habitable_surface_m2, sale.carrez_surface_m2,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event not like 'projection%')
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000004'$$,
  $$values (54::numeric, 50::numeric, null::numeric, 0)$$,
  'the held value does not enter the habitable and Carrez columns, and that is not an event'
);

set local role service_role;
execute reimport('4', 54, 54, 'built', 'fact_registry', 0.85, 58, 57, null, 2, 1, 'occupied');
reset role;

select results_eq(
  $$select habitable_surface_m2, carrez_surface_m2 from public.auction_sales
      where id = '88500000-1000-4000-8000-000000000004'$$,
  $$values (58::numeric, 57::numeric)$$,
  'another value of the listing passes in the neighbour columns'
);

-- Retrait avec une annonce muette, puis la valeur revient par une colonne voisine (vente 5) ------------------
execute decide('51', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('5') ->> 'changed';
execute decide('51', 'withdrawn', 'entry_error', null);
select pg_temp.project('5') ->> 'changed';

update public.auction_sales set habitable_surface_m2 = 54 where id = '88500000-1000-4000-8000-000000000005';
update public.auction_sales set carrez_surface_m2 = 54.4 where id = '88500000-1000-4000-8000-000000000005';

select results_eq(
  $$select sale.surface_m2, sale.app_surface_m2, sale.habitable_surface_m2, sale.carrez_surface_m2,
           (select array_agg(event.incoming_value order by event.seq)
              from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'echo_suppressed')
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000005'$$,
  $$values (null::numeric, null::numeric, null::numeric, null::numeric, array['54'::jsonb, '54.4'::jsonb])$$,
  'after a withdrawal on a silent listing, the value cannot come back through the habitable or Carrez column'
);

update public.auction_sales set surface_m2 = 54 where id = '88500000-1000-4000-8000-000000000005';
update public.auction_sales set habitable_surface_m2 = 47 where id = '88500000-1000-4000-8000-000000000005';

select results_eq(
  $$select surface_m2, habitable_surface_m2 from public.auction_sales
      where id = '88500000-1000-4000-8000-000000000005'$$,
  $$values (null::numeric, 47::numeric)$$,
  'a partial write of the echo on one value column is refused; a partial write of another value passes'
);

-- Terrain (vente 6) : la valeur tenue n'entre pas dans la surface principale, ni tenue, ni retirée --------------
execute decide('61', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('6') ->> 'changed';

update public.auction_sales set land_surface_m2 = 800, app_surface_m2 = 800, app_surface_kind = 'land'
where id = '88500000-1000-4000-8000-000000000006';

select results_eq(
  $$select sale.land_surface_m2, sale.app_surface_m2, sale.app_surface_kind,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event not like 'projection%')
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000006'$$,
  $$values (800::numeric, 750::numeric, 'land', 0)$$,
  'a held land surface is not copied into the main surface of a land sale by a direct write'
);

execute decide('61', 'withdrawn', 'entry_error', null);
select pg_temp.project('6') ->> 'changed';
update public.auction_sales set app_surface_m2 = 800 where id = '88500000-1000-4000-8000-000000000006';
update public.auction_sales set surface_m2 = 800 where id = '88500000-1000-4000-8000-000000000006';

select results_eq(
  $$select sale.land_surface_m2, sale.app_surface_m2, sale.surface_m2,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'echo_suppressed')
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000006'$$,
  $$values (750::numeric, 750::numeric, null::numeric, 1)$$,
  'a withdrawn land surface cannot come back as the main surface of the land sale'
);

-- Échéance, opposition, autorisation retirée (vente 7) ---------------------------------------------------------
execute decide('71', 'accepted', null, '2026-11-01 09:00:00+00');
execute decide('72', 'accepted', null, '2026-11-01 09:00:00+00');
execute decide('73', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('7') ->> 'changed';
execute decide('71', 'withdrawn', 'entry_error', null);
execute decide('72', 'opposed', 'professional_opposition', null);
execute decide('73', 'withdrawn', 'authorization_withdrawn', null);
select pg_temp.project('7') ->> 'changed';

select results_eq(
  $$select held_fields #>> '{property.rooms_count,released_by}',
           held_fields #> '{property.rooms_count,echo,0}' ? 'until',
           held_fields #>> '{property.occupancy_status,released_by}',
           held_fields #> '{property.occupancy_status,echo}',
           held_fields #>> '{property.land_surface_m2,released_by}',
           held_fields #> '{property.land_surface_m2,echo}'
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000007'$$,
  $$values ('withdrawn', true, 'opposed', '[{"value": "vacant"}]'::jsonb, 'withdrawn',
            '[{"value": 800}]'::jsonb)$$,
  'a plain withdrawal is remembered for a term; an opposition and a withdrawn authorization have none'
);

select is(
  (select array_agg(field.key order by field.key)
     from public.auction_sales sale,
          jsonb_object_keys(app_private.sale_field_echo_prune(
            sale.held_fields, statement_timestamp() + interval '10 years')) field(key)
     where sale.id = '88500000-1000-4000-8000-000000000007'),
  array['property.land_surface_m2', 'property.occupancy_status'],
  'ten years later only the plain withdrawal has expired: the opposed values live as long as the sale'
);

-- Le terme du retrait simple est passé (échéance ramenée à hier, par la seule écriture admise : le marqueur).
select set_config('app.sale_field_projection', '88500000-1000-4000-8000-000000000007', true);
update public.auction_sales
set held_fields = jsonb_set(
  held_fields, '{property.rooms_count,echo,0,until}', to_jsonb(statement_timestamp() - interval '1 day'))
where id = '88500000-1000-4000-8000-000000000007';
select set_config('app.sale_field_projection', '', true);

create temporary table expiry_marks on commit drop as
select ctid as row_version, updated_at from public.auction_sales
where id = '88500000-1000-4000-8000-000000000007';

select ok(
  (select (app_private.project_sale_fields(sale.id, null, false) ->> 'changed') = 'false'
          and (app_private.project_sale_fields(sale.id, null, true) ->> 'changed') = 'false'
          and (select sale_after.ctid = mark.row_version and sale_after.updated_at = mark.updated_at
                      and sale_after.held_fields ? 'property.rooms_count'
                 from public.auction_sales sale_after, expiry_marks mark where sale_after.id = sale.id)
     from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000007'),
  'an expired echo value alone is not a change: the simulation says so and the projection does not rewrite the sale'
);

set local role service_role;
execute reimport('7', 50, 50, 'habitable', 'listing_text', 0.7, 50, null, 800, 3, 1, 'vacant');
reset role;

select results_eq(
  $$select sale.rooms_count, sale.occupancy_status, sale.land_surface_m2,
           (select array_agg(field.key order by field.key) from jsonb_object_keys(sale.held_fields) field(key)),
           (select array_agg(event.field_key order by event.field_key)
              from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'echo_suppressed')
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000007'$$,
  $$values (3, 'occupied', null::numeric, array['property.land_surface_m2', 'property.occupancy_status'],
            array['property.land_surface_m2', 'property.occupancy_status'])$$,
  'the expired value passes and its entry is removed at that write; the opposed values are still held back'
);

-- Nouvelle acceptation sur un champ libéré : la mémoire d'écho est gardée (vente 8) ----------------------------
execute decide('81', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('8') ->> 'changed';
execute decide('81', 'withdrawn', 'entry_error', null);
select pg_temp.project('8') ->> 'changed';
execute decide('82', 'accepted', null, '2026-11-03 09:00:00+00');
select pg_temp.project('8') ->> 'changed';

select results_eq(
  $$select rooms_count, held_fields #>> '{property.rooms_count,state}',
           held_fields #> '{property.rooms_count,value}', held_fields #> '{property.rooms_count,listing}',
           held_fields #> '{property.rooms_count,echo,0,value}',
           held_fields #> '{property.rooms_count}' ? 'released_by'
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000008'$$,
  $$values (5, 'held', '5'::jsonb, '{"rooms_count": 2}'::jsonb, '3'::jsonb, false)$$,
  'a new acceptance on a released field holds it again, with the listing value and the echo memory kept'
);

set local role service_role;
execute reimport('8', 50, 50, 'habitable', 'listing_text', 0.7, 50, null, null, 3, 1, 'occupied');
reset role;

select results_eq(
  $$select sale.rooms_count, sale.held_fields #> '{property.rooms_count,listing}',
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'echo_suppressed')
      from public.auction_sales sale where sale.id = '88500000-1000-4000-8000-000000000008'$$,
  $$values (5, '{"rooms_count": 2}'::jsonb, 1)$$,
  'the value withdrawn earlier is still recognised as an echo under the new piece'
);

-- Idempotence : après une libération puis une reprise, une seconde projection ne change rien.
create temporary table idempotence_marks on commit drop as
select id, ctid as row_version, updated_at, held_fields from public.auction_sales
where id::text like '88500000-1000-%';

select is(
  (select count(*)::integer from public.auction_sales sale
     where sale.id::text like '88500000-1000-%'
       and (app_private.project_sale_fields(sale.id, null, true) ->> 'changed')::boolean),
  0,
  'a second projection of every sale of this file changes nothing'
);

select is(
  (select count(*)::integer from public.auction_sales sale join idempotence_marks mark using (id)
     where sale.ctid <> mark.row_version or sale.updated_at <> mark.updated_at
       or sale.held_fields is distinct from mark.held_fields),
  0,
  'and rewrites no row'
);

-- L'annonce se tait (vente 9) -----------------------------------------------------------------------------------
execute decide('91', 'accepted', null, '2026-11-01 09:00:00+00');
execute decide('92', 'accepted', null, '2026-11-01 09:00:00+00');
select pg_temp.project('9') ->> 'changed';

-- Écriture partielle d'une autre colonne : rien n'est noté.
update public.auction_sales set city = 'Betaville' where id = '88500000-1000-4000-8000-000000000009';

select ok(
  (select not held_fields #> '{property.surface_m2}' ? 'listing_silent_since'
          and not held_fields #> '{property.occupancy_status}' ? 'listing_silent_since'
     from public.auction_sales where id = '88500000-1000-4000-8000-000000000009'),
  'a write that does not touch the columns of a held field notes nothing'
);

-- L'annonce ne donne plus de surface, et une occupation inconnue.
set local role service_role;
execute reimport('9', null, null, null, null, null, 50, null, null, 2, 1, 'unknown');
reset role;

select results_eq(
  $$select surface_m2, occupancy_status, held_fields #> '{property.surface_m2,listing}',
           held_fields #> '{property.occupancy_status,listing}',
           (held_fields #>> '{property.surface_m2,listing_silent_since}')::timestamptz
             between statement_timestamp() - interval '1 minute' and statement_timestamp(),
           held_fields #> '{property.occupancy_status}' ? 'listing_silent_since',
           held_fields #> '{property.surface_m2}' ? 'echo'
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000009'$$,
  $$values (54::numeric, 'vacant',
            '{"surface_m2": 50, "app_surface_m2": 50, "app_surface_kind": "habitable",
              "surface_source": "listing_text", "surface_confidence": 0.7}'::jsonb,
            '{"occupancy_status": "occupied"}'::jsonb, true, true, false)$$,
  'a listing that goes silent keeps the pieces and the remembered listing values; the entries only note the silence'
);

create temporary table silence_marks on commit drop as
select held_fields #>> '{property.surface_m2,listing_silent_since}' as since from public.auction_sales
where id = '88500000-1000-4000-8000-000000000009';

set local role service_role;
execute reimport('9', 0, 0, null, null, null, 50, null, null, 2, 1, null);
reset role;

select ok(
  (select sale.held_fields #>> '{property.surface_m2,listing_silent_since}' = mark.since
     from public.auction_sales sale, silence_marks mark
     where sale.id = '88500000-1000-4000-8000-000000000009')
  and not exists (
    select 1 from public.auction_sale_field_hold_events
    where sale_id = '88500000-1000-4000-8000-000000000009' and event not like 'projection%'),
  'the silence is dated once, and is never an event'
);

-- Recopie de la valeur tenue par la collecte : elle ne dit rien de l'annonce, la note reste.
set local role service_role;
execute reimport('9', 54, 54, 'built', 'fact_registry', 0.85, 50, null, null, 2, 1, 'vacant');
reset role;

select ok(
  (select held_fields #> '{property.surface_m2}' ? 'listing_silent_since'
          and held_fields #> '{property.occupancy_status}' ? 'listing_silent_since'
     from public.auction_sales where id = '88500000-1000-4000-8000-000000000009'),
  'the held value copied back by the collection says nothing about the listing: the note stays'
);

-- Retrait pendant le silence : la valeur d'annonce mémorisée revient (règle du lot R1, gardée par le plan).
execute decide('92', 'withdrawn', 'entry_error', null);
select pg_temp.project('9') ->> 'changed';

select is(
  (select occupancy_status from public.auction_sales where id = '88500000-1000-4000-8000-000000000009'),
  'occupied',
  'a withdrawal during the silence restores the remembered listing value: it was not emptied'
);

-- L'annonce redit sa valeur : la note disparaît.
set local role service_role;
execute reimport('9', 50, 50, 'habitable', 'listing_text', 0.7, 50, null, null, 2, 1, 'occupied');
reset role;

select ok(
  (select not held_fields #> '{property.surface_m2}' ? 'listing_silent_since' and surface_m2 = 54
     from public.auction_sales where id = '88500000-1000-4000-8000-000000000009'),
  'once the listing gives its value again, the note is removed and the piece still holds'
);

-- La note disparaît aussi quand l'annonce change.
set local role service_role;
execute reimport('9', null, null, null, null, null, 50, null, null, 2, 1, 'occupied');
execute reimport('9', 62, 62, 'carrez', 'pdf', 0.9, 50, null, null, 2, 1, 'occupied');
reset role;

select results_eq(
  $$select held_fields #> '{property.surface_m2}' ? 'listing_silent_since',
           held_fields #> '{property.surface_m2,listing,surface_m2}'
      from public.auction_sales where id = '88500000-1000-4000-8000-000000000009'$$,
  $$values (false, '62'::jsonb)$$,
  'a changed listing ends the silence too'
);

-- updated_at monotone ---------------------------------------------------------------------------------------------
-- updated_at de la vente est dans le futur (horloge d'un autre serveur, restauration) : la projection l'avance
-- quand même, pour qu'une écriture optimiste de la collecte, gardée par updated_at, abandonne.
update public.auction_sales set updated_at = statement_timestamp() + interval '1 day'
where id = '88500000-1000-4000-8000-000000000009';
create temporary table clock_marks on commit drop as
select updated_at from public.auction_sales where id = '88500000-1000-4000-8000-000000000009';
execute decide('91', 'withdrawn', 'entry_error', null);
select pg_temp.project('9') ->> 'changed';

select ok(
  (select sale.updated_at > mark.updated_at from public.auction_sales sale, clock_marks mark
     where sale.id = '88500000-1000-4000-8000-000000000009'),
  'the projection always advances updated_at, even when it is ahead of the clock'
);

-- Indices de fusion -----------------------------------------------------------------------------------------------
-- Vente a (conservée) : la fusion y a déjà recopié les 4 pièces que tenait la vente absorbée (annonce réelle :
-- 2 pièces). Les indices sont l'entrée held_fields de la vente absorbée.
update public.auction_sales set rooms_count = 4 where id = '88500000-1000-4000-8000-00000000000a';
execute decide('a1', 'accepted', null, '2026-11-01 09:00:00+00');

select is(
  (app_private.project_sale_fields(
    '88500000-1000-4000-8000-00000000000a', array['property.rooms_count'], true,
    '{"property.rooms_count": {"v": 2, "state": "held", "value": 4, "claim_id": "x",
        "listing": {"rooms_count": 2, "surface_m2": 999},
        "echo": [{"value": 3}, {"value": 7, "until": "2000-01-01T00:00:00+00:00"}]}}'::jsonb
   ) #> '{fields,property.rooms_count}') - 'decision_id',
  '{"state": "held", "value": 4, "claim_id": "88500000-2000-4000-8000-0000000000a1"}'::jsonb,
  'the projection takes merge hints'
);

select results_eq(
  $$select rooms_count, held_fields #> '{property.rooms_count,listing}',
           held_fields #> '{property.rooms_count,echo}'
      from public.auction_sales where id = '88500000-1000-4000-8000-00000000000a'$$,
  $$values (4, '{"rooms_count": 2}'::jsonb, '[{"value": 3}]'::jsonb)$$,
  'a column already carrying the value held by the absorbed sale: the listing block is the hint, only its own column, and the live echo memory is taken over'
);

execute decide('a1', 'withdrawn', 'entry_error', null);
select pg_temp.project('a') ->> 'changed';

select is(
  (select rooms_count from public.auction_sales where id = '88500000-1000-4000-8000-00000000000a'),
  2,
  'the withdrawal then gives the real listing value back, not the value of the piece'
);

-- Vente b : ses colonnes ne portent pas la valeur de l'indice : l'instantané des colonnes fait foi. La valeur que
-- tenait la vente absorbée, différente de celle qui tient désormais, entre en mémoire d'écho.
execute decide('b1', 'accepted', null, '2026-11-01 09:00:00+00');
select app_private.project_sale_fields(
  '88500000-1000-4000-8000-00000000000b', null, true,
  '{"property.rooms_count": {"state": "held", "value": 4, "listing": {"rooms_count": 9}},
    "property.occupancy_status": {"state": "released", "echo": [{"value": "vacant"}]}}'::jsonb
) ->> 'changed';

select results_eq(
  $$select rooms_count, held_fields #> '{property.rooms_count,listing}',
           held_fields #> '{property.rooms_count,echo,0,value}',
           held_fields #> '{property.rooms_count,echo,0}' ? 'until',
           held_fields #> '{property.occupancy_status}'
      from public.auction_sales where id = '88500000-1000-4000-8000-00000000000b'$$,
  $$values (6, '{"rooms_count": 2}'::jsonb, '4'::jsonb, true,
            '{"v": 2, "state": "released", "released_by": "merge", "tolerance": {},
              "echo": [{"value": "vacant"}]}'::jsonb)$$,
  'without contamination the snapshot of the columns is the listing block; the echo memory of the absorbed sale is kept, even for a field that nothing holds'
);

update public.auction_sales set occupancy_status = 'vacant', rooms_count = 4
where id = '88500000-1000-4000-8000-00000000000b';

select results_eq(
  $$select occupancy_status, rooms_count from public.auction_sales
      where id = '88500000-1000-4000-8000-00000000000b'$$,
  $$values ('occupied', 6)$$,
  'the values remembered from the absorbed sale cannot come back on the kept sale'
);

select throws_ok(
  $$select app_private.project_sale_fields(
      '88500000-1000-4000-8000-00000000000b', null, false, '[]'::jsonb)$$,
  '22023',
  'Listing hints must be a JSON object.',
  'merge hints that are not a JSON object are refused'
);

-- Un état inconnu dans held_fields arrête l'écriture au lieu de laisser un champ sans garde ---------------------
select set_config('app.sale_field_projection', '88500000-1000-4000-8000-000000000004', true);
update public.auction_sales
set held_fields = jsonb_set(held_fields, '{property.surface_m2,state}', '"frozen"'::jsonb)
where id = '88500000-1000-4000-8000-000000000004';
select set_config('app.sale_field_projection', '', true);

select throws_ok(
  $$update public.auction_sales set surface_m2 = 70 where id = '88500000-1000-4000-8000-000000000004'$$,
  '22023',
  'auction_sales.held_fields holds the field property.surface_m2 in an unknown state.',
  'an entry in a state that the trigger does not know stops the write loudly'
);

-- Le rôle de la collecte n'écrit ni la file ni held_fields : c'est la retenue qui les a écrits -----------------
select ok(
  not has_table_privilege('service_role', 'public.auction_sale_field_hold_events', 'INSERT')
  and (select count(*) >= 8 from public.auction_sale_field_hold_events
         where sale_id::text like '88500000-1000-%' and event = 'echo_suppressed'),
  'the echo events above were written by the trigger, not by the server role, which cannot insert in the queue'
);

select * from finish();
rollback;
