-- 20261117100500 et 20261117100600 : valeurs d'annonce pour la fusion, contrôle quotidien du registre des pièces
-- et ses alertes (lot R2a, étape A7).
--   * public.get_sale_field_baselines : champs tenus seulement, colonnes et valeur d'annonce, jamais la valeur
--     tenue, la pièce, la décision ni l'origine ; serveur seul ;
--   * public.check_fact_registry_consistency : n'écrit rien (simulation seulement), même quand la simulation
--     rend « changed » ; base saine : rien à signaler ; chaque écart provoqué est vu sur sa vente (dérive de la
--     projection, déclencheur hors mode, colonne tenue différente, libellé réservé sans surface tenue, valeur
--     d'une pièce dans une colonne voisine, une copie ou un champ libéré, colonne interne recopiée, rafale
--     d'évènements, écho écarté, annonce qui se tait, surface tenue sur un terrain) ; comptes et identifiants de
--     vente, jamais une valeur ;
--   * public.sync_fact_registry_alerts : sans paramètre ; une alerte opérationnelle par contrôle, clé et gravité
--     fixées, refermée quand l'écart disparaît, jamais refermée par un rapport tronqué ;
--   * la tâche fact-registry-check est attendue par cron.stale toutes les 27 heures.
-- 20261118100300 (lot R2b) : les contrôles par vente se font par page et l'addition des pages vaut le rapport d'une
-- seule page ; la tâche enchaîne vraiment plus d'une page et calcule une fois les contrôles généraux ; la relance
-- planifiée de la projection est un appel à part, fermée par défaut (ligne absente = fermée), sans effet tant que
-- le journal des décisions est vide ou qu'un déclencheur manque, bornée à trente ventes écrites, journalisée
-- (drift_reprojected), et une vente dont la projection échoue ne compte pas dans la borne ni n'arrête la passe ;
-- une alerte reste ouverte tant que la relance l'est.
begin;

set local timezone = 'UTC';

select plan(92);

-- Relance planifiée, journal des décisions vide (lot R2b) ----------------------------------------------------------
-- À faire avant toute décision du jeu d'essai. La lecture des ventes du registre est remplacée par une fonction qui
-- lève : interrupteur ouvert, la relance ne doit même pas la lire tant qu'aucune décision n'existe.
select is(
  (select enabled from app_private.fact_registry_switches where switch_name = 'scheduled_reprojection'),
  false,
  'the scheduled reprojection is closed by default'
);

create temporary table saved_definitions on commit drop as
select pg_get_functiondef('app_private.fact_registry_candidate_sales()'::regprocedure) as definition;

create or replace function app_private.fact_registry_candidate_sales()
returns setof uuid language plpgsql stable security definer set search_path = '' as $function$
begin
  raise exception 'registry sales read';
end;
$function$;

select app_private.set_fact_registry_scheduled_reprojection(true);
select is(
  public.reproject_fact_registry_drift(),
  '{"enabled": true, "max": 30, "drifted": 0, "applied": 0, "busy": 0, "failed": 0, "failures": [],
    "bounded": false}'::jsonb,
  'opened, with an empty decision journal, the scheduled reprojection does not even read the sales of the registry'
);
select app_private.set_fact_registry_scheduled_reprojection(false);

do $restore$
begin
  execute (select definition from saved_definitions);
end;
$restore$;

-- Fonctions et droits ---------------------------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[] and provolatile = 's'
          and pg_get_function_result(oid) = 'TABLE(sale_id uuid, field_key text, columns text[], listing jsonb)'
     from pg_proc where oid = 'public.get_sale_field_baselines(uuid[])'::regprocedure),
  'the baselines function is stable, security definer, and returns four columns'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[] and provolatile = 's'
          and pg_get_function_result(oid) = 'jsonb'
     from pg_proc where oid = 'public.check_fact_registry_consistency(integer)'::regprocedure),
  'the daily check is a stable function: its own statements are read-only'
);

-- Une fonction stable peut tout de même appeler une fonction volatile, qui écrirait : le contrôle n'appelle la
-- projection qu'en simulation (troisième argument false, écrit en dur), et aucune instruction d'écriture.
select ok(
  (select (select count(*) from regexp_matches(prosrc, 'project_sale_fields\s*\(', 'g')) = 2
          and (select count(*) from regexp_matches(
                 prosrc, 'app_private\.project_sale_fields\(v_sale_id, null, false\)', 'g')) = 2
     from pg_proc where oid = 'app_private.fact_registry_page_checks(uuid[])'::regprocedure)
  and (select bool_and(prosrc !~* '\m(insert|update|delete|truncate|set_config|nextval)\M'
                       and (proname = 'fact_registry_page_checks' or prosrc !~ 'project_sale_fields'))
     from pg_proc where oid in (
       'public.check_fact_registry_consistency(integer)'::regprocedure,
       'app_private.fact_registry_page_checks(uuid[])'::regprocedure,
       'app_private.fact_registry_global_checks(uuid[])'::regprocedure,
       'app_private.fact_registry_candidate_sales()'::regprocedure)),
  'the daily check only simulates the projection (apply = false, written literally, in the pass and in its replay of the per-sale page) and none of its functions has a write statement'
);

select is(
  (select array_agg(routine.signature || ':' || api_role.name order by routine.signature collate "C", api_role.name collate "C")
     from unnest(array[
       'public.get_sale_field_baselines(uuid[])', 'public.check_fact_registry_consistency(integer)',
       'public.sync_fact_registry_alerts()']) routine(signature)
     cross join unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     where has_function_privilege(api_role.name, routine.signature, 'execute')),
  array[
    'public.check_fact_registry_consistency(integer):service_role',
    'public.get_sale_field_baselines(uuid[]):service_role',
    'public.sync_fact_registry_alerts():service_role'
  ],
  'the three functions are executable by the server role only'
);

