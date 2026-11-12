-- 20261118100100 : fonctions de décision du registre des pièces (lot R2b, étape B1).
--   * aucun droit d'exécution : ni anon, ni authenticated, ni service_role (les droits s'ouvrent au lot R2c) ;
--   * l'auteur est celui du jeton (auth.uid()), aucun paramètre ne le fournit ; public.is_admin() en tête, second
--     facteur compris quand l'interrupteur est actif ;
--   * sans déclencheur du registre en place, rien n'est écrit (registry_unavailable) ;
--   * chaque transition admise et refusée ; chaque refus propre à l'acceptation ; motifs et rattachements jugés
--     par les contraintes de la table ; lot_ref normalisé, NULL hors motif ;
--   * retrait : la valeur de l'annonce revient ; opposition : plus d'acceptation ;
--   * une décision reprojette toute la vente (nombre de chambres corrigé, reclassement en terrain) ;
--   * observation détachée par une fusion : décidée pour la vente absorbée, projetée sur la vente conservée ;
--   * une erreur inattendue devient registry_write_failed, sans détail ni indice ;
--   * public.review_auction_fact_claim : vente verrouillée d'abord, colonnes nommées, observation professionnelle
--     ou déjà décidée au journal refusée.
-- Le cas « sale_busy » (vente verrouillée par une autre session) se rejoue à deux sessions : runbook R2b.
begin;

set local timezone = 'UTC';

select plan(64);

-- Droits ----------------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer
     from unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     cross join unnest(array[
       'public.accept_auction_fact_claim(uuid, text, text, uuid)',
       'public.reject_auction_fact_claim(uuid, text)',
       'public.withdraw_auction_fact_claim(uuid, text)',
       'public.oppose_auction_fact_claim(uuid, text)',
       'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)',
       'app_private.lock_sale_for_registry(uuid)']) routine(signature)
     where has_function_privilege(api_role.name, routine.signature, 'EXECUTE')),
  0,
  'no API role can execute a decision function at this stage: neither anon, nor authenticated, nor service_role'
);

