-- 20261118100000 et 20261118100200 : le registre des pièces lors d'une fusion de doublons (lot R2b, étapes B0 et B2).
--   * la fusion reprojette elle-même la vente conservée, avec les entrées de la vente absorbée en indice ;
--   * vente absorbée tenue, vente conservée libre dont la colonne porte déjà la valeur de la pièce : le champ est
--     tenu, la valeur d'annonce mémorisée est celle de l'absorbée, et un retrait la rend ;
--   * deux pièces d'origines différentes qui se contredisent : rien ne bascule, la valeur de l'absorbée est
--     mémorisée ;
--   * fusion en deux temps ;
--   * SANS GAGNANT (pièce délogée par l'annonce de la vente conservée, vente de terrain) : la valeur d'annonce de
--     l'indice revient, l'entrée est libérée au nom de la fusion, la valeur tenue entre en mémoire d'écho ;
--   * sans gagnant et sans colonne contaminée : seule la mémoire est reprise ;
--   * rappeler la projection avec le même indice ne change rien ;
--   * la contamination se juge à l'égalité exacte, sur chacune des deux colonnes de valeur de la surface ;
--   * fusion en chaîne : une pièce bloquée sur les deux premières ventes est reportée à la troisième ;
--   * une pièce reportée est journalisée (merge_carried, vente d'origine) et comptée par le contrôle quotidien ;
--     une prise ultérieure de la même pièce, hors fusion, ne l'est pas ;
--   * une opposition suit la fusion, sans échéance ;
--   * le journal des publications de l'agent d'information suit la vente conservée ;
--   * rien à reporter, ou pas de vente conservée : la projection n'est pas appelée.
begin;

set local timezone = 'UTC';

select plan(32);

-- Jeu d'essai -----------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('88800000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('88800000-0000-4000-8000-0000000000a1', 'registre-admin-888@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"88800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

-- Vingt-sept ventes : maison, 50 m², 2 pièces, 1 chambre. Ventes 11, 21 et 22 : 7 pièces, 6 chambres. Vente 13 :
-- un terrain.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
  rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88800000-1000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'licitor',
  'https://example.test/888/sale-' || n, 'upcoming', current_timestamp + interval '20 days', 'Alphaville',
  case when n = 13 then 'land' else 'house' end, 90000, '{}'::jsonb,
  '{}'::jsonb, 'tribunal', 50, 50, 'habitable', 'listing_text', 0.7,
  case when n in (11, 21, 22) then 7 else 2 end, case when n in (11, 21, 22) then 6 else 1 end, 'occupied',
  '[]'::jsonb
from generate_series(1, 27) n;

-- Une pièce par vente utile, chacune d'un dossier d'avocat distinct (origines différentes, même rang).
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88800000-2000-4000-8000-0000000000' || piece.sale)::uuid,
  ('88800000-1000-4000-8000-0000000000' || piece.sale)::uuid,
  piece.field_key, piece.value, 'professional_email',
  jsonb_build_object('case_id', '88800000-3000-4000-8000-0000000000' || piece.sale), 0.6,
  'information_agent', 'v1', '88800000-0000-4000-8000-0000000000a1'
from (
  values
    ('01', 'property.rooms_count', '5'::jsonb),
    ('03', 'property.rooms_count', '5'::jsonb),
    ('04', 'property.rooms_count', '6'::jsonb),
    ('05', 'property.rooms_count', '5'::jsonb),
    ('08', 'property.rooms_count', '5'::jsonb),
    ('09', 'property.rooms_count', '6'::jsonb),
    ('10', 'property.rooms_count', '3'::jsonb),
    ('12', 'property.surface_m2', '54'::jsonb),
    ('14', 'property.rooms_count', '5'::jsonb),
    ('18', 'property.rooms_count', '5'::jsonb),
    ('21', 'property.rooms_count', '3'::jsonb),
    ('24', 'property.surface_m2', '54'::jsonb),
    ('27', 'property.surface_m2', '54'::jsonb)
) as piece (sale, field_key, value);

create function pg_temp.sale(p_suffix text) returns uuid
language sql as $function$ select ('88800000-1000-4000-8000-0000000000' || p_suffix)::uuid $function$;
create function pg_temp.claim(p_suffix text) returns uuid
language sql as $function$ select ('88800000-2000-4000-8000-0000000000' || p_suffix)::uuid $function$;

-- Une fusion comme la fait la collecte : la vente conservée est écrite d'abord (elle reçoit l'adresse de la vente
-- absorbée, et p_columns : les colonnes fusionnées), puis la vente absorbée est supprimée. Ses entrées sont
-- gardées dans merge_hints pour les essais de stabilité.
create temporary table merge_hints (old_sale uuid primary key, hint jsonb) on commit drop;
create function pg_temp.merge(p_old text, p_kept text, p_columns text default null) returns void
language plpgsql as $function$
begin
  insert into merge_hints select sale.id, sale.held_fields from public.auction_sales sale
  where sale.id = pg_temp.sale(p_old);
  execute format(
    'update public.auction_sales set source_urls = %L::jsonb%s where id = %L',
    jsonb_build_array('https://example.test/888/sale-' || p_kept::integer,
      'https://example.test/888/sale-' || p_old::integer),
    coalesce(', ' || p_columns, ''), pg_temp.sale(p_kept));
  perform count(*) from public.bridge_auction_sales_to_outcome_graph();
  delete from public.auction_sales where id = pg_temp.sale(p_old);
end;
$function$;

-- 1. Vente absorbée tenue, vente conservée libre et contaminée ---------------------------------------------------------
select public.accept_auction_fact_claim(pg_temp.claim('01'), 'single_lot') ->> 'state';
insert into public.information_agent_fact_publications (
  fact_id, sale_id, fact_key, actor_kind, actor_id, recipient_kind
) values (
  '88800000-4000-4000-8000-000000000001', pg_temp.sale('01'), 'rooms_count', 'admin',
  '88800000-0000-4000-8000-0000000000a1', 'source_lawyer'
);
select pg_temp.merge('01', '02', 'rooms_count = 5');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           (sale.held_fields #>> '{property.rooms_count,claim_id}')::uuid,
           sale.held_fields #> '{property.rooms_count,listing}'
      from public.auction_sales sale where sale.id = pg_temp.sale('02')$$,
  $$values (5, 'held', pg_temp.claim('01'), '{"rooms_count": 2}'::jsonb)$$,
  'the merge itself reprojects the kept sale: the piece of the absorbed sale holds the field, and the listing value remembered is the one of the absorbed sale, not the value of the piece already written in the column'
);

select results_eq(
  $$select event.event, event.held_value, event.listing_value, event.incoming_value,
           event.decision_id = (select decision.id from public.auction_fact_claim_decisions decision
                                 where decision.claim_id = pg_temp.claim('01'))
      from public.auction_sale_field_hold_events event
      where event.sale_id = pg_temp.sale('02') order by event.seq$$,
  $$values ('projection_held', '5'::jsonb, '2'::jsonb, null::jsonb, true),
           ('merge_carried', '5'::jsonb, null::jsonb,
            jsonb_build_object('from_sale_id', pg_temp.sale('01')), true)$$,
  'the take is logged for the kept sale, and a merge_carried event names the sale the piece comes from and its decision'
);

select results_eq(
  $$select sale_id from public.information_agent_fact_publications
      where fact_id = '88800000-4000-4000-8000-000000000001'$$,
  $$values (pg_temp.sale('02'))$$,
  'the publication journal of the information agent follows the kept sale instead of being deleted by the cascade'
);

select is(
  (select app_private.project_sale_fields(pg_temp.sale('02'), null, false, hint) ->> 'changed'
     from merge_hints where old_sale = pg_temp.sale('01')),
  'false',
  'projecting again with the same hint changes nothing'
);

create temporary table withdrawn on commit drop as
select public.withdraw_auction_fact_claim(pg_temp.claim('01'), 'entry_error') as result;

select results_eq(
  $$select result ->> 'state', result ->> 'sale_id',
           (select rooms_count from public.auction_sales where id = pg_temp.sale('02'))
      from withdrawn$$,
  $$values ('released', pg_temp.sale('02')::text, 2)$$,
  'a withdrawal after the merge gives back the true listing value, not the value of the piece'
);

-- 2. Les deux ventes tiennent le champ, par deux origines qui se contredisent ------------------------------------------
select public.accept_auction_fact_claim(pg_temp.claim('03'), 'single_lot') ->> 'state';
select public.accept_auction_fact_claim(pg_temp.claim('04'), 'single_lot') ->> 'state';
select pg_temp.merge('03', '04');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           (sale.held_fields #>> '{property.rooms_count,claim_id}')::uuid,
           jsonb_path_query_array(sale.held_fields, '$."property.rooms_count".echo[*].value'),
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'conflicted')
      from public.auction_sales sale where sale.id = pg_temp.sale('04')$$,
  $$values (6, 'conflicted', pg_temp.claim('04'), '[5]'::jsonb, 1)$$,
  'two pieces of different origins that disagree: nothing switches, the displayed value stays, the case goes to review, and the value held by the absorbed sale is remembered'
);

-- 3. Fusion en deux temps ----------------------------------------------------------------------------------------------
select public.accept_auction_fact_claim(pg_temp.claim('05'), 'single_lot') ->> 'state';
select pg_temp.merge('05', '06', 'rooms_count = 5');
select pg_temp.merge('06', '07', 'rooms_count = 5');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           sale.held_fields #> '{property.rooms_count,listing}',
           (select count(*)::integer from app_private.auction_sale_merges merge
              where merge.canonical_sale_id = sale.id)
      from public.auction_sales sale where sale.id = pg_temp.sale('07')$$,
  $$values (5, 'held', '{"rooms_count": 2}'::jsonb, 2)$$,
  'a merge in two steps: the piece follows to the sale finally kept, with the listing value of the first sale'
);

