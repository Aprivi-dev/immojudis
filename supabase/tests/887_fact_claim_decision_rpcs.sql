-- 20261118100100 : fonctions de décision du registre des pièces (lot R2b, étape B1), retouchées et ouvertes par le
-- lot R2c (20261119100100, 20261119100400).
--   * droits : les quatre fonctions publiques sont exécutables par authenticated SEUL (ni anon, ni PUBLIC, ni
--     service_role) ; la fonction de décision et les fonctions internes par aucun rôle de l'API ;
--   * l'auteur est celui du jeton (auth.uid()), aucun paramètre ne le fournit ; public.is_admin() en tête : un
--     utilisateur connecté qui n'est pas administrateur est refusé (admin_required) ;
--   * second facteur du registre : mécanisme gardé, ligne absente = exigé, changé par le propriétaire seulement ;
--     état livré par le lot R2c : levé ;
--   * sans déclencheur du registre en place, rien n'est écrit (registry_unavailable) ;
--   * plafonds de décisions par administrateur (rate_limited, final_rate_limited) : mécanisme gardé, ligne absente
--     = appliqués ; état livré par le lot R2c : non appliqués ; levés, ni compte ni verrou d'auteur ;
--   * une autre décision du même administrateur en cours : decision_in_progress, et non sale_busy ;
--   * chaque transition admise et refusée ; opposition et retrait de l'autorisation définitifs ; provenance reprise
--     d'une décision à la suivante, sauf autour d'un retrait de l'autorisation ;
--   * refus propres à l'acceptation : l'origine est jugée par la table de préséance, le terrain par la fonction
--     commune (type de bien, portée, nature de la surface) ; motifs et rattachements jugés par les contraintes de
--     la table ; lot_ref normalisé, NULL hors motif ;
--   * retrait : la valeur de l'annonce revient ;
--   * une décision reprojette toute la vente (nombre de chambres corrigé, reclassement en terrain) ;
--   * observation détachée par une fusion : décidée pour la vente absorbée, projetée sur la vente conservée ;
--   * une erreur inattendue devient registry_write_failed, sans détail ni indice ;
--   * le délai de verrou de 3 secondes est un réglage des fonctions, rendu à l'appelant à la sortie ;
--   * public.review_auction_fact_claim : vente verrouillée d'abord, colonnes nommées, observation d'origine
--     réservée ou déjà décidée au journal refusée, vente disparue refusée ;
--   * aucune autre fonction de la base n'écrit une décision, ne pose un jeton, ni n'enveloppe ces fonctions.
-- Les cas à deux sessions (sale_busy, délai de 3 secondes) sont décrits au runbook R2b.
-- En local, auth.jwt() du script d'amorçage rend {} : les assertions « aal2 » demandent la définition de Supabase
-- (docs/runbooks/registre-des-pieces-r2b.md, « Échecs locaux connus »).
begin;

set local timezone = 'UTC';

select plan(127);

-- Droits ----------------------------------------------------------------------------------------------------------
-- Lot R2c : la seule ouverture est authenticated sur les quatre fonctions publiques. « public » est le droit
-- donné à tout le monde.
select results_eq(
  $$select routine.signature, api_role.name
      from unnest(array['public', 'anon', 'authenticated', 'service_role']) api_role(name)
      cross join unnest(array[
        'public.accept_auction_fact_claim(uuid, text, text, uuid)',
        'public.reject_auction_fact_claim(uuid, text)',
        'public.withdraw_auction_fact_claim(uuid, text)',
        'public.oppose_auction_fact_claim(uuid, text)',
        'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)',
        'app_private.lock_sale_for_registry(uuid)',
        'app_private.set_fact_registry_decisions_second_factor(boolean)',
        'app_private.set_fact_registry_decision_rate_limits(boolean)',
        'app_private.fact_registry_hourly_decision_limit()',
        'app_private.fact_registry_daily_final_decision_limit()',
        'app_private.fact_registry_decisions_second_factor_required()',
        'app_private.fact_registry_decision_rate_limits_enabled()',
        'app_private.fact_lot_attachment_holds(text)',
        'app_private.fact_registry_kept_sale(uuid)',
        'app_private.fact_decision_is_final(text, text)',
        'app_private.sale_is_land_sale(text, text, text, jsonb)']) routine(signature)
      where has_function_privilege(api_role.name, routine.signature, 'EXECUTE')
      order by routine.signature collate "C", api_role.name collate "C"$$,
  $$values ('public.accept_auction_fact_claim(uuid, text, text, uuid)', 'authenticated'),
           ('public.oppose_auction_fact_claim(uuid, text)', 'authenticated'),
           ('public.reject_auction_fact_claim(uuid, text)', 'authenticated'),
           ('public.withdraw_auction_fact_claim(uuid, text)', 'authenticated')$$,
  'authenticated alone executes the four public decision functions: neither anon, nor PUBLIC, nor service_role; no API role executes the decision function or an internal function'
);
-- Les droits écrits au catalogue : le propriétaire, et authenticated sans droit de le redonner.
select results_eq(
  $$select (routine.proname::text) collate "default",
           (select array_agg(granted.grantee::regrole::text || ':' || granted.privilege_type
                             || case when granted.is_grantable then ':grantable' else '' end
                             order by granted.grantee::regrole::text collate "C")
              from aclexplode(routine.proacl) granted
              where granted.grantee <> routine.proowner)
      from pg_proc routine
      where routine.pronamespace = 'public'::regnamespace
        and routine.proname in ('accept_auction_fact_claim', 'reject_auction_fact_claim',
                                'withdraw_auction_fact_claim', 'oppose_auction_fact_claim')
      order by routine.proname::text collate "C"$$,
  $$values ('accept_auction_fact_claim', array['authenticated:EXECUTE']),
           ('oppose_auction_fact_claim', array['authenticated:EXECUTE']),
           ('reject_auction_fact_claim', array['authenticated:EXECUTE']),
           ('withdraw_auction_fact_claim', array['authenticated:EXECUTE'])$$,
  'beside their owner, the catalogue grants these four functions to authenticated only, without grant option'
);

