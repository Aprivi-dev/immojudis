# Outcome Graph — runbook exploitation

_Version 0.2 — 31 juillet 2026. Ce runbook couvre la tranche actuelle : lecture premium, fondation SQL et baseline descriptive. Le worker, l’upload de preuves, le portail cabinet et les alertes dédiées ne sont pas encore opérationnels._

## Résumé opérateur

En cas d’incident :

1. identifier si l’échec est un refus métier normal ou une erreur technique;
2. conserver le `x-request-id` et l’identifiant de vente, sans collecter de plafond privé;
3. couper la restitution applicative si la provenance ou l’autorisation est douteuse;
4. arrêter tout producteur concerné lorsqu’il existera;
5. ne jamais modifier ou supprimer événements, preuves, snapshots, cohortes ou prédictions;
6. corriger par une nouvelle version, puis vérifier en preview/staging;
7. documenter cause, étendue, décision de rollback et conditions de réactivation.

Il n’existe pas encore de kill switch runtime Outcome Graph indépendant. Une coupure globale nécessite une modification de la matrice d’entitlement ou de la route, puis un déploiement.

## Périmètre et prérequis

Artefacts concernés :

- migration `supabase/migrations/20260730105842_outcome_graph_foundation.sql`;
- pgTAP `supabase/tests/100_outcome_graph_foundation.sql`;
- API `GET /api/v1/sales/{id}/outcome-graph`;
- repository et baseline TypeScript;
- composant `OutcomeForecast` dans la fiche Analyse;
- événement d’usage `outcome_graph.viewed`.

Prérequis opérateur : accès au déploiement applicatif, rôle base approprié, sauvegarde récente et possibilité de tester sur staging. Ne jamais afficher une clé `service_role` dans une commande partagée, un ticket ou un log.

## Triage rapide

```text
401/403/400 ? → refus HTTP / auth / entitlement / entrée
200 + forecast.status=insufficient_data ? → refus métier normal
500/503 ? → incident API, configuration ou base
200 + ready mais donnée suspecte ? → couper la restitution, préserver les IDs, auditer la provenance
```

Collecter :

- heure UTC et environnement;
- `x-request-id` ou `requestId` de la réponse;
- `saleId`, `roundId`, `predictionId`, `snapshotId`, `modelVersion` s’ils sont présents;
- statut HTTP et `forecast.status`;
- message de refus affiché;
- version du déploiement et dernière migration appliquée.

Ne pas collecter : jeton Bearer, secret Supabase, contenu intégral d’une preuve, plafond saisi, identité de débiteur/occupant ou donnée personnelle non nécessaire.

## Refus HTTP

| HTTP / code               | Sens                                                        | Action                                                                                                |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `401 AUTH_REQUIRED`       | Session absente ou jeton invalide                           | Faire renouveler la session; ne pas contourner l’auth                                                 |
| `403 FORBIDDEN`           | Compte sans `property.outcomeGraph`                         | Vérifier le résolveur d’offre et l’abonnement; ne pas modifier directement le tier utilisateur        |
| `400 INVALID_REQUEST`     | UUID ou requête invalide                                    | Corriger l’appel client; surveiller un volume anormal                                                 |
| `429 RATE_LIMITED`        | Limite générique atteinte si un contrôle amont la déclenche | Respecter le délai; aucun rate limit spécifique Outcome n’est livré                                   |
| `503 CONFIGURATION_ERROR` | Configuration serveur indisponible                          | Vérifier les variables serveur sans les journaliser                                                   |
| `500 INTERNAL_ERROR`      | Repository, usage event ou base en erreur                   | Corréler le `requestId`, vérifier logs et santé Supabase; couper si la donnée servie peut être fausse |

## Refus métier

Un refus fonctionnel normal renvoie HTTP 200 avec `forecast.status = insufficient_data`. Le DTO actuel expose un `refusalReason` en texte libre; les codes `OUTCOME_GRAPH_*` du dictionnaire sont une cible, pas encore le contrat runtime.

