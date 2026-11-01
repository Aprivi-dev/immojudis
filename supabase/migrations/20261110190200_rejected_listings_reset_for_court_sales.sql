begin;

set local lock_timeout = '5s';

-- Retire du cache des annonces refusées (migration 20261108202200) les ventes au tribunal refusées pour minimum
-- insuffisant. Jusqu'à l'ajout de la preuve `court_email` (services/data-pipeline/src/listing_minimum.py, référentiel
-- public.court_registry_contacts, migration 20261110190000), une vente au tribunal sans email d'avocat était refusée puis
-- mémorisée 7 jours : elle ne doit pas attendre ce délai pour être réexaminée au prochain passage. Le cache n'est qu'un
-- confort : vide, le pipeline relit les fiches au passage suivant.
--
-- Le cache ne garde ni le type de vente ni le tribunal (source_url, source_name, empreinte, motif) : on retire toutes les
-- lignes sauf celles des sources qui ne publient jamais de vente au tribunal (notaires, cessions de l'État, AGRASC),
-- qui restent mémorisées. Les autres sources sont relues une fois de plus, sans conséquence. Même schéma que
-- 20261108204100. Ne supprime aucune annonce du catalogue.
delete from app_private.rejected_listings
where reason = 'insufficient_listing'
  and source_name not in ('notaires', 'cessions_etat', 'agrasc');

commit;