select ok(
  (select bool_and(routine.prosecdef and routine.proconfig @> array['search_path=""'])
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

-- Le délai de verrou est un réglage de chaque fonction qui verrouille : PostgreSQL le pose à l'entrée et rend la
-- valeur de l'appelant à la sortie.
select is(
  (select count(*)::integer from pg_proc routine
     where routine.oid in (
       'app_private.lock_sale_for_registry(uuid)'::regprocedure,
       'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure,
       'public.review_auction_fact_claim(uuid, uuid, text, text)'::regprocedure)
       and routine.proconfig @> array['lock_timeout=3s']),
  3,
  'the sale lock, the decision function and the review function each run under a lock timeout of 3 seconds'
);

-- État livré par le lot R2c (décisions du propriétaire du 12/11/2026).
select results_eq(
  $$select switch_name, enabled from app_private.fact_registry_switches order by switch_name collate "C"$$,
  $$values ('decision_rate_limits_enabled', false), ('decisions_require_second_factor', false),
           ('scheduled_reprojection', false)$$,
  'the three switches as delivered: the ceilings are not applied, the second factor is not required, the scheduled reprojection is closed'
);

select is(app_private.fact_registry_hourly_decision_limit(), 20, 'the hourly ceiling is twenty decisions');
select is(
  app_private.fact_registry_daily_final_decision_limit(), 5,
  'the ceiling of final decisions (opposition, withdrawn authorization) is five per 24 hours'
);

-- Une autre décision du même administrateur en cours : le verrou d'auteur a son propre bloc et son propre code. Le
-- cas à deux sessions est décrit au runbook R2c.
select ok(
  (select prosrc ~ 'exception when lock_not_available then\s+v_refusal := ''decision_in_progress'';'
          and prosrc ~ 'when v_refusal = ''decision_in_progress'' then ''55P03'''
          and prosrc ~ 'v_counted_at := pg_catalog.clock_timestamp\(\);'
          and prosrc !~ 'decided_at > pg_catalog.clock_timestamp'
     from pg_proc
     where oid = 'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure),
  'a wait on the author lock gives decision_in_progress (55P03), not sale_busy, and the ceilings are counted from a time read once, after the lock'
);

-- Les plafonds sont exacts : un verrou consultatif par auteur est pris avant le compte, que sert un index.
select ok(
  (select position('pg_catalog.pg_advisory_xact_lock(' in prosrc) > 0
          and position('pg_catalog.pg_advisory_xact_lock(' in prosrc)
              < position('where decision.actor_id = v_actor' in prosrc)
     from pg_proc
     where oid = 'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure)
  and pg_get_indexdef('public.auction_fact_claim_decisions_actor_decided_idx'::regclass)
      ~ 'USING btree \(actor_id, decided_at DESC\)$',
  'the decision function takes an advisory lock before it counts the decisions of the author, and the journal has an index on author and date'
);

-- Le verrou de la vente laisse passer les insertions d'observations : jamais FOR UPDATE.
select ok(
  (select prosrc ~* 'for\s+no\s+key\s+update' and prosrc !~* 'for\s+(update|share|key\s+share)'
     from pg_proc where oid = 'app_private.lock_sale_for_registry(uuid)'::regprocedure),
  'the sale lock is FOR NO KEY UPDATE only: an import that inserts a claim of the sale (foreign key, FOR KEY SHARE) is never blocked by a decision'
);

-- Jeu d'essai -----------------------------------------------------------------------------------------------------
-- (Les deux plafonds sont relevés pour le fichier : ils sont essayés à part, plus bas.)
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 1000 $function$;
create or replace function app_private.fact_registry_daily_final_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 1000 $function$;

insert into auth.users (id) values
  ('88700000-0000-4000-8000-0000000000a1'), ('88700000-0000-4000-8000-0000000000b1'),
  ('88700000-0000-4000-8000-0000000000c1'), ('88700000-0000-4000-8000-0000000000d1');
insert into public.user_profiles (user_id, email, user_role) values
  ('88700000-0000-4000-8000-0000000000a1', 'registre-admin-887@example.test', 'admin'),
  ('88700000-0000-4000-8000-0000000000c1', 'registre-admin-bis-887@example.test', 'admin'),
  ('88700000-0000-4000-8000-0000000000d1', 'registre-admin-ter-887@example.test', 'admin'),
  ('88700000-0000-4000-8000-0000000000b1', 'registre-membre-887@example.test', 'user')
on conflict (user_id) do update set user_role = excluded.user_role;

-- Ventes 1 à 9 : maison, 50 m², 2 pièces, 1 chambre, occupée. Vente 3 : un terrain (type de bien). Vente 4 : 7
-- pièces, 6 chambres. Vente 6 : nature de la surface « terrain ». Vente 8 : portée de la surface « terrain ».
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, surface_scope,
  rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88700000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/887/sale-' || n,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville',
  case when n = 3 then 'land' else 'house' end, 90000, '{}'::jsonb,
  '{}'::jsonb, 'tribunal', 50, 50, case when n = 6 then 'land' else 'habitable' end, 'listing_text', 0.7,
  case when n = 8 then 'land' end,
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
    ('62', '6', 'property.surface_m2', '54'::jsonb),
    ('71', '7', 'property.rooms_count', '6'::jsonb),
    ('72', '7', 'property.occupancy_status', '"vacant"'::jsonb),
    ('73', '7', 'property.surface_m2', '54'::jsonb),
    ('2a', '2', 'property.rooms_count', '4'::jsonb),
    ('2b', '2', 'property.land_surface_m2', '500'::jsonb),
    ('2c', '2', 'property.occupancy_status', '"vacant"'::jsonb),
    ('2d', '2', 'property.surface_m2', '60'::jsonb),
    ('2e', '2', 'property.rooms_count', '8'::jsonb),
    ('2f', '2', 'property.land_surface_m2', '510'::jsonb),
    ('26', '2', 'property.surface_m2', '62'::jsonb),
    ('27', '2', 'property.rooms_count', '9'::jsonb),
    ('20', '8', 'property.land_surface_m2', '420'::jsonb),
    ('23', '8', 'property.land_surface_m2', '430'::jsonb),
    ('28', '8', 'property.land_surface_m2', '440'::jsonb),
    ('29', '8', 'property.land_surface_m2', '450'::jsonb),
    ('81', '8', 'property.surface_m2', '54'::jsonb),
    ('91', '9', 'property.rooms_count', '5'::jsonb),
    ('92', '9', 'property.land_surface_m2', '410'::jsonb),
    ('93', '9', 'property.occupancy_status', '"vacant"'::jsonb),
    ('94', '9', 'property.surface_m2', '57'::jsonb)
) as piece (suffix, sale, field_key, value);

-- Vente 2 : une observation de document et une observation d'annonce. Vente 9 : une saisie d'administrateur.
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
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, confidence_score,
  extractor_name, extractor_version, created_by
) values (
  '88700000-2000-4000-8000-000000000095', '88700000-1000-4000-8000-000000000009', 'property.rooms_count',
  '3'::jsonb, 'admin_entry', '{}'::jsonb, 0.9, 'admin', 'v1', '88700000-0000-4000-8000-0000000000a1'
);

create function pg_temp.sign_in(p_user text, p_aal text default 'aal2') returns void
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

-- Une décision ancienne du second administrateur (c1), pour essayer les fenêtres des plafonds : la date d'une
-- décision est imposée par le déclencheur de validation, suspendu le temps de cette seule écriture.
create function pg_temp.old_decision(p_suffix text, p_decision text, p_age interval) returns void
language plpgsql as $function$
begin
  alter table public.auction_fact_claim_decisions disable trigger auction_fact_claim_decisions_validate;
  insert into public.auction_fact_claim_decisions (
    claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code, seq, decided_at
  )
  select claim.id, claim.auction_sale_id, claim.field_key, p_decision, 'unknown', 'admin',
    '88700000-0000-4000-8000-0000000000c1',
    case p_decision when 'opposed' then 'professional_opposition' else 'other' end,
    nextval('app_private.fact_registry_seq'), clock_timestamp() - p_age
  from public.auction_fact_claims claim where claim.id = pg_temp.claim(p_suffix);
  alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_validate;
end;
$function$;

create temporary table results (label text primary key, result jsonb) on commit drop;

-- Le lot R2c livre le second facteur levé et les plafonds non appliqués. Ce fichier essaie les deux mécanismes : il
-- les remet d'abord en service, comme le ferait le propriétaire ; l'état livré est essayé en fin de fichier.
select app_private.set_fact_registry_decisions_second_factor(true);
select app_private.set_fact_registry_decision_rate_limits(true);

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

-- Second facteur du registre : exigé par défaut, quel que soit l'interrupteur global.
select pg_temp.sign_in('a1', 'aal1');
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '42501', 'second_factor_required',
  'by default an administrator signed in at aal1 decides nothing, even with the global second-factor switch off'
);
select throws_ok(
  $$select public.oppose_auction_fact_claim(pg_temp.claim('11'))$$,
  '42501', 'second_factor_required', 'nor does he record an opposition'
);
select set_config(
  'request.jwt.claims', '{"sub":"88700000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '42501', 'second_factor_required', 'a token without an aal claim is treated as aal1'
);
select pg_temp.sign_in('a1', 'aal2');
select lives_ok(
  $$insert into results select 'mfa', public.reject_auction_fact_claim(pg_temp.claim('91'), 'other')$$,
  'at aal2 the same administrator decides'
);

-- Seul le propriétaire lève l'exigence, par la fonction de réglage.
set local role service_role;
select throws_ok(
  $$select app_private.set_fact_registry_decisions_second_factor(false)$$,
  '42501', null, 'an API role cannot lift the second-factor requirement'
);
reset role;
select app_private.set_fact_registry_decisions_second_factor(false);
select pg_temp.sign_in('a1', 'aal1');
select lives_ok(
  $$insert into results select 'aal1 lifted', public.oppose_auction_fact_claim(pg_temp.claim('44'), 'other')$$,
  'once the owner has lifted the requirement, an administrator at aal1 decides'
);
-- L'interrupteur global reste lu par public.is_admin(), indépendamment.
update app_private.security_switches set enabled = true where switch_name = 'admin_mfa_required';
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '42501', 'admin_required',
  'the global second-factor switch is still read by is_admin(): on, an administrator at aal1 is not one'
);
update app_private.security_switches set enabled = false where switch_name = 'admin_mfa_required';
-- Ligne absente : exigé. La fonction de réglage lève au lieu de ne rien faire.
delete from app_private.fact_registry_switches where switch_name = 'decisions_require_second_factor';
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot')$$,
  '42501', 'second_factor_required', 'a missing switch row means required'
);
select throws_ok(
  $$select app_private.set_fact_registry_decisions_second_factor(false)$$,
  '55000', 'The switch decisions_require_second_factor has no row: restore it by a migration.',
  'the setter raises when its row is missing instead of doing nothing'
);
insert into app_private.fact_registry_switches (switch_name, enabled)
values ('decisions_require_second_factor', true);
select pg_temp.sign_in('a1');

