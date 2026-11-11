-- 20261117100000 à 20261117100450 : durcissement du registre des pièces (lot R2a, étapes A1, A2, A4, A5 et A6).
--   * A1 : une séquence commune numérote les décisions et les évènements ; l'écrivain ne choisit pas seq ; l'ordre
--     entre une libération par l'annonce et une décision se lit dans seq, jamais dans une date ; une libération de
--     la vente conservée écarte aussi les décisions plus anciennes d'une vente absorbée ;
--   * A2 : gardes par rôle en liste blanche (un rôle hors de la liste d'exclusion est refusé, même avec le
--     marqueur de la projection posé) ; garde du marqueur sur les colonnes d'une vente du registre ; origine
--     professionnelle non forgeable par le triplet du pont ; contrôle du mode « always » et de la fonction des
--     douze déclencheurs, remise en état ; évènement echo_suppressed admis ; inertie prouvée ;
--   * A4 : l'historique des ventes ne reçoit jamais held_fields ;
--   * A5 : aucune fonction de public ne rend la ligne entière de auction_sales ; les deux RPC de dérogation
--     rendent six clés ;
--   * A6 : les deux index du registre sont enregistrés pour la construction concurrente, et construits ici
--     dans la transaction du test : texte du catalogue figé, unicité prouvée.
begin;

set local timezone = 'UTC';

select plan(66);

-- A1. Séquence commune --------------------------------------------------------------------------------------------
select ok(
  (select relkind = 'S' from pg_class where oid = 'app_private.fact_registry_seq'::regclass)
  and (select seqtypid = 'bigint'::regtype and seqcache = 1 and seqincrement = 1 and not seqcycle
         from pg_sequence where seqrelid = 'app_private.fact_registry_seq'::regclass),
  'the common sequence of the two journals exists, counts in bigint, one by one, and caches no number (seqcache = 1: no session orders its rows ahead of another)'
);

select is(
  (select count(*)::integer
     from unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) privilege(name)
     where has_sequence_privilege(api_role.name, 'app_private.fact_registry_seq', privilege.name)),
  0,
  'no API role can read or advance the common sequence'
);

