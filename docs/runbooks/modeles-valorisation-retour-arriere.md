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
- le suivi des résultats montre une dérive que l'ancienne version n'avait pas.

Le retour arrière ne corrige pas une donnée source erronée : si les comparables eux-mêmes sont faux, voir d'abord
`docs/runbooks/valuation-queue-degraded.md`.

## Avant : lire l'état du segment

Dans l'éditeur SQL de Supabase (lecture seule), pour le segment concerné :

```sql
select version, status, activated_at, retired_at,
       training_metrics->>'test_mape_pct' as mape_test,
       training_metrics->'comparison'->>'candidate_median_ape_pct' as erreur_mediane_candidat,
       training_metrics->'comparison'->'error_gap'->'vs_active' as ecart_vs_actif
from public.valuation_model_versions
where model_key = 'immojudis_market_value' and segment = 'apartment'
order by coalesce(activated_at, created_at) desc;
```

Repérer la version `active` et la dernière version `retired` : c'est celle à remettre en service. Une version
`draft` n'a jamais été activée (la porte l'a refusée) : ne pas la remettre en service par ce chemin.

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

## Après : vérifier

1. Attendre 5 minutes (cache du modèle), puis ouvrir la fiche d'une vente de ce segment et vérifier que la fourchette
   « indicative » est cohérente avec les ventes voisines.
2. Relire la requête « Avant » : une seule ligne `active` par segment (ou aucune après l'action B).
3. Noter dans le journal de l'équipe : segment, versions avant et après, motif, date et heure.
4. Ne pas relancer l'entraînement avec `--activate` tant que la cause n'est pas comprise : la porte exige au moins
   300 ventes de test et un écart d'erreur prouvé (intervalle bootstrap apparié sous zéro) face au modèle actif
   et au repère naïf. Un entraînement sans `--activate` reste publié en brouillon, sans effet sur le site.

## Ce que le retour arrière ne fait pas

- Il ne recalcule pas immédiatement les estimations déjà stockées pour les ventes (voir plus haut).
- Il ne revient pas sur une migration : ce runbook ne concerne que les lignes du registre.
- Il ne se fait jamais depuis un assistant ni un script automatique : c'est une écriture en production, à confirmer
  par une personne.