set local role service_role;
select throws_ok(
  $$select public.accept_auction_fact_claim('88700000-2000-4000-8000-000000000011', 'single_lot')$$,
  '42501', 'permission denied for function accept_auction_fact_claim',
  'the server role has no author: it cannot execute a decision function'
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
-- Le délai de verrou de l'appelant lui est rendu.
set local lock_timeout = '7s';
insert into results select 'accept 11', public.accept_auction_fact_claim(pg_temp.claim('11'), 'single_lot');
select is(
  current_setting('lock_timeout'), '7s',
  'after a decision the caller finds its own lock timeout again'
);
select ok(
  app_private.lock_sale_for_registry(pg_temp.sale('1')) and current_setting('lock_timeout') = '7s'
  and not app_private.lock_sale_for_registry('88700000-1000-4000-8000-0000000000ff'),
  'the sale lock returns true for a sale, false for a missing one, and gives the caller its lock timeout back'
);
set local lock_timeout = '5s';

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
select is(
  (select decision from public.auction_fact_claim_decisions where id = pg_temp.last_decision('44')),
  'opposed',
  'a claim never decided can be opposed (done above, at aal1 once the requirement was lifted)'
);

-- Autorisation d'affichage retirée : définitif aussi --------------------------------------------------------------------
insert into results select 'accept 92', public.accept_auction_fact_claim(pg_temp.claim('92'), 'single_lot');
insert into results
select 'withdraw 92', public.withdraw_auction_fact_claim(pg_temp.claim('92'), 'authorization_withdrawn');
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('92'), 'single_lot', null, pg_temp.last_decision('92'))$$,
  '55000', 'withdrawal_final',
  'after a withdrawal for a withdrawn authorization the claim is never accepted again'
);
select results_eq(
  $$select sale.land_surface_m2, sale.held_fields #> '{property.land_surface_m2,echo}'
      from public.auction_sales sale where sale.id = pg_temp.sale('9')$$,
  $$values (null::numeric, '[{"value": 410}]'::jsonb)$$,
  'as in the projection, which remembers its value without a deadline'
);

