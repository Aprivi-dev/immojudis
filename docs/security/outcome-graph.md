# Outcome Graph — architecture de sécurité

_État audité au 30 juillet 2026. Ce document sépare les contrôles présents de la cible de sécurité. Il ne certifie pas les surfaces encore absentes, notamment worker, portail cabinet, upload de preuves et stockage objet._

## Objectifs

Outcome Graph doit protéger simultanément :

- l’historique judiciaire et sa provenance contre l’écrasement;
- les snapshots et prédictions contre la fuite temporelle;
- les preuves et artefacts contre un accès client direct;
- l’offre premium contre le contournement de l’entitlement;
- les secrets serveur et la clé `service_role`;
- les plafonds utilisateurs et données personnelles;
- la qualité du modèle contre des lignes non prouvées ou conflictuelles.

Les principes de refus sûr sont : aucun accès implicite, aucune source autorisée par défaut, aucune donnée inconnue transformée en résultat négatif et aucune prédiction inventée lorsque la provenance manque.

## Frontières de confiance actuelles

```text
Navigateur non fiable
  → Bearer Supabase
API Next.js
  → authentification
  → entitlement property.outcomeGraph
  → validation UUID
  → client serveur service_role
PostgreSQL / RLS / triggers
```

Le navigateur est une surface de présentation. Le composant Analyse et le masquage premium ne constituent pas une frontière d’autorisation.

### Acteurs

| Acteur | Droits actuels Outcome Graph |
|---|---|
| Anonyme | Aucun grant sur les 16 tables; route refusée sans authentification |
| Découverte authentifié | Entitlement refusé; aucun accès direct aux tables internes |
| Analyse / premium manuel | Lecture de la projection API uniquement; aucun accès direct aux 16 tables internes |
| Administrateur | Accès Analyse via le résolveur canonique existant |
| `service_role` | Écritures serveur/worker selon les grants; contourne la RLS |
| Opérateur, reviewer, cabinet, analyste | Rôles fins non encore implémentés dans la tranche Outcome Graph |

Être premium ne donne aucun droit d’écriture dans le registre.

## Contrôles implémentés

### Authentification et premium

La route `GET /api/v1/sales/{id}/outcome-graph` :

1. valide le jeton avec `requireSupabaseAuthContext`;
2. appelle `assertFeatureEntitlement(auth, "property.outcomeGraph", …)`;
3. valide ensuite l’identifiant UUID;
4. lit le registre avec le client serveur;
5. répond avec `Cache-Control: private, no-store` et un `x-request-id`.

L’ordre empêche une requête anonyme ou Découverte de sonder l’existence d’un identifiant. Comme le repository utilise `supabaseAdmin`, le contrôle d’entitlement avant toute lecture est obligatoire : `service_role` contourne la RLS.

L’accès Analyse canonique couvre : administrateur, `account_tier = premium`, ou abonnement `analyse` actif/non expiré. Une vérification directe du seul tier serait incorrecte.

### RLS et grants

Les deux migrations activent la RLS sur les 16 tables Outcome Graph et les 7 tables d'ingestion source.

- `anon` et `authenticated` ne reçoivent aucun grant et aucune policy sur ces tables;
- aucune cohorte, version de modèle, prédiction, lot, round, snapshot, feature, artefact, résultat, preuve ou revue n’est lisible directement par un client;
- toute lecture premium passe par la route serveur après authentification et entitlement;
- les écritures sont réservées au `service_role` selon la mutabilité de la table.

Les prédictions premium sont un produit global par vente, pas une ressource possédée par l’utilisateur. L’isolation organisationnelle deviendra obligatoire avant le portail cabinet.

### Immutabilité et intégrité

Huit tables historiques rejettent `UPDATE` et `DELETE` : artefacts bruts, événements, versions de résultat, preuves, revues, snapshots, statistiques de cohorte et prédictions. Une garde séparée rend le contenu d’un modèle immuable tout en autorisant son cycle de statut contrôlé. Dès qu’un round possède un snapshot, une autre garde interdit de modifier ses entrées prédictives; toute correction ou nouvelle programmation doit créer un nouveau round. Les validateurs de snapshot et de prédiction prennent un verrou `FOR SHARE` sur le round afin de sérialiser ces contrôles avec une modification concurrente.

Les validations SQL couvrent notamment :

