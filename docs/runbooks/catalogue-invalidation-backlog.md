# Alerte `catalogue.invalidation.backlog` (avertissement)

La boîte d'envoi `app_private.catalogue_invalidations` (ventes retirées du catalogue public, à purger du
cache) n'est pas vidée : sa ligne la plus ancienne date de plus de **2 heures**, ou elle contient plus de
**1 000 lignes**. Une vente retirée (fusion, quarantaine, purge) reste alors servie par le cache du site.

Le vidage est fait par le pipeline (`python -m src.cache_invalidation --flush`), qui appelle
`POST /api/pipeline/revalidate-sale` puis supprime les lignes transmises.

## Diagnostic

1. `select details from operational_alerts where alert_key = 'catalogue.invalidation.backlog';`
2. `select count(*), min(at) from app_private.catalogue_invalidations;` (rôle de service).
3. Le pipeline tourne-t-il (workflow `data-pipeline.yml`, étape d'invalidation) ? L'appel
   `revalidate-sale` répond-il (secret partagé, journaux Vercel) ?
4. Détail du cache et de la purge : `docs/runbooks/catalogue-visibility-projection.md`.

## Actions

Corriger l'appel (secret, route, pipeline) puis relancer le vidage ; les lignes ne se suppriment que quand
l'appel a réussi. Ne pas vider la table à la main : les ventes concernées resteraient visibles dans le
cache (au plus une minute de plus pour l'aperçu, selon `revalidate`).

## Fermeture

Automatique : boîte vidée, l'alerte devient inactive puis se ferme après deux heures.