select ok(
  (select bool_and(routine.prosecdef and routine.proconfig = array['search_path=""'])
     from pg_proc routine
     where routine.oid in (
       'public.accept_auction_fact_claim(uuid, text, text, uuid)'::regprocedure,
       'public.reject_auction_fact_claim(uuid, text)'::regprocedure,
       'public.withdraw_auction_fact_claim(uuid, text)'::regprocedure,
       'public.oppose_auction_fact_claim(uuid, text)'::regprocedure,
       'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure)),
  'the five functions are security definer with an empty search path'
);

select is(
  (select count(*)::integer
     from pg_proc routine
     where routine.proname in (
       'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
       'oppose_auction_fact_claim', 'decide_auction_fact_claim')
       and pg_get_function_arguments(routine.oid) ~* 'actor|reviewer|user|admin'),
  0,
  'none of them takes the author as a parameter'
);

-- Jeu d'essai -----------------------------------------------------------------------------------------------------
insert into auth.users (id) values
  ('88700000-0000-4000-8000-0000000000a1'), ('88700000-0000-4000-8000-0000000000b1');
insert into public.user_profiles (user_id, email, user_role) values
  ('88700000-0000-4000-8000-0000000000a1', 'registre-admin-887@example.test', 'admin'),
  ('88700000-0000-4000-8000-0000000000b1', 'registre-membre-887@example.test', 'user')
on conflict (user_id) do update set user_role = excluded.user_role;

-- Ventes 1 à 9 : maison, 50 m², 2 pièces, 1 chambre, occupée. Vente 3 : un terrain. Vente 4 : 7 pièces, 6 chambres.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
  rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88700000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/887/sale-' || n,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville',
  case when n = 3 then 'land' else 'house' end, 90000, '{}'::jsonb,
  '{}'::jsonb, 'tribunal', 50, 50, 'habitable', 'listing_text', 0.7,
  case when n = 4 then 7 else 2 end, case when n = 4 then 6 else 1 end, 'occupied', '[]'::jsonb
from generate_series(1, 9) n;

-- Observations d'un professionnel : (suffixe, vente, champ, valeur).
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88700000-2000-4000-8000-0000000000' || piece.suffix)::uuid,
  ('88700000-1000-4000-8000-00000000000' || piece.sale)::uuid,
  piece.field_key, piece.value, 'professional_email',
  jsonb_build_object('case_id', '88700000-3000-4000-8000-0000000000' || piece.suffix), 0.6,
  'information_agent', 'v1', '88700000-0000-4000-8000-0000000000a1'
from (
  values
    ('11', '1', 'property.rooms_count', '4'::jsonb),
    ('12', '1', 'property.surface_m2', '54'::jsonb),
    ('13', '1', 'property.occupancy_status', '"owner_occupied"'::jsonb),
    ('14', '1', 'sale.starting_price_eur', '95000'::jsonb),
    ('15', '1', 'property.land_surface_m2', '800'::jsonb),
    ('31', '3', 'property.surface_m2', '54'::jsonb),
    ('41', '4', 'property.rooms_count', '3'::jsonb),
    ('42', '4', 'property.occupancy_status', '"vacant"'::jsonb),
    ('43', '4', 'property.surface_m2', '61'::jsonb),
    ('44', '4', 'property.land_surface_m2', '300'::jsonb),
    ('51', '5', 'property.rooms_count', '5'::jsonb),
    ('61', '6', 'property.rooms_count', '5'::jsonb),
    ('71', '7', 'property.rooms_count', '6'::jsonb),
    ('72', '7', 'property.occupancy_status', '"vacant"'::jsonb),
    ('91', '9', 'property.rooms_count', '5'::jsonb)
) as piece (suffix, sale, field_key, value);

-- Vente 2 : une observation de document et une observation d'annonce.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
  extractor_name, extractor_version
) values
  ('88700000-2000-4000-8000-000000000021', '88700000-1000-4000-8000-000000000002', 'property.rooms_count',
   '6'::jsonb, 'source_document', '{}'::jsonb, 'https://example.test/887/cahier.pdf', 0.5,
   'immojudis-fact-claims', 'v1'),
  ('88700000-2000-4000-8000-000000000022', '88700000-1000-4000-8000-000000000002', 'property.rooms_count',
   '2'::jsonb, 'source_listing', '{}'::jsonb, 'https://example.test/887/sale-2', 0.5,
   'immojudis-fact-claims', 'v1');

create function pg_temp.sign_in(p_user text, p_aal text default 'aal1') returns void
language sql as $function$
  select set_config(
    'request.jwt.claims',
    case when p_user is null then '' else
      jsonb_build_object('sub', '88700000-0000-4000-8000-0000000000' || p_user, 'role', 'authenticated',
        'aal', p_aal)::text end,
    true);
$function$;
create function pg_temp.claim(p_suffix text) returns uuid
language sql as $function$ select ('88700000-2000-4000-8000-0000000000' || p_suffix)::uuid $function$;
create function pg_temp.sale(p_suffix text) returns uuid
language sql as $function$ select ('88700000-1000-4000-8000-00000000000' || p_suffix)::uuid $function$;
create function pg_temp.last_decision(p_suffix text) returns uuid
language sql as $function$
  select decision.id from public.auction_fact_claim_decisions decision
  where decision.claim_id = pg_temp.claim(p_suffix) order by decision.seq desc limit 1
$function$;

create temporary table results (label text primary key, result jsonb) on commit drop;

-- Qui peut décider -----------------------------------------------------------------------------------------------
select pg_temp.sign_in(null);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '42501', 'admin_required', 'without a signed-in user nothing is decided'
);

select pg_temp.sign_in('b1');
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '42501', 'admin_required', 'a signed-in user who is not an administrator decides nothing'
);

select pg_temp.sign_in('a1');
update app_private.security_switches set enabled = true where switch_name = 'admin_mfa_required';
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '42501', 'admin_required', 'with the second-factor switch on, an administrator signed in at aal1 decides nothing'
);
select throws_ok(
  $$select public.oppose_auction_fact_claim(pg_temp.claim('11'))$$,
  '42501', 'admin_required', 'nor does he record an opposition'
);
select pg_temp.sign_in('a1', 'aal2');
select lives_ok(
  $$insert into results select 'mfa', public.reject_auction_fact_claim(pg_temp.claim('91'), 'other')$$,
  'at aal2 the same administrator decides'
);
update app_private.security_switches set enabled = false where switch_name = 'admin_mfa_required';
select pg_temp.sign_in('a1');