- états `unknown`, `cancelled`, `not_requested`, `postponed`, `held_no_bid`, `held_adjudicated` distincts;
- prix obligatoire pour une adjudication;
- `training_eligible = false` forcé sur les résultats canoniques tant que le workflow de preuve et revue n'existe pas;
- cutoff strictement antérieur à l’audience;
- reconstruction post-audience obligatoirement `retrospective` et non éligible;
- manifeste publié et capturé avant le cutoff lorsque le contrôle est `passed`;
- prédiction générée après le build du snapshot et avant l’audience;
- date d’audience obligatoire pour toute prédiction `ready`;
- lot actif et round dans un état prévisionnel (`scheduled`, `confirmed`, `surenchere_round_scheduled` ou `reiteration_round_scheduled`) pour toute prédiction `ready`;
- même horizon entre snapshot, cohorte et prédiction, et même schéma de features entre snapshot et modèle;
- modèle créé et approuvé avant la prédiction, cutoff d’entraînement antérieur ou égal au cutoff des features, et cohorte créée et bornée avant ce même cutoff;
- insertion d’une version de modèle uniquement en `draft`, sans approbation, puis transitions contrôlées avec `approved_at` et `approved_by` obligatoires pour un statut publié et immuables après la sortie de `draft`;
- prédiction client `outcome_graph` reliée uniquement à un modèle `active`, et prédiction `shadow` uniquement à un modèle `shadow`;
- chaîne de remplacement dirigée vers l’ancienne prédiction par `supersedes_prediction_id`, limitée au même round/type/horizon, strictement croissante en `generated_at` et sans branche grâce à un index unique; `superseded_by` reste obligatoirement nul;
- cohorte éligible, sans conflit, avec `n >= 10`, et `prediction.sample_size` strictement égal à la taille persistée de cette cohorte;
- probabilités dans `[0,1]`, sommes conditionnelles cohérentes et quantiles présents/monotones;
- seuils 300/1 000 pour les modèles statistiques/ML;
- une seule version active par clé et segment.

Les UUID d’acteurs historiques ne portent pas de cascade vers `auth.users`; une suppression de compte ne réécrit donc pas une ligne append-only.

Le `service_role` reste un writer de confiance et peut porter les transitions de statut. Les futures commandes d’administration devront journaliser l’approbateur réel et contrôler son rôle; le formulaire et l’audit métier de promotion ne sont pas encore livrés.

### Politique source

`data_sources` distingue `allowed_automated`, `allowed_manual`, `partner_only`, `disabled` et `prohibited`. Le SQL refuse `allowed_automated` sans revue juridique `approved`. L’interrupteur `active` ne remplace pas la politique.

Les connecteurs/parseurs DVF, Judilibre, Justice et Enchères ainsi que la CLI commune sont présents.
La politique est vérifiée avant Storage puis verrouillée avec `FOR SHARE` dans la transaction de
provenance. Judilibre reste `pending`, `disabled`, inactif, et possède en plus un interrupteur runtime
désactivé par défaut. Les candidats source sont tous contraints à `training_eligible = false`.

Le bucket `outcome-raw-artifacts` est privé et ne possède aucune policy navigateur. L'activation
Judilibre reste interdite tant que le replay SQL/RLS, le janitor d'objets orphelins et le worker de
purge physique ne sont pas testés.

### Confidentialité du plafond

La table `auction_predictions` ne possède aucun champ de plafond personnel. La route ne reçoit pas le plafond saisi et le repository restitue systématiquement `ceiling: null`. L’UI choisit localement son seuil d’affichage, recalcule dans le navigateur les deux probabilités sous plafond et n’envoie pas ce montant dans l’événement d’usage, qui journalise seulement statut et identifiants de modèle/prédiction/snapshot.

Le P50 peut servir de seuil initial côté client; il ne représente pas un plafond utilisateur persistant ni une valeur fournie par le repository.

Le repository n’extrait la valeur de marché d’un snapshot qu’après validation de sa provenance. Un snapshot refusé ne peut donc pas faire fuiter `marketValueCents`; lorsqu’aucune provenance n’existe, `generatedAt`, `horizon` et `modelVersion` restent explicitement nuls.

### Minimisation des données

Le schéma analytique ne définit aucune colonne d’identité de magistrat ou de greffe. Les réponses premium portent des agrégats, identifiants techniques et montants, pas des débiteurs, occupants nominatifs ou coordonnées privées.

Cette protection n’est pas encore garantie à l’intérieur de tous les JSON libres (`features`, `payload`, explications, métadonnées). Les futurs producteurs doivent appliquer un schéma et une règle de minimisation avant insertion.

### Journalisation

La route produit un log structuré serveur avec `scope=outcome-graph.forecast`, `requestId`, timestamp, statut HTTP et durée. Les erreurs ajoutent un code et le message technique dans les logs serveur; la réponse 5xx reste générique.

Chaque lecture réussie tente d’insérer `outcome_graph.viewed` dans `feature_usage_events`, avec identifiants de provenance et sans plafond. Le registre `audit_log` spécifique à la cible Outcome Graph n’est pas encore créé.

## Menaces et réponse actuelle