-- Provenance : reprise d'une décision à la suivante, sauf autour d'un retrait de l'autorisation ------------------------
-- La première décision est écrite comme le fera le noyau de l'agent d'information (lot R2c), avec sa provenance.
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, information_agent_fact_id,
  recipient_kind, received_at
) values (
  pg_temp.claim('93'), pg_temp.sale('9'), 'property.occupancy_status', 'accepted', 'unknown', 'admin',
  '88700000-0000-4000-8000-0000000000a1', '88700000-5000-4000-8000-000000000093', 'source_lawyer',
  '2026-11-02 09:00:00+00'
);
insert into results
select 'accept 93', public.accept_auction_fact_claim(pg_temp.claim('93'), 'single_lot', null,
  pg_temp.last_decision('93'));
select results_eq(
  $$select decision.information_agent_fact_id, decision.recipient_kind, decision.received_at,
           sale.held_fields #>> '{property.occupancy_status,recipient_kind}',
           sale.held_fields #>> '{property.occupancy_status,received_on}'
      from public.auction_fact_claim_decisions decision, public.auction_sales sale
      where decision.id = pg_temp.last_decision('93') and sale.id = pg_temp.sale('9')$$,
  $$values ('88700000-5000-4000-8000-000000000093'::uuid, 'source_lawyer',
            '2026-11-02 09:00:00+00'::timestamptz, 'source_lawyer', '2026-11-02')$$,
  'a correction of the lot carries the provenance of the decision it replaces: the fact of the agent, the recipient, the reception date'
);
insert into results
select 'withdraw 93', public.withdraw_auction_fact_claim(pg_temp.claim('93'), 'authorization_withdrawn');
insert into results select 'oppose 93', public.oppose_auction_fact_claim(pg_temp.claim('93'));
select results_eq(
  $$select decision.decision, decision.information_agent_fact_id, decision.recipient_kind, decision.received_at
      from public.auction_fact_claim_decisions decision
      where decision.claim_id = pg_temp.claim('93') order by decision.seq desc limit 2$$,
  $$values ('opposed', null::uuid, null::text, null::timestamptz),
           ('withdrawn', null::uuid, null::text, null::timestamptz)$$,
  'once the authorization is withdrawn the provenance is never carried again: neither by the withdrawal nor by what follows it'
);

-- Plafond horaire --------------------------------------------------------------------------------------------------------
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql stable set search_path = '' as $function$
  select count(*)::integer from public.auction_fact_claim_decisions
  where actor_id = '88700000-0000-4000-8000-0000000000a1'