-- 4. Sans gagnant : la pièce de l'absorbée est délogée par l'annonce de la vente conservée --------------------------------
-- La pièce de la vente 8 est acceptée d'abord. La vente 9 tient 6 pièces sous le réglage « l'annonce l'emporte »,
-- puis son annonce passe à 9 pièces : le champ est libéré, et cet évènement écarte toute décision plus ancienne.
select public.accept_auction_fact_claim(pg_temp.claim('08'), 'single_lot') ->> 'state';
update public.auction_fact_fields set on_listing_change = 'listing_wins_and_review'
where field_key = 'property.rooms_count';
select public.accept_auction_fact_claim(pg_temp.claim('09'), 'single_lot') ->> 'state';
update public.auction_fact_fields set on_listing_change = 'keep_and_review'
where field_key = 'property.rooms_count';
update public.auction_sales set rooms_count = 9 where id = pg_temp.sale('09');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           sale.held_fields #>> '{property.rooms_count,released_by}'
      from public.auction_sales sale where sale.id = pg_temp.sale('09')$$,
  $$values (9, 'released', 'listing')$$,
  'before the merge: the listing of the kept sale has dislodged its piece'
);

-- La fusion écrit la valeur que tenait la vente 8 (5 pièces) dans la vente 9, puis supprime la vente 8.
select pg_temp.merge('08', '09', 'rooms_count = 5');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           sale.held_fields #>> '{property.rooms_count,released_by}',
           sale.held_fields #> '{property.rooms_count,restored}',
           jsonb_path_query_array(sale.held_fields, '$."property.rooms_count".echo[*].value'),
           (select bool_and(item.value ? 'until')
              from jsonb_array_elements(sale.held_fields #> '{property.rooms_count,echo}') item)
      from public.auction_sales sale where sale.id = pg_temp.sale('09')$$,
  $$values (2, 'released', 'merge', '{"rooms_count": 2}'::jsonb, '[5, 6]'::jsonb, true)$$,
  'no piece takes the field (the older piece of the absorbed sale is dislodged too): the listing value of the hint comes back instead of the value of the piece, the entry is released in the name of the merge, and the value the absorbed sale held enters the echo memory with a deadline'
);

select results_eq(
  $$select event.event, event.held_value, event.listing_value
      from public.auction_sale_field_hold_events event
      where event.sale_id = pg_temp.sale('09') order by event.seq desc limit 1$$,
  $$values ('projection_released', '5'::jsonb, '2'::jsonb)$$,
  'the release is logged for the kept sale, with the value it removes'
);

select results_eq(
  $$select app_private.project_sale_fields(pg_temp.sale('09'), null, false) ->> 'changed',
           app_private.project_sale_fields(pg_temp.sale('09'), null, false, hint) ->> 'changed'
      from merge_hints where old_sale = pg_temp.sale('08')$$,
  $$values ('false', 'false')$$,
  'stable: neither a plain projection nor a projection with the same hint changes anything afterwards'
);

-- La valeur de la pièce ne revient pas par un import en retard.
update public.auction_sales set rooms_count = 5 where id = pg_temp.sale('09');
select results_eq(
  $$select sale.rooms_count,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'echo_suppressed')
      from public.auction_sales sale where sale.id = pg_temp.sale('09')$$,
  $$values (2, 1)$$,
  'and a late write of the value the absorbed sale held is set aside as an echo'
);