set local role authenticated;
select throws_ok(
  'select * from public.get_sale_field_baselines()',
  '42501',
  null,
  'a signed-in browser session cannot read the baselines'
);
select throws_ok(
  'select public.check_fact_registry_consistency()',
  '42501',
  null,
  'nor run the daily check'
);
reset role;

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('88900000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('88900000-0000-4000-8000-0000000000a1', 'registre-admin-889@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, habitable_surface_m2,
  rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88900000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/889/sale-' || n,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville', 'house', 90000, '{}'::jsonb,
  '{}'::jsonb, 'tribunal', 50, 50, 'habitable', 'listing_text', 0.7, 50, 2, 1, 'occupied', '[]'::jsonb
from generate_series(1, 5) n;

-- Vente 1 : surface 54 et 3 pièces tenues. Vente 2 : 3 pièces posées puis retirées (entrée libérée).
-- Vente 3 : 3 pièces tenues. Vente 4 : une acceptation jamais projetée. Vente 5 : rien.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88900000-2000-4000-8000-0000000000' || piece.code)::uuid,
  ('88900000-1000-4000-8000-00000000000' || left(piece.code, 1))::uuid,
  piece.field_key, piece.value_jsonb, 'professional_email',
  jsonb_build_object('case_id', '88900000-3000-4000-8000-00000000000' || left(piece.code, 1)),
  0.6, 'information_agent', 'v1', '88900000-0000-4000-8000-0000000000a1'
from (values
  ('11', 'property.surface_m2', '54'::jsonb), ('12', 'property.rooms_count', '3'::jsonb),
  ('21', 'property.rooms_count', '3'::jsonb), ('31', 'property.rooms_count', '3'::jsonb),
  ('41', 'property.rooms_count', '3'::jsonb)
) piece(code, field_key, value_jsonb);

prepare decide(text, text) as
  insert into public.auction_fact_claim_decisions (
    claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code, recipient_kind,
    received_at
  )
  select claim.id, claim.auction_sale_id, claim.field_key, $2, 'single_lot', 'admin',
    '88900000-0000-4000-8000-0000000000a1',
    case $2 when 'accepted' then null when 'opposed' then 'professional_opposition' else 'entry_error' end,
    'source_lawyer', '2026-11-01 09:00:00+00'
  from public.auction_fact_claims claim
  where claim.id = ('88900000-2000-4000-8000-0000000000' || $1)::uuid;

execute decide('11', 'accepted');
execute decide('12', 'accepted');
execute decide('21', 'accepted');
execute decide('31', 'accepted');
select app_private.project_sale_fields(('88900000-1000-4000-8000-00000000000' || n)::uuid, null, true)
  ->> 'changed'
from generate_series(1, 3) n;
execute decide('21', 'withdrawn');
select app_private.project_sale_fields('88900000-1000-4000-8000-000000000002', null, true) ->> 'changed';

-- Statistiques des tables chargées : sans elles, si un VACUUM automatique lit le journal pendant le test, le
-- planificateur croit les tables vides et le test passe de quelques dizaines de secondes à plus de dix minutes.
-- ANALYZE est permis dans une transaction, au propriétaire des tables (pas besoin d'un superutilisateur).
analyze public.auction_sales;
analyze public.auction_fact_claims;
analyze public.auction_fact_claim_decisions;
analyze public.auction_sale_field_hold_events;

-- L'état de départ du test : la file ne garde que les évènements de ce fichier (les autres tests n'en laissent pas).
create temporary table check_reports (step text primary key, report jsonb) on commit drop;
grant select, insert on check_reports to service_role;

-- Valeurs d'annonce pour la fusion -----------------------------------------------------------------------------
set local role service_role;
select results_eq(
  $$select sale_id, field_key, columns, listing from public.get_sale_field_baselines()
      where sale_id::text like '88900000-1000-%'$$,
  $$values
      ('88900000-1000-4000-8000-000000000001'::uuid, 'property.rooms_count', array['rooms_count'],
        '{"rooms_count": 2}'::jsonb),
      ('88900000-1000-4000-8000-000000000001'::uuid, 'property.surface_m2',
        array['surface_m2', 'app_surface_m2', 'app_surface_kind', 'surface_source', 'surface_confidence'],
        '{"surface_m2": 50, "app_surface_m2": 50, "app_surface_kind": "habitable",
          "surface_source": "listing_text", "surface_confidence": 0.7}'::jsonb),
      ('88900000-1000-4000-8000-000000000003'::uuid, 'property.rooms_count', array['rooms_count'],
        '{"rooms_count": 2}'::jsonb)$$,
  'the baselines give, for each held field, its columns and the last known listing value; a released field is not listed'
);

select results_eq(
  $$select field_key, listing from public.get_sale_field_baselines(
      array['88900000-1000-4000-8000-000000000003', '88900000-1000-4000-8000-000000000005']::uuid[])$$,
  $$values ('property.rooms_count', '{"rooms_count": 2}'::jsonb)$$,
  'the baselines can be asked for some sales only; a sale that holds nothing gives no row'
);

select is(
  (select count(*)::integer from public.get_sale_field_baselines() baseline
     where baseline.sale_id::text like '88900000-1000-%'
       and to_jsonb(baseline)::text ~ '88900000-2000|claim_id|decision_id|source_kind|lawyer|"value"|54|echo'),
  0,
  'the baselines never carry the held value, the piece, the decision or the origin'
);
reset role;

-- Base saine : rien à signaler, rien d'écrit ----------------------------------------------------------------
create temporary table write_marks on commit drop as
select
  (select array_agg(sale.xmin::text || ':' || sale.ctid::text order by sale.id) from public.auction_sales sale
     where sale.id::text like '88900000-1000-%') as sales,
  (select count(*) from public.auction_sale_field_hold_events) as events,
  (select count(*) from public.auction_fact_claim_decisions) as decisions,
  (select count(*) from public.operational_alerts) as alerts,
  (select last_value from app_private.fact_registry_seq) as last_seq;
grant select on write_marks to service_role;

set local role service_role;
insert into check_reports select 'sound', public.check_fact_registry_consistency();
reset role;

select is(
  (select array_agg(check_row.key order by check_row.key collate "C")
     from check_reports, jsonb_each(report -> 'checks') check_row where step = 'sound'),
  array[
    'column_mismatch', 'echo_blocked', 'echo_suppressed', 'echo_suspected', 'events_burst', 'final_decisions',
    'final_decisions_over_limit', 'internal_column_copied', 'projection_drift', 'registry_label',
    'reprojection_enabled', 'stale_listing', 'triggers_not_always'
  ],
  'the daily check reports thirteen controls'
);

select is(
  (select count(*)::integer from check_reports, jsonb_each(report -> 'checks') check_row
     where step = 'sound' and (check_row.value ->> 'active')::boolean),
  0,
  'a sound registry raises nothing'
);

select is(
  (select report - 'checks' - 'checked_at' from check_reports where step = 'sound'),
  (select jsonb_build_object(
     'limit', 500, 'truncated', false, 'merge_carried', '{"count": 0, "window_hours": 24}'::jsonb,
     'simulation_failures', '[]'::jsonb, 'decisions_second_factor_required', false,
     'decision_rate_limits_enabled', false, 'scheduled_reprojection_enabled', false,
     'candidate_sales', count(*), 'sales_checked', count(*),
     'held_sale_count', count(*) filter (where exists (
       select 1 from jsonb_each(sale.held_fields) field where field.value ->> 'state' in ('held', 'conflicted'))),
     'held_field_count', (select count(*) from public.auction_sales held, jsonb_each(held.held_fields) field
                      where field.value ->> 'state' in ('held', 'conflicted')))
     from public.auction_sales sale where sale.held_fields is not null),
  'it examines every sale that holds or remembers a field, counts the held ones, and gives the state of the three switches as delivered by lot R2c: second factor not required, ceilings not applied, scheduled reprojection closed'
);

select ok(
  (select mark.sales = (select array_agg(sale.xmin::text || ':' || sale.ctid::text order by sale.id)
                          from public.auction_sales sale where sale.id::text like '88900000-1000-%')
          and mark.events = (select count(*) from public.auction_sale_field_hold_events)
          and mark.decisions = (select count(*) from public.auction_fact_claim_decisions)
          and mark.alerts = (select count(*) from public.operational_alerts)
          and mark.last_seq = (select last_value from app_private.fact_registry_seq)
     from write_marks mark),
  'the daily check writes nothing: no sale, no event, no decision, no alert, no sequence number'
);

-- 1. Dérive de la projection : la vente 4 a une acceptation que personne n'a projetée ------------------------
execute decide('41', 'accepted');
set local role service_role;
insert into check_reports select 'drift', public.check_fact_registry_consistency();
reset role;

select is(
  (select report #> '{checks,projection_drift}' from check_reports where step = 'drift'),
  '{"active": true, "count": 1, "sale_ids": ["88900000-1000-4000-8000-000000000004"]}'::jsonb,
  'an accepted piece that was never projected is a projection drift, on a sale that holds nothing yet'
);

select app_private.project_sale_fields('88900000-1000-4000-8000-000000000004', null, true) ->> 'changed';

-- 2. Mode des déclencheurs -------------------------------------------------------------------------------------
alter table public.auction_sales disable trigger user;
alter table public.auction_sales enable trigger user;

set local role service_role;
insert into check_reports select 'triggers', public.check_fact_registry_consistency();
reset role;

select is(
  (select report #> '{checks,triggers_not_always}' from check_reports where step = 'triggers'),
  '{"active": true, "count": 4, "triggers": [
      "auction_sales.aaab_auction_sales_held_fields_insert_guard",
      "auction_sales.aaab_auction_sales_held_fields_marker_guard",
      "auction_sales.aaab_auction_sales_held_fields_role_guard",
      "auction_sales.aaab_auction_sales_hold_projected_fields"]}'::jsonb,
  'triggers put back to the ordinary mode are reported by name'
);

alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_insert_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_marker_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_role_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_hold_projected_fields;

-- 3, 4, 5 et 8. Écarts provoqués sur la vente 1 et la vente 3, par la seule écriture qui passe la retenue ------
-- (le marqueur de la projection, posé ici à la main par le propriétaire des fonctions).
select set_config('app.sale_field_projection', '88900000-1000-4000-8000-000000000001', true);
update public.auction_sales
set rooms_count = 9,                          -- colonne tenue différente de la valeur de l'entrée
    habitable_surface_m2 = 54,                -- la valeur tenue dans une colonne voisine
    raw_payload = '{"held_fields": {}}'::jsonb -- la colonne interne recopiée dans raw_payload
where id = '88900000-1000-4000-8000-000000000001';
select set_config('app.sale_field_projection', '88900000-1000-4000-8000-000000000003', true);
update public.auction_sales
set held_fields = jsonb_set(
  held_fields, '{property.rooms_count,listing_silent_since}', to_jsonb(statement_timestamp()))
where id = '88900000-1000-4000-8000-000000000003';
select set_config('app.sale_field_projection', '', true);

-- Une copie (properties) qui porte la valeur tenue de la vente 3. Pour la vente 4, qui tient 3 pièces sur une
-- annonce de 2 : une copie d'une autre valeur (7) et une copie égale à la valeur d'annonce, qui ne sont pas des
-- écarts.
insert into public.properties (source_url, source_name, rooms_count) values
  ('https://example.test/889/sale-3', 'licitor', 3),
  ('https://example.test/889/sale-4', 'licitor', 7);
insert into public.auction_surfaces (source_url, rooms_count) values
  ('https://example.test/889/sale-4', 2);

set local role service_role;
insert into check_reports select 'forged', public.check_fact_registry_consistency();
reset role;

select is(
  (select report #> '{checks,column_mismatch}' from check_reports where step = 'forged'),
  '{"active": true, "count": 1, "sale_ids": ["88900000-1000-4000-8000-000000000001"]}'::jsonb,
  'a held column that no longer carries the value of its entry is a column mismatch'
);

select is(
  (select report #> '{checks,echo_suspected}' from check_reports where step = 'forged'),
  '{"active": true, "count": 2, "sale_ids": [
      "88900000-1000-4000-8000-000000000001", "88900000-1000-4000-8000-000000000003"]}'::jsonb,
  'the held value in a neighbour column, or in a copy, is a suspected echo; a copy of the listing value, or of any other value, is not'
);

select is(
  (select report #> '{checks,internal_column_copied}' from check_reports where step = 'forged'),
  '{"active": true, "count": 1, "sales_read": 4, "sale_ids": ["88900000-1000-4000-8000-000000000001"]}'::jsonb,
  'raw_payload carrying a held_fields key is reported'
);

select is(
  (select report #> '{checks,stale_listing}' from check_reports where step = 'forged'),
  '{"active": true, "count": 1, "sale_ids": ["88900000-1000-4000-8000-000000000003"]}'::jsonb,
  'a held field whose listing went silent is reported as a stale listing'
);

select is(
  (select report #> '{checks,projection_drift}' from check_reports where step = 'forged'),
  '{"active": true, "count": 1, "sale_ids": ["88900000-1000-4000-8000-000000000001"]}'::jsonb,
  'the forged column is also a projection drift: the simulation would put the piece back'
);

-- Les libellés neutres d'une surface tenue font partie du contrôle des colonnes.
select app_private.project_sale_fields('88900000-1000-4000-8000-000000000001', null, true) ->> 'changed';
select set_config('app.sale_field_projection', '88900000-1000-4000-8000-000000000001', true);
update public.auction_sales
set surface_source = 'fact_registry_lawyer_email', habitable_surface_m2 = 50, raw_payload = '{}'::jsonb,
    property_type = 'land'
where id = '88900000-1000-4000-8000-000000000001';
select set_config('app.sale_field_projection', '88900000-1000-4000-8000-000000000003', true);
update public.auction_sales set held_fields = held_fields #- '{property.rooms_count,listing_silent_since}'
where id = '88900000-1000-4000-8000-000000000003';
select set_config('app.sale_field_projection', '', true);
delete from public.properties where source_url like 'https://example.test/889/%';
delete from public.auction_surfaces where source_url like 'https://example.test/889/%';

set local role service_role;
insert into check_reports select 'labels', public.check_fact_registry_consistency();
reset role;

select is(
  (select jsonb_build_object(
     'column_mismatch', report #> '{checks,column_mismatch,sale_ids}',
     'stale_listing', report #> '{checks,stale_listing,sale_ids}',
     'echo_suspected', report #> '{checks,echo_suspected,count}',
     'internal_column_copied', report #> '{checks,internal_column_copied,count}')
     from check_reports where step = 'labels'),
  '{"column_mismatch": ["88900000-1000-4000-8000-000000000001"],
    "stale_listing": ["88900000-1000-4000-8000-000000000001"],
    "echo_suspected": 0, "internal_column_copied": 0}'::jsonb,
  'a surface label that names an origin is a column mismatch, and a surface held on a land sale a stale listing'
);

select set_config('app.sale_field_projection', '88900000-1000-4000-8000-000000000001', true);
update public.auction_sales set property_type = 'house' where id = '88900000-1000-4000-8000-000000000001';
select set_config('app.sale_field_projection', '', true);
select app_private.project_sale_fields('88900000-1000-4000-8000-000000000001', null, true) ->> 'changed';

-- 6 et 7. La file de relecture ---------------------------------------------------------------------------------
-- Un écho écarté par la retenue sur la vente 2 (la valeur retirée revient).
update public.auction_sales set rooms_count = 3 where id = '88900000-1000-4000-8000-000000000002';

-- Des évènements anciens, datés à la main (le déclencheur d'horodatage est suspendu le temps de l'écriture) : un
-- écho écarté il y a 60 heures, et 51 changements d'annonce il y a 30 heures. Ni l'un ni les autres ne comptent.
alter table public.auction_sale_field_hold_events disable trigger auction_sale_field_hold_events_stamp;
insert into public.auction_sale_field_hold_events (seq, sale_id, field_key, event, incoming_value, created_at)
values (nextval('app_private.fact_registry_seq'), '88900000-1000-4000-8000-000000000005', 'property.rooms_count',
  'echo_suppressed', '7'::jsonb, statement_timestamp() - interval '60 hours');
insert into public.auction_sale_field_hold_events (seq, sale_id, field_key, event, incoming_value, created_at)
select nextval('app_private.fact_registry_seq'), '88900000-1000-4000-8000-000000000005', 'property.rooms_count',
  'listing_changed_kept', to_jsonb(100 + n), statement_timestamp() - interval '30 hours'
from generate_series(1, 51) n;
alter table public.auction_sale_field_hold_events
  enable always trigger auction_sale_field_hold_events_stamp;

set local role service_role;
insert into check_reports select 'echo', public.check_fact_registry_consistency();
reset role;

select is(
  (select report #> '{checks,echo_suppressed}' from check_reports where step = 'echo'),
  '{"active": true, "count": 1, "total": 2, "window_hours": 48,
    "sale_ids": ["88900000-1000-4000-8000-000000000002"]}'::jsonb,
  'one suppressed echo is enough to raise the indicator of a forgotten path; an echo older than 48 hours only counts in the total'
);

select is(
  (select report #> '{checks,echo_blocked}' from check_reports where step = 'echo'),
  '{"active": true, "count": 1, "sale_ids": ["88900000-1000-4000-8000-000000000002"]}'::jsonb,
  'and the released entry that held the write back carries a blocking note, reported as long as it exists'
);

select is(
  (select report #> '{checks,events_burst}' from check_reports where step = 'echo'),
  '{"active": false, "count": 1, "threshold": 50, "window_hours": 24}'::jsonb,
  'a handful of events is not a burst, and the fifty-one changes of thirty hours ago are out of the window'
);

-- Cinquante et un évènements de la projection dans l'heure : une séance d'acceptations n'est pas une rafale.
insert into public.auction_sale_field_hold_events (sale_id, field_key, event, incoming_value)
select '88900000-1000-4000-8000-000000000005', 'property.rooms_count', 'projection_blocked', to_jsonb(n)
from generate_series(1, 51) n;

set local role service_role;
insert into check_reports select 'projection events', public.check_fact_registry_consistency();
reset role;

select is(
  (select report #> '{checks,events_burst}' from check_reports where step = 'projection events'),
  '{"active": false, "count": 1, "threshold": 50, "window_hours": 24}'::jsonb,
  'the events of the projection do not count in the burst'
);

insert into public.auction_sale_field_hold_events (sale_id, field_key, event, incoming_value)
select '88900000-1000-4000-8000-000000000005', 'property.rooms_count', 'listing_changed_kept', to_jsonb(n)
from generate_series(1, 51) n;

set local role service_role;
insert into check_reports select 'burst', public.check_fact_registry_consistency();
reset role;

select ok(
  (select (report #>> '{checks,events_burst,active}')::boolean
          and (report #>> '{checks,events_burst,count}')::integer > 50
     from check_reports where step = 'burst'),
  'more than fifty direct-write events in a day is a burst'
);

-- Le rapport ne porte que des comptes et des identifiants --------------------------------------------------
select is(
  (select count(*)::integer from check_reports
     where report::text ~ '"value"|"listing"|"echo"|claim_id|decision_id|lawyer|88900000-2000'),
  0,
  'no report carries a value, a listing block, an echo memory, a piece or a decision'
);

-- Borne : au-delà de p_limit ventes, le rapport le dit --------------------------------------------------------
set local role service_role;
select results_eq(
  $$select (report ->> 'truncated')::boolean, (report ->> 'sales_checked')::integer,
           (report ->> 'candidate_sales')::integer > 1, (report ->> 'limit')::integer
      from (select public.check_fact_registry_consistency(1) as report) bounded$$,
  $$values (true, 1, true, 1)$$,
  'beyond the limit the report is marked truncated instead of passing for complete'
);
reset role;

-- Alertes opérationnelles ---------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.operational_alerts where alert_key like 'fact\_registry.%'),
  0,
  'the check alone opened no alert'
);

-- État au moment de la synchronisation : un écho écarté, une rafale d'évènements ; et un déclencheur hors mode.
alter table public.auction_fact_claims disable trigger auction_fact_claims_registry_origin_guard;

set local role service_role;
insert into check_reports select 'sync', public.sync_fact_registry_alerts();
reset role;

select results_eq(
  $$select alert_key, category, severity, status from public.operational_alerts
      where alert_key like 'fact\_registry.%' order by alert_key collate "C"$$,
  $$values
      ('fact_registry.echo_blocked', 'import', 'warning', 'open'),
      ('fact_registry.echo_suppressed', 'import', 'warning', 'open'),
      ('fact_registry.events_burst', 'import', 'warning', 'open'),
      ('fact_registry.triggers_not_always', 'import', 'critical', 'open')$$,
  'the synchronisation opens one alert per raised control, with its fixed key, category and severity'
);

select is(
  (select details - 'checked_at' from public.operational_alerts
     where alert_key = 'fact_registry.triggers_not_always'),
  '{"count": 1, "triggers": ["auction_fact_claims.auction_fact_claims_registry_origin_guard"],
    "sales_checked": 4, "truncated": false}'::jsonb,
  'the critical alert names the trigger, with counts only'
);

select is(
  (select details - 'checked_at' from public.operational_alerts
     where alert_key = 'fact_registry.echo_suppressed'),
  '{"count": 1, "total": 2, "window_hours": 48, "sale_ids": ["88900000-1000-4000-8000-000000000002"],
    "sales_checked": 4, "truncated": false}'::jsonb,
  'the echo alert carries a count and the sale, never a value'
);

select is(
  (select report -> 'checks' from check_reports where step = 'sync'),
  (select public.check_fact_registry_consistency() -> 'checks'),
  'the synchronisation returns the report of the check it ran'
);

-- Retour au calme : l'alerte du déclencheur devient inactive (elle se ferme deux heures plus tard, hystérésis).
alter table public.auction_fact_claims enable always trigger auction_fact_claims_registry_origin_guard;

set local role service_role;
select public.sync_fact_registry_alerts() #>> '{checks,triggers_not_always,active}';
reset role;

select results_eq(
  $$select alert_key, status, inactive_since is not null from public.operational_alerts
      where alert_key like 'fact\_registry.%' order by alert_key collate "C"$$,
  $$values
      ('fact_registry.echo_blocked', 'open', false),
      ('fact_registry.echo_suppressed', 'open', false),
      ('fact_registry.events_burst', 'open', false),
      ('fact_registry.triggers_not_always', 'open', true)$$,
  'once the trigger is back, its alert turns inactive; the three others stay raised'
);

select app_private.sync_operational_alert(
  'fact_registry.triggers_not_always', 'import', 'critical', '{}'::jsonb, false,
  statement_timestamp() + interval '3 hours');

select is(
  (select status from public.operational_alerts where alert_key = 'fact_registry.triggers_not_always'),
  'resolved',
  'and closes by itself after the two calm hours of every operational alert'
);

set local role authenticated;
select throws_ok(
  'select public.sync_fact_registry_alerts()',
  '42501',
  null,
  'a signed-in browser session cannot synchronise the alerts'
);
reset role;

-- Seconde partie : champs libérés, copies, colonnes voisines, gravités, rapport tronqué ---------------------------
delete from public.operational_alerts where alert_key like 'fact\_registry.%';
delete from public.properties where source_url like 'https://example.test/889/%';
delete from public.auction_surfaces where source_url like 'https://example.test/889/%';

-- Dix ventes de plus (6 à 9, a à f), toutes sur la même annonce : 50 m² habitables, 2 pièces, occupé. La vente 8
-- porte déjà, avant toute pièce, une surface Carrez de 54 m² lue dans un document.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, habitable_surface_m2,
  carrez_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88900000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/889/sale-' || n,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville', 'house', 90000, '{}'::jsonb,
  '{}'::jsonb, 'tribunal', 50, 50, 'habitable', 'listing_text', 0.7, 50,
  case when n = '8' then 54 end, 2, 1, 'occupied', '[]'::jsonb
from unnest(array['6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f']) n;

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88900000-2000-4000-8000-0000000000' || piece.code)::uuid,
  ('88900000-1000-4000-8000-00000000000' || left(piece.code, 1))::uuid,
  piece.field_key, piece.value_jsonb, 'professional_email',
  jsonb_build_object('case_id', '88900000-3000-4000-8000-00000000000' || left(piece.code, 1)),
  0.6, 'information_agent', 'v1', '88900000-0000-4000-8000-0000000000a1'
from (values
  ('61', 'property.occupancy_status', '"vacant"'::jsonb), ('71', 'property.land_surface_m2', '800'::jsonb),
  ('81', 'property.surface_m2', '54'::jsonb), ('91', 'property.surface_m2', '54'::jsonb),
  ('a1', 'property.occupancy_status', '"vacant"'::jsonb), ('b1', 'property.land_surface_m2', '800'::jsonb),
  ('c1', 'property.surface_m2', '54'::jsonb), ('d1', 'property.surface_m2', '50.4'::jsonb),
  ('51', 'property.occupancy_status', '"vacant"'::jsonb),
  ('e1', 'property.rooms_count', '3'::jsonb),
  ('f1', 'property.surface_m2', '54'::jsonb), ('f2', 'property.rooms_count', '2'::jsonb)
) piece(code, field_key, value_jsonb);

-- Une écriture qui passe la retenue : le marqueur de la projection, posé à la main par le propriétaire.
create function pg_temp.forge(p_sale text, p_assignments text) returns void
language plpgsql as $$
declare
  v_id uuid := ('88900000-1000-4000-8000-00000000000' || p_sale)::uuid;
begin
  perform set_config('app.sale_field_projection', v_id::text, true);
  execute format('update public.auction_sales set %s where id = %L', p_assignments, v_id);
  perform set_config('app.sale_field_projection', '', true);
end;
$$;

create function pg_temp.sale_ids(variadic p_sales text[]) returns jsonb
language sql as $$
  select jsonb_agg('88900000-1000-4000-8000-00000000000' || sale order by sale) from unnest(p_sales) sale;
$$;

execute decide('61', 'accepted');
execute decide('71', 'accepted');
execute decide('81', 'accepted');
execute decide('91', 'accepted');
execute decide('a1', 'accepted');
execute decide('b1', 'accepted');
execute decide('c1', 'accepted');
execute decide('f1', 'accepted');
execute decide('f2', 'accepted');
select count(app_private.project_sale_fields(('88900000-1000-4000-8000-00000000000' || n)::uuid, null, true))
from unnest(array['6', '7', '8', '9', 'a', 'b', 'c', 'f']) n;
-- Vente f : une pièce qui dit exactement ce que dit l'annonce (2 pièces), puis retirée.
execute decide('f2', 'withdrawn');
select app_private.project_sale_fields('88900000-1000-4000-8000-00000000000f', null, true) ->> 'changed';

analyze public.auction_sales;
analyze public.auction_fact_claims;
analyze public.auction_fact_claim_decisions;
analyze public.auction_sale_field_hold_events;

set local role service_role;
insert into check_reports select 'sound again', public.check_fact_registry_consistency();
reset role;

select is(
  (select jsonb_object_agg(check_row.key, check_row.value -> 'sale_ids')
     from check_reports, jsonb_each(report -> 'checks') check_row
     where step = 'sound again' and check_row.value ? 'sale_ids'
       and check_row.key not in ('echo_suppressed', 'echo_blocked') and jsonb_array_length(check_row.value -> 'sale_ids') > 0),
  null::jsonb,
  'held and released fields in order raise nothing: a neighbour column that already carried the value at the first take, and a released piece that said what the listing says, are not echoes'
);

-- Écarts provoqués, un par vente ------------------------------------------------------------------------------------
select pg_temp.forge('6', $$occupancy_status = 'rented'$$);       -- occupation tenue réécrite
select pg_temp.forge('7', $$land_surface_m2 = 999$$);             -- terrain tenu réécrit
select pg_temp.forge('8', $$app_surface_kind = 'habitable'$$);    -- nature d'une surface tenue réécrite
select pg_temp.forge('b', $$app_surface_m2 = 800$$);              -- terrain tenu recopié en surface principale
insert into public.auction_surfaces (source_url, surface_m2) values ('https://example.test/889/sale-9', 54);
insert into public.properties (source_url, source_name, occupancy_status) values
  ('https://example.test/889/sale-a', 'licitor', 'vacant');
-- Vente c : la portée de la surface devient « terrain » (colonne que la retenue ne surveille pas).
update public.auction_sales set surface_scope = 'land' where id = '88900000-1000-4000-8000-00000000000c';
-- Vente e : absorbée par la vente d, avec une acceptation que personne n'a projetée. Depuis le lot R2b la fusion
-- reprojette elle-même la vente conservée : pour laisser une dérive, l'acceptation est écrite APRÈS la fusion, sur
-- l'observation détachée, que sa première décision (un retrait) rattache à la vente e.
execute decide('e1', 'withdrawn');
update public.auction_sales
set source_urls = '["https://example.test/889/sale-d", "https://example.test/889/sale-e"]'::jsonb
where id = '88900000-1000-4000-8000-00000000000d';
select count(*) > 0 from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales where id = '88900000-1000-4000-8000-00000000000e';
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind, received_at
)
select claim.id, '88900000-1000-4000-8000-00000000000e', claim.field_key, 'accepted', 'single_lot', 'admin',
  '88900000-0000-4000-8000-0000000000a1', 'source_lawyer', '2026-11-01 09:00:00+00'
from public.auction_fact_claims claim
where claim.id = '88900000-2000-4000-8000-0000000000e1';

create temporary table drift_marks on commit drop as
select
  (select array_agg(sale.xmin::text || ':' || sale.ctid::text order by sale.id) from public.auction_sales sale
     where sale.id::text like '88900000-1000-%') as sales,
  (select count(*) from public.auction_sale_field_hold_events) as events,
  (select count(*) from public.auction_fact_claim_decisions) as decisions,
  (select count(*) from public.operational_alerts) as alerts,
  (select last_value from app_private.fact_registry_seq) as last_seq;

set local role service_role;
insert into check_reports select 'one by one', public.check_fact_registry_consistency();
reset role;

select is(
  (select jsonb_build_object(
     'column_mismatch', report #> '{checks,column_mismatch,sale_ids}',
     'echo_suspected', report #> '{checks,echo_suspected,sale_ids}',
     'stale_listing', report #> '{checks,stale_listing,sale_ids}',
     'projection_drift', report #> '{checks,projection_drift,sale_ids}')
     from check_reports where step = 'one by one'),
  jsonb_build_object(
    'column_mismatch', pg_temp.sale_ids('6', '7', '8'),
    'echo_suspected', pg_temp.sale_ids('9', 'a', 'b'),
    'stale_listing', pg_temp.sale_ids('c'),
    'projection_drift', pg_temp.sale_ids('6', '7', '8', 'c', 'd')),
  'each deviation is seen on its own sale: occupancy, land and surface kind rewritten; a copy in auction_surfaces, a copy in properties, a land surface copied as main surface; a surface held under a land scope; an acceptance on an absorbed sale, carried to the kept sale'
);

select ok(
  (select mark.sales = (select array_agg(sale.xmin::text || ':' || sale.ctid::text order by sale.id)
                          from public.auction_sales sale where sale.id::text like '88900000-1000-%')
          and mark.events = (select count(*) from public.auction_sale_field_hold_events)
          and mark.decisions = (select count(*) from public.auction_fact_claim_decisions)
          and mark.alerts = (select count(*) from public.operational_alerts)
          and mark.last_seq = (select last_value from app_private.fact_registry_seq)
     from drift_marks mark)
  and (select (report #>> '{checks,projection_drift,count}')::integer = 5
         from check_reports where step = 'one by one'),
  'the daily check writes nothing either when the simulation answers changed: five sales drift, none is rewritten'
);

-- Champs libérés : le contrôle les regarde encore ------------------------------------------------------------------
-- Vente 9 : opposition ; la copie garde 54 alors que la fiche est revenue à 50. Vente a : retrait ; la copie garde
-- « libre ». Vente f : opposition, puis la valeur opposée est remise dans les colonnes de la surface, avec le
-- libellé du registre. Vente 5 (qui ne tient rien) : le libellé seul. Vente d : une pièce qui confirme l'annonce à
-- la tolérance près (50,4 m² pour 50), acceptée puis opposée, et dont la valeur est remise dans les colonnes : la
-- comparaison à la valeur rendue (50) est exacte, sinon 50,4 passerait pour la valeur d'annonce.
-- Vente 5 : une pièce d'occupation acceptée puis opposée, remise dans la colonne. Vente 2 (pièces retirées
-- depuis le début du fichier) : le nombre de pièces retiré remis dans la colonne. Vente c : des dates de visite
-- tenues (état provoqué : le champ est verrouillé) et recopiées dans judicial_sales.
execute decide('d1', 'accepted');
execute decide('51', 'accepted');
select count(app_private.project_sale_fields(('88900000-1000-4000-8000-00000000000' || n)::uuid, null, true))
from unnest(array['5', 'd']) n;
execute decide('91', 'opposed');
execute decide('a1', 'withdrawn');
execute decide('d1', 'opposed');
execute decide('51', 'opposed');
execute decide('f1', 'opposed');
select count(app_private.project_sale_fields(('88900000-1000-4000-8000-00000000000' || n)::uuid, null, true))
from unnest(array['5', '9', 'a', 'd', 'f']) n;
-- (une seule colonne de la surface : chaque colonne du champ libéré est regardée pour elle-même)
select pg_temp.forge('d', $$app_surface_m2 = 50.4$$);
select pg_temp.forge('5', $$occupancy_status = 'vacant'$$);
select pg_temp.forge('2', $$rooms_count = 3$$);
select pg_temp.forge('c', $$visit_dates = '["2026-12-01"]'::jsonb,
  held_fields = held_fields || '{"sale.visit_dates": {"v": 2, "state": "held", "value": ["2026-12-01"],
    "listing": {"visit_dates": []}, "tolerance": {}, "on_listing_change": "keep_and_review"}}'::jsonb$$);
insert into public.properties (source_url, source_name) values ('https://example.test/889/sale-c', 'licitor');
insert into public.judicial_sales (source_url, property_source_url, source_name, visit_dates) values
  ('https://example.test/889/sale-c', 'https://example.test/889/sale-c', 'licitor', '["2026-12-01"]'::jsonb);
select pg_temp.forge('f', $$surface_m2 = 54, app_surface_m2 = 54, surface_source = 'fact_registry'$$);
select pg_temp.forge('5', $$surface_source = 'fact_registry'$$);

set local role service_role;
insert into check_reports select 'released', public.check_fact_registry_consistency();
reset role;

select is(
  (select jsonb_build_object(
     'echo_suspected', report #> '{checks,echo_suspected,sale_ids}',
     'registry_label', report #> '{checks,registry_label}',
     'column_mismatch', report #> '{checks,column_mismatch,sale_ids}')
     from check_reports where step = 'released'),
  jsonb_build_object(
    'echo_suspected', pg_temp.sale_ids('2', '5', '9', 'a', 'b', 'c', 'd', 'f'),
    'registry_label', jsonb_build_object('active', true, 'count', 2, 'sale_ids', pg_temp.sale_ids('5', 'f')),
    'column_mismatch', pg_temp.sale_ids('6', '7', '8')),
  'a released field is still watched: the opposed or withdrawn value left in a copy, or put back in a column of the field (one surface column alone, the room count, the occupancy; even within the tolerance of the listing value), is a suspected echo; so are held visit dates copied in judicial_sales; the reserved label without a held surface is reported, even on a sale that holds nothing'
);

select is(
  (select jsonb_build_object(
     'final_decisions', report #> '{checks,final_decisions}',
     'final_decisions_over_limit', report #> '{checks,final_decisions_over_limit}')
     from check_reports where step = 'released'),
  '{"final_decisions": {"active": true, "count": 4, "window_hours": 48},
    "final_decisions_over_limit": {"active": false, "count": 0, "limit": 5, "limit_period_hours": 24,
                                   "window_hours": 48}}'::jsonb,
  'final decisions (here four oppositions) are counted over 48 hours and raise their control; under the ceiling per author the second control stays quiet'
);

-- La valeur opposée dans une colonne voisine seule (les colonnes du champ sont remises en ordre).
select pg_temp.forge('d', $$app_surface_m2 = 50$$);
select pg_temp.forge('5', $$occupancy_status = 'occupied'$$);
select pg_temp.forge('2', $$rooms_count = 2$$);
delete from public.judicial_sales where source_url like 'https://example.test/889/%';
select pg_temp.forge('f', $$surface_m2 = 50, app_surface_m2 = 50, surface_source = 'listing_text',
  habitable_surface_m2 = 54$$);
select pg_temp.forge('5', $$surface_source = 'listing_text'$$);
-- L'échéance de la mémoire de la vente a est passée : sa copie n'est plus comparée à rien.
select pg_temp.forge('a', $$held_fields = jsonb_set(held_fields, '{property.occupancy_status,echo,0,until}',
  to_jsonb(statement_timestamp() - interval '1 day'))$$);

set local role service_role;
insert into check_reports select 'expired', public.check_fact_registry_consistency();
reset role;

select is(
  (select jsonb_build_object(
     'echo_suspected', report #> '{checks,echo_suspected,sale_ids}',
     'registry_label', report #> '{checks,registry_label,count}')
     from check_reports where step = 'expired'),
  jsonb_build_object('echo_suspected', pg_temp.sale_ids('9', 'b', 'f'), 'registry_label', 0),
  'the opposed value in a neighbour column of the released field is seen too; an expired memory value is no longer compared; the label alert follows the column'
);

-- Gravité de chaque alerte ---------------------------------------------------------------------------------------------
select app_private.sync_fact_registry_alerts_from_report(
  jsonb_build_object(
    'checked_at', statement_timestamp(), 'sales_checked', 0, 'truncated', false,
    'checks', (
      select jsonb_object_agg(check_key, jsonb_build_object('active', true, 'count', 1))
      from unnest(array[
        'projection_drift', 'triggers_not_always', 'column_mismatch', 'registry_label', 'echo_suspected',
        'internal_column_copied', 'events_burst', 'echo_suppressed', 'echo_blocked', 'stale_listing',
        'reprojection_enabled', 'final_decisions', 'final_decisions_over_limit']) check_key)));

select results_eq(
  $$select alert_key, category, severity, status from public.operational_alerts
      where alert_key like 'fact\_registry.%' order by alert_key collate "C"$$,
  $$values
      ('fact_registry.column_mismatch', 'import', 'critical', 'open'),
      ('fact_registry.echo_blocked', 'import', 'warning', 'open'),
      ('fact_registry.echo_suppressed', 'import', 'warning', 'open'),
      ('fact_registry.echo_suspected', 'import', 'warning', 'open'),
      ('fact_registry.events_burst', 'import', 'warning', 'open'),
      ('fact_registry.final_decisions', 'import', 'warning', 'open'),
      ('fact_registry.final_decisions_over_limit', 'import', 'critical', 'open'),
      ('fact_registry.internal_column_copied', 'import', 'warning', 'open'),
      ('fact_registry.projection_drift', 'import', 'critical', 'open'),
      ('fact_registry.registry_label', 'import', 'critical', 'open'),
      ('fact_registry.reprojection_enabled', 'import', 'warning', 'open'),
      ('fact_registry.stale_listing', 'import', 'warning', 'open'),
      ('fact_registry.triggers_not_always', 'import', 'critical', 'open')$$,
  'each of the thirteen controls has its alert, with its own severity: five critical, eight warnings'
);

select throws_ok(
  $$select app_private.sync_fact_registry_alerts_from_report('{"truncated": false, "checks": {}}'::jsonb)$$,
  'XX000',
  'fact registry check projection_drift returned no state',
  'a report without the state of a control is refused'
);

select throws_ok(
  $$select app_private.sync_fact_registry_alerts_from_report('{"checks": {}}'::jsonb)$$,
  'XX000',
  'fact registry check returned no truncation state',
  'and so is a report that does not say whether it is complete'
);

-- Rapport tronqué : aucune alerte n'est refermée -----------------------------------------------------------------------
delete from public.operational_alerts where alert_key like 'fact\_registry.%';
set local role service_role;
select public.sync_fact_registry_alerts() ->> 'truncated';
reset role;

select results_eq(
  $$select alert_key, inactive_since is null from public.operational_alerts
      where alert_key in ('fact_registry.projection_drift', 'fact_registry.column_mismatch',
                          'fact_registry.triggers_not_always') and status = 'open'
      order by alert_key collate "C"$$,
  $$values ('fact_registry.column_mismatch', true), ('fact_registry.projection_drift', true)$$,
  'a complete report opens the critical alerts of the deviations above'
);

-- Borne à une vente : la vente examinée (la première, en ordre) n'a aucun écart ; un déclencheur est hors mode.
alter table public.auction_fact_claims disable trigger auction_fact_claims_no_truncate;

select results_eq(
  $$select (partial.report ->> 'truncated')::boolean, partial.report #>> '{checks,projection_drift,active}',
           partial.report #>> '{checks,column_mismatch,active}',
           partial.report #>> '{checks,triggers_not_always,active}',
           app_private.sync_fact_registry_alerts_from_report(partial.report) is null
      from (select public.check_fact_registry_consistency(1) as report) partial$$,
  $$values (true, 'false', 'false', 'true', false)$$,
  'a report bounded to the first sale sees no drift, no mismatch, and the trigger'
);

select results_eq(
  $$select alert_key, status, inactive_since is null, (details ->> 'truncated')::boolean
      from public.operational_alerts
      where alert_key in ('fact_registry.projection_drift', 'fact_registry.column_mismatch',
                          'fact_registry.triggers_not_always')
      order by alert_key collate "C"$$,
  $$values
      ('fact_registry.column_mismatch', 'open', true, false),
      ('fact_registry.projection_drift', 'open', true, false),
      ('fact_registry.triggers_not_always', 'open', true, true)$$,
  'a truncated report closes nothing: the two critical alerts stay raised, untouched; the control that is active in it is still synchronised'
);

alter table public.auction_fact_claims enable always trigger auction_fact_claims_no_truncate;

select ok(
  to_regprocedure('public.sync_fact_registry_alerts(integer)') is null
  and pg_get_function_arguments('public.sync_fact_registry_alerts()'::regprocedure) = ''
  and (select prosrc ~ 'app_private\.fact_registry_page_checks\(' and prosrc !~ 'reproject'
              and prosrc ~ 'app_private\.sync_fact_registry_alerts_from_report\(v_report\)'
         from pg_proc where oid = 'public.sync_fact_registry_alerts()'::regprocedure),
  'the alert function takes no parameter: the caller chooses neither the bound nor the report'
);

-- Borne du rapport : vingt identifiants de vente au plus par contrôle, le compte reste entier ---------------------
-- Vingt et une ventes de plus, chacune avec une acceptation que personne n'a projetée.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, rooms_count
)
select
  ('88900000-1000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, 'licitor',
  'https://example.test/889/bound-' || n, 'upcoming', current_timestamp + interval '20 days', 'Alphaville',
  'house', 90000, '{}'::jsonb, '{}'::jsonb, 'tribunal', 2
from generate_series(1, 21) n;

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88900000-2000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  ('88900000-1000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  'property.rooms_count', '3'::jsonb, 'professional_email',
  jsonb_build_object('case_id', '88900000-3000-4000-8000-0000000001' || lpad(n::text, 2, '0')),
  0.6, 'information_agent', 'v1', '88900000-0000-4000-8000-0000000000a1'
from generate_series(1, 21) n;

insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind, received_at
)
select claim.id, claim.auction_sale_id, claim.field_key, 'accepted', 'single_lot', 'admin',
  '88900000-0000-4000-8000-0000000000a1', 'source_lawyer', '2026-11-01 09:00:00+00'
from public.auction_fact_claims claim
where claim.id::text like '88900000-2000-4000-8000-0000000001%';

analyze public.auction_sales;
analyze public.auction_fact_claims;
analyze public.auction_fact_claim_decisions;
analyze public.auction_sale_field_hold_events;

select results_eq(
  $$select (bounded.report ->> 'truncated')::boolean,
           (bounded.report #>> '{checks,projection_drift,count}')::integer >= 21,
           jsonb_array_length(bounded.report #> '{checks,projection_drift,sale_ids}')
      from (select public.check_fact_registry_consistency() as report) bounded$$,
  $$values (false, true, 20)$$,
  'a control lists twenty sales at most and still counts them all: twenty-one more drifting sales, a complete report'
);

-- Pages (lot R2b) -----------------------------------------------------------------------------------------------------
-- Les contrôles par vente, page de sept ventes par page de sept ventes, additionnés, valent ceux d'une seule page.
create temporary table paged_report (report jsonb, pages integer) on commit drop;
do $pages$
declare
  v_all uuid[] := array(
    select candidate.id from app_private.fact_registry_candidate_sales() candidate(id) order by candidate.id);
  v_report jsonb;
  v_page jsonb;
  v_pages integer := 0;
begin
  loop
    v_page := app_private.fact_registry_page_checks(v_all[v_pages * 7 + 1 : (v_pages + 1) * 7]);
    v_report := case
      when v_report is null then v_page else app_private.fact_registry_report_add_page(v_report, v_page) end;
    v_pages := v_pages + 1;
    exit when v_pages * 7 >= cardinality(v_all);
  end loop;
  insert into paged_report values (v_report, v_pages);
end;
$pages$;

select ok(
  (select pages >= 4 from paged_report)
  and (
    select paged.report = jsonb_build_object(
        'sales_checked', whole.report -> 'sales_checked',
        'held_sale_count', whole.report -> 'held_sale_count',
        'held_field_count', whole.report -> 'held_field_count',
        'simulation_failures', whole.report -> 'simulation_failures',
        'checks', (
          select jsonb_object_agg(check_row.key, check_row.value)
          from jsonb_each(whole.report -> 'checks') check_row
          where paged.report -> 'checks' ? check_row.key))
    from paged_report paged, (select public.check_fact_registry_consistency(5000) as report) whole),
  'the pages of seven sales, added up, give the per-sale controls of a single page: same counts, same first twenty sales'
);

select results_eq(
  $$select array_agg(check_row.key order by check_row.key collate "C")
      from paged_report, jsonb_object_keys(report -> 'checks') check_row(key)$$,
  $$values (array['column_mismatch', 'echo_blocked', 'echo_suspected', 'projection_drift', 'stale_listing'])$$,
  'a page carries the five controls that depend on a sale; the eight others are computed once'
);

select results_eq(
  $$select array_agg(check_row.key order by check_row.key collate "C")
      from jsonb_object_keys(app_private.fact_registry_global_checks(null) -> 'checks') check_row(key)$$,
  $$values (array['echo_suppressed', 'events_burst', 'final_decisions', 'final_decisions_over_limit',
                  'internal_column_copied', 'registry_label', 'reprojection_enabled', 'triggers_not_always'])$$,
  'the controls that do not depend on a page: triggers, reserved label, copied internal column, event queue, opened reprojection, final decisions'
);

-- La lecture de raw_payload est bornée aux 500 premières ventes du registre.
select is(
  app_private.fact_registry_global_checks(array(
    select candidate.id from app_private.fact_registry_candidate_sales() candidate(id) order by candidate.id
  )) #> '{checks,internal_column_copied,sales_read}',
  to_jsonb(least(500, (select count(*)::integer from app_private.fact_registry_candidate_sales()))),
  'the read of raw_payload is bounded to the first sales of the registry, and says how many it read'
);

-- La vraie boucle de la tâche, sur plus d'une page : 520 ventes de plus, chacune avec une acceptation que personne
-- n'a projetée.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, rooms_count
)
select
  ('88900000-1000-4000-8000-00000002' || lpad(n::text, 4, '0'))::uuid, 'licitor',
  'https://example.test/889/page-' || n, 'upcoming', current_timestamp + interval '20 days', 'Alphaville',
  'house', 90000, '{}'::jsonb, '{}'::jsonb, 'tribunal', 2
from generate_series(1, 520) n;

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
)
select
  ('88900000-2000-4000-8000-00000002' || lpad(n::text, 4, '0'))::uuid,
  ('88900000-1000-4000-8000-00000002' || lpad(n::text, 4, '0'))::uuid,
  'property.rooms_count', '3'::jsonb, 'professional_email',
  jsonb_build_object('case_id', '88900000-3000-4000-8000-00000002' || lpad(n::text, 4, '0')),
  0.6, 'information_agent', 'v1', '88900000-0000-4000-8000-0000000000a1'
from generate_series(1, 520) n;

insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind, received_at
)
select claim.id, claim.auction_sale_id, claim.field_key, 'accepted', 'single_lot', 'admin',
  '88900000-0000-4000-8000-0000000000a1', 'source_lawyer', '2026-11-01 09:00:00+00'
from public.auction_fact_claims claim
where claim.id::text like '88900000-2000-4000-8000-00000002%';

analyze public.auction_sales;
analyze public.auction_fact_claims;
analyze public.auction_fact_claim_decisions;
analyze public.auction_sale_field_hold_events;

set local role service_role;
insert into check_reports select 'two pages', public.sync_fact_registry_alerts();
insert into check_reports select 'one page', public.check_fact_registry_consistency(5000);
reset role;

select results_eq(
  $$select (synced.report ->> 'pages')::integer, (synced.report ->> 'truncated')::boolean,
           (synced.report ->> 'candidate_sales')::integer > 520,
           (synced.report ->> 'sales_checked')::integer = (synced.report ->> 'candidate_sales')::integer,
           (synced.report #>> '{checks,projection_drift,count}')::integer >= 541,
           synced.report - 'pages' - 'limit' - 'checked_at' = whole.report - 'limit' - 'checked_at',
           synced.report ? 'reprojection',
           (synced.report #>> '{checks,internal_column_copied,sales_read}')::integer
      from check_reports synced, check_reports whole
      where synced.step = 'two pages' and whole.step = 'one page'$$,
  $$values (2, false, true, true, true, true, false, 500)$$,
  'the daily job really chains two pages of 500 sales: every sale of the registry is examined, and its report is the one of a single page; it does not run the reprojection'
);

select ok(
  (select provolatile = 'v' and proconfig @> array['statement_timeout=120s'] and pronargs = 0
     from pg_proc where oid = 'public.sync_fact_registry_alerts()'::regprocedure)
  and (select proconfig @> array['statement_timeout=120s'] and pronargs = 0 and prosecdef
     from pg_proc where oid = 'public.reproject_fact_registry_drift()'::regprocedure)
  and (select bool_and(provolatile = 's') from pg_proc where oid in (
     'app_private.fact_registry_page_checks(uuid[])'::regprocedure,
     'app_private.fact_registry_global_checks(uuid[])'::regprocedure,
     'app_private.fact_registry_candidate_sales()'::regprocedure,
     'public.check_fact_registry_consistency(integer)'::regprocedure)),
  'the two functions the job calls take no parameter and carry a statement timeout; the checks are stable functions'
);

-- Relance planifiée de la projection (lot R2b) -------------------------------------------------------------------------
-- Fermée : rien n'est écrit, et le dit.
set local role service_role;
insert into check_reports select 'closed', public.reproject_fact_registry_drift();
reset role;

select results_eq(
  $$select report,
           (select count(*)::integer from public.auction_sales
              where id::text like '88900000-1000-4000-8000-0000000001%' and rooms_count = 2),
           (select count(*)::integer from public.auction_sale_field_hold_events where event = 'drift_reprojected'),
           (select report #>> '{checks,reprojection_enabled,active}' from check_reports where step = 'two pages')
      from check_reports where step = 'closed'$$,
  $$values ('{"enabled": false, "max": 30, "drifted": 0, "applied": 0, "busy": 0, "failed": 0, "failures": [],
              "bounded": false}'::jsonb, 21, 0, 'false')$$,
  'closed by default: the reprojection writes nothing, logs no event, and says so; its control is inactive'
);

-- Ligne du réglage absente : fermée, et la fonction de réglage lève.
delete from app_private.fact_registry_switches where switch_name = 'scheduled_reprojection';
select results_eq(
  $$select public.reproject_fact_registry_drift() ->> 'enabled',
           app_private.fact_registry_global_checks(null) #>> '{checks,reprojection_enabled,active}'$$,
  $$values ('false', 'false')$$,
  'a missing switch row means closed'
);
select throws_ok(
  $$select app_private.set_fact_registry_scheduled_reprojection(true)$$,
  '55000', 'The switch scheduled_reprojection has no row: restore it by a migration.',
  'and the setter raises instead of doing nothing'
);
insert into app_private.fact_registry_switches (switch_name, enabled) values ('scheduled_reprojection', false);

select app_private.set_fact_registry_scheduled_reprojection(true);

-- Ouverte, mais un déclencheur du registre manque : rien n'est écrit.
alter table public.auction_fact_claims disable trigger auction_fact_claims_no_truncate;
select is(
  public.reproject_fact_registry_drift() - 'enabled' - 'max',
  '{"drifted": 0, "applied": 0, "busy": 0, "failed": 0, "failures": [], "bounded": false}'::jsonb,
  'opened, with a registry trigger out of its mode, the scheduled reprojection writes nothing'
);
alter table public.auction_fact_claims enable always trigger auction_fact_claims_no_truncate;

-- Vingt et une ventes dont la projection échoue (contrainte posée pour l'essai), en tête des ventes en dérive : elles
-- ne comptent pas dans la borne et ne privent pas les suivantes de leur tour.
alter table public.auction_sales add constraint pgtap_889_refused_projection check (
  id::text not like '88900000-1000-4000-8000-0000000001%' or rooms_count <> 3
) not valid;

create temporary table reprojection_runs (label text, report jsonb) on commit drop;
insert into reprojection_runs select 'first', public.reproject_fact_registry_drift();

select results_eq(
  $$select (report ->> 'applied')::integer, (report ->> 'failed')::integer >= 21, (report ->> 'bounded')::boolean,
           jsonb_array_length(report -> 'failures'),
           (select count(*) between 20 and 30 from public.auction_sales
              where id::text like '88900000-1000-4000-8000-00000002%' and rooms_count = 3),
           (select count(*)::integer from public.auction_sales
              where id::text like '88900000-1000-4000-8000-0000000001%' and rooms_count = 3)
      from reprojection_runs where label = 'first'$$,
  $$values (30, true, true, 20, true, 0)$$,
  'bounded to thirty written sales: the pass stops there; the twenty-one failing sales ahead do not count in the bound and do not starve the sales that follow'
);

select results_eq(
  $$select distinct failure ->> 'sqlstate', failure ->> 'constraint',
           (select array_agg(field.key order by field.key collate "C") from jsonb_object_keys(failure) field(key))
      from reprojection_runs, jsonb_array_elements(report -> 'failures') failure
      where label = 'first' and failure ->> 'sale_id' like '88900000-1000-4000-8000-0000000001%'$$,
  $$values ('23514', 'pgtap_889_refused_projection', array['constraint', 'sale_id', 'sqlstate'])$$,
  'a failing sale is returned with its SQLSTATE and the constraint name, and nothing else: no message, no detail'
);

select results_eq(
  $$select count(*)::integer, count(distinct event.sale_id)::integer,
           bool_and(event.field_key = 'property.rooms_count' and event.held_value = '3'::jsonb
                    and event.decision_id is not null)
      from public.auction_sale_field_hold_events event
      where event.event = 'drift_reprojected'
        and event.sale_id::text like '88900000-1000-4000-8000-00000002%'$$,
  $$values (
      (select count(*)::integer from public.auction_sales
         where id::text like '88900000-1000-4000-8000-00000002%' and rooms_count = 3),
      (select count(*)::integer from public.auction_sales
         where id::text like '88900000-1000-4000-8000-00000002%' and rooms_count = 3),
      true)$$,
  'logged: one drift_reprojected event per reprojected sale, on the field whose entry changed, with the decision that holds it'
);

select is(
  (select count(*)::integer from public.auction_fact_claim_decisions),
  (select count(*)::integer from public.auction_fact_claim_decisions
     where publication_mode = 'manual' and actor_kind = 'admin'),
  'the scheduled reprojection writes no decision: every decision of the journal is still a manual one of an administrator'
);

alter table public.auction_sales drop constraint pgtap_889_refused_projection;

-- Une dérive qui libère (un retrait écrit au journal sans projection), et une dérive des colonnes seules (une
-- colonne tenue réécrite sous le marqueur) : deux ventes déjà reprojetées, en tête du passage suivant.
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code
)
select claim.id, claim.auction_sale_id, claim.field_key, 'withdrawn', 'single_lot', 'admin',
  '88900000-0000-4000-8000-0000000000a1', 'entry_error'
from public.auction_fact_claims claim
where claim.id = '88900000-2000-4000-8000-000000020001';
select set_config('app.sale_field_projection', '88900000-1000-4000-8000-000000020002', true);
update public.auction_sales set rooms_count = 9 where id = '88900000-1000-4000-8000-000000020002';
select set_config('app.sale_field_projection', '', true);

insert into reprojection_runs select 'second', public.reproject_fact_registry_drift();

select results_eq(
  $$select sale.rooms_count, sale.held_fields #>> '{property.rooms_count,state}',
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'drift_reprojected' and event.held_value is null)
      from public.auction_sales sale where sale.id = '88900000-1000-4000-8000-000000020001'$$,
  $$values (2, 'released', 1)$$,
  'a drift that releases a field is reprojected too, and logged on the field whose entry changed, without a held value'
);

select results_eq(
  $$select sale.rooms_count,
           (select count(*)::integer from public.auction_sale_field_hold_events event
              where event.sale_id = sale.id and event.event = 'drift_reprojected' and event.held_value = '3'::jsonb)
      from public.auction_sales sale where sale.id = '88900000-1000-4000-8000-000000020002'$$,
  $$values (3, 2)$$,
  'a drift of the columns alone (the entry did not change) is reprojected and logged on the held field'
);

select results_eq(
  $$select (report ->> 'applied')::integer, (report ->> 'failed')::integer, (report ->> 'bounded')::boolean,
           (select count(*)::integer from public.auction_sales
              where id::text like '88900000-1000-4000-8000-0000000001%' and rooms_count = 3)
      from reprojection_runs where label = 'second'$$,
  $$values (30, 0, true, 21)$$,
  'the next pass takes what the first one left: the twenty-one sales that failed are reprojected once their projection passes'
);

-- La tâche qui suit : la relance ouverte tient une alerte ouverte.
set local role service_role;
insert into check_reports select 'opened', public.sync_fact_registry_alerts();
reset role;

select results_eq(
  $$select (select report #>> '{checks,reprojection_enabled,active}' from check_reports where step = 'opened'),
           alert.status, alert.severity
      from public.operational_alerts alert where alert.alert_key = 'fact_registry.reprojection_enabled'$$,
  $$values ('true', 'open', 'warning')$$,
  'while the scheduled reprojection is opened, an operational alert says so'
);

-- Tout le reste est projeté d'un coup (la relance le ferait en une quinzaine de passages) : plus rien ne dérive.
select count(app_private.project_sale_fields(candidate.id, null, true)) > 0
from app_private.fact_registry_candidate_sales() candidate(id);

select is(
  public.reproject_fact_registry_drift() - 'enabled' - 'max',
  '{"drifted": 0, "applied": 0, "busy": 0, "failed": 0, "failures": [], "bounded": false}'::jsonb,
  'once every sale is reprojected, a further pass finds no drift and writes nothing'
);

-- Une vente dont la simulation lève (ici une échéance de mémoire d'écho illisible, posée sous le marqueur) : ni le
-- contrôle ni la relance ne s'arrêtent. La vente est comptée en dérive, rendue avec son code ; la relance traite
-- les autres ventes (ici la vente 3, dont la colonne tenue est réécrite).
select pg_temp.forge('a', $$held_fields = jsonb_set(held_fields, '{property.occupancy_status,echo,0,until}',
  '"pas-une-date"'::jsonb)$$);
select pg_temp.forge('3', $$rooms_count = 9$$);

select throws_ok(
  $$select app_private.project_sale_fields('88900000-1000-4000-8000-00000000000a', null, false)$$,
  '22007', null,
  'a sale with a damaged entry: its simulation raises'
);

select results_eq(
  $$select raised.report #> '{checks,projection_drift}', raised.report -> 'simulation_failures',
           (raised.report ->> 'sales_checked')::integer = (raised.report ->> 'candidate_sales')::integer
      from (select public.check_fact_registry_consistency(5000) as report) raised$$,
  $$values (
      jsonb_build_object('active', true, 'count', 2, 'sale_ids', pg_temp.sale_ids('3', 'a')),
      jsonb_build_array(jsonb_build_object(
        'sale_id', '88900000-1000-4000-8000-00000000000a', 'sqlstate', '22007')),
      true)$$,
  'the daily check does not stop on it: the sale is counted as drifting and returned with its SQLSTATE, and every other sale is still examined'
);

insert into reprojection_runs select 'raised', public.reproject_fact_registry_drift();

select results_eq(
  $$select raised.report - 'enabled' - 'max',
           (select rooms_count from public.auction_sales where id = '88900000-1000-4000-8000-000000000003')
      from reprojection_runs raised where raised.label = 'raised'$$,
  $$values (
      jsonb_build_object('drifted', 1, 'applied', 1, 'busy', 0, 'failed', 1, 'bounded', false,
        'failures', jsonb_build_array(jsonb_build_object(
          'sale_id', '88900000-1000-4000-8000-00000000000a', 'sqlstate', '22007'))),
      3)$$,
  'nor does the scheduled reprojection: the sale is counted as failed with its SQLSTATE, and the drifting sale after it is reprojected'
);

select pg_temp.forge('a', $$held_fields = jsonb_set(held_fields, '{property.occupancy_status,echo,0,until}',
  to_jsonb(statement_timestamp() - interval '1 day'))$$);

-- Dérive de masse : seules les vingt premières ventes en dérive d'une page sont rejouées, les suivantes sont
-- comptées sans rejeu (leur compte est vérifié plus haut : vingt et une ventes en dérive, toutes comptées).
select ok(
  (select position('foreach v_sale_id in array v_drift_first[1:20] loop' in prosrc) > 0
          and position('v_drift || v_drift_first[21:] || v_failed' in prosrc) > 0
     from pg_proc where oid = 'app_private.fact_registry_page_checks(uuid[])'::regprocedure),
  'a page replays its first twenty drifting sales only; the following ones are counted without a replay'
);

select app_private.set_fact_registry_scheduled_reprojection(false);

-- Une acceptation sans lot identifié ne tient rien : sa vente n'est pas une vente du registre.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, rooms_count
) values (
  '88900000-1000-4000-8000-000000000301', 'licitor', 'https://example.test/889/unmatched', 'upcoming',
  current_timestamp + interval '20 days', 'Alphaville', 'house', 90000, '{}'::jsonb, '{}'::jsonb, 'tribunal', 2
);
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
) values (
  '88900000-2000-4000-8000-000000000301', '88900000-1000-4000-8000-000000000301', 'property.rooms_count',
  '3'::jsonb, 'professional_email', '{"case_id": "88900000-3000-4000-8000-000000000301"}'::jsonb, 0.6,
  'information_agent', 'v1', '88900000-0000-4000-8000-0000000000a1'
);
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind, received_at
) values (
  '88900000-2000-4000-8000-000000000301', '88900000-1000-4000-8000-000000000301', 'property.rooms_count',
  'accepted', 'unmatched', 'admin', '88900000-0000-4000-8000-0000000000a1', 'source_lawyer',
  '2026-11-01 09:00:00+00'
);

select results_eq(
  $$select count(*) filter (where candidate.id = '88900000-1000-4000-8000-000000000301')::integer,
           count(*) filter (where candidate.id = '88900000-1000-4000-8000-000000000003')::integer
      from app_private.fact_registry_candidate_sales() candidate(id)$$,
  $$values (0, 1)$$,
  'an acceptance without an identified lot holds nothing: its sale is not a sale of the registry'
);

-- Décisions définitives au-delà du plafond par auteur : deux oppositions de plus, écrites au journal sans passer
-- par la fonction de décision (qui les refuserait).
execute decide('31', 'opposed');
execute decide('12', 'opposed');

select is(
  app_private.fact_registry_global_checks(null) #> '{checks,final_decisions_over_limit}',
  '{"active": true, "count": 1, "limit": 5, "limit_period_hours": 24, "window_hours": 48}'::jsonb,
  'an author above the ceiling of final decisions over 24 hours raises the second control'
);

-- Fenêtre de 48 heures (lot R2c) : deux passages de la tâche. Un second auteur a dépassé le plafond la veille (six
-- oppositions d'il y a 26 heures), et n'a rien décidé depuis. La date d'une décision est imposée par le
-- déclencheur de validation, suspendu le temps de cette seule écriture.
insert into auth.users (id) values
  ('88900000-0000-4000-8000-0000000000b1'), ('88900000-0000-4000-8000-0000000000c1');
create function pg_temp.old_oppositions(p_actor uuid, p_count integer, p_age interval) returns void
language plpgsql as $function$
begin
  alter table public.auction_fact_claim_decisions disable trigger auction_fact_claim_decisions_validate;
  insert into public.auction_fact_claim_decisions (
    claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code, seq, decided_at
  )
  select claim.id, claim.auction_sale_id, claim.field_key, 'opposed', 'unknown', 'admin', p_actor,
    'professional_opposition', nextval('app_private.fact_registry_seq'),
    clock_timestamp() - p_age - make_interval(secs => n)
  from public.auction_fact_claims claim, generate_series(1, p_count) n
  where claim.id = '88900000-2000-4000-8000-000000000301';
  alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_validate;
end;
$function$;
create temporary table finals_before on commit drop as
  select (app_private.fact_registry_global_checks(null) #>> '{checks,final_decisions,count}')::integer as count;

select pg_temp.old_oppositions('88900000-0000-4000-8000-0000000000b1', 6, interval '26 hours');
select results_eq(
  $$select (checked.report #>> '{checks,final_decisions,count}')::integer - (select count from finals_before),
           (checked.report #>> '{checks,final_decisions_over_limit,count}')::integer
      from (select app_private.fact_registry_global_checks(null) as report) checked$$,
  $$values (6, 2)$$,
  'final decisions of the day before are still counted, and an author who went over the ceiling the day before is still reported: the window covers two runs of the job'
);

select pg_temp.old_oppositions('88900000-0000-4000-8000-0000000000c1', 6, interval '49 hours');
select results_eq(
  $$select (checked.report #>> '{checks,final_decisions,count}')::integer - (select count from finals_before),
           (checked.report #>> '{checks,final_decisions_over_limit,count}')::integer
      from (select app_private.fact_registry_global_checks(null) as report) checked$$,
  $$values (6, 2)$$,
  'beyond 48 hours a final decision is no longer counted'
);

-- Les trois réglages du registre se lisent dans le rapport.
select app_private.set_fact_registry_decisions_second_factor(true);
select app_private.set_fact_registry_decision_rate_limits(true);
select app_private.set_fact_registry_scheduled_reprojection(true);
select is(
  (select jsonb_build_object(
     'second_factor', checked.report -> 'decisions_second_factor_required',
     'ceilings', checked.report -> 'decision_rate_limits_enabled',
     'reprojection', checked.report -> 'scheduled_reprojection_enabled')
     from (select app_private.fact_registry_global_checks(null) as report) checked),
  '{"second_factor": true, "ceilings": true, "reprojection": true}'::jsonb,
  'the report gives the state of the three switches: second factor required, ceilings applied, scheduled reprojection opened'
);
select app_private.set_fact_registry_decisions_second_factor(false);
select app_private.set_fact_registry_decision_rate_limits(false);
select app_private.set_fact_registry_scheduled_reprojection(false);
select is(
  (select jsonb_build_object(
     'second_factor', checked.report -> 'decisions_second_factor_required',
     'ceilings', checked.report -> 'decision_rate_limits_enabled',
     'reprojection', checked.report -> 'scheduled_reprojection_enabled')
     from (select app_private.fact_registry_global_checks(null) as report) checked),
  '{"second_factor": false, "ceilings": false, "reprojection": false}'::jsonb,
  'and says when each of them is lifted or closed'
);

select ok(
  (select count(*) = 0 from unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     cross join unnest(array[
       'app_private.fact_registry_candidate_sales()', 'app_private.fact_registry_page_checks(uuid[])',
       'app_private.fact_registry_global_checks(uuid[])',
       'app_private.fact_registry_report_add_page(jsonb, jsonb)',
       'app_private.fact_registry_failure(uuid, text, text)',
       'app_private.fact_registry_error_is_systemic(text)',
       'app_private.fact_registry_decision_rate_limits_enabled()',
       'app_private.set_fact_registry_decision_rate_limits(boolean)',
       'app_private.fact_registry_scheduled_reprojection_enabled()',
       'app_private.set_fact_registry_scheduled_reprojection(boolean)']) routine(signature)
     where has_function_privilege(api_role.name, routine.signature, 'EXECUTE'))
  and has_function_privilege('service_role', 'public.reproject_fact_registry_drift()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.reproject_fact_registry_drift()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.reproject_fact_registry_drift()', 'EXECUTE')
  and (select count(*) = 0 from unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege(name)
     where has_table_privilege(api_role.name, 'app_private.fact_registry_switches', privilege.name))
  and (select relrowsecurity from pg_class where oid = 'app_private.fact_registry_switches'::regclass),
  'the reprojection is run by the server role only; no API role reads the sales of the registry, nor reads or flips a switch'
);

-- cron.stale ------------------------------------------------------------------------------------------------------
select ok(
  position('(''fact-registry-check'', interval ''27 hours'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0,
  'the daily check is an expected job of cron.stale, with the 27-hour threshold of the daily jobs'
);

select ok(
  (select bool_and(position('(''' || job_name || ''', interval ''' in pg_get_functiondef(
            'app_private.evaluate_operational_health(timestamptz)'::regprocedure)) > 0)
     from unnest(array[
       'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor', 'data-retention',
       'sale-retention', 'information-agent-inbound', 'listing-completeness', 'sale-pepites',
       'sale-flood-risk', 'sale-reminders', 'sale-results', 'weekly-digest']) as job_name),
  'none of the thirteen earlier jobs left the list'
);

delete from public.operational_job_runs;
insert into public.operational_job_runs (job_name, status, started_at, finished_at)
select job_name, 'success', '2026-11-17T09:58:00Z'::timestamptz, '2026-11-17T09:59:00Z'::timestamptz
from unnest(array[
  'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor', 'data-retention',
  'sale-retention', 'information-agent-inbound', 'listing-completeness', 'sale-pepites', 'sale-flood-risk',
  'sale-reminders', 'sale-results', 'weekly-digest']) as job_name;

select is(
  public.evaluate_operational_health('2026-11-17T10:00:00Z') -> 'stale_cron_jobs',
  '["fact-registry-check"]'::jsonb,
  'before its first success the daily check is the only stale job'
);

insert into public.operational_job_runs (job_name, status, started_at, finished_at) values
  ('fact-registry-check', 'success', '2026-11-16T07:00:00Z', '2026-11-16T07:01:00Z');

select is(
  public.evaluate_operational_health('2026-11-17T10:00:00Z') -> 'stale_cron_jobs',
  '[]'::jsonb,
  'a success 26 hours 59 minutes ago is not stale'
);

select is(
  public.evaluate_operational_health('2026-11-17T10:02:00Z') -> 'stale_cron_jobs' ? 'fact-registry-check',
  true,
  'a success 27 hours 01 minute ago is stale'
);

-- Erreurs systémiques (lot R2c) -------------------------------------------------------------------------------------
-- (En dernier : la définition commune de la vente de terrain, que la projection appelle pour chaque vente, reste
-- remplacée par une fonction qui lève le code voulu.)
select is(
  (select array_agg(app_private.fact_registry_error_is_systemic(code.value) order by code.position)
     from unnest(array['42501', '42883', '53200', '58030', 'XX000', '22007', '23514', '40001', '55P03', null])
       with ordinality code(value, position)),
  array[true, true, true, true, true, false, false, false, false, false],
  'systemic errors are the SQLSTATE classes 42, 53, 58 and XX; a data error, a conflict or a busy lock is not one'
);

create or replace function app_private.sale_is_land_sale(
  p_property_type text, p_surface_scope text, p_app_surface_kind text, p_held_fields jsonb
)
returns boolean language plpgsql stable set search_path = '' as $function$
begin
  raise exception using errcode = current_setting('pgtap.raised_code'), message = 'pgtap 889';
end;
$function$;
select app_private.set_fact_registry_scheduled_reprojection(true);

select set_config('pgtap.raised_code', '22023', true);
select results_eq(
  $$select (raised.report #>> '{checks,projection_drift,count}')::integer
             = (raised.report ->> 'candidate_sales')::integer,
           raised.report #>> '{simulation_failures,0,sqlstate}'
      from (select public.check_fact_registry_consistency(5000) as report) raised$$,
  $$values (true, '22023')$$,
  'an error of a sale (here a data error on every sale) is still kept per sale: the check goes on and returns its code'
);

select set_config('pgtap.raised_code', '42501', true);
select throws_ok(
  $$select public.check_fact_registry_consistency(5000)$$,
  '42501', 'pgtap 889',
  'a systemic error (here a missing privilege) is not swallowed sale by sale: the daily check raises it'
);
select throws_ok(
  $$select public.reproject_fact_registry_drift()$$,
  '42501', 'pgtap 889',
  'nor by the scheduled reprojection, which stops and writes nothing'
);
select set_config('pgtap.raised_code', 'XX000', true);
select throws_ok(
  $$select public.sync_fact_registry_alerts()$$,
  'XX000', 'pgtap 889',
  'and the job function raises an internal error instead of reporting the whole registry as drifting'
);

select * from finish();
rollback;