set local role service_role;
select throws_ok(
  $$select public.accept_auction_fact_claim('88700000-2000-4000-8000-000000000011', 'single_lot')$$,
  '42501', 'permission denied for function accept_auction_fact_claim',
  'through an API role the function is not even executable at this stage'
);
reset role;

-- Contrôle des déclencheurs : échec fermé --------------------------------------------------------------------------
alter table public.auction_fact_claims disable trigger auction_fact_claims_no_truncate;
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '55000', 'registry_unavailable', 'with a registry trigger out of its mode, no decision is written'
);
alter table public.auction_fact_claims enable always trigger auction_fact_claims_no_truncate;

select is(
  (select count(*)::integer from public.auction_fact_claim_decisions where claim_id = pg_temp.claim('11')),
  0,
  'none of the refusals above left a decision'
);

-- Arguments --------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.accept_auction_fact_claim(null, 'single_lot')$$,
  '22023', 'invalid_argument', 'a decision names a claim'
);
select throws_ok(
  $$select public.accept_auction_fact_claim('88700000-2000-4000-8000-0000000000ff', 'single_lot')$$,
  'P0002', 'claim_not_found', 'an unknown claim is reported as such'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), null)$$,
  '22023', 'invalid_lot_attachment', 'an acceptance says how the piece is attached to the lot'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'whole_building')$$,
  '22023', 'invalid_lot_attachment', 'a lot attachment out of the list is refused by the constraint of the table'
);
select throws_ok(
  $$select app_private.decide_auction_fact_claim(pg_temp.claim('11'), 'contradicted', 'other', null, null, null)$$,
  '22023', 'invalid_argument', 'the internal function writes the four decisions of an administrator, no other'
);

-- Accepter : la pièce tient le champ, l'auteur est celui du jeton ----------------------------------------------------
insert into results select 'accept 11', public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot');

select results_eq(
  $$select array_agg(field.key order by field.key collate "C") from results, jsonb_object_keys(result) field(key)
      where label = 'accept 11'$$,
  $$values (array['claim_id', 'decision', 'decision_id', 'field_key', 'sale_id', 'state'])$$,
  'the result carries six keys and no column of the sale'
);

select results_eq(
  $$select result - 'decision_id', (result ->> 'decision_id')::uuid = pg_temp.last_decision('11')
      from results where label = 'accept 11'$$,
  $$values (jsonb_build_object(
      'claim_id', pg_temp.claim('11'), 'decision', 'accepted', 'sale_id', pg_temp.sale('1'),
      'field_key', 'property.rooms_count', 'state', 'held'), true)$$,
  'an acceptance returns the claim, the decision, the sale, the field and the state of the field'
);

select results_eq(
  $$select decision.actor_kind, decision.actor_id, decision.publication_mode, decision.lot_attachment,
           decision.lot_ref, decision.reason_code, sale.rooms_count,
           sale.held_fields #>> '{property.rooms_count,state}'
      from public.auction_fact_claim_decisions decision
      join public.auction_sales sale on sale.id = decision.sale_id
      where decision.claim_id = pg_temp.claim('11')$$,
  $$values ('admin', '88700000-0000-4000-8000-0000000000a1'::uuid, 'manual', 'single_lot', null::text,
            null::text, 4, 'held')$$,
  'the decision is written in the name of the signed-in administrator, in manual mode, and the piece holds the field'
);

-- Transitions ------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '55000', 'invalid_transition', 'accepting again without naming the decision replaced is refused (double click)'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'matched', 'lot 2', pg_temp.last_decision('91'))$$,
  '55000', 'invalid_transition', 'so is naming a decision that is not the last one of this claim'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('12'), 'single_lot', null, gen_random_uuid())$$,
  '55000', 'invalid_transition', 'a first acceptance replaces nothing'
);
select throws_ok(
  $$select public.withdraw_auction_fact_claim(pg_temp.claim('12'), 'entry_error')$$,
  '55000', 'invalid_transition', 'only an accepted claim is withdrawn'
);