$function$;
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('94'), 'single_lot')$$,
  '53400', 'rate_limited',
  'an administrator who has reached the hourly ceiling decides nothing more'
);
-- Le compte est celui de l'auteur : un second administrateur, qui n'a rien décidé, passe sous le même plafond. Son
-- verrou consultatif n'est pas encore pris ; celui du premier l'est depuis sa première décision.
select results_eq(
  $$select actor.label, exists (
             select 1 from pg_locks held
             where held.locktype = 'advisory' and held.pid = pg_backend_pid() and held.objsubid = 1
               and ((held.classid::bigint << 32) | held.objid::bigint)
                 = hashtextextended('immojudis:fact_registry_decisions:88700000-0000-4000-8000-0000000000'
                     || actor.label, 0))
      from (values ('a1'), ('c1')) actor(label) order by actor.label collate "C"$$,
  $$values ('a1', true), ('c1', false)$$,
  'the advisory lock of the ceilings is taken per author, and held until the end of the transaction'
);
select pg_temp.sign_in('c1');
select lives_ok(
  $$insert into results select 'c1 reject 2a', public.reject_auction_fact_claim(pg_temp.claim('2a'), 'other')$$,
  'the ceiling is counted per author: another administrator still decides'
);
select pg_temp.sign_in('a1');
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql stable set search_path = '' as $function$
  select count(*)::integer + 1 from public.auction_fact_claim_decisions
  where actor_id = '88700000-0000-4000-8000-0000000000a1'
$function$;
select lives_ok(
  $$insert into results select 'accept 94', public.accept_auction_fact_claim(pg_temp.claim('94'), 'single_lot')$$,
  'one decision under the ceiling still passes'
);
-- La fenêtre est d'une heure. Second administrateur : une décision à l'instant (2a), une vieille de 61 minutes.
select pg_temp.old_decision('2b', 'rejected', interval '61 minutes');
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 2 $function$;
select pg_temp.sign_in('c1');
select lives_ok(
  $$insert into results select 'c1 reject 2c', public.reject_auction_fact_claim(pg_temp.claim('2c'), 'other')$$,
  'a decision older than one hour no longer counts: one recent decision under a ceiling of two'
);
-- Deux décisions récentes, plus une de 59 minutes : trois, pour un plafond de trois.
select pg_temp.old_decision('2d', 'rejected', interval '59 minutes');
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 3 $function$;
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('2e'), 'other')$$,
  '53400', 'rate_limited',
  'while a decision of 59 minutes ago still counts'
);
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 1000 $function$;

-- Plafond des décisions définitives ---------------------------------------------------------------------------------------
-- Premier administrateur : au plafond (le plafond est remplacé par le compte de ses décisions définitives).
select pg_temp.sign_in('a1');
create or replace function app_private.fact_registry_daily_final_decision_limit()
returns integer language sql stable set search_path = '' as $function$
  select count(*)::integer from public.auction_fact_claim_decisions decision
  where decision.actor_id = '88700000-0000-4000-8000-0000000000a1'
    and (decision.decision = 'opposed' or decision.reason_code = 'authorization_withdrawn')
$function$;
select throws_ok(
  $$select public.oppose_auction_fact_claim(pg_temp.claim('2e'))$$,
  '53400', 'final_rate_limited',
  'an administrator who has reached the ceiling of final decisions opposes nothing more'
);
select throws_ok(
  $$select public.withdraw_auction_fact_claim(pg_temp.claim('94'), 'authorization_withdrawn')$$,
  '53400', 'final_rate_limited',
  'nor withdraws for a withdrawn authorization'
);
select lives_ok(
  $$insert into results select 'withdraw 94', public.withdraw_auction_fact_claim(pg_temp.claim('94'), 'entry_error')$$,
  'a decision that is not final still passes: this ceiling counts the final ones only'
);
-- Second administrateur : aucune décision définitive récente (une opposition vieille de 25 heures, des rejets
-- récents). Sous un plafond de un, sa première opposition passe.
select pg_temp.old_decision('2f', 'opposed', interval '25 hours');
create or replace function app_private.fact_registry_daily_final_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 1 $function$;
select pg_temp.sign_in('c1');
select lives_ok(
  $$insert into results select 'c1 oppose 2e', public.oppose_auction_fact_claim(pg_temp.claim('2e'))$$,
  'the ceiling of final decisions is counted per author, over 24 hours, and on final decisions only'
);
-- Une opposition récente, plus une de 23 heures : deux, pour un plafond de deux.
select pg_temp.old_decision('26', 'opposed', interval '23 hours');
create or replace function app_private.fact_registry_daily_final_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 2 $function$;
select throws_ok(
  $$select public.oppose_auction_fact_claim(pg_temp.claim('27'))$$,
  '53400', 'final_rate_limited',
  'while a final decision of 23 hours ago still counts'
);
create or replace function app_private.fact_registry_daily_final_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 1000 $function$;
select pg_temp.sign_in('a1');

-- Refus propres à l'acceptation ---------------------------------------------------------------------------------------
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('21'), 'single_lot')$$,
  '55000', 'origin_cannot_hold', 'a document claim is not accepted: the precedence table closes this origin before lot R3'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('22'), 'single_lot')$$,
  '55000', 'origin_cannot_hold', 'a listing claim never holds a field'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('31'), 'single_lot')$$,
  '55000', 'field_not_applicable', 'a built surface is not accepted on a land sale (property type)'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('62'), 'single_lot')$$,
  '55000', 'field_not_applicable', 'nor on a sale whose surface kind is land'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('81'), 'single_lot')$$,
  '55000', 'field_not_applicable', 'nor on a sale whose surface scope is land'
);
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('13'), 'single_lot')$$,
  '22023', 'invalid_argument', 'a value the registry cannot hold (who occupies) is not accepted'
);
select lives_ok(
  $$insert into results select 'reject 21', public.reject_auction_fact_claim(pg_temp.claim('21'), 'already_known')$$,
  'a document claim can be rejected'
);