| Menace | Contrôle actuel | Résiduel |
|---|---|---|
| Contournement premium | Auth + entitlement serveur; aucun grant/policy navigateur sur les tables internes | Tests réels admin/abonnement actif à compléter pour cette route |
| IDOR / énumération | Auth/entitlement avant UUID; produit global premium | Pas encore de ressources cabinet à isoler |
| Exposition `service_role` | Import serveur uniquement; aucune clé dans le DTO | Rotation/scan secrets relèvent de l’exploitation existante |
| Réécriture historique | Triggers append-only; chaîne `supersedes_prediction_id` linéaire, horodatée et indexée | Motif métier et audit opérateur d’une supersession à formaliser |
| Modification concurrente de l’audience | Garde des entrées du round après snapshot et verrous `FOR SHARE` dans les validateurs | Le producteur doit créer un nouveau round pour toute correction post-snapshot |
| Fuite post-audience | Validateurs snapshot/prédiction et repository | JSON de manifeste fourni par un producteur de confiance; builder non livré |
| Prédiction sur cohorte faible | Règles `n >= 10`, éligibilité et conflit | Éligibilité résultat/preuve complète pas encore matérialisée bout en bout |
| Publication du mauvais modèle | Insert draft-only, transitions avec approbateur, type public/shadow lié au statut | Commande d’administration et audit métier de promotion non livrés |
| Donnée personnelle dans features | Aucune colonne magistrat; accès snapshot serveur seulement | Validation de contenu JSON et audit PII manquants |
| Exposition de preuve | Aucun grant client sur artefacts/preuves | Bucket privé, URL signée et upload sécurisé non livrés |
| SSRF connecteur | Judilibre n'accepte que les origines PISTE prévues et refuse les redirections | Les autres futures sources réseau devront appliquer les mêmes protections |
| Abus volumétrique API | Validation UUID et logs | Pas de rate limit spécifique Outcome Graph livré |
| XSS via texte de cohorte/explication | React échappe les chaînes par défaut | Sanitation et bornes de longueur producteur à formaliser |

## Surfaces non encore livrées

Les contrôles suivants restent des prérequis, pas des capacités actuelles :

- organisations, memberships et isolation inter-cabinets;
- rôles opérateur/reviewer/analyste et commandes d’écriture dédiées;
- bucket privé de preuves, URL signées courtes et politique Storage;
- contrôle MIME réel, taille, antivirus, noms UUID et quarantaine d’upload;
- scheduler durable, exécuteur de queue supervisé, janitor d'objets orphelins et purge physique;
- blocage réseau générique localhost/IP privées/metadata cloud pour tout futur connecteur configurable;
- validation fermée des JSON et détection de données personnelles;
- rate limiting spécifique, alertes et tableaux de bord Outcome;
- test E2E du parcours registre → preuve → revue → snapshot → prédiction;
- kill switch runtime indépendant de la matrice d’offre.

Il ne faut pas ouvrir une route d’upload ou un connecteur en s’appuyant sur ce document comme preuve que ces contrôles existent.

## Vérification disponible

Exécuté dans le worktree :

- 41 tests Vitest ciblés : 25 moteur, 12 repository et 4 route premium;
- suite Vitest complète : 95 fichiers et 387 tests réussis;
- ESLint, TypeScript, build Next de développement et invariants de sécurité réussis;
- `npx tsc --noEmit`.

Présent mais non encore exécuté localement faute de validation Docker :

- `supabase/tests/100_outcome_graph_foundation.sql`, plan de 46 assertions;
- `supabase/tests/110_outcome_source_ingestion.sql`, plan de 75 assertions.

Le pgTAP couvre statiquement présence des tables, RLS, absence de grants navigateur, refus d’automatisation non revue, anti-fuite, append-only, audience datée, lot/round prévisionnels, garde durable des entrées du round, supersession linéaire, cohorte insuffisante, cohérence stricte de l’échantillon, quantiles manquants, séparation report/annulation, workflow modèle, provenance d’approbation figée, séparation public/shadow et unicité du modèle actif. Il ne couvre pas encore cabinet, upload, SSRF, bucket, abonnement Stripe réel, administrateur ni parcours E2E.

## Checklist avant extension

Avant toute nouvelle surface :

1. définir l’acteur, le scope et la policy RLS;
2. contrôler l’entitlement ou le rôle avant tout usage de `service_role`;
3. valider Zod et SQL, avec bornes de taille et vocabulaires fermés;
4. ajouter un test refusant free, autre organisation et identifiant non autorisé;
5. exclure plafond, secret, preuve brute et donnée personnelle des logs;
6. préserver l’append-only par une nouvelle version ou un événement compensatoire;
7. vérifier `published_at` et `captured_at` avant tout snapshot;
8. refuser par défaut toute source sans politique applicable;
9. documenter rollback, monitoring et restauration;
10. exécuter replay des migrations, pgTAP, tests, build et scan avant staging.

Voir [`docs/runbooks/outcome-graph.md`](../runbooks/outcome-graph.md) pour le traitement opérationnel et [`docs/model-card-outcome-graph.md`](../model-card-outcome-graph.md) pour les limites statistiques.