select is(
  (select count(*)::integer from pg_depend dependency
     where dependency.refobjid in (
       'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass)
       and dependency.deptype = 'i'
       and dependency.classid = 'pg_class'::regclass
       and (select relkind from pg_class where oid = dependency.objid) = 'S'),
  0,
  'neither journal keeps an identity sequence of its own'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('88400000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('88400000-0000-4000-8000-0000000000a1', 'registre-admin-884@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
  rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88400000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/884/sale-' || n,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville', 'house', 90000, '{}'::jsonb,
  '{}'::jsonb, 'tribunal', 50, 50, 'habitable', 'listing_text', 0.7, 2, 1, 'occupied', '[]'::jsonb
from generate_series(1, 6) n;

-- Une pièce « nombre de pièces » par vente (dossiers d'avocat distincts) ; la vente 1 porte aussi une surface.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88400000-2000-4000-8000-00000000000' || n)::uuid, ('88400000-1000-4000-8000-00000000000' || n)::uuid,
  'property.rooms_count', to_jsonb(2 + n), 'professional_email',
  jsonb_build_object('case_id', '88400000-3000-4000-8000-00000000000' || n), 0.6, 'information_agent', 'v1',
  '88400000-0000-4000-8000-0000000000a1'
from generate_series(1, 6) n;
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
) values (
  '88400000-2000-4000-8000-000000000011', '88400000-1000-4000-8000-000000000001', 'property.surface_m2',
  '54'::jsonb, 'professional_email', '{"case_id": "88400000-3000-4000-8000-000000000001"}'::jsonb, 0.6,
  'information_agent', 'v1', '88400000-0000-4000-8000-0000000000a1'
);
-- Vente 2 : une pièce de document (rang plus faible que l'avocat), qui dit 6 pièces.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
  extractor_name, extractor_version
) values (
  '88400000-2000-4000-8000-000000000022', '88400000-1000-4000-8000-000000000002', 'property.rooms_count',
  '6'::jsonb, 'source_document', '{}'::jsonb, 'https://example.test/884/cahier.pdf', 0.5,
  'immojudis-fact-claims', 'v1'
);

prepare decide(text, text, text) as
  insert into public.auction_fact_claim_decisions (
    claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code
  )
  select claim.id, ('88400000-1000-4000-8000-00000000000' || $3)::uuid, claim.field_key, $2, 'single_lot',
    'admin', '88400000-0000-4000-8000-0000000000a1', case when $2 = 'accepted' then null else 'entry_error' end
  from public.auction_fact_claims claim
  where claim.id = ('88400000-2000-4000-8000-0000000000' || $1)::uuid;

-- Les deux journaux tirent leurs numéros de la même séquence : décision, évènement, décision.
execute decide('01', 'accepted', '1');
select app_private.project_sale_fields('88400000-1000-4000-8000-000000000001', null, true) ->> 'changed';
execute decide('11', 'accepted', '1');

select ok(
  (select first_decision.seq < held_event.seq and held_event.seq < second_decision.seq
     from public.auction_fact_claim_decisions first_decision,
          public.auction_sale_field_hold_events held_event,
          public.auction_fact_claim_decisions second_decision
     where first_decision.claim_id = '88400000-2000-4000-8000-000000000001'
       and held_event.sale_id = '88400000-1000-4000-8000-000000000001'
       and held_event.event = 'projection_held'
       and second_decision.claim_id = '88400000-2000-4000-8000-000000000011'),
  'a decision, then an event, then a decision take three increasing numbers from one sequence'
);

select is(
  (select count(distinct journal.seq)::integer from (
     select seq from public.auction_fact_claim_decisions where sale_id::text like '88400000-1000-%'
     union all
     select seq from public.auction_sale_field_hold_events where sale_id::text like '88400000-1000-%') journal),
  3,
  'no number is shared between the two journals'
);

-- L'écrivain ne choisit pas le numéro : une valeur fournie est remplacée, dans les deux journaux.
insert into public.auction_fact_claim_decisions (
  seq, claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code
) values (
  -7, '88400000-2000-4000-8000-000000000011', '88400000-1000-4000-8000-000000000001', 'property.surface_m2',
  'withdrawn', 'single_lot', 'admin', '88400000-0000-4000-8000-0000000000a1', 'entry_error'
);
insert into public.auction_sale_field_hold_events (seq, sale_id, field_key, event)
values (-7, '88400000-1000-4000-8000-000000000001', 'property.surface_m2', 'projection_blocked');

select ok(
  (select max(seq) from public.auction_sale_field_hold_events
     where sale_id = '88400000-1000-4000-8000-000000000001' and event = 'projection_blocked')
    > (select max(seq) from public.auction_fact_claim_decisions
         where claim_id = '88400000-2000-4000-8000-000000000011')
  and (select min(seq) > 0 from public.auction_fact_claim_decisions
         where claim_id = '88400000-2000-4000-8000-000000000011')
  and not exists (select 1 from public.auction_fact_claim_decisions where seq = -7)
  and not exists (select 1 from public.auction_sale_field_hold_events where seq = -7),
  'a number given by the writer is replaced by the next number of the sequence, in both journals'
);

-- Deux écritures d'une même instruction : deux numéros, dans l'ordre des lignes.
insert into public.auction_sale_field_hold_events (sale_id, field_key, event, incoming_value) values
  ('88400000-1000-4000-8000-000000000001', 'property.surface_m2', 'projection_blocked', '1'::jsonb),
  ('88400000-1000-4000-8000-000000000001', 'property.surface_m2', 'projection_blocked', '2'::jsonb);

select ok(
  (select first_row.seq < second_row.seq
     from public.auction_sale_field_hold_events first_row, public.auction_sale_field_hold_events second_row
     where first_row.incoming_value = '1'::jsonb and second_row.incoming_value = '2'::jsonb
       and first_row.sale_id = '88400000-1000-4000-8000-000000000001'
       and second_row.sale_id = first_row.sale_id),
  'two rows of one statement take two numbers, in the order of the rows'
);

set local role service_role;
select throws_ok(
  $$select nextval('app_private.fact_registry_seq')$$,
  '42501',
  null,
  'the server role cannot take a number from the sequence'
);
reset role;

-- Ordre entre une libération par l'annonce et une décision : seq, jamais la date ----------------------------
-- Ventes 2 et 3, réglage inverse (l'annonce l'emporte) : leur pièce est posée puis délogée par l'annonce. La
-- vente 2 a aussi une pièce de document acceptée, plus faible : l'avocat tient, et c'est sa décision que
-- l'évènement de libération nomme.
update public.auction_fact_fields set on_listing_change = 'listing_wins_and_review'
where field_key = 'property.rooms_count';
execute decide('02', 'accepted', '2');
execute decide('22', 'accepted', '2');
execute decide('03', 'accepted', '3');
select app_private.project_sale_fields(('88400000-1000-4000-8000-00000000000' || n)::uuid, null, true)
  ->> 'changed'
from unnest(array[2, 3]) n;
update public.auction_sales set rooms_count = 9
where id in ('88400000-1000-4000-8000-000000000002', '88400000-1000-4000-8000-000000000003');

select is(
  (select array_agg(app_private.project_sale_fields(sale.id, array['property.rooms_count'], true)
            #>> '{fields,property.rooms_count,state}' order by sale.id)
     from public.auction_sales sale
     where sale.id in ('88400000-1000-4000-8000-000000000002', '88400000-1000-4000-8000-000000000003')),
  array['pass_through', 'pass_through'],
  'neither the piece dislodged by the listing nor a weaker piece accepted before the release takes the field back'
);

-- Vente 2 : la décision de la pièce de document, antérieure à la libération et que l'évènement ne nomme pas,
-- porte une date de l'an 2999 (gardes coupées le temps d'une écriture, pour simuler une date fausse restée dans
-- le journal, par exemple après une restauration). Par la date, elle suivrait la libération et prendrait le
-- champ ; par seq, elle la précède.
alter table public.auction_fact_claim_decisions disable trigger auction_fact_claim_decisions_validate;
alter table public.auction_fact_claim_decisions disable trigger auction_fact_claim_decisions_append_only;
update public.auction_fact_claim_decisions set decided_at = '2999-01-01 00:00:00+00'
where claim_id = '88400000-2000-4000-8000-000000000022';
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_append_only;

select is(
  app_private.project_sale_fields('88400000-1000-4000-8000-000000000002', array['property.rooms_count'], true)
    #>> '{fields,property.rooms_count,state}',
  'pass_through',
  'a decision written before the release but dated after it (year 2999) does not take the field: seq decides'
);

-- Vente 3 : une nouvelle acceptation, écrite APRÈS la libération mais datée de l'an 2000 (antérieure, par la
-- date, à la libération). Par la date elle serait écartée ; par seq, elle suit la libération et tient.
insert into public.auction_fact_claim_decisions (
  seq, claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, decided_at,
  supersedes_decision_id
)
select nextval('app_private.fact_registry_seq'), decision.claim_id, decision.sale_id, decision.field_key,
  'accepted', 'single_lot', 'admin', '88400000-0000-4000-8000-0000000000a1', '2000-01-01 00:00:00+00', decision.id
from public.auction_fact_claim_decisions decision
where decision.claim_id = '88400000-2000-4000-8000-000000000003';
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_validate;

select is(
  (app_private.project_sale_fields('88400000-1000-4000-8000-000000000003', array['property.rooms_count'], true)
    #> '{fields,property.rooms_count}') - 'decision_id',
  '{"state": "held", "value": 5, "claim_id": "88400000-2000-4000-8000-000000000003"}'::jsonb,
  'an acceptance written after the release holds, even dated before it (year 2000): seq decides'
);

-- Vente 2, absorbée par la vente 6 (qui ne tient rien). L'évènement de libération de la vente 2 nomme la décision
-- de sa pièce d'avocat ; il ne nomme pas celle de sa pièce de document, qu'il suit. Sur la vente conservée,
-- aucune des deux ne prend le champ : une libération écarte toute décision antérieure de SA vente, nommée ou non.
update public.auction_sales
set source_urls = '["https://example.test/884/sale-6", "https://example.test/884/sale-2"]'::jsonb
where id = '88400000-1000-4000-8000-000000000006';
select count(*) > 0 from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales where id = '88400000-1000-4000-8000-000000000002';

select results_eq(
  $$select app_private.project_sale_fields(sale.id, array['property.rooms_count'], true)
             #> '{fields,property.rooms_count}',
           sale.rooms_count, sale.held_fields is null
      from public.auction_sales sale where sale.id = '88400000-1000-4000-8000-000000000006'$$,
  $$values ('{"state": "pass_through"}'::jsonb, 2, true)$$,
  'on the kept sale, neither piece of the absorbed sale takes the field back: its release dislodged the decision it names and the earlier one it does not name'
);

-- Libération durable et vente absorbée ----------------------------------------------------------------------------
-- Vente 4 (conservée) : 6 pièces tenues, puis son annonce passe à 9 et déloge la pièce. Vente 5 : 7 pièces
-- acceptées AVANT cette libération, puis la vente 5 est absorbée par la vente 4. La pièce de la vente absorbée
-- ne reprend pas le champ que l'annonce de la vente conservée vient de libérer.
execute decide('04', 'accepted', '4');
execute decide('05', 'accepted', '5');
select app_private.project_sale_fields(('88400000-1000-4000-8000-00000000000' || n)::uuid, null, true)
  ->> 'changed'
from unnest(array[4, 5]) n;
update public.auction_sales set rooms_count = 9 where id = '88400000-1000-4000-8000-000000000004';

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}', event.sale_id
      from public.auction_sales sale
      join public.auction_sale_field_hold_events event
        on event.sale_id = sale.id and event.event = 'listing_changed_released'
      where sale.id = '88400000-1000-4000-8000-000000000004'$$,
  $$values (9, 'released', '88400000-1000-4000-8000-000000000004'::uuid)$$,
  'the listing of the kept sale dislodged its piece'
);