-- 5. Sans gagnant, sans colonne contaminée : la pièce est refusée par les chambres de la vente conservée -------------------
select public.accept_auction_fact_claim(pg_temp.claim('10'), 'single_lot') ->> 'state';
select pg_temp.merge('10', '11');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           sale.held_fields #>> '{property.rooms_count,released_by}',
           sale.held_fields #> '{property.rooms_count}' ? 'restored',
           jsonb_path_query_array(sale.held_fields, '$."property.rooms_count".echo[*].value'),
           (select event.event from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id order by event.seq desc limit 1)
      from public.auction_sales sale where sale.id = pg_temp.sale('11')$$,
  $$values (7, 'released', 'merge', false, '[3]'::jsonb, 'projection_blocked')$$,
  'no piece takes the field and no column carries the value of the piece: the columns are left alone, only the memory is taken over, and the blocked piece goes to review'
);

select is(
  (select app_private.project_sale_fields(pg_temp.sale('11'), null, false, hint) ->> 'changed'
     from merge_hints where old_sale = pg_temp.sale('10')),
  'false',
  'projecting again with the same hint does not extend a deadline'
);

-- 6. Sans gagnant : une surface tenue, absorbée par une vente de terrain ---------------------------------------------------
select public.accept_auction_fact_claim(pg_temp.claim('12'), 'single_lot') ->> 'state';
select pg_temp.merge('12', '13', 'surface_m2 = 54, app_surface_m2 = 54');