-- La table de préséance juge, pas la fonction, et champ par champ : rouverte pour un autre champ, l'origine reste
-- fermée pour celui-ci ; rouverte pour ce champ (comme le fera le lot R3), elle passe.
update public.auction_fact_source_precedence set can_hold = true
where source_kind = 'document' and field_key = 'property.land_surface_m2';
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('21'), 'single_lot', null, pg_temp.last_decision('21'))$$,
  '55000', 'origin_cannot_hold', 'an origin opened for another field stays closed for this one'
);
update public.auction_fact_source_precedence set can_hold = false
where source_kind = 'document' and field_key = 'property.land_surface_m2';
update public.auction_fact_source_precedence set can_hold = true
where source_kind = 'document' and field_key = 'property.rooms_count';
select results_eq(
  $$select result ->> 'state'
      from (select public.accept_auction_fact_claim(pg_temp.claim('21'), 'single_lot', null,
              pg_temp.last_decision('21')) as result) accepted$$,
  $$values ('held')$$,
  'once the precedence table opens the document origin for the field, the same claim is accepted: the function names no origin'
);
update public.auction_fact_source_precedence set can_hold = false
where source_kind = 'document' and field_key = 'property.rooms_count';

-- Vente de terrain : une seule définition, celle que lisent la décision, la projection et le contrôle.
select results_eq(
  $$select app_private.sale_is_land_sale('house', null, 'habitable', null),
           app_private.sale_is_land_sale('land', null, 'habitable', null),
           app_private.sale_is_land_sale('house', 'land', null, null),
           app_private.sale_is_land_sale('house', null, 'land', null),
           app_private.sale_is_land_sale('house', null, 'built',
             '{"property.surface_m2": {"state": "held", "listing": {"app_surface_kind": "land"}}}'::jsonb),
           app_private.sale_is_land_sale('house', null, 'land',
             '{"property.surface_m2": {"state": "held", "listing": {"app_surface_kind": "habitable"}}}'::jsonb),
           app_private.sale_is_land_sale('house', null, 'land',
             '{"property.surface_m2": {"state": "released"}}'::jsonb),
           app_private.sale_is_land_sale('house', null, 'built',
             '{"property.surface_m2": {"state": "conflicted", "listing": {"app_surface_kind": "land"}}}'::jsonb),
           app_private.sale_is_land_sale(null, null, null, null)$$,
  $$values (false, true, true, true, true, false, true, true, false)$$,
  'a land sale: property type, surface scope or surface kind says land; for a held surface, conflicted or not, the kind read is the one of the listing, kept in the entry'
);
-- La projection lit la même définition : une acceptation écrite au journal sans passer par la fonction de décision
-- (vente 6, nature « terrain » ; vente 8, portée « terrain ») est bloquée, pas posée.
insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
)
select claim.id, claim.auction_sale_id, claim.field_key, 'accepted', 'single_lot', 'admin',
  '88700000-0000-4000-8000-0000000000a1'
from public.auction_fact_claims claim
where claim.id in (pg_temp.claim('62'), pg_temp.claim('81'));
select results_eq(
  $$select app_private.project_sale_fields(sale.id, null, false) #>> '{fields,property.surface_m2,state}',
           app_private.project_sale_fields(sale.id, null, false)
             #>> '{fields,property.surface_m2,blocked,reason}'
      from public.auction_sales sale where sale.id in (pg_temp.sale('6'), pg_temp.sale('8'))$$,
  $$values ('blocked', 'land_sale'), ('blocked', 'land_sale')$$,
  'the projection reads the same definition as the decision: a surface accepted on such a sale is blocked, not held'
);

-- Champ que le registre ne tient pas : la décision est enregistrée, rien n'est affiché.
insert into results select 'accept 14', public.accept_auction_fact_claim(pg_temp.claim('14'), 'single_lot');
select results_eq(
  $$select result -> 'state', result ->> 'field_key',
           (select starting_price_eur from public.auction_sales where id = pg_temp.sale('1'))
      from results where label = 'accept 14'$$,
  $$values ('null'::jsonb, 'sale.starting_price_eur', 90000::numeric)$$,
  'an acceptance on a field the registry does not hold is recorded and changes no column (plan, section 10: recorded, not displayed)'
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
insert into results select 'reject 73', public.reject_auction_fact_claim(pg_temp.claim('73'), 'other');
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

-- Le terrain se juge sur la vente conservée (vente 8, portée « terrain »), pas sur la vente absorbée (une maison).
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('73'), 'single_lot', null, pg_temp.last_decision('73'))$$,
  '55000', 'field_not_applicable',
  'after a merge the land rule is judged on the kept sale: a built surface decided on the absorbed house is not accepted on the land sale that kept it'
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
      or actor_id not in ('88700000-0000-4000-8000-0000000000a1', '88700000-0000-4000-8000-0000000000c1'))),
  'the automatic publication locks are in place, and every decision written here is a manual one of a signed-in administrator'
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
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('21'), 'rejected', 'pgtap 887')$$,
  '55000', 'A fact claim already decided in the fact registry cannot be reviewed here.',
  'the review of source claims refuses a claim that the registry journal has already decided'
);
select throws_ok(
  $$select public.review_auction_fact_claim(
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('72'), 'rejected', 'pgtap 887')$$,
  '55000', 'A claim without a current sale target cannot be reviewed.',
  'and a claim that a merge has detached'
);
select throws_ok(
  $$select public.review_auction_fact_claim(
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('81'), 'rejected', 'pgtap 887')$$,
  '55000', 'A professional or administrator fact claim is decided through the fact registry.',
  'a professional claim, even never decided'
);
select throws_ok(
  $$select public.review_auction_fact_claim(
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('95'), 'rejected', 'pgtap 887')$$,
  '55000', 'A professional or administrator fact claim is decided through the fact registry.',
  'and an administrator entry'
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
          and prosrc !~ '''(document|listing|lawyer_email|lawyer_form|admin_entry)'''
     from pg_proc
     where oid = 'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure),
  'the decision function copies neither the lot format, nor the reason lists, nor a list of origins: the constraints and the data of the tables judge'
);