update public.auction_sales
set source_urls = '["https://example.test/884/sale-4", "https://example.test/884/sale-5"]'::jsonb
where id = '88400000-1000-4000-8000-000000000004';
select count(*) > 0 from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales where id = '88400000-1000-4000-8000-000000000005';

select is(
  app_private.project_sale_fields('88400000-1000-4000-8000-000000000004', array['property.rooms_count'], true)
    #> '{fields,property.rooms_count}',
  '{"state": "pass_through"}'::jsonb,
  'a piece accepted on the absorbed sale before the release of the kept sale does not take the field back'
);

select is(
  (select rooms_count from public.auction_sales where id = '88400000-1000-4000-8000-000000000004'),
  9,
  'the listing value that won on the kept sale stays displayed after the merge'
);

-- Une nouvelle décision humaine, postérieure, sur la pièce de la vente absorbée : elle tient la vente conservée.
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, supersedes_decision_id
)
select decision.claim_id, decision.sale_id, decision.field_key, 'accepted', 'single_lot', 'admin',
  '88400000-0000-4000-8000-0000000000a1', decision.id
from public.auction_fact_claim_decisions decision
where decision.claim_id = '88400000-2000-4000-8000-000000000005';

select is(
  (app_private.project_sale_fields('88400000-1000-4000-8000-000000000004', array['property.rooms_count'], true)
    #> '{fields,property.rooms_count}') - 'decision_id',
  '{"state": "held", "value": 7, "claim_id": "88400000-2000-4000-8000-000000000005"}'::jsonb,
  'a new acceptance of the piece of the absorbed sale, taken after the release, holds the kept sale'
);

update public.auction_fact_fields set on_listing_change = 'keep_and_review'
where field_key = 'property.rooms_count';

-- A2. Gardes par rôle en liste blanche ----------------------------------------------------------------------------
select ok(
  (select bool_and(not prosecdef
            and prosrc ~ 'current_user in \(''anon'', ''authenticated'', ''service_role'', ''authenticator''\)'
            and prosrc ~ 'pg_get_userbyid\(routine\.proowner\) is distinct from current_user')
          and count(*) = 3
     from pg_proc where oid in (
       'app_private.refuse_api_role_held_fields_write()'::regprocedure,
       'app_private.refuse_api_role_registry_origin()'::regprocedure,
       'app_private.refuse_sale_field_projection_marker()'::regprocedure)),
  'the two role guards and the marker guard read the calling role and accept only the owner of the projection'
);

select is(
  (select pg_get_triggerdef(oid) from pg_trigger
     where tgrelid = 'public.auction_fact_claims'::regclass
       and tgname = 'auction_fact_claims_registry_origin_guard'),
  $def$CREATE TRIGGER auction_fact_claims_registry_origin_guard BEFORE INSERT ON public.auction_fact_claims FOR EACH ROW WHEN (((new.evidence_kind = ANY (ARRAY['professional_email'::text, 'professional_form'::text, 'admin_entry'::text])) OR (new.extractor_name = 'information_agent'::text) OR (new.evidence_locator ? 'information_agent_fact_id'::text))) EXECUTE FUNCTION app_private.refuse_api_role_registry_origin()$def$,
  'the origin guard covers the three reserved kinds, the extractor of the information agent and its fact identifier'
);

-- Un rôle créé après coup, absent de la liste d'exclusion, avec tous les droits de table et des politiques qui
-- lui ouvrent toutes les lignes. Ni superutilisateur ni BYPASSRLS : le test tourne aussi sous un rôle qui n'est
-- pas superutilisateur (il se donne alors l'appartenance au rôle créé, pour pouvoir l'endosser).
create role registry_probe_884 nologin;
grant registry_probe_884 to current_user;
grant usage on schema public to registry_probe_884;
grant select, insert, update on public.auction_sales, public.auction_fact_claims to registry_probe_884;
-- (le journal des ventes est écrit par un déclencheur SECURITY INVOKER de auction_sales.)
grant insert on public.auction_sale_history to registry_probe_884;
create policy registry_probe_884_sales on public.auction_sales
  for all to registry_probe_884 using (true) with check (true);
create policy registry_probe_884_claims on public.auction_fact_claims
  for all to registry_probe_884 using (true) with check (true);
create policy registry_probe_884_history on public.auction_sale_history
  for insert to registry_probe_884 with check (true);

set local role registry_probe_884;
select set_config('app.sale_field_projection', '88400000-1000-4000-8000-000000000001', true);
select throws_ok(
  $$update public.auction_sales set held_fields = null where id = '88400000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields cannot be written by an API role.',
  'a role outside the exclusion list cannot write held_fields, even with the projection marker set'
);
-- Le marqueur n'ouvre pas non plus les colonnes tenues : sans toucher held_fields, la retenue laissait tout passer.
select throws_ok(
  $$update public.auction_sales set rooms_count = 9, occupancy_status = 'rented', surface_m2 = 99,
           app_surface_m2 = 99
      where id = '88400000-1000-4000-8000-000000000001'$$,
  '42501',
  'The sale field projection marker is reserved to app_private.project_sale_fields.',
  'with the marker set, a role that does not own the projection cannot rewrite the held columns of a sale of the registry'
);
select throws_ok(
  $$update public.auction_sales set habitable_surface_m2 = 54
      where id = '88400000-1000-4000-8000-000000000001'$$,
  '42501',
  'The sale field projection marker is reserved to app_private.project_sale_fields.',
  'nor one of the watched neighbour columns'
);
-- Le marqueur d'une AUTRE vente ne dit rien de celle-ci : l'écriture passe la garde et la retenue s'applique.
select set_config('app.sale_field_projection', '88400000-1000-4000-8000-000000000006', true);
select lives_ok(
  $$update public.auction_sales set rooms_count = 9 where id = '88400000-1000-4000-8000-000000000001'$$,
  'with the marker of another sale the write is not refused: it is held like any direct write'
);
select set_config('app.sale_field_projection', '', true);
select throws_ok(
  $$update public.auction_sales set held_fields = '{}'::jsonb
      where id = '88400000-1000-4000-8000-000000000006'$$,
  '42501',
  'auction_sales.held_fields cannot be written by an API role.',
  'nor on a sale that holds nothing'
);
select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, extractor_name,
      extractor_version
    ) values (
      '88400000-1000-4000-8000-000000000006', 'property.rooms_count', '4'::jsonb, 'admin_entry', '{}'::jsonb,
      'admin_entry', 'v1')$$,
  '42501',
  'A professional or administrator fact claim cannot be inserted by an API role.',
  'a role outside the exclusion list cannot insert a claim of a reserved origin'
);
select lives_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, extractor_name,
      extractor_version
    ) values (
      '88400000-1000-4000-8000-000000000006', 'property.rooms_count', '4'::jsonb, 'source_listing',
      '{}'::jsonb, 'https://example.test/884/sale-6', 'immojudis-fact-claims', 'v1')$$,
  'the same role still inserts an ordinary listing claim: the guard only covers the reserved origins'
);
select lives_ok(
  $$update public.auction_sales set rooms_count = 3 where id = '88400000-1000-4000-8000-000000000006'$$,
  'and still writes the columns of a sale that holds nothing'
);
reset role;