select results_eq(
  $$select sale.surface_m2, sale.app_surface_m2, sale.app_surface_kind, sale.surface_source,
           sale.held_fields #>> '{property.surface_m2,state}',
           sale.held_fields #>> '{property.surface_m2,released_by}',
           sale.held_fields #> '{property.surface_m2,restored}'
      from public.auction_sales sale where sale.id = pg_temp.sale('13')$$,
  $$values (50::numeric, 50::numeric, 'habitable', 'listing_text', 'released', 'merge',
            '{"surface_m2": 50, "app_surface_m2": 50}'::jsonb)$$,
  'a built surface absorbed by a land sale is not held: the whole surface group of the hint comes back, and the entry is released in the name of the merge'
);

-- 7. Une opposition suit la fusion ------------------------------------------------------------------------------------------
select public.accept_auction_fact_claim(pg_temp.claim('14'), 'single_lot') ->> 'state';
select public.oppose_auction_fact_claim(pg_temp.claim('14')) ->> 'state';
select pg_temp.merge('14', '15');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           sale.held_fields #>> '{property.rooms_count,released_by}',
           sale.held_fields #> '{property.rooms_count,echo}'
      from public.auction_sales sale where sale.id = pg_temp.sale('15')$$,
  $$values (2, 'released', 'merge', '[{"value": 5}]'::jsonb)$$,
  'an opposed value follows the merge, without a deadline: it will not come back on the kept sale either'
);

update public.auction_sales set rooms_count = 5 where id = pg_temp.sale('15');
select is(
  (select rooms_count from public.auction_sales where id = pg_temp.sale('15')),
  2,
  'a write of the opposed value on the kept sale is set aside'
);

