begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » (offre Analyse) : la fiche et l'onglet Statistiques affichaient
-- « Les statistiques du tribunal n'ont pas pu être chargées » pour toutes les ventes.
--
-- public.get_court_auction_scenarios (20261019100000) appelle app_private.court_auction_scenarios,
-- qui appelle app_private.starting_price_band. Ces fonctions ne sont pas security definer : elles
-- s'exécutent avec les droits de l'appelant (service_role). Depuis 20261010004000, une fonction créée
-- hors du schéma public ne reçoit plus aucun EXECUTE par défaut, et la migration des scénarios n'a
-- pas accordé starting_price_band à service_role. Chaque appel finissait donc en
-- « permission denied for function starting_price_band » (403 PostgREST, 500 côté route).

revoke all on function app_private.starting_price_band(numeric) from public, anon, authenticated;
grant execute on function app_private.starting_price_band(numeric) to service_role;

notify pgrst, 'reload schema';

commit;