select results_eq(
  $$select held_fields #> '{property.rooms_count,value}', rooms_count, occupancy_status, surface_m2,
           habitable_surface_m2
      from public.auction_sales where id = '88400000-1000-4000-8000-000000000001'$$,
  $$values ('3'::jsonb, 3, 'occupied', 50::numeric, null::numeric)$$,
  'the held entry and the columns of the sale are intact after the refused writes'
);

-- Le propriétaire de la projection, lui, passe la garde du marqueur (c'est ce que fait la projection).
select set_config('app.sale_field_projection', '88400000-1000-4000-8000-000000000001', true);
select lives_ok(
  $$update public.auction_sales set rooms_count = rooms_count where id = '88400000-1000-4000-8000-000000000001'$$,
  'the owner of the projection passes the marker guard'
);
select set_config('app.sale_field_projection', '', true);

-- Origine professionnelle forgée par le triplet du pont : nature ordinaire, extracteur de l'agent, identifiant de
-- fait. Le classement la rangerait en « lawyer_email ».
select is(
  app_private.fact_claim_source_kind(
    'manual_review', 'information_agent', '{"information_agent_fact_id": "88400000-5000-4000-8000-000000000001"}'),
  'lawyer_email',
  'an ordinary kind with the extractor of the agent and a fact identifier is classified as a lawyer email'
);

set local role service_role;
select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
      extractor_name, extractor_version
    ) values (
      '88400000-1000-4000-8000-000000000006', 'property.rooms_count', '9'::jsonb, 'manual_review',
      '{"information_agent_fact_id": "88400000-5000-4000-8000-000000000001"}'::jsonb,
      'https://example.test/884/forged', 0.9, 'information_agent', 'v1')$$,
  '42501',
  'A professional or administrator fact claim cannot be inserted by an API role.',
  'the server role cannot forge a professional origin with the triplet of the bridge'
);
select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
      extractor_name, extractor_version
    ) values (
      '88400000-1000-4000-8000-000000000006', 'property.rooms_count', '9'::jsonb, 'email_attachment',
      '{"information_agent_fact_id": "88400000-5000-4000-8000-000000000002"}'::jsonb,
      'https://example.test/884/forged', 0.9, 'immojudis-fact-claims', 'v1')$$,
  '42501',
  'A professional or administrator fact claim cannot be inserted by an API role.',
  'nor reserve the identifier of a fact under another extractor'
);
select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
      extractor_name, extractor_version
    ) values (
      '88400000-1000-4000-8000-000000000006', 'property.rooms_count', '9'::jsonb, 'portal_upload',
      '{}'::jsonb, 'https://example.test/884/forged', 0.9, 'information_agent', 'v1')$$,
  '42501',
  'A professional or administrator fact claim cannot be inserted by an API role.',
  'nor use the extractor of the agent without an identifier'
);
reset role;