-- Correction du lot : une nouvelle acceptation qui nomme la précédente. lot_ref : espaces insécables et doubles
-- espaces ramenés à une espace, bords retirés.
insert into results
select 'accept 11 again', public.accept_auction_fact_claim(
  pg_temp.claim('11'), 'matched', '  Lot' || chr(160) || 'n°' || chr(8239) || ' 3 ', pg_temp.last_decision('11'));

select results_eq(
  $$select decision.lot_attachment, decision.lot_ref,
           decision.supersedes_decision_id is not null, (select count(*)::integer
             from public.auction_fact_claim_decisions same where same.claim_id = decision.claim_id)
      from public.auction_fact_claim_decisions decision where decision.id = pg_temp.last_decision('11')$$,
  $$values ('matched', 'Lot n° 3', true, 2)$$,
  'a new acceptance that names the last decision corrects the lot; the lot label is normalised before it is written'
);

-- Un libellé hors motif donne NULL, sans échec ni troncature.
insert into results
select 'accept 51', public.accept_auction_fact_claim(pg_temp.claim('51'), 'matched', 'lot unique du 12 rue Haute');
select results_eq(
  $$select decision.decision, decision.lot_ref, sale.rooms_count
      from public.auction_fact_claim_decisions decision
      join public.auction_sales sale on sale.id = decision.sale_id
      where decision.id = pg_temp.last_decision('51')$$,
  $$values ('accepted', null::text, 5)$$,
  'a lot label that the format constraint refuses is written as NULL: the acceptance does not fail'
);

-- Lot inconnu : la décision est au journal, rien n'est posé.
insert into results select 'accept 61', public.accept_auction_fact_claim(pg_temp.claim('61'), 'unknown');
select results_eq(
  $$select result ->> 'state', (select rooms_count from public.auction_sales where id = pg_temp.sale('6')),
           (select held_fields is null from public.auction_sales where id = pg_temp.sale('6'))
      from results where label = 'accept 61'$$,
  $$values ('pass_through', 2, true)$$,
  'an acceptance of an unknown lot is recorded and holds nothing'
);

-- Motifs : la liste est celle de la contrainte de la table.
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('12'), 'entry_error')$$,
  '22023', 'invalid_reason_code', 'a rejection takes a rejection reason'
);
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('12'), null)$$,
  '22023', 'invalid_reason_code', 'and it takes one'
);
select throws_ok(
  $$select public.withdraw_auction_fact_claim(pg_temp.claim('11'), 'already_known')$$,
  '22023', 'invalid_reason_code', 'a withdrawal takes a withdrawal reason'
);
select throws_ok(
  $$select public.oppose_auction_fact_claim(pg_temp.claim('11'), 'entry_error')$$,
  '22023', 'invalid_reason_code', 'an opposition takes an opposition reason'
);
select is(
  (select rooms_count from public.auction_sales where id = pg_temp.sale('1')),
  4,
  'a refused reason leaves the decision journal and the sale as they were'
);

-- Retrait : la valeur de l'annonce revient ---------------------------------------------------------------------------
insert into results select 'withdraw 11', public.withdraw_auction_fact_claim(pg_temp.claim('11'), 'entry_error');
select results_eq(
  $$select result ->> 'state', result ->> 'decision',
           (select rooms_count from public.auction_sales where id = pg_temp.sale('1')),
           (select lot_attachment from public.auction_fact_claim_decisions where id = pg_temp.last_decision('11'))
      from results where label = 'withdraw 11'$$,
  $$values ('released', 'withdrawn', 2, 'matched')$$,
  'a withdrawal gives the listing value back, and carries the lot attachment of the decision it follows'
);
select throws_ok(
  $$select public.withdraw_auction_fact_claim(pg_temp.claim('11'), 'entry_error')$$,
  '55000', 'invalid_transition', 'a withdrawn claim is not withdrawn twice'
);
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('11'), 'other')$$,
  '55000', 'invalid_transition', 'nor rejected'
);

