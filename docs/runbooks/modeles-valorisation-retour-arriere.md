# Modèles de valorisation : retour à la version précédente

Objet : remettre en service la version d'un modèle de valorisation (LightGBM, par segment) que l'activation d'une
nouvelle version a retirée, ou arrêter le modèle pour revenir aux seuls comparables. Public : le propriétaire
(ou la personne qu'il charge de la base).

Dernier essai : jamais (à dater après un essai sur une copie de la base ou en préproduction).

## Ce qu'il faut savoir

- Le registre est `public.valuation_model_versions`. Un seul modèle peut être `active` par segment
  (`apartment`, `house`, `building`, `commercial`, `land`) : l'index `valuation_model_versions_one_active_idx` l'impose.
- Activer une version retire l'ancienne (`status = 'retired'`, `retired_at` renseigné) mais **ne l'efface jamais** :
  son artefact reste dans le registre. C'est ce qui rend le retour arrière possible.
- Sans modèle actif pour un segment, l'estimation retombe sur les comparables seuls (moteur sans modèle). Rien
  n'est cassé : la fourchette est seulement celle des ventes voisines.
- L'application garde le modèle actif en mémoire 5 minutes (`MODEL_CACHE_TTL_MS` dans
  `src/lib/valuation-model-registry.ts`). Compter jusqu'à 5 minutes après l'opération.
- Les estimations déjà calculées pour les ventes (`auction_sale_market_estimates`) gardent la version du modèle qui
  les a produites (colonne `model_version`) jusqu'à leur prochain recalcul planifié ; il n'y a rien à réécrire à la
  main.

## Quand revenir en arrière

- l'écart avec le marché ou les fourchettes changent brutalement après une activation, sans changement de marché ;
- un segment montre des estimations aberrantes (valeurs hors de toute proportion avec les ventes voisines) ;
- le suivi des résultats montre une dérive que l'ancienne version n'avait pas ;
- le modèle actif est antérieur à la porte d'activation : pas d'export `localMarket` dans son artefact, ou pas
  de bloc `comparison` dans ses `training_metrics`. C'est le cas des deux modèles `lgbm-cqr-20260713`
  (`house`, `apartment`) constaté le 08/11/2026 : voir « Cas : modèles actifs antérieurs à la porte ». Pour
  eux, c'est l'action B, jamais l'action A.

Le retour arrière ne corrige pas une donnée source erronée : si les comparables eux-mêmes sont faux, voir d'abord
`docs/runbooks/valuation-queue-degraded.md`.

## Avant : lire l'état du segment

Dans l'éditeur SQL de Supabase (lecture seule), pour le segment concerné :

```sql
select version, status, activated_at, retired_at,
       training_metrics->>'test_mape_pct' as mape_test,
       training_metrics->'comparison'->>'candidate_median_ape_pct' as erreur_mediane_candidat,
       training_metrics->'comparison'->'error_gap'->'vs_active' as ecart_vs_actif,
       artifact ? 'localMarket' as a_export_local,
       training_metrics ? 'comparison' as a_comparaison
from public.valuation_model_versions
where model_key = 'immojudis_market_value' and segment = 'apartment'
order by coalesce(activated_at, created_at) desc;
```

Repérer la version `active` et la dernière version `retired` : c'est celle à remettre en service. Une version
`draft` n'a jamais été activée (la porte l'a refusée) : ne pas la remettre en service par ce chemin. Une version
dont `a_export_local` ou `a_comparaison` vaut `false` n'est pas non plus à remettre en service : elle n'a pas
passé la porte actuelle.

## Action A : réactiver la version retirée

À faire dans une seule transaction, pour un segment à la fois. Remplacer `apartment` et les deux versions.

```sql
begin;

update public.valuation_model_versions
set status = 'retired', retired_at = now(), updated_at = now()
where model_key = 'immojudis_market_value'
  and segment = 'apartment'
  and status = 'active'
  and version = '<version actuellement active>';

update public.valuation_model_versions
set status = 'active', activated_at = now(), retired_at = null, updated_at = now()
where model_key = 'immojudis_market_value'
  and segment = 'apartment'
  and status = 'retired'
  and version = '<version à remettre en service>';

-- Contrôle avant de valider : une seule ligne active pour ce segment, et c'est la bonne.
select version, status from public.valuation_model_versions
where model_key = 'immojudis_market_value' and segment = 'apartment' and status = 'active';

commit;  -- ou rollback; si le contrôle ne montre pas exactement une ligne
```

Attention : cette écriture se fait à la main, hors du script de publication. Le script
`scripts/publish-valuation-models.mjs` n'est PAS fait pour cela : il refuse tout lot dont le rapport de la porte
d'activation (`<segment>-<version>.report.json`) n'a pas validé l'activation, et la version retirée n'a, par
définition, plus de raison de repasser cette porte face au modèle qui l'a remplacée.

## Action B : arrêter le modèle d'un segment (retour aux comparables seuls)