-- Le pont existant s'exécute en propriétaire : la même ligne passe.
select lives_ok(
  $$insert into public.auction_fact_claims (
      id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
      extractor_name, extractor_version
    ) values (
      '88400000-2000-4000-8000-0000000000b1', '88400000-1000-4000-8000-000000000006', 'property.rooms_count',
      '9'::jsonb, 'manual_review',
      '{"information_agent_fact_id": "88400000-5000-4000-8000-000000000001"}'::jsonb,
      'https://example.test/884/bridge', 0.9, 'information_agent', 'v1')$$,
  'the owner of the projection, as the existing bridge does, still inserts that claim'
);

set local role service_role;
select throws_ok(
  $$update public.auction_sales set held_fields = null where id = '88400000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields cannot be written by an API role.',
  'the server role is still refused by name'
);
reset role;

-- Le propriétaire de la projection passe la garde par rôle (c'est le rôle de cette session) : seul le marqueur
-- de la projection lui manque.
select throws_ok(
  $$update public.auction_sales set held_fields = null where id = '88400000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'the owner of the projection passes the role guard and is stopped by the hold, which wants the marker'
);

-- A2. Mode des déclencheurs ---------------------------------------------------------------------------------------
select is(
  app_private.fact_registry_triggers_not_always(),
  array[]::text[],
  'the twelve triggers of the registry are in place, fire always and call their own function'
);

select lives_ok(
  'select app_private.assert_fact_registry_triggers()',
  'the trigger check passes on a sound database'
);

-- Ce que faisait le rattrapage 20261029100200 : tous les déclencheurs de la table repassent en mode ordinaire.
alter table public.auction_sales disable trigger user;
alter table public.auction_sales enable trigger user;

select is(
  app_private.fact_registry_triggers_not_always(),
  array[
    'auction_sales.aaab_auction_sales_held_fields_insert_guard',
    'auction_sales.aaab_auction_sales_held_fields_marker_guard',
    'auction_sales.aaab_auction_sales_held_fields_role_guard',
    'auction_sales.aaab_auction_sales_hold_projected_fields'
  ],
  'after disable then enable trigger user, the four triggers of auction_sales are reported out of the always mode'
);

select throws_ok(
  'select app_private.assert_fact_registry_triggers()',
  '55000',
  'registry_unavailable',
  'the trigger check then fails closed'
);

-- Remise en état (supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql).
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_insert_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_marker_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_role_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_hold_projected_fields;

select lives_ok(
  'select app_private.assert_fact_registry_triggers()',
  'once the four triggers are enabled always again, the check passes'
);

-- Un déclencheur supprimé, ou simplement désactivé, est signalé de la même façon.
alter table public.auction_fact_claims disable trigger auction_fact_claims_registry_origin_guard;
drop trigger auction_sale_field_hold_events_stamp on public.auction_sale_field_hold_events;

select is(
  app_private.fact_registry_triggers_not_always(),
  array[
    'auction_fact_claims.auction_fact_claims_registry_origin_guard',
    'auction_sale_field_hold_events.auction_sale_field_hold_events_stamp'
  ],
  'a disabled trigger and a dropped trigger are both reported'
);

alter table public.auction_fact_claims enable always trigger auction_fact_claims_registry_origin_guard;
create trigger auction_sale_field_hold_events_stamp
  before insert on public.auction_sale_field_hold_events
  for each row execute function app_private.stamp_fact_registry_event();
alter table public.auction_sale_field_hold_events enable always trigger auction_sale_field_hold_events_stamp;

select is(
  app_private.fact_registry_triggers_not_always(),
  array[]::text[],
  'everything is back in place'
);

-- Un déclencheur du bon nom, en mode « always », mais lié à une autre fonction ne garde plus rien : il est signalé.
create or replace trigger auction_fact_claims_no_truncate
  before truncate on public.auction_fact_claims
  for each statement execute function app_private.fact_registry_append_only();
alter table public.auction_fact_claims enable always trigger auction_fact_claims_no_truncate;

select results_eq(
  $$select app_private.fact_registry_triggers_not_always(),
           (select tgenabled::text from pg_trigger
              where tgrelid = 'public.auction_fact_claims'::regclass
                and tgname = 'auction_fact_claims_no_truncate')$$,
  $$values (array['auction_fact_claims.auction_fact_claims_no_truncate'], 'A')$$,
  'a trigger recreated on another function is reported, although its name and its mode are right'
);

create or replace trigger auction_fact_claims_no_truncate
  before truncate on public.auction_fact_claims
  for each statement execute function app_private.refuse_auction_fact_claims_truncate();
alter table public.auction_fact_claims enable always trigger auction_fact_claims_no_truncate;

select is(
  app_private.fact_registry_triggers_not_always(),
  array[]::text[],
  'and no longer once it calls its own function again'
);

select is(
  (select count(*)::integer
     from unnest(array[
       'app_private.assert_fact_registry_triggers()', 'app_private.fact_registry_triggers_not_always()',
       'app_private.sale_field_echo_memory()', 'app_private.sale_field_echo_prune(jsonb,timestamptz)',
       'app_private.sale_field_echo_matches(text,jsonb,jsonb,numeric,numeric)',
       'app_private.sale_field_echo_add(jsonb,text,jsonb,timestamptz,numeric,numeric)',
       'app_private.sale_field_incoming_class(text,jsonb,jsonb,jsonb,jsonb,numeric,numeric)',
       'app_private.sale_field_value_leaks(text,jsonb,jsonb,jsonb,jsonb,numeric,numeric)',
       'app_private.refuse_sale_field_projection_marker()',
       'app_private.sync_fact_registry_alerts_from_report(jsonb)'
     ]) routine(signature)
     cross join unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     where has_function_privilege(api_role.name, routine.signature, 'execute')),
  0,
  'no API role can execute the new internal functions of the registry'
);

-- A2. Évènement echo_suppressed ------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.auction_sale_field_hold_events (sale_id, field_key, event, incoming_value)
      values ('88400000-1000-4000-8000-000000000001', 'property.rooms_count', 'echo_suppressed', '3'::jsonb)$$,
  'the event queue accepts the echo_suppressed event'
);