| Motif observé                      | Vérification                                                 | Remédiation sûre                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Vente non reliée                   | Pont `auction_lots.auction_sale_id`                          | Créer/valider le lot et son lien; ne pas inférer un résultat depuis l’annonce                                                               |
| Aucune audience                    | `auction_rounds` du lot                                      | Créer un round versionné avec le bon tribunal et la bonne séquence                                                                          |
| Audience à corriger après snapshot | Entrées prédictives du round et présence d’un snapshot       | Créer un nouveau round relié au précédent; ne pas modifier le round déjà snapshoté                                                          |
| Lot inactif / audience hors phase  | `auction_lots.active`, puis `auction_rounds.current_status`  | Ne publier `ready` que pour un lot actif et un état `scheduled`, `confirmed`, `surenchere_round_scheduled` ou `reiteration_round_scheduled` |
| Aucune prédiction vérifiée         | Prédictions du dernier round                                 | Attendre/relancer le producteur futur; ne pas fabriquer une probabilité côté API                                                            |
| Traçabilité incomplète             | Snapshot, modèle, cohorte et IDs                             | Insérer une nouvelle prédiction complète; ne pas réécrire l’ancienne ni inventer ses champs de provenance                                   |
| Taille d’échantillon incohérente   | `prediction.sample_size` et `cohort_statistics.sample_size`  | Corriger le producteur puis insérer une nouvelle prédiction; ne jamais recopier une taille différente                                       |
| Snapshot non admissible            | Cutoff, manifeste, `retrospective`, leakage                  | Reconstruire une nouvelle ligne; toute reconstruction post-audience reste rétrospective/non-training                                        |
| Modèle non actif / type incohérent | Statut et approbation de `model_versions`, `prediction_kind` | Promouvoir depuis un brouillon avec approbateur; réserver `outcome_graph` à un modèle actif et `shadow` à un modèle shadow                  |
| Cohorte non éligible/conflit       | `training_eligible`, conflit, période                        | Résoudre preuves/revues puis produire une nouvelle statistique                                                                              |
| Échantillon `< 10`                 | `sample_size` réellement éligible                            | Appliquer le fallback hiérarchique ou refuser; jamais compléter artificiellement                                                            |
| Probabilités/quantiles invalides   | JSON et provenance de la prédiction                          | Mettre le producteur en quarantaine, insérer une correction versionnée                                                                      |

`unknown` n’est pas un incident et ne doit jamais devenir automatiquement annulation, report, no-bid ou absence de surenchère.

## Monitoring actuel

### Logs API

Filtrer les logs structurés sur :

```text
scope = outcome-graph.forecast
status
durationMs
requestId
code
```

Comparer le taux de 4xx, 5xx et la latence à la période précédente. Aucun seuil d’alerte Outcome spécifique n’est configuré dans cette tranche; les seuils et responsables doivent être fixés avant production large.

### Usage et refus

Requêtes de diagnostic à exécuter avec un rôle d’exploitation autorisé :

```sql
select
  date_trunc('hour', created_at) as hour,
  metadata ->> 'status' as forecast_status,
  count(*) as views
from public.feature_usage_events
where event_key = 'outcome_graph.viewed'
  and created_at >= now() - interval '24 hours'
group by 1, 2
order by 1 desc, 2;
```

```sql
select
  prediction_kind,
  prediction_status,
  horizon,
  coalesce(refusal_reason, 'none') as refusal_reason,
  count(*)
from public.auction_predictions
where generated_at >= now() - interval '7 days'
group by 1, 2, 3, 4
order by 5 desc;
```

Ces requêtes ne couvrent pas les refus avant création d’une prédiction, par exemple vente non reliée. Ceux-ci apparaissent dans `feature_usage_events.metadata.status` et les logs API.

### Santé des snapshots et modèles

```sql
select
  prediction_horizon,
  leakage_check_status,
  retrospective,
  count(*)
from public.auction_feature_snapshots
group by 1, 2, 3
order by 1, 2, 3;
```

```sql
select model_key, segment, version, status, training_sample_size, approved_at
from public.model_versions
order by model_key, segment, created_at desc;
```

Déclencher une enquête avant réactivation si :

- un snapshot `passed` ou une prédiction `ready` semble postérieur à l’audience;
- plusieurs modèles actifs apparaissent pour une même clé/segment;
- le taux de refus ou de 5xx se dégrade brutalement;
- une source non approuvée produit un artefact;
- les probabilités/quantiles sont refusés par le repository ou la base;
- des champs personnels ou une identité de magistrat apparaissent dans un JSON.

### Métriques cibles non encore instrumentées

Couverture J+1/J+10/J+45, grades A/B/C, conflits, délai de revue, taux de matching, snapshots manquants, profondeur/âge de file, retries, dead-letter et calibration doivent être ajoutés avec le worker et les workflows de preuve.

## Migration locale et validation

La migration est additive. Elle ne remplace pas `auction_sales` et le pont `auction_sale_id` est nullable avec `ON DELETE SET NULL`.

### Préflight

1. confirmer une sauvegarde et une restauration testable;
2. vérifier que le fichier de migration n’a pas déjà été appliqué sous une autre version;
3. ne pas utiliser de données ou secrets de production en local;
4. démarrer Docker;
5. utiliser la version Supabase épinglée par la CI.

Commandes attendues :

```bash
npm ci
npm run check:migrations
npx --yes supabase@2.110.0 start
npx --yes supabase@2.110.0 db reset --local --no-seed --log-level error
npm run check:schema-drift
npx --yes supabase@2.110.0 test db
npm run test
npx tsc --noEmit
npm run lint
npm run build
npx --yes supabase@2.110.0 stop --no-backup
```

