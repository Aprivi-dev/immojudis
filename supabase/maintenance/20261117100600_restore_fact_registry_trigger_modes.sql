-- MAINTENANCE MANUELLE. Ne pas placer ce fichier dans supabase/migrations.
--
-- Registre des pièces : remet les douze déclencheurs du registre en mode « always », puis le vérifie.
--
-- Quand l'utiliser : le contrôle quotidien ouvre l'alerte fact_registry.triggers_not_always, ou
-- app_private.assert_fact_registry_triggers() lève « registry_unavailable ». Cause connue : une instruction
-- « alter table … disable trigger user » suivie de « enable trigger user » (ou « enable trigger all ») sur une
-- des quatre tables, par un rattrapage ou à la main. Le second ordre remet TOUS les déclencheurs en mode
-- ordinaire : ceux du registre ne jouent plus en session_replication_role = replica, sans aucune erreur.
--
-- Ce que fait le fichier : « alter table … enable always trigger … » pour chaque déclencheur, nommé un à un, puis
-- l'appel du contrôle, qui fait échouer la transaction (rien n'est gardé) s'il manque un déclencheur ou si l'un
-- d'eux n'est plus lié à sa fonction : dans ce cas, le recréer par la définition de sa migration, jamais à la
-- main :
--   20261116100000  les trois déclencheurs de chacun des deux journaux (ajout seul, pas de TRUNCATE, validation
--                   des décisions, horodatage des évènements) ;
--   20261116100100  auction_fact_claims_no_truncate ;
--   20261117100100  auction_fact_claims_registry_origin_guard (clause WHEN étendue) ;
--   20261116100500  aaab_auction_sales_held_fields_insert_guard et aaab_auction_sales_held_fields_role_guard ;
--   20261117100200  aaab_auction_sales_hold_projected_fields et aaab_auction_sales_held_fields_marker_guard.
--
-- Verrous : SHARE ROW EXCLUSIVE bref sur public.auction_sales, public.auction_fact_claims et les deux journaux
-- (lectures possibles, écritures en attente quelques millisecondes). À LANCER HORS IMPORT ; lock_timeout (5 s)
-- fait échouer la transaction sans effet si un verrou n'est pas obtenu.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql
--
-- Idempotent : rejoué sur une base saine, il ne change rien.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- État avant (lecture seule).
select app_private.fact_registry_triggers_not_always() as declencheurs_hors_mode_avant;

alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_insert_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_marker_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_role_guard;
alter table public.auction_sales enable always trigger aaab_auction_sales_hold_projected_fields;
alter table public.auction_fact_claims enable always trigger auction_fact_claims_no_truncate;
alter table public.auction_fact_claims enable always trigger auction_fact_claims_registry_origin_guard;
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_append_only;
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_no_truncate;
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_validate;
alter table public.auction_sale_field_hold_events
  enable always trigger auction_sale_field_hold_events_append_only;
alter table public.auction_sale_field_hold_events
  enable always trigger auction_sale_field_hold_events_no_truncate;
alter table public.auction_sale_field_hold_events enable always trigger auction_sale_field_hold_events_stamp;

-- Échec fermé : la transaction n'est validée que si les douze déclencheurs sont en place.
select app_private.assert_fact_registry_triggers();

commit;

select app_private.fact_registry_triggers_not_always() as declencheurs_hors_mode_apres;