select ok(
  (select pg_get_constraintdef(oid) like '%echo_suppressed%' and convalidated from pg_constraint
     where conrelid = 'public.auction_sale_field_hold_events'::regclass
       and conname = 'auction_sale_field_hold_events_event_check'),
  'the event constraint lists echo_suppressed and is validated'
);

-- A4. L'historique des ventes ne reçoit jamais held_fields -------------------------------------------------------
-- La vente 1 a reçu une pose (projection) : son historique porte les colonnes changées, pas la colonne interne.
select ok(
  (select count(*) > 0 from public.auction_sale_history
     where source_url = 'https://example.test/884/sale-1' and changed_fields ? 'rooms_count'),
  'the projection is journaled in the sale history through the columns it changed'
);

-- Une annonce qui change sur un champ tenu : la retenue réécrit held_fields (valeur d'annonce mémorisée).
update public.auction_sales set rooms_count = 8, city = 'Betaville'
where id = '88400000-1000-4000-8000-000000000001';

select results_eq(
  $$select sale.rooms_count, sale.held_fields #> '{property.rooms_count,listing}',
           (select count(*)::integer from public.auction_sale_history history
              where history.source_url = sale.source_url and history.changed_fields ? 'city')
      from public.auction_sales sale where sale.id = '88400000-1000-4000-8000-000000000001'$$,
  $$values (3, '{"rooms_count": 8}'::jsonb, 1)$$,
  'a changed listing on a held field rewrites held_fields, and the write is journaled for its other columns'
);

select is(
  (select count(*)::integer from public.auction_sale_history
     where source_url like 'https://example.test/884/%'
       and (changed_fields ? 'held_fields' or changed_fields::text like '%claim_id%')),
  0,
  'no row of the sale history carries held_fields, even as a fingerprint'
);

select ok(
  (select prosrc ~ 'new_row\.held_fields := null' and prosrc ~ 'old_row\.held_fields := null'
          and prosrc ~ '''sale_procedure'', ''held_fields'''
     from pg_proc where oid = 'public.log_auction_sale_change()'::regprocedure),
  'the history function empties held_fields on its two local copies and ignores the key'
);

-- A5. Les RPC ne rendent plus la ligne entière ---------------------------------------------------------------------
select is(
  (select count(*)::integer from pg_proc routine
     where routine.pronamespace = 'public'::regnamespace
       and routine.prorettype = 'public.auction_sales'::regtype),
  0,
  'no function of the public schema returns a whole auction_sales row'
);

select ok(
  (select bool_and(prorettype = 'jsonb'::regtype and prosecdef and not proretset) and count(*) = 2 from pg_proc
     where oid in (
       'public.set_auction_sale_readiness_override(uuid,text,text,timestamptz)'::regprocedure,
       'public.clear_auction_sale_readiness_override(uuid)'::regprocedure))
  and has_function_privilege(
    'authenticated', 'public.set_auction_sale_readiness_override(uuid,text,text,timestamptz)', 'execute')
  and has_function_privilege(
    'authenticated', 'public.clear_auction_sale_readiness_override(uuid)', 'execute')
  and not has_function_privilege(
    'anon', 'public.set_auction_sale_readiness_override(uuid,text,text,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.clear_auction_sale_readiness_override(uuid)', 'execute'),
  'the two override functions return jsonb and keep their rights (administrators through authenticated, never anon)'
);

create temporary table override_results (step text primary key, result jsonb) on commit drop;
grant select, insert on override_results to authenticated;

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '88400000-0000-4000-8000-0000000000a1';
insert into override_results
select 'set', public.set_auction_sale_readiness_override(
  '88400000-1000-4000-8000-000000000001', 'publish', 'pgtap 884 dérogation', '2026-12-31 00:00:00+00');
insert into override_results
select 'clear', public.clear_auction_sale_readiness_override('88400000-1000-4000-8000-000000000001');
select throws_ok(
  $$select public.clear_auction_sale_readiness_override('88400000-1000-4000-8000-0000000000ff')$$,
  'P0002',
  'Sale not found.',
  'an unknown sale is still refused'
);
reset role;

select is(
  (select array_agg(field.key order by field.key) from override_results, jsonb_object_keys(result) field(key)
     where step = 'set'),
  array[
    'id', 'premium_readiness_override', 'premium_readiness_override_at', 'premium_readiness_override_by',
    'premium_readiness_override_expires_at', 'premium_readiness_override_reason'
  ],
  'setting an override returns six keys: the sale and the five override columns'
);

select is(
  (select result - 'premium_readiness_override_at' from override_results where step = 'set'),
  '{
     "id": "88400000-1000-4000-8000-000000000001",
     "premium_readiness_override": "publish",
     "premium_readiness_override_reason": "pgtap 884 dérogation",
     "premium_readiness_override_by": "88400000-0000-4000-8000-0000000000a1",
     "premium_readiness_override_expires_at": "2026-12-31T00:00:00+00:00"
   }'::jsonb,
  'with the decision, its reason, its author and its term'
);