`npm run check:migrations` vérifie les versions de fichiers, pas la validité SQL. Au 31 juillet 2026, TypeScript, ESLint, le build Next, 41 tests ciblés (25 moteur, 12 repository, 4 route) et la suite complète de 95 fichiers/387 tests passent. Les 84 migrations ont été rejouées depuis zéro et les 12 plans pgTAP totalisent 274 assertions réussies, dont 166 pour Outcome Graph, ingestion et pont catalogue.

Ne jamais exécuter `supabase db reset --linked` sur une base distante.

### Staging puis production

1. appliquer la migration sur staging avant le déploiement du code qui lit les nouvelles tables;
2. exécuter pgTAP et confirmer l’absence de tout grant/policy navigateur sur les 16 tables internes;
3. vérifier qu’un compte Découverte obtient 403 et qu’un compte Analyse admissible obtient soit un refus métier sûr, soit une prévision traçable;
4. vérifier `private, no-store`, `x-request-id` et l’événement d’usage;
5. insérer toute version de modèle comme brouillon non approuvé, puis utiliser seulement les transitions revues avec `approved_at` et `approved_by`;
6. déployer d’abord en prévisualisation interne, puis shadow mode;
7. activer commercialement seulement après les seuils documentés dans la model card.

La commande d’application distante doit rester celle du processus de release ImmoJudis configuré; ne pas improviser une connexion ou extraire des credentials pour ce runbook.

## Rollback et coupure

### Couper la restitution

Pour un incident d’autorisation, de provenance ou de données :

1. modifier temporairement l’accès `property.outcomeGraph` afin qu’il soit `locked` pour toutes les offres, ou faire retourner une indisponibilité contrôlée par la route;
2. déployer cette coupure;
3. confirmer qu’aucune lecture `ready` n’est servie;
4. arrêter les producteurs Outcome lorsqu’ils existeront;
5. préserver tables, snapshots, prédictions et événements pour l’analyse.

Cette opération est un déploiement : aucun feature flag runtime dédié n’existe encore.

### Retirer une version de modèle

Pour un incident limité à une version active, utiliser une transaction contrôlée et l’identifiant exact audité :

```sql
begin;

select id, model_key, segment, version, status
from public.model_versions
where id = '<MODEL_VERSION_UUID>'::uuid
for update;

update public.model_versions
set status = 'retired'
where id = '<MODEL_VERSION_UUID>'::uuid
  and status in ('shadow', 'active');

commit;
```

Vérifier qu’une seule ligne a changé. Une version retirée ne se réactive pas en place; une correction produit une nouvelle version après revue. Une version seulement `validated` suit le chemin de rejet prévu, pas une transition inventée.

### Rollback de schéma

Ne pas supprimer la migration ni lancer de `DROP TABLE` comme réponse à incident. Les données sont append-only et la migration additive. Le rollback sûr consiste à :

- couper lectures et producteurs;
- laisser le schéma en place;
- corriger par une nouvelle migration additive;
- restaurer depuis une sauvegarde uniquement selon la procédure globale testée, si l’intégrité de la base entière l’exige.

Une restauration doit être répétée d’abord hors production. RTO, RPO et responsables d’autorisation restent à définir dans le plan de continuité global.

## Contrôles après incident ou migration

- free/Analyse/admin conformes à la matrice attendue;
- aucun grant/policy `anon` ou `authenticated` sur les 16 tables internes;
- RLS active sur les 16 tables;
- snapshots et prédictions non modifiables;
- entrées prédictives d’un round non modifiables après son premier snapshot; toute correction crée un nouveau round;
- aucun résultat `held_adjudicated` sans prix;
- aucune prédiction `ready` sans audience datée, snapshot, cohorte et modèle admissibles;
- aucune prédiction `ready` pour un lot inactif ou un round hors des quatre états prévisionnels admis;
- génération postérieure ou égale au build, schémas snapshot/modèle identiques, modèle créé/approuvé avant la prédiction et données d’entraînement/cohorte bornées au cutoff des features;
- aucune divergence entre la taille d’échantillon annoncée par la prédiction et celle de sa cohorte;
- chaque correction de prédiction pointe vers l’ancienne par une chaîne `supersedes_prediction_id` strictement horodatée, sans branche; la lecture prend `generated_at`, puis `created_at`, décroissants;
- aucune prédiction `outcome_graph` issue d’un modèle non actif, ni prédiction `shadow` issue d’un modèle non shadow;
- provenance `approved_at`/`approved_by` figée dès qu’un modèle quitte `draft`;
- report et annulation/non-réquisition toujours séparés;
- `ceiling: null` à la sortie du repository et aucune donnée de magistrat, plafond ou preuve brute dans les logs/DTO serveur;
- `marketValueCents: null` pour un snapshot refusé et provenance temporelle/modèle nulle lorsqu’elle n’existe pas;
- métriques et taux de refus revenus à un niveau expliqué;
- cause et action corrective ajoutées au journal d’incident.

Voir [`docs/security/outcome-graph.md`](../security/outcome-graph.md) et [`docs/model-card-outcome-graph.md`](../model-card-outcome-graph.md) pour les contrôles et limites qui justifient ces procédures.