-- 7 bis. Contamination : égalité exacte, sur chacune des deux colonnes de valeur de la surface -----------------------------
-- Vente 25 : son annonce dit 53,5 m², dans la tolérance de la pièce de 54 m² que tenait la vente 24. Ce n'est pas
-- la valeur de la pièce recopiée par la fusion : la valeur d'annonce mémorisée est 53,5, pas celle de la vente 24.
select public.accept_auction_fact_claim(pg_temp.claim('24'), 'single_lot') ->> 'state';
select pg_temp.merge('24', '25', 'surface_m2 = 53.5, app_surface_m2 = 53.5');
select results_eq(
  $$select sale.app_surface_m2, sale.held_fields #>> '{property.surface_m2,state}',
           sale.held_fields #> '{property.surface_m2,listing,app_surface_m2}',
           sale.held_fields #> '{property.surface_m2,listing,surface_m2}'
      from public.auction_sales sale where sale.id = pg_temp.sale('25')$$,
  $$values (54::numeric, 'held', '53.5'::jsonb, '53.5'::jsonb)$$,
  'a listing value close to the piece, within its tolerance, is not the piece copied by the merge: it stays the listing value remembered'
);

-- Vente 26 : la fusion a écrit la valeur de la pièce dans surface_m2 seulement (app_surface_m2 garde 50).
select public.accept_auction_fact_claim(pg_temp.claim('27'), 'single_lot') ->> 'state';
select pg_temp.merge('27', '26', 'surface_m2 = 54');
select results_eq(
  $$select sale.held_fields #>> '{property.surface_m2,state}',
           sale.held_fields #> '{property.surface_m2,listing,surface_m2}',
           sale.held_fields #> '{property.surface_m2,listing,app_surface_m2}'
      from public.auction_sales sale where sale.id = pg_temp.sale('26')$$,
  $$values ('held', '50'::jsonb, '50'::jsonb)$$,
  'the value of the piece written in surface_m2 alone is seen too: the listing block is the one of the absorbed sale'
);

-- 7 ter. Fusion en chaîne : la pièce est bloquée sur les deux premières ventes (6 chambres), aucune ne tient rien -------------
select public.accept_auction_fact_claim(pg_temp.claim('21'), 'single_lot') ->> 'state';
select pg_temp.merge('21', '22');
select results_eq(
  $$select sale.rooms_count, sale.held_fields is null,
           (select count(*)::integer from public.auction_fact_claim_decisions decision
              where decision.sale_id = sale.id)
      from public.auction_sales sale where sale.id = pg_temp.sale('22')$$,
  $$values (7, true, 0)$$,
  'before the second merge: the middle sale holds nothing, remembers nothing, and no decision names it'
);
select pg_temp.merge('22', '23');
select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           (sale.held_fields #>> '{property.rooms_count,claim_id}')::uuid,
           (select event.incoming_value from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'merge_carried')
      from public.auction_sales sale where sale.id = pg_temp.sale('23')$$,
  $$values (3, 'held', pg_temp.claim('21'), jsonb_build_object('from_sale_id', pg_temp.sale('21')))$$,
  'a merge in chain reprojects the sale finally kept even when the middle sale carried nothing itself: the decision names a sale it had absorbed'
);