select is(
  (select result from override_results where step = 'clear'),
  '{
     "id": "88400000-1000-4000-8000-000000000001",
     "premium_readiness_override": null,
     "premium_readiness_override_reason": null,
     "premium_readiness_override_by": null,
     "premium_readiness_override_at": null,
     "premium_readiness_override_expires_at": null
   }'::jsonb,
  'clearing an override returns the same six keys, emptied'
);

select is(
  (select count(*)::integer from override_results
     where result::text ~ 'held_fields|raw_payload|rooms_count|claim_id'),
  0,
  'neither answer carries held_fields, raw_payload or any other column of the sale'
);

-- A6. Index enregistrés pour la construction concurrente ---------------------------------------------------------
select results_eq(
  $$select operation_key, schema_name, table_name, index_name, create_sql
      from app_private.concurrent_index_operations
      where operation_key like '20261117100450:%' order by operation_key$$,
  $$values
      ('20261117100450:auction_fact_claims_agent_fact_key', 'public', 'auction_fact_claims',
        'auction_fact_claims_agent_fact_key',
        'create unique index concurrently if not exists "auction_fact_claims_agent_fact_key" on "public"."auction_fact_claims" (("evidence_locator" ->> ''information_agent_fact_id'')) where ("evidence_locator" ? ''information_agent_fact_id'')'),
      ('20261117100450:auction_sales_held_fields_idx', 'public', 'auction_sales',
        'auction_sales_held_fields_idx',
        'create index concurrently if not exists "auction_sales_held_fields_idx" on "public"."auction_sales" ("id") where ("held_fields" is not null)')$$,
  'the two indexes of the registry are registered as reviewed concurrent builds'
);