-- Erreurs : jamais le détail ni l'indice de PostgreSQL ------------------------------------------------------------------
select ok(
  (select prosrc !~* 'pg_exception_detail|pg_exception_hint|pg_exception_context|message_text|detail\s*=|hint\s*='
          and prosrc ~ 'raise log ''fact registry decision failed: sqlstate %, constraint %'''
     from pg_proc
     where oid = 'app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)'::regprocedure),
  'the decision function reads only the SQLSTATE and the constraint name of an error, logs these two, and relays no detail'
);

-- Aucune autre fonction du dépôt n'écrit une décision, ne pose un jeton, ni n'enveloppe ces fonctions -----------------
-- (double des invariants de sécurité, lu dans le catalogue.) La définition entière de chaque fonction et procédure
-- est lue (pg_get_functiondef : corps « begin atomic » et réglages compris), pas la seule colonne prosrc.
-- Portée : les schémas que les migrations du dépôt créent ou remplissent (public, app_private, licitor_ingestion).
-- LIMITE : les fonctions de la plateforme (auth, realtime, storage, extensions, pgTAP…) ne sont pas lues ici. L'une
-- d'elles pose le jeton par nature (Realtime rejoue les politiques au nom de l'abonné). Une migration du dépôt ne
-- peut pas en créer ni en modifier une sans être lue par l'invariant de texte registry-rpc-actor-from-jwt, qui juge
-- le fichier entier quel que soit le schéma visé.
-- Chaque assertion nomme les fonctions fautives (schéma et nom), pas seulement leur nombre.
select results_eq(
  $$select (namespace.nspname::text || '.' || routine.proname::text) collate "default"
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname in ('public', 'app_private', 'licitor_ingestion')
        and routine.prokind in ('f', 'p')
        and pg_get_functiondef(routine.oid)
          ~* '(insert\s+into|merge\s+into|copy)\s+(only\s+)?("?public"?\.)?"?auction_fact_claim_decisions'
      order by (namespace.nspname::text || '.' || routine.proname::text) collate "C"$$,
  $$values ('app_private.decide_auction_fact_claim')$$,
  'one routine only writes into the decision journal (insert, merge or copy): the decision function'
);
select is_empty(
  $$select (namespace.nspname::text || '.' || routine.proname::text) collate "default"
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname in ('public', 'app_private', 'licitor_ingestion')
        and routine.prokind in ('f', 'p')
        and (pg_get_functiondef(routine.oid) ~* 'set_config\s*\(\s*''request\.jwt'
             or pg_get_functiondef(routine.oid) ~* 'set\s+(local\s+)?"?request\.jwt'
             or exists (select 1 from unnest(routine.proconfig) setting where setting ~* '^request\.jwt'))
      order by (namespace.nspname::text || '.' || routine.proname::text) collate "C"$$,
  'no function of the repository schemas sets the token of the request (request.jwt.claim…): the author cannot be forged from SQL'
);
select is_empty(
  $$select role_setting.setrole::regrole::text, setting
      from pg_db_role_setting role_setting, unnest(role_setting.setconfig) setting
      where setting ~* '^request\.jwt'
      order by role_setting.setrole::regrole::text collate "C", setting collate "C"$$,
  'and no role carries a token setting'
);
select results_eq(
  $$select (namespace.nspname::text || '.' || routine.proname::text) collate "default"
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname in ('public', 'app_private', 'licitor_ingestion')
        and routine.prokind in ('f', 'p')
        and routine.proname <> 'decide_auction_fact_claim'
        and pg_get_functiondef(routine.oid) ~* 'decide_auction_fact_claim\s*\('
      order by (namespace.nspname::text || '.' || routine.proname::text) collate "C"$$,
  $$values ('public.accept_auction_fact_claim'), ('public.oppose_auction_fact_claim'),
           ('public.reject_auction_fact_claim'), ('public.withdraw_auction_fact_claim')$$,
  'the decision function is called by its four public functions only'
);
select is_empty(
  $$select (namespace.nspname::text || '.' || routine.proname::text) collate "default"
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname in ('public', 'app_private', 'licitor_ingestion')
        and routine.prokind in ('f', 'p')
        and routine.proname !~ '^(accept|reject|withdraw|oppose)_auction_fact_claim$'
        and pg_get_functiondef(routine.oid) ~* '(accept|reject|withdraw|oppose)_auction_fact_claim'
      order by (namespace.nspname::text || '.' || routine.proname::text) collate "C"$$,
  'and no function wraps one of the four'
);