-- Rejet : d'une observation jamais décidée, ou acceptée.
insert into results select 'reject 12', public.reject_auction_fact_claim(pg_temp.claim('12'), 'doubtful_statement');
select results_eq(
  $$select result ->> 'decision', result ->> 'state',
           (select lot_attachment from public.auction_fact_claim_decisions where id = pg_temp.last_decision('12'))
      from results where label = 'reject 12'$$,
  $$values ('rejected', 'pass_through', 'unknown')$$,
  'a claim never decided is rejected, with an unknown lot attachment'
);
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('12'), 'other')$$,
  '55000', 'invalid_transition', 'a rejected claim is not rejected twice'
);
select lives_ok(
  $$insert into results
    select 'accept 12', public.accept_auction_fact_claim(pg_temp.claim('12'), 'single_lot', null,
      pg_temp.last_decision('12'))$$,
  'a rejected claim is accepted again by naming its rejection'
);
select lives_ok(
  $$insert into results select 'reject 12 again', public.reject_auction_fact_claim(pg_temp.claim('12'), 'other')$$,
  'an accepted claim is rejected'
);

-- Opposition : définitive --------------------------------------------------------------------------------------------
select lives_ok(
  $$insert into results
    select 'accept 11 third', public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot', null,
      pg_temp.last_decision('11'))$$,
  'a withdrawn claim is accepted again by naming its withdrawal'
);
insert into results select 'oppose 11', public.oppose_auction_fact_claim(pg_temp.claim('11'));
select results_eq(
  $$select result ->> 'state', decision.reason_code, sale.rooms_count,
           sale.held_fields #>> '{property.rooms_count,released_by}',
           sale.held_fields #> '{property.rooms_count,echo}'
      from results, public.auction_fact_claim_decisions decision, public.auction_sales sale
      where label = 'oppose 11' and decision.id = pg_temp.last_decision('11') and sale.id = pg_temp.sale('1')$$,
  $$values ('released', 'professional_opposition', 2, 'opposed', '[{"value": 4}]'::jsonb)$$,
  'an opposition ends the display, with its default reason, and the opposed value is remembered without a deadline'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot', null, pg_temp.last_decision('11'))$$,
  '55000', 'opposed_final', 'after an opposition the claim is never accepted again'
);
select throws_ok(
  $$select public.oppose_auction_fact_claim(pg_temp.claim('11'))$$,
  '55000', 'invalid_transition', 'an opposition is not recorded twice'
);
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('11'), 'other')$$,
  '55000', 'invalid_transition', 'and an opposed claim is not rejected'
);
select lives_ok(
  $$insert into results select 'oppose 44', public.oppose_auction_fact_claim(pg_temp.claim('44'), 'other')$$,
  'a claim never decided can be opposed'
);

-- Refus propres à l'acceptation ---------------------------------------------------------------------------------------
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('21'), 'single_lot')$$,
  '55000', 'origin_not_open', 'a document claim is not accepted before lot R3'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('22'), 'single_lot')$$,
  '55000', 'origin_cannot_hold', 'a listing claim never holds a field'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('31'), 'single_lot')$$,
  '55000', 'field_not_applicable', 'a built surface is not accepted on a land sale'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('13'), 'single_lot')$$,
  '22023', 'invalid_argument', 'a value the registry cannot hold (who occupies) is not accepted'
);
select lives_ok(
  $$insert into results select 'reject 21', public.reject_auction_fact_claim(pg_temp.claim('21'), 'already_known')$$,
  'a document claim can be rejected'
);

-- Champ que le registre ne tient pas : la décision est enregistrée, rien n'est affiché.
insert into results select 'accept 14', public.accept_auction_fact_claim(pg_temp.claim('14'), 'single_lot');
select results_eq(
  $$select result -> 'state', result ->> 'field_key',
           (select starting_price_eur from public.auction_sales where id = pg_temp.sale('1'))
      from results where label = 'accept 14'$$,
  $$values ('null'::jsonb, 'sale.starting_price_eur', 90000::numeric)$$,
  'an acceptance on a field the registry does not hold is recorded and changes no column'
);