-- Les index sont construits ici, dans la transaction du test, par l'instruction enregistrée (sans « concurrently »,
-- interdit dans une transaction) : s'ils existent déjà, l'instruction ne fait rien. Les assertions qui suivent
-- portent donc toujours sur des index réels.
do $$
declare
  v_operation record;
begin
  for v_operation in
    select create_sql from app_private.concurrent_index_operations
    where operation_key like '20261117100450:%' order by operation_key
  loop
    if position(' concurrently ' in v_operation.create_sql) = 0 then
      raise exception 'unexpected statement: %', v_operation.create_sql;
    end if;
    execute replace(v_operation.create_sql, ' concurrently ', ' ');
  end loop;
end;
$$;

select results_eq(
  $$select operation.index_name, index_row.indisvalid, index_row.indisunique,
           pg_get_indexdef(index_row.indexrelid)
      from app_private.concurrent_index_operations operation
      join pg_index index_row
        on index_row.indexrelid = to_regclass(operation.schema_name || '.' || operation.index_name)
      where operation.operation_key like '20261117100450:%'
      order by operation.index_name$$,
  $$values
      ('auction_fact_claims_agent_fact_key', true, true,
        'CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims USING btree (((evidence_locator ->> ''information_agent_fact_id''::text))) WHERE (evidence_locator ? ''information_agent_fact_id''::text)'),
      ('auction_sales_held_fields_idx', true, false,
        'CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales USING btree (id) WHERE (held_fields IS NOT NULL)')$$,
  'built from the registered statements, the two indexes are the reviewed ones, word for word in the catalogue'
);

select results_eq(
  $$select pg_get_expr(index_row.indexprs, index_row.indrelid) collate "default",
           pg_get_expr(index_row.indpred, index_row.indrelid) collate "default"
      from pg_index index_row
      where index_row.indexrelid = 'public.auction_fact_claims_agent_fact_key'::regclass$$,
  $$values ('(evidence_locator ->> ''information_agent_fact_id''::text)',
            '(evidence_locator ? ''information_agent_fact_id''::text)')$$,
  'the expression and the predicate read by the index script are those of the catalogue'
);

select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
      extractor_name, extractor_version
    ) values (
      '88400000-1000-4000-8000-000000000001', 'property.surface_m2', '70'::jsonb, 'manual_review',
      '{"information_agent_fact_id": "88400000-5000-4000-8000-000000000001"}'::jsonb,
      'https://example.test/884/bridge-twice', 0.9, 'information_agent', 'v1')$$,
  '23505',
  'duplicate key value violates unique constraint "auction_fact_claims_agent_fact_key"',
  'one fact of the information agent gives one claim at most, whatever the sale and the field'
);

-- Inertie prouvée --------------------------------------------------------------------------------------------------
-- La fonction de retenue est remplacée par une fonction qui lève : si le déclencheur l'appelait pour une vente
-- qui ne tient rien, l'écriture échouerait. (En dernier : les fonctions restent remplacées jusqu'au rollback.)
create or replace function app_private.hold_projected_sale_fields()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  raise exception 'hold function called';
end;
$function$;

set local role service_role;
select lives_ok(
  $$update public.auction_sales
      set surface_m2 = 51, app_surface_m2 = 51, app_surface_kind = 'carrez', surface_source = 'pdf',
          surface_confidence = 0.9, habitable_surface_m2 = 51, carrez_surface_m2 = 51, land_surface_m2 = 10,
          rooms_count = 4, bedrooms_count = 2, occupancy_status = 'vacant', visit_dates = '["2026-12-01"]'::jsonb
      where id = '88400000-1000-4000-8000-000000000006'$$,
  'inert: a write of every watched column of a sale that holds nothing never calls the hold function'
);
select throws_ok(
  $$update public.auction_sales set rooms_count = 4 where id = '88400000-1000-4000-8000-000000000001'$$,
  'P0001',
  'hold function called',
  'while the same write on a sale of the registry does call it'
);
reset role;

-- Même preuve pour la garde du marqueur : aucun appel quand rien n'est tenu.
create or replace function app_private.refuse_sale_field_projection_marker()
returns trigger language plpgsql security invoker set search_path = '' as $function$
begin
  raise exception 'marker guard called';
end;
$function$;

set local role service_role;
select lives_ok(
  $$update public.auction_sales
      set surface_m2 = 52, app_surface_m2 = 52, habitable_surface_m2 = 52, rooms_count = 5, bedrooms_count = 2,
          occupancy_status = 'occupied'
      where id = '88400000-1000-4000-8000-000000000006'$$,
  'no cost when nothing is held: the marker guard is not called either'
);
select throws_ok(
  $$update public.auction_sales set rooms_count = 4 where id = '88400000-1000-4000-8000-000000000001'$$,
  'P0001',
  'marker guard called',
  'and it is called, before the hold, for a sale of the registry'
);
reset role;

select * from finish();
rollback;