```sql
update public.valuation_model_versions
set status = 'retired', retired_at = now(), updated_at = now()
where model_key = 'immojudis_market_value'
  and segment = 'apartment'
  and status = 'active';
```

Pour le remettre en service ensuite : action A, sans la première requête.

### Cas : modèles actifs antérieurs à la porte (sans `localMarket`)

Situation mesurée le 08/11/2026 : deux lignes `active`, `house` et `apartment`, version `lgbm-cqr-20260713`,
activées le 27/07/2026, sans `artifact.localMarket` ni `training_metrics.comparison`. Ces modèles reçoivent au
service des variables locales approchées depuis les comparables, différentes de celles de leur entraînement, et
leur mélange avec les comparables n'a jamais été évalué. Il n'existe pas de version antérieure qui ait passé la
porte : on arrête le modèle (action B), on ne réactive rien.

Les deux segments dans une seule transaction ; la condition sur l'export empêche de retirer par erreur un modèle
plus récent qui, lui, l'aurait.

```sql
begin;

update public.valuation_model_versions
set status = 'retired', retired_at = now(), updated_at = now()
where model_key = 'immojudis_market_value'
  and segment in ('house', 'apartment')
  and status = 'active'
  and version = 'lgbm-cqr-20260713'
  and not (artifact ? 'localMarket');
-- Attendu : UPDATE 2. Sinon : rollback; et relire la requête « Avant ».

-- Contrôle avant de valider : plus aucune ligne active pour ces deux segments.
select segment, version, status from public.valuation_model_versions
where model_key = 'immojudis_market_value' and segment in ('house', 'apartment') and status = 'active';
-- Attendu : 0 ligne.

commit;  -- ou rollback; si l'UPDATE n'a pas touché exactement 2 lignes ou si le contrôle montre une ligne
```

Ensuite, voir « Après : vérifier » (requêtes de contrôle et effet attendu sur la fiche), puis lancer un
entraînement en brouillon (workflow « Immojudis Valuation Model Training », `activate` décoché) et le faire
auditer avant toute activation.

## Après : vérifier

1. Attendre 5 minutes (cache du modèle), puis ouvrir la fiche d'une vente de ce segment et vérifier que la fourchette
   « indicative » est cohérente avec les ventes voisines.
2. Relire la requête « Avant » : une seule ligne `active` par segment (ou aucune après l'action B).
3. Après l'action B, requête de contrôle du registre (lecture seule) :

   ```sql
   select segment, version, status, activated_at, retired_at,
          artifact ? 'localMarket' as a_export_local
   from public.valuation_model_versions
   where model_key = 'immojudis_market_value'
     and segment in ('house', 'apartment')
   order by segment, coalesce(activated_at, created_at) desc;
   ```

   Attendu : aucune ligne `active` pour les segments arrêtés ; la version arrêtée en `retired` avec un
   `retired_at` à l'heure de l'opération.

4. Après l'action B, effet sur la fiche : le segment retombe sur les comparables seuls. Pour un calcul fait après
   le délai du cache (5 minutes), `engineKind` vaut `comparable_ensemble`, la valeur médiane et la fourchette
   p10-p90 affichées sont celles des ventes comparables (plus de mélange avec le modèle) et le diagnostic du
   modèle disparaît. Les valeurs affichées peuvent donc bouger. Les estimations déjà stockées gardent l'ancien
   mélange jusqu'à leur recalcul planifié (`next_refresh_at`, sept jours après le dernier calcul). Suivi en
   lecture seule :

   ```sql
   select segment, engine_kind, model_version, count(*) as ventes, max(computed_at) as dernier_calcul
   from public.auction_sale_market_estimates
   where status = 'ready' and segment in ('house', 'apartment')
   group by segment, engine_kind, model_version
   order by segment, engine_kind;
   ```

   Attendu : le nombre de lignes `hybrid_lightgbm` / `lgbm-cqr-20260713` décroît jusqu'à zéro en une semaine
   environ ; les nouvelles lignes sont `comparable_ensemble` avec `model_version` vide. S'il reste des lignes
   `hybrid_lightgbm` au-delà de huit jours, vérifier que la file des estimations tourne
   (`docs/runbooks/valuation-queue-degraded.md`).

5. Noter dans le journal de l'équipe : segment, versions avant et après, motif, date et heure.
6. Ne pas relancer l'entraînement avec `--activate` tant que la cause n'est pas comprise : la porte exige au moins
   300 ventes de test, un écart d'erreur prouvé (intervalle bootstrap apparié sous zéro) face au modèle actif
   et au repère naïf, et un mélange modèle + comparables qui ne fait pas moins bien que les comparables seuls
   (bloc `blend` du rapport). Un entraînement sans `--activate` reste publié en brouillon, sans effet sur le
   site.

## Ce que le retour arrière ne fait pas

- Il ne recalcule pas immédiatement les estimations déjà stockées pour les ventes (voir plus haut).
- Il ne revient pas sur une migration : ce runbook ne concerne que les lignes du registre.
- Il ne se fait jamais depuis un assistant ni un script automatique : c'est une écriture en production, à confirmer
  par une personne.