-- Une décision reprojette toute la vente (voie A de la relance) ----------------------------------------------------------
-- Vente 4 : 7 pièces, 6 chambres. La pièce « 3 pièces » est acceptée mais bloquée ; la surface est posée.
insert into results select 'accept 41', public.accept_auction_fact_claim(pg_temp.claim('41'), 'single_lot');
insert into results select 'accept 43', public.accept_auction_fact_claim(pg_temp.claim('43'), 'single_lot');
-- La collecte corrige les chambres, puis reclasse la vente en terrain : personne ne rappelle la projection.
update public.auction_sales set bedrooms_count = 2 where id = pg_temp.sale('4');
update public.auction_sales set surface_scope = 'land' where id = pg_temp.sale('4');

select results_eq(
  $$select (select result ->> 'state' from results where label = 'accept 41'), sale.rooms_count,
           sale.app_surface_m2, sale.surface_source,
           (app_private.project_sale_fields(sale.id, null, false) ->> 'changed')::boolean
      from public.auction_sales sale where sale.id = pg_temp.sale('4')$$,
  $$values ('blocked', 7, 61::numeric, 'fact_registry', true)$$,
  'before: the room piece was blocked by the bedrooms, the surface is held, and the sale has drifted since the collection corrected the bedrooms and reclassified the sale as land'
);

insert into results select 'accept 42', public.accept_auction_fact_claim(pg_temp.claim('42'), 'single_lot');

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}', sale.app_surface_m2,
           sale.surface_source, sale.held_fields #>> '{property.surface_m2,released_by}', sale.occupancy_status,
           (app_private.project_sale_fields(sale.id, null, false) ->> 'changed')::boolean
      from public.auction_sales sale where sale.id = pg_temp.sale('4')$$,
  $$values (3, 'held', 50::numeric, 'listing_text', 'blocked', 'vacant', false)$$,
  'a decision on another field reprojects the whole sale: the room piece now holds, the built surface of the land sale is released, and nothing drifts any more'
);

-- Erreur inattendue : registry_write_failed, sans détail ni indice ------------------------------------------------------
alter table public.auction_sales add constraint pgtap_887_refused_land check (
  land_surface_m2 is null or land_surface_m2 < 500
) not valid;

create temporary table caught (sqlstate text, message text, detail text, hint text) on commit drop;
do $caught$
declare
  v_sqlstate text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  perform public.accept_auction_fact_claim(pg_temp.claim('15'), 'single_lot');
exception when others then
  get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text,
    v_detail = pg_exception_detail, v_hint = pg_exception_hint;
  insert into caught values (v_sqlstate, v_message, v_detail, v_hint);
end;
$caught$;

select results_eq(
  $$select sqlstate, message, detail, hint from caught$$,
  $$values ('P0001', 'registry_write_failed', '', '')$$,
  'a constraint of auction_sales violated by the projection gives registry_write_failed, with no detail and no hint (the detail of PostgreSQL carries the whole row)'
);
select results_eq(
  $$select (select count(*)::integer from public.auction_fact_claim_decisions where claim_id = pg_temp.claim('15')),
           (select land_surface_m2 from public.auction_sales where id = pg_temp.sale('1'))$$,
  $$values (0, null::numeric)$$,
  'and nothing is written: neither the decision nor the sale'
);
alter table public.auction_sales drop constraint pgtap_887_refused_land;

-- Observation détachée par une fusion ------------------------------------------------------------------------------------
-- Vente 7 : la pièce 71 est acceptée (6 pièces), la pièce 72 n'est jamais décidée ; puis la vente 8 l'absorbe.
insert into results select 'accept 71', public.accept_auction_fact_claim(pg_temp.claim('71'), 'single_lot');
update public.auction_sales
set source_urls = '["https://example.test/887/sale-8", "https://example.test/887/sale-7"]'::jsonb
where id = pg_temp.sale('8');
select count(*) > 0 from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales where id = pg_temp.sale('7');

select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('72'), 'single_lot')$$,
  '55000', 'claim_detached', 'a detached claim that was never decided can no longer be decided'
);

