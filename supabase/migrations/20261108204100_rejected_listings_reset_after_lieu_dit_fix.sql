begin;

set local lock_timeout = '5s';

-- Vide le cache des annonces refusées (migration 20261108202200). Jusqu'au correctif de
-- services/data-pipeline/src/listing_minimum.has_street_or_lieu_dit, la règle Python refusait un lieu nommé suivi de
-- la commune sans code postal (« Le Prieuré, Sossais », Licitor) : ces annonces ne doivent pas attendre 7 jours avant
-- d'être relues. Le cache n'est qu'un confort : vide, le pipeline relit les fiches au passage suivant.
delete from app_private.rejected_listings;

commit;