-- Lot R2c : droits ouverts à authenticated seul --------------------------------------------------------------------
-- La fonction de décision juge le jeton, pas le rôle : sous le rôle authenticated, un utilisateur connecté qui
-- n'est pas administrateur est refusé, un administrateur décide.
select pg_temp.sign_in('b1');
set local role authenticated;
select throws_ok(
  $$select public.reject_auction_fact_claim('88700000-2000-4000-8000-000000000028', 'other')$$,
  '42501', 'admin_required',
  'under the authenticated role, a signed-in user who is not an administrator decides nothing'
);
reset role;
select pg_temp.sign_in('a1', 'aal1');
set local role authenticated;
select throws_ok(
  $$select public.reject_auction_fact_claim('88700000-2000-4000-8000-000000000028', 'other')$$,
  '42501', 'second_factor_required',
  'nor an administrator at aal1 while the owner requires the second factor'
);
reset role;
select pg_temp.sign_in('a1');
set local role authenticated;
select lives_ok(
  $$select public.reject_auction_fact_claim('88700000-2000-4000-8000-000000000028', 'other')$$,
  'under the authenticated role, an administrator decides'
);
select throws_ok(
  $$select app_private.decide_auction_fact_claim(
      '88700000-2000-4000-8000-000000000029', 'rejected', 'other', null, null, null)$$,
  '42501', 'permission denied for function decide_auction_fact_claim',
  'the decision function itself stays closed to authenticated: only the four public functions call it'
);
reset role;
select results_eq(
  $$select decision.decision, decision.actor_kind, decision.actor_id
      from public.auction_fact_claim_decisions decision where decision.claim_id = pg_temp.claim('28')$$,
  $$values ('rejected', 'admin', '88700000-0000-4000-8000-0000000000a1'::uuid)$$,
  'and the decision carries the author of the token'
);
set local role anon;
select throws_ok(
  $$select public.reject_auction_fact_claim('88700000-2000-4000-8000-000000000029', 'other')$$,
  '42501', 'permission denied for function reject_auction_fact_claim',
  'anon cannot execute a decision function'
);
reset role;
set local role service_role;
select throws_ok(
  $$select public.oppose_auction_fact_claim('88700000-2000-4000-8000-000000000029', 'other')$$,
  '42501', 'permission denied for function oppose_auction_fact_claim',
  'nor the server role'
);
reset role;
-- Le rôle de service n'a pas d'auteur : aurait-il le droit d'exécution qu'il serait refusé par la fonction (essayé
-- par le propriétaire, avec le jeton du rôle de service).
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.oppose_auction_fact_claim(pg_temp.claim('29'), 'other')$$,
  '42501', 'admin_required', 'and a token of the server role, which names no user, is refused: admin_required'
);

-- Lot R2c : plafonds levés par le propriétaire -------------------------------------------------------------------------
-- Troisième administrateur (d1), qui n'a encore rien décidé. Plafonds à zéro : appliqués, ils refusent tout.
select pg_temp.sign_in('d1');
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 0 $function$;
create or replace function app_private.fact_registry_daily_final_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 0 $function$;
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('29'), 'other')$$,
  '53400', 'rate_limited', 'while the ceilings are applied, an administrator at the hourly ceiling decides nothing'
);
set local role service_role;
select throws_ok(
  $$select app_private.set_fact_registry_decision_rate_limits(false)$$,
  '42501', null, 'an API role cannot lift the ceilings'
);
reset role;
select app_private.set_fact_registry_decision_rate_limits(false);
select lives_ok(
  $$insert into results select 'd1 reject 29', public.reject_auction_fact_claim(pg_temp.claim('29'), 'other')$$,
  'once the owner has lifted the ceilings, the hourly ceiling no longer applies'
);
select lives_ok(
  $$insert into results select 'd1 oppose 20', public.oppose_auction_fact_claim(pg_temp.claim('20'), 'other')$$,
  'nor the ceiling of final decisions'
);
select ok(
  not exists (
    select 1 from pg_locks held
    where held.locktype = 'advisory' and held.pid = pg_backend_pid() and held.objsubid = 1
      and ((held.classid::bigint << 32) | held.objid::bigint)
        = hashtextextended('immojudis:fact_registry_decisions:88700000-0000-4000-8000-0000000000d1', 0)),
  'and no author lock is taken: it only serves the count of the ceilings'
);
-- Ligne absente : plafonds appliqués. La fonction de réglage lève au lieu de ne rien faire.
delete from app_private.fact_registry_switches where switch_name = 'decision_rate_limits_enabled';
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('23'), 'other')$$,
  '53400', 'rate_limited', 'a missing switch row means that the ceilings are applied'
);
select throws_ok(
  $$select app_private.set_fact_registry_decision_rate_limits(false)$$,
  '55000', 'The switch decision_rate_limits_enabled has no row: restore it by a migration.',
  'the setter of the ceilings raises when its row is missing instead of doing nothing'
);
insert into app_private.fact_registry_switches (switch_name, enabled)
values ('decision_rate_limits_enabled', true);
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 1000 $function$;
create or replace function app_private.fact_registry_daily_final_decision_limit()
returns integer language sql immutable set search_path = '' as $function$ select 1000 $function$;
select pg_temp.sign_in('a1');

-- Verrous : course avec une fusion, vente disparue (en dernier : la fonction de verrou reste remplacée) ----------------
-- La vente est supprimée (l'observation détachée par sa clé étrangère) entre la lecture et le verrou : l'appelant réessaie.
create or replace function app_private.lock_sale_for_registry(p_sale_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $function$
begin
  delete from public.auction_sales where id = p_sale_id;
  return true;
end;
$function$;
select throws_ok(
  $$select public.accept_auction_fact_claim(pg_temp.claim('81'), 'single_lot')$$,
  '40001', 'retry',
  'a claim detached between the read and the lock (a merge in progress) is not decided: the caller tries again'
);

-- La vente a disparu entre la lecture et le verrou.
create or replace function app_private.lock_sale_for_registry(p_sale_id uuid)
returns boolean language sql volatile set search_path = '' as $function$ select false $function$;
select throws_ok(
  $$select public.review_auction_fact_claim(
      '88700000-0000-4000-8000-0000000000a1', pg_temp.claim('31'), 'rejected', 'pgtap 887')$$,
  '55000', 'The claim sale no longer exists.',
  'the review refuses a claim whose sale has disappeared'
);
select throws_ok(
  $$select public.reject_auction_fact_claim(pg_temp.claim('31'), 'other')$$,
  'P0002', 'sale_not_found',
  'and the decision function reports the missing sale'
);

select * from finish();
rollback;