insert into results select 'withdraw 71', public.withdraw_auction_fact_claim(pg_temp.claim('71'), 'other_lot');
select results_eq(
  $$select result ->> 'sale_id', result ->> 'state', decision.sale_id, sale.rooms_count,
           (select auction_sale_id is null from public.auction_fact_claims where id = pg_temp.claim('71'))
      from results, public.auction_fact_claim_decisions decision, public.auction_sales sale
      where label = 'withdraw 71' and decision.id = pg_temp.last_decision('71') and sale.id = pg_temp.sale('8')$$,
  $$values (pg_temp.sale('8')::text, 'released', pg_temp.sale('7'), 2, true)$$,
  'a withdrawal after a merge: the decision carries the absorbed sale, the kept sale is locked, reprojected and gets its listing value back'
);

-- Vente supprimée sans vente conservée : l'observation décidée n'a plus de vente.
delete from public.auction_sales where id = pg_temp.sale('5');
select throws_ok(
  $$select public.withdraw_auction_fact_claim(pg_temp.claim('51'), 'other')$$,
  'P0002', 'sale_not_found', 'a decided claim whose sale was deleted without a kept sale reports the missing sale'
);

-- Publication automatique : toujours verrouillée -----------------------------------------------------------------------
select ok(
  (select count(*) = 2 from pg_constraint
     where conrelid = 'public.auction_fact_claim_decisions'::regclass
       and conname in ('auction_fact_claim_decisions_auto_locked', 'auction_fact_claim_decisions_accepted_by_admin')
       and convalidated)
  and not exists (
    select 1 from public.auction_fact_claim_decisions
    where claim_id::text like '88700000-2000-%' and (publication_mode <> 'manual' or actor_kind <> 'admin'
      or actor_id <> '88700000-0000-4000-8000-0000000000a1')),
  'the automatic publication locks are in place, and every decision written here is a manual one of the signed-in administrator'
);

-- public.review_auction_fact_claim, retouchée ----------------------------------------------------------------------------
select ok(
  (select prosrc !~ 'sale\.\*'
          and position('app_private.lock_sale_for_registry' in prosrc) > 0
          and position('app_private.lock_sale_for_registry' in prosrc) < position('for update' in prosrc)
     from pg_proc where oid = 'public.review_auction_fact_claim(uuid, uuid, text, text)'::regprocedure)
  and (select position('app_private.lock_sale_for_registry' in prosrc)
              < position('for no key update' in prosrc)
          and position('for no key update' in prosrc)
              < position('insert into public.auction_fact_claim_decisions' in prosrc)
     from pg_proc
     where oid = 'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure),
  'both writers lock the sale first, then the claim; the review function no longer reads the whole sale row'
);
select throws_ok(
  $$select public.review_auction_fact_claim(
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('91'), 'rejected', 'pgtap 887')$$,
  '55000', 'A professional fact claim is decided through the fact registry.',
  'the review of source claims refuses a professional claim'
);
select throws_ok(
  $$select public.review_auction_fact_claim(
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('21'), 'rejected', 'pgtap 887')$$,
  '55000', 'A fact claim already decided in the fact registry cannot be reviewed here.',
  'and a claim that the registry journal has already decided'
);
select lives_ok(
  $$select public.review_auction_fact_claim(
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('22'), 'rejected', 'pgtap 887')$$,
  'it still resolves a listing claim that the registry has not decided'
);

-- Le contrat de lot_ref tient à la contrainte de la table, pas à une copie du motif ------------------------------------
select ok(
  (select prosrc !~ 'lots\?' and position('auction_fact_claim_decisions_lot_ref_check' in prosrc) > 0
          and position('auction_fact_claim_decisions_reason_code_check' in prosrc) > 0
          and prosrc !~ 'already_known|entry_error|professional_opposition'
     from pg_proc
     where oid = 'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure),
  'the decision function copies neither the lot format nor the reason lists: the constraints of the table judge'
);

-- Erreurs : jamais le détail ni l'indice de PostgreSQL ------------------------------------------------------------------
select ok(
  (select prosrc !~* 'pg_exception_detail|pg_exception_hint|pg_exception_context|message_text|detail\s*=|hint\s*='
     from pg_proc
     where oid = 'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure),
  'the decision function reads only the SQLSTATE and the constraint name of an error, and relays no detail'
);

select * from finish();
rollback;
