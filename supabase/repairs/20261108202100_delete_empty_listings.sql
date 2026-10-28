-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai (supabase/README.md, regle 2). Procedure : supabase/repairs/README.md.
--
-- Annonces vides : suppression DEFINITIVE des annonces qui n'ont NI voie ou lieu-dit, NI adresse email de contact,
-- NI piece, NI autre source (decision du proprietaire du 28/10/2026 ; environ 380 ventes a venir, dont Vench 326 et
-- Petites Affiches 54, et 2 ventes passees au constat du 28/10 ; la regle d'email retire en plus celles qui n'ont
-- qu'un nom d'avocat ou un telephone : le comptage ci-dessous donne le nombre exact).
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus).
--
-- PREREQUIS, DANS CET ORDRE :
--   1. le code du pipeline avec la regle d'entree (services/data-pipeline/src/listing_minimum.py) est FUSIONNE ET
--      ACTIF (la collecte planifiee l'utilise). Sinon la collecte suivante recree les annonces supprimees ;
--   2. le BALAYAGE DE DEDOUBLONNAGE des annonces sans voie est passe AVANT cette reparation : rapport « candidates »
--      (services/data-pipeline/src/dedupe_streetless.py), relu, PUIS application. Une annonce Vench ou Petites Affiches
--      dont la vente jumelle (Licitor, Encheres immobilieres...) est deja en base se rattache a elle ; sans le balayage,
--      cette reparation la supprimerait alors qu'elle est rattachable (le rattachement lui donne « une autre source ») ;
--   3. la migration 20261108202000_listing_minimum_and_empty_listing_cleanup.sql est appliquee (elle ne
--      supprime rien : elle cree app_private.delete_empty_listings et la regle SQL) ;
--   4. hors collecte : aucun run « running » dans auction_runs (le fichier prend le verrou de publication et un verrou de
--      table sur auction_sales pendant la suppression).
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261108202100_delete_empty_listings.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : aucune ecriture, la transaction est en lecture seule. Affiche, en
--          NOTICE puis en tableau, le nombre d'annonces vides, de ventes gardees pour une trace utilisateur (par
--          table), de ventes ecartees par un lien bloquant (par table) et de ventes supprimables.
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261108202100_delete_empty_listings.sql
--       -> mode APPLICATION : supprime, par lots de 25 ventes, dans une seule transaction (tout ou rien pour le
--          fichier ; une vente que la base refuse est comptee et gardee, les autres continuent). Cinq appels de
--          1000 ventes au plus, chacun sous son propre statement_timeout de 10 minutes (un parametre change dans une
--          fonction ne rearme pas le delai de l'instruction qui l'appelle : le delai se pose donc par appel).
--
-- Ce que le fichier fait, et ne fait jamais :
--   - JAMAIS une vente qui a une trace utilisateur : favoris, deblocages, rapports, espaces de travail, analyses, suivis,
--     avis sur un signal, evenements de compte, demandes d'avocat, demandes de publication, dossiers de l'agent
--     d'information, rappels, demandes de rafraichissement, alias revus, fusions, ou toute table liee qui porte un
--     user_id, account_id ou owner_id. La liste des cles etrangeres vers auction_sales est lue dans la base au
--     lancement (pg_constraint), pas figee ici ;
--   - JAMAIS une vente qui a un prix d'adjudication ou une issue connue dans le graphe des issues (decision du 28/10/2026) ;
--     les ventes passees SANS resultat restent concernees ;
--   - le controle des traces et des liens bloquants est REFAIT pour chaque vente, juste avant sa suppression (une trace
--     posee depuis le calcul initial la fait garder : `kept_after_recheck` dans le compte rendu) ;
--   - user_alert_matches et user_alert_notifications partent en cascade avec la vente (accepte par le proprietaire :
--     alertes generees par le systeme) ;
--   - une cle etrangere NO ACTION / RESTRICT vers valuation_estimates ou auction_observations est videe d'abord
--     (comme la retention) ; vers toute autre table (faits sources, graphe des issues, revues IA, affectations de
--     juridiction...), la vente est ECARTEE et comptee par table : on ne vide pas des preuves ou des journaux
--     immuables pour supprimer une annonce vide ;
--   - le pont du graphe des issues (« annoncee, issue inconnue ») est complete avant chaque suppression, comme pour toute
--     vente purgee : le graphe garde cette trace, non exploitable pour les statistiques (issue inconnue, non eligible a l'apprentissage) ;
--   - aucune trace de retention : l'URL reste reimportable techniquement ; la regle d'entree du pipeline l'empeche.
--
-- Idempotente : une seconde application ne trouve plus rien a supprimer.
--
-- Retour arriere : IMPOSSIBLE par ce fichier (suppression definitive). Une sauvegarde de la base (ou un export des
-- lignes vises, `select * from public.auction_sales s where not app_private.sale_has_listing_minimum(s)`) avant
-- l'application permet de reinserer les lignes ; les alertes en cascade se regenerent au prochain calcul.
--
-- Controle apres application (lecture seule) : doit rendre 0 ligne hors ventes gardees pour trace utilisateur, prix d'adjudication ou issue connue, ou ecartees.
--   select count(*) from public.auction_sales s where not app_private.sale_has_listing_minimum(s);

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply off
\endif

\if :apply
  \echo === MODE APPLICATION : les annonces vides seront supprimees definitivement ===
\else
  \echo === MODE COMPTAGE SEULEMENT : aucune ecriture. Relancer avec -v apply=1 pour appliquer. ===
\endif

begin;
set local lock_timeout = '5s';

\if :apply
\else
  set transaction read only;
\endif

-- Comptage (et suppression en mode application). Les NOTICE donnent le detail ; le tableau le resume.
\if :apply
  set local statement_timeout = '10min';
  select jsonb_pretty(app_private.delete_empty_listings(1000, true)) as compte_rendu_lot_1;
  select jsonb_pretty(app_private.delete_empty_listings(1000, true)) as compte_rendu_lot_2;
  select jsonb_pretty(app_private.delete_empty_listings(1000, true)) as compte_rendu_lot_3;
  select jsonb_pretty(app_private.delete_empty_listings(1000, true)) as compte_rendu_lot_4;
  select jsonb_pretty(app_private.delete_empty_listings(1000, true)) as compte_rendu_lot_5;
\else
  select jsonb_pretty(app_private.delete_empty_listings(5000, false)) as compte_rendu;
\endif

\if :apply
  commit;
\else
  rollback;
\endif