-- Une prise hors fusion n'est pas un report. Vente 04 : la fusion n'a rien posé (contradiction). Le retrait de la
-- pièce de la vente conservée laisse la pièce de la vente absorbée prendre le champ, par une décision.
select public.withdraw_auction_fact_claim(pg_temp.claim('04'), 'entry_error') ->> 'state';
select results_eq(
  $$select (sale.held_fields #>> '{property.rooms_count,claim_id}')::uuid,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'merge_carried')
      from public.auction_sales sale where sale.id = pg_temp.sale('04')$$,
  $$values (pg_temp.claim('03'), 0)$$,
  'a piece of an absorbed sale that takes the field later, by a decision and not by a merge, is not logged as carried'
);

-- Le contrôle quotidien compte les pièces reportées sur 24 heures.
select is(
  app_private.fact_registry_global_checks(null) -> 'merge_carried',
  jsonb_build_object(
    'count', (select count(*)::integer from public.auction_sale_field_hold_events where event = 'merge_carried'),
    'window_hours', 24),
  'the daily check counts the pieces carried by a merge over 24 hours'
);
select is(
  (select count(*)::integer from public.auction_sale_field_hold_events where event = 'merge_carried'), 6,
  'every piece posed on a kept sale by the merges above is logged as carried, once'
);

-- 8. Les décisions ne sont pas déplacées --------------------------------------------------------------------------------------
select results_eq(
  $$select count(*)::integer, count(*) filter (where claim.auction_sale_id is null)::integer,
           count(*) filter (where merge.canonical_sale_id is not null)::integer
      from public.auction_fact_claim_decisions decision
      join public.auction_fact_claims claim on claim.id = decision.claim_id
      left join app_private.auction_sale_merges merge on merge.old_sale_id = decision.sale_id
      where decision.claim_id in (pg_temp.claim('01'), pg_temp.claim('03'), pg_temp.claim('05'),
        pg_temp.claim('08'), pg_temp.claim('10'), pg_temp.claim('12'), pg_temp.claim('14'))$$,
  $$values (9, 9, 9)$$,
  'nothing is moved in the registry: every decision keeps the absorbed sale, its claim is detached, and the merge table leads to the kept sale'
);

select is(
  (select count(*)::integer from public.auction_sales sale
     where sale.id in (pg_temp.sale('02'), pg_temp.sale('04'), pg_temp.sale('07'), pg_temp.sale('09'),
       pg_temp.sale('11'), pg_temp.sale('13'), pg_temp.sale('15'), pg_temp.sale('23'), pg_temp.sale('25'),
       pg_temp.sale('26'))
       and (app_private.project_sale_fields(sale.id, null, false) ->> 'changed')::boolean),
  0,
  'after these merges no kept sale drifts: the daily check has nothing to report'
);

-- 9. La fonction de report lit les entrées de la vente absorbée, sans jamais écrire la colonne ---------------------------------
select ok(
  (select position(
            'app_private.project_sale_fields(v_target, null, true, coalesce(old.held_fields, ''{}''::jsonb))'
            in prosrc) > 0
          and prosrc !~* 'held_fields\s*(:=|=[^=])'
          and position('insert into app_private.auction_sale_merges' in prosrc)
              < position('app_private.project_sale_fields' in prosrc)
          and prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'app_private.carry_sale_user_data_to_merged_sale()'::regprocedure)
  and not has_function_privilege('service_role', 'app_private.carry_sale_user_data_to_merged_sale()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.carry_sale_user_data_to_merged_sale()', 'EXECUTE'),
  'the carry function projects the kept sale after recording the merge, passes the entries of the absorbed sale as the hint, never assigns the column, and is executable by no API role'
);

-- 10. Rien à reporter, ou pas de vente conservée : la projection n'est pas appelée ------------------------------------------------
-- (En dernier : la projection reste remplacée par une fonction qui lève jusqu'au rollback.)
select public.accept_auction_fact_claim(pg_temp.claim('18'), 'single_lot') ->> 'state';

create or replace function app_private.project_sale_fields(
  p_sale_id uuid,
  p_fields text[] default null,
  p_apply boolean default false,
  p_listing_hints jsonb default null
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
begin
  raise exception 'projection called';
end;
$function$;

select lives_ok(
  $$select pg_temp.merge('16', '17')$$,
  'inert: a merge of two sales that the registry does not know never calls the projection'
);

select throws_ok(
  $$select pg_temp.merge('18', '19')$$,
  'P0001', 'projection called',
  'while the merge of a sale that holds a field does call it'
);

select lives_ok(
  $$delete from public.auction_sales where id = pg_temp.sale('18')$$,
  'a held sale deleted without a kept sale (retention, withdrawal) calls no projection'
);

select results_eq(
  $$select count(*)::integer from app_private.auction_sale_merges
      where old_sale_id in (pg_temp.sale('16'), pg_temp.sale('18'))$$,
  $$values (1)$$,
  'and records no merge'
);

select ok(
  (select count(*) = 0 from public.auction_fact_claim_decisions
     where claim_id::text like '88800000-2000-%' and (publication_mode <> 'manual' or actor_kind <> 'admin')),
  'no merge wrote a decision: the journal holds only the manual decisions of the administrator'
);

select * from finish();
rollback;
