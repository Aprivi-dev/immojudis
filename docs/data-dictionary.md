# Outcome Graph — dictionnaire de données

_Version initiale du contrat au 30 juillet 2026._

## Portée et lecture

Ce dictionnaire couvre uniquement les tables, vocabulaires et contrats d’Outcome Graph. Il décrit la cible fonctionnelle; la migration SQL versionnée reste la source de vérité pour les objets effectivement présents. L’avancement physique est indiqué dans [`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md).

Les tables historiques `auction_sales`, `properties` et `judicial_sales` restent des modèles de catalogue et de lecture pendant la migration. Elles ne remplacent aucune entité du registre. `user_profiles`, `user_subscriptions` et `public.has_analysis_access()` sont réutilisés comme intégration d’identité et d’entitlement, mais ne font pas partie du registre judiciaire lui-même.

## Conventions globales

| Sujet | Contrat |
|---|---|
| Identifiants | UUID générés par PostgreSQL, jamais choisis par le client |
| Dates métier | `timestamptz` en UTC; `local_timezone` conserve le fuseau de l’audience |
| Montants SQL | `numeric(14,2)`, positifs ou nuls selon le champ |
| Montants API | centimes entiers sûrs, suffixe `Cents`, jamais nombre JSON flottant représentant des euros |
| Scores | `numeric(5,4)` pour `[0,1]`; `numeric(5,2)` pour `[0,100]` |
| JSON | structure versionnée et validée à l’écriture; pas de fourre-tout non documenté |
| Texte inconnu | valeur canonique `unknown` quand l’état doit être explicite; `NULL` lorsque l’attribut n’a pas été observé |
| Immutabilité | événements, preuves, revues, snapshots, prédictions, audits et contenu des versions de résultat ne sont ni modifiés ni supprimés |
| Corrections | nouvelle version ou événement compensatoire avec lien `supersedes_*` et motif |
| Provenance | chaque claim publié reste relié à une source, un artefact et des horodatages |
| Données personnelles | exclues de l’analytique sauf nécessité documentée et accès restreint |

Une contrainte de confiance ou de probabilité accepte `0` et `1`. Une valeur absente ne reçoit pas automatiquement `0`.

## Vocabulaires contrôlés

### Politique d’ingestion

| Valeur | Sens | Collecte automatique |
|---|---|---|
| `allowed_automated` | Revue juridique favorable à l’automatisation | Oui, dans les limites enregistrées |
| `allowed_manual` | Consultation ou dépôt manuel seulement | Non |
| `partner_only` | Flux contractuel ou portail partenaire | Uniquement via le canal partenaire |
| `disabled` | Connecteur arrêté opérationnellement | Non |
| `prohibited` | Collecte interdite | Non |

Toute valeur absente ou inconnue vaut refus.

### Type d’audience (`round_kind`)

| Valeur | Sens |
|---|---|
| `initial` | Première tentative de vente du lot |
| `postponed` | Nouvelle audience créée à la suite d’un report |
| `surenchere` | Audience ouverte après dépôt d’une surenchère |
| `reiteration` | Audience après défaillance de paiement/réitération |

### État courant d’audience

```text
draft
scheduled
confirmed
postponed
cancelled
not_requested
held_no_bid
held_adjudicated_initial
surenchere_window_open
surenchere_filed
surenchere_round_scheduled
held_adjudicated_after_surenchere
surenchere_deadline_expired
procedurally_definitive
settlement_pending
payment_confirmed
payment_default_detected
reiteration_requested
reiteration_round_scheduled
reiterated
unknown_outcome
closed
```

`current_status` est une projection. L’historique opposable est la séquence de `auction_events`.

### Résultat (`outcome_status`)

| Valeur | Sens |
|---|---|
| `unknown` | Résultat non établi |
| `cancelled` | Annulation explicitement prouvée |
| `not_requested` | Vente explicitement non requise |
| `postponed` | Audience reportée; un nouveau round doit être créé |
| `held_no_bid` | Audience tenue et enchères désertes prouvées |
| `held_adjudicated` | Adjudication avec prix compatible et preuve |

Ces valeurs sont mutuellement distinctes. `unknown` n’est jamais transformé par défaut en l’une des cinq autres.

### Surenchère, finalité et paiement

| Champ | Valeurs initiales |
|---|---|
| `surenchere_status` | `unknown`, `window_open`, `filed`, `not_filed`, `deadline_expired` |
| `finality_status` | `unknown`, `provisional`, `procedurally_definitive` |
| `payment_status` | `unknown`, `pending`, `confirmed`, `default_detected` |
| `reiteration_status` (projection dérivée) | `unknown`, `not_applicable`, `requested`, `scheduled`, `reiterated` |

`not_filed` ne peut être affirmé qu’après contrôle de l’échéance; l’absence de signal avant l’échéance reste `unknown` ou `window_open`.

La réitération est dérivée de la chaîne de rounds et de `auction_events`; le DDL cœur de `auction_outcomes` ne la persiste pas comme vérité indépendante.

### Preuve et revue

| Champ | Valeurs |
|---|---|
| `evidence_grade` | `A`, `B`, `C`, `rejected` |
| `review_status` | `pending`, `in_review`, `approved`, `rejected`, `conflicted` |
| `decision` | `approved`, `rejected`, `needs_correction`, `needs_second_review` |

Un signalement contributeur commence au grade C. Une ligne d’entraînement exige une preuve A ou B, un lot et une audience confirmés, un snapshot valide, aucun problème bloquant et toutes les revues requises.

### Nombre d’enchérisseurs

```text
0
1
2-3
4-6
7-10
11+
unknown
```

Le contrat interdit de convertir en enchérisseurs le nombre d’avocats, de mandats, de mouvements d’enchère ou de personnes présentes.

### Horizons

Valeurs de snapshot : `T-30`, `T-14`, `T-7`, `T-1`, `T-2h`.

Une prédiction conserve aussi un `horizon` explicite, même lorsqu’il correspond au `prediction_horizon` du snapshot.

### Qualité

Catégories initiales de `data_quality_issues.issue_type` :

```text
wrong_case
wrong_lot
wrong_round
wrong_price
wrong_status
wrong_finality
wrong_surenchere_status
wrong_date
duplicate
personal_data_issue
```

## Catalogue des tables

### Identité, organisations et référentiels

#### `organizations`

Représente une organisation habilitée : plateforme, cabinet, partenaire ou équipe d’analyse.

| Champ clé | Type | Contrat |
|---|---|---|
| `id` | uuid | Clé primaire |
| `name` | text | Nom d’affichage |
| `organization_type` | text | `platform`, `law_firm`, `partner`, `analytics` |
| `status` | text | `active`, `suspended`, `closed` |
| `created_at` | timestamptz | Date de création |

Mutabilité : métadonnées courantes modifiables; actions sensibles dans `audit_log`.

#### `organization_members`

Associe un utilisateur à une organisation et définit son rôle dans cette portée.

| Champ clé | Type | Contrat |
|---|---|---|
| `id` | uuid | Clé primaire |
| `organization_id` | uuid | FK `organizations` |
| `user_id` | uuid | FK `auth.users` |
| `role` | text | `admin`, `operator`, `reviewer`, `partner`, `contributor`, `analyst` |
| `status` | text | `invited`, `active`, `revoked` |
| `created_at`, `revoked_at` | timestamptz | Cycle de vie de l’appartenance |

Contrainte : une appartenance révoquée n’est pas réactivée; une nouvelle invitation crée une nouvelle ligne.

#### `user_profiles`

Table d’application existante. Outcome Graph réutilise `user_id`, `account_tier` et `user_role`; les rôles métier fins viennent de `organization_members`.

Contrainte d’intégration : l’accès client Analyse est résolu par le mécanisme canonique existant et ne se résume pas à `account_tier`.

#### `courts`

Référentiel des juridictions utilisé pour les audiences et les agrégations.

Champs minimaux : `id`, `code`, `name`, `court_type`, `address_id`, `judicial_region`, `active`, `created_at`, `updated_at`.

Contrainte : aucune identité de magistrat ou de greffe.

#### `law_firms`

Référentiel des cabinets poursuivants et partenaires.

Champs minimaux : `id`, `organization_id`, `name`, `address_id`, `external_references`, `active`, `created_at`, `updated_at`.

Les statistiques cabinet doivent respecter les seuils d’échantillon et ne constituent pas un classement individuel.

#### `addresses`

Adresse normalisée réutilisée par lots, juridictions et cabinets.

Champs minimaux : `id`, `label`, `street`, `postal_code`, `city`, `insee_code`, `latitude`, `longitude`, `geocoding_source`, `geocoding_score`, `created_at`, `updated_at`.

Une adresse occultée conserve une granularité compatible avec le droit d’accès et la finalité analytique.

#### `parcels`

Parcelle cadastrale : `id`, références territoriales, `parcel_number`, géométrie PostGIS, source/version et horodatages.

#### `buildings`

Bâtiment RNB/BDNB : `id`, identifiant externe, `address_id`, usage, période, géométrie, source/version et horodatages.

### Sources, artefacts et ingestion

#### `data_sources`

Registre obligatoire avant toute collecte.

| Champ | Type | Contrat |
|---|---|---|
| `id` | uuid | Clé primaire |
| `name`, `publisher` | text | Identité de la source |
| `official` | boolean | Source officielle ou non |
| `base_url` | text | Origine canonique |
| `license` | text | Licence connue |
| `terms_url`, `terms_version` | text | Conditions revues |
| `legal_review_status` | text | État de la revue juridique |
| `ingestion_policy` | text | Vocabulaire de politique contrôlé |
| `rate_limit` | jsonb | Quota et fenêtre documentés |
| `personal_data_possible` | boolean | Déclenche les contrôles de minimisation |
| `active` | boolean | Interrupteur opérationnel, jamais substitut de politique |

Mutabilité : configuration courante modifiable et auditée. Une collecte web automatisée n’est possible que si `active = true` et `ingestion_policy = allowed_automated`; une ingestion `partner_only` emprunte exclusivement le canal partenaire authentifié et prévu par le contrat.

#### `source_fetches`

Une tentative de collecte HTTP, partenaire ou d'import d'un fichier local préalablement validé.

Champs minimaux : `id`, `source_id`, `capture_transport`, `request_url`, `external_record_id`, `requested_at`, `completed_at`, `http_status`, `etag`, `last_modified`, `connector_version`, `content_hash`, `status`, `error_code`, `created_at`. Un import `local_file` ne porte ni méthode ni statut HTTP.

Mutabilité : état technique jusqu’à terminaison, puis conservation historique.

#### `raw_artifacts`

Contenu brut capturé.

| Champ clé | Contrat |
|---|---|
| `source_id`, `source_fetch_id` | Provenance |
| `external_record_id` | Identité source si disponible |
| `published_at`, `captured_at` | Temps de publication et de disponibilité ImmoJudis |
| `mime_type`, `content_length` | Métadonnées vérifiées |
| `content_hash` | SHA-256 du contenu |
| `storage_bucket`, `storage_path` | Objet privé |
| `parser_status` | `pending`, `parsed`, `failed`, `dead_letter` |

Immutabilité : le contenu et son hash ne changent pas. Un contenu distinct produit une nouvelle ligne. Une recapture strictement identique peut réutiliser l’artefact adressé par hash seulement si une nouvelle ligne `source_fetches` conserve la tentative et ses horodatages; aucune observation de collecte ne disparaît.

#### `artifact_extractions`

Extraction structurée d’un artefact par une version de parser ou modèle.

Champs minimaux : `id`, `raw_artifact_id`, `extractor_name`, `extractor_version`, `schema_version`, `input_hash`, `result`, `confidence`, `status`, `created_at`.

Un rerun avec une autre version crée une nouvelle extraction. Le JSON résultat n’est pas une vérité canonique avant rapprochement et revue.

#### `ingestion_jobs`

File durable du worker.

| Champ | Contrat |
|---|---|
| `job_type` | Étape ou commande |
| `payload` | Entrée versionnée et bornée |
| `status` | `queued`, `running`, `retry`, `completed`, `dead_letter`, `cancelled` |
| `priority`, `run_after` | Ordonnancement |
| `attempt_count`, `max_attempts` | Budget de retry |
| `locked_at`, `locked_by`, `heartbeat_at` | Lease du worker |
| `idempotency_key` | Clé unique |
| `last_error` | Code/message expurgé |

Consommation : transaction `FOR UPDATE SKIP LOCKED`. Un 429 respecte `Retry-After`; 5xx utilise un backoff exponentiel; erreur de licence désactive le connecteur.

### Registre judiciaire

#### `auction_cases`

Une procédure judiciaire identifiable, pouvant contenir plusieurs lots.

| Champ | Type | Contrat |
|---|---|---|
| `id` | uuid | Clé primaire |
| `court_id` | uuid | FK `courts`, obligatoire |
| `procedure_type` | text | Type de procédure, obligatoire |
| `court_case_number` | text | Référence locale si connue |
| `portalis_number` | text | Référence Portalis si connue |
| `pursuing_firm_id` | uuid | FK `law_firms` |
| `current_status` | text | Projection de cycle de vie du dossier |
| `first_observed_at`, `last_observed_at` | timestamptz | Fenêtre d’observation |
| `created_by`, `created_at`, `updated_at` | uuid/timestamptz | Audit courant |

Index : tribunal, `(court_id, court_case_number)` et Portalis partiel. Une collision de référence crée une tâche de rapprochement, pas une fusion silencieuse.

#### `auction_lots`

Bien ou ensemble de biens réellement offert à la vente.

| Champ | Type | Contrat |
|---|---|---|
| `id`, `auction_case_id` | uuid | PK et FK dossier |
| `lot_number`, `lot_label` | text | Identité dans le dossier |
| `property_type`, `address_id` | text/uuid | Description normalisée |
| `occupation_status` | text | `unknown` par défaut |
| `occupation_confidence` | numeric(5,4) | `[0,1]` |
| `living_area_m2`, `carrez_area_m2`, `land_area_m2` | numeric | Positif ou nul |
| `room_count`, `bedroom_count`, `parking_count` | integer | Positif ou nul |
| `initial_starting_price_eur` | numeric(14,2) | Positif ou nul |
| `price_reduction_rules` | jsonb | Règles structurées/versionnées |
| `document_completeness_score` | numeric(5,2) | `[0,100]` |
| `active`, `created_at`, `updated_at` | boolean/timestamptz | Projection courante; un lot inactif ne peut porter une prédiction `ready` |

Intégration transitoire : un pont nullable et non destructif relie le lot à `auction_sales.id`. La suppression d’une annonce ne supprime jamais le lot.

#### `auction_lot_parcels`

Association plusieurs-à-plusieurs `lot_id`, `parcel_id`, avec rôle (`primary`, `included`, `access`) et confiance. Clé unique sur le couple.

#### `auction_lot_buildings`

Association plusieurs-à-plusieurs `lot_id`, `building_id`, avec rôle et confiance. Clé unique sur le couple.

#### `auction_rounds`

Une tentative de vente à une date donnée.

| Champ | Type | Contrat |
|---|---|---|
| `id`, `lot_id` | uuid | PK et FK lot |
| `round_kind` | text | Vocabulaire contrôlé |
| `sequence_number` | integer | `>= 1`, unique par lot |
| `scheduled_at` | timestamptz | Peut être inconnu au brouillon |
| `local_timezone` | text | `Europe/Paris` par défaut |
| `actual_started_at`, `actual_ended_at` | timestamptz | Observations factuelles |
| `court_id` | uuid | FK tribunal, obligatoire |
| `hearing_room` | text | Sans identité personnelle |
| `initial_starting_price_eur`, `effective_starting_price_eur` | numeric(14,2) | Positif ou nul |
| `price_steps_eur` | numeric(14,2)[] | Paliers ordonnés |
| `first_bid_level_eur` | numeric(14,2) | Premier niveau constaté |
| `current_status` | text | Projection de la machine d’état |
| `previous_round_id` | uuid | Round précédent du même lot |
| `publication_first_seen_at`, `result_first_seen_at` | timestamptz | Délais séparés |
| `status_confidence` | numeric(5,4) | `[0,1]` |

Contrainte : un report conserve le round original et crée une nouvelle ligne liée.

Une prédiction `ready` n’est admise que pour les états prévisionnels `scheduled`, `confirmed`, `surenchere_round_scheduled` et `reiteration_round_scheduled`.

#### `auction_events`

Journal append-only de toute transition, correction ou observation métier.

| Champ | Contrat |
|---|---|
| `case_id`, `lot_id`, `round_id` | Au moins l’entité pertinente; cohérence vérifiée |
| `event_type` | Transition ou événement contrôlé |
| `event_at` | Moment métier, nullable s’il est inconnu |
| `observed_at` | Moment de connaissance, obligatoire |
| `source_id`, `raw_artifact_id` | Provenance |
| `actor_user_id`, `actor_organization_id` | Auteur humain/organisation |
| `payload` | Détails versionnés, sans modifier les colonnes communes |
| `confidence_score` | `[0,1]` |
| `supersedes_event_id`, `correction_reason` | Correction explicite |
| `created_at` | Insertion |

Accès : insert via commandes autorisées; aucun update/delete applicatif.

#### `auction_outcomes`

Versions canoniques du résultat d’un round.

| Champ | Type | Contrat |
|---|---|---|
| `id`, `round_id` | uuid | PK et FK round |
| `version` | integer | Commence à 1; unique par round |
| `outcome_status` | text | Vocabulaire contrôlé |
| `initial_hammer_price_eur`, `final_hammer_price_eur` | numeric(14,2) | Positif ou nul |
| `taxed_costs_eur` | numeric(14,2) | Positif ou nul |
| `bidder_count_bucket` | text | Bucket contrôlé |
| `surenchere_status`, `surenchere_filed_at`, `surenchere_amount_eur` | mixte | État, date et montant distincts |
| `finality_status`, `payment_status` | text | Vocabulaires contrôlés |
| `result_observed_at` | timestamptz | Date de connaissance du résultat |
| `canonical_confidence` | numeric(5,4) | `[0,1]` |
| `training_eligible` | boolean | Fait d’éligibilité au moment de cette version, faux par défaut |
| `valid_from`, `valid_to` | timestamptz | Fenêtre logique; la fin est dérivée sans mutation de l’ancienne version |
| `supersedes_outcome_id` | uuid | Version précédente du même round |
| `created_by`, `created_at` | uuid/timestamptz | Auteur et insertion |

Une correction crée une nouvelle version. Les valeurs métier d’une version existante ne changent pas; la version courante est celle qui n’est pas supersédée ou qui possède le numéro maximal valide. Dans le chemin append-only, `valid_to` de l’ancienne ligne n’est pas renseigné par update : la fin de validité est calculée à partir de la version suivante ou d’une projection de lecture.

`training_eligible` n’est pas basculé sur une version existante après une revue. L’éligibilité courante est dérivée des preuves, revues et problèmes qualité append-only; si elle doit être matérialisée dans `auction_outcomes`, une nouvelle version est insérée.

Dans la tranche actuelle, une contrainte conservatrice force encore toutes les versions
`auction_outcomes` à `training_eligible = false`. Une future migration ne pourra ouvrir cette
promotion qu'avec le workflow preuve A/B, match confirmé, revue et tests associé.

#### `auction_outcome_evidence`

Preuve append-only soutenant une version de résultat.

| Champ | Contrat |
|---|---|
| `outcome_id` | FK résultat |
| `raw_artifact_id`, `source_id` | Document et source |
| `evidence_type`, `evidence_grade` | Nature et grade A/B/C/rejected |
| `claim_types` | Claims soutenus : date, statut, prix, finalité, surenchère, participation… |
| `lot_matching_confidence`, `round_matching_confidence` | `[0,1]` |
| `price_extraction_confidence`, `finality_confidence` | `[0,1]` |
| `review_status` | État connu à l’insertion de la preuve, pas un workflow mutable |
| `created_at` | Insertion |

Le grade n’efface pas les confiances par champ. Une preuve rejetée est conservée.

Le statut de revue courant se déduit de la suite append-only de `evidence_reviews`. Une preuve créée `pending` n’est pas mise à jour vers `approved` ou `rejected`.

#### `evidence_reviews`

Décision humaine append-only sur une preuve.

Champs : `id`, `evidence_id`, `reviewer_user_id`, `review_type`, `decision`, `field_decisions`, `notes`, `independent_review`, `reviewed_at`.

Contrainte : un utilisateur ne peut pas être les deux reviewers indépendants d’une même preuve. Les 500 premiers résultats exigent une revue à 100 % et une double revue indépendante à 20 %.

#### `auction_participation_observations`

Observation non canonique du niveau de participation.

Champs minimaux : `id`, `round_id`, `outcome_id`, `bidder_count_bucket`, `observer_type`, `observation_method`, `confidence_score`, `source_id`, `raw_artifact_id`, `observed_at`, `created_at`.

Plusieurs observations contradictoires sont conservées et créent, si nécessaire, un problème qualité.

### Features, cohortes et prédictions

#### `feature_definitions`

Catalogue versionné des features autorisées.

Champs minimaux : `id`, `feature_name`, `feature_schema_version`, `data_type`, `description`, `source_kind`, `leakage_policy`, `contains_personal_data`, `active`, `created_at`.

Contrainte : aucun champ de magistrat, greffe, plafond individuel ou résultat post-audience.

#### `auction_feature_snapshots`

Copie immuable des données disponibles à un cutoff.

| Champ | Contrat |
|---|---|
| `lot_id`, `round_id` | Entités scorées |
| `prediction_horizon`, `feature_cutoff_at` | Horizon et cutoff |
| `built_at` | Date de construction |
| `feature_schema_version`, `feature_builder_version` | Reproductibilité |
| `features` | Valeurs validées |
| `source_manifest`, `source_manifest_hash` | Sources, dates et versions |
| `snapshot_hash` | Hash canonique du snapshot |
| `market_estimate_version` | Version de valorisation |
| `dvf_release`, `bdnb_release`, `rnic_release`, `dpe_release` | Releases ouvertes |
| `data_completeness_score`, `data_freshness_score` | `[0,100]` |
| `leakage_check_status` | Résultat au moment de l’insertion : `pending`, `passed`, `failed` |
| `retrospective`, `training_eligible` | Faits figés de cette construction; faux par défaut pour l’éligibilité |
| `created_at` | Insertion |

Un snapshot reconstruit après audience est `retrospective = true` et non éligible tant que l’existence antérieure de chaque donnée n’est pas prouvée.

Le builder doit idéalement terminer les contrôles anti-fuite avant l’insertion et écrire directement `passed` ou `failed`. Une ligne restée `pending` demeure inéligible et n’est pas mutée. Si une preuve historique justifie ultérieurement une reconstruction, un nouveau snapshot avec un nouveau hash et un lien de provenance vers la reconstruction précédente est inséré.

#### `cohort_definitions`

Définit les dimensions et le fallback d’une cohorte.

Champs minimaux : `id`, `name`, `version`, `dimensions`, `filters`, `parent_cohort_id`, `minimum_sample_size`, `active`, `created_at`.

Dimensions autorisées : national, région judiciaire, tribunal, procédure, type de bien, occupation, tranche de décote. Aucune identité individuelle judiciaire.

#### `cohort_statistics`

Agrégat versionné pour une définition et une période.

Champs minimaux : `id`, `cohort_definition_id`, `period_start`, `period_end`, `computed_at`, `sample_size`, `eligible_sample_size`, `statistics`, `source_snapshot_hash`, `status`, `created_at`.

Contrat : `n < 10` interdit une statistique autonome. Les quantiles de prix utilisent prioritairement `log(prix_final / mise_effective)` et restent monotones.

#### `model_versions`

Registre des modèles d’issue judiciaire, distinct du registre de valorisation immobilière existant.

Champs minimaux : `id`, `model_key`, `segment`, `version`, `model_kind`, `training_window`, `feature_schema_version`, `artifact_uri`, `artifact_hash`, `metrics`, `calibration`, `status`, `approved_by`, `approved_at`, `created_at`.

Statuts initiaux : `draft`, `validated`, `shadow`, `active`, `retired`, `rejected`. Une seule version active par `model_key` et segment.

#### `auction_predictions`

Sortie immuable d’un modèle ou d’une baseline pour un snapshot.

| Champ | Contrat |
|---|---|
| `round_id`, `snapshot_id`, `model_version_id`, `cohort_statistics_id` | Traçabilité obligatoire pour une sortie `ready` |
| `prediction_kind` | `outcome_graph` pour la restitution publiée, `shadow` pour l’évaluation silencieuse |
| `prediction_status` | `ready` ou `insufficient_data`; ce dernier exige un motif |
| `generated_at`, `created_at`, `horizon` | Temps de calcul, insertion et portée; `created_at >= generated_at` |
| `conditional_on` | Conditions visibles, par exemple audience tenue |
| `probabilities` | Valeurs `[0,1]` et somme cohérente quand catégories exclusives |
| `quantiles` | `P05…P95`, montants en centimes entiers et ordre monotone |
| `expected_value_eur` | `numeric(14,2)` si pertinent |
| `confidence_level`, `confidence_label` | Score et libellé explicites |
| `sample_size` | Échantillon éligible réellement utilisé |
| `explanation_factors` | Facteurs agrégés, sans donnée personnelle |
| `prediction_hash` | Hash du contrat canonique |
| `supersedes_prediction_id` | Lien append-only vers la prédiction précédente du même round, type et horizon |
| `superseded_by` | Pointeur avant réservé à la compatibilité; toujours `NULL` dans le chemin strict |

La chaîne `supersedes_prediction_id` progresse strictement en `generated_at`. Un index unique interdit plusieurs successeurs de la même prédiction et le validateur rejette les branches ou les liens incohérents. `superseded_by` n’autorise aucune mutation de l’ancienne sortie et reste nul. Le repository ne le filtre pas : il lit la prédiction `outcome_graph` la plus récente par `generated_at`, puis `created_at`, décroissants.

Une sortie `ready` exige un lot actif, un round dans l’un des quatre états prévisionnels admis, une date d’audience et une provenance complète/admissible. Un snapshot refusé ne contribue pas sa valeur de marché au DTO de refus. Si le refus ne possède aucune provenance, `generatedAt`, `horizon` et `modelVersion` valent `null` plutôt qu’une valeur inventée.

### Qualité et audit

#### `data_quality_issues`

Problème de donnée relié à une ou plusieurs entités.

Champs minimaux : `id`, `issue_type`, `severity`, `status`, `case_id`, `lot_id`, `round_id`, `outcome_id`, `evidence_id`, `details`, `blocking_training`, `detected_at`, `resolved_at`, `resolved_by`, `resolution_notes`.

La résolution n’efface ni le problème ni la valeur originale.

#### `audit_log`

Journal append-only des actions sensibles.

Champs minimaux : `id`, `occurred_at`, `actor_user_id`, `actor_organization_id`, `action`, `entity_type`, `entity_id`, `request_id`, `ip_hash`, `metadata`, `success`, `error_code`.

Le journal ne contient pas de secret, contenu intégral de preuve, plafond privé ou donnée personnelle inutile.

## Contrats de restitution

### Projection de prévision premium

La réponse de lecture d’une audience expose logiquement :

```json
{
  "saleId": "legacy-sale-uuid",
  "roundId": "uuid",
  "snapshotId": "uuid",
  "predictionId": "uuid",
  "modelVersion": "outcome-baseline-v1",
  "status": "ready",
  "generatedAt": "2026-07-30T10:00:00Z",
  "horizon": "T-7",
  "startingPriceCents": 9000000,
  "effectiveStartingPriceCents": 9000000,
  "marketEstimate": {
    "p50Cents": 17200000,
    "version": "market-model-version"
  },
  "course": {
    "hearingHeld": 0.88,
    "postponed": 0.08,
    "cancelledOrNotRequested": 0.04,
    "adjudicatedGivenHeld": 0.91,
    "noBidGivenHeld": 0.09
  },
  "initialPrice": {
    "p05Cents": 11500000,
    "p10Cents": 12300000,
    "p20Cents": 13000000,
    "p30Cents": 13600000,
    "p40Cents": 14100000,
    "p50Cents": 14600000,
    "p60Cents": 15100000,
    "p70Cents": 15800000,
    "p80Cents": 16700000,
    "p90Cents": 17900000,
    "p95Cents": 19000000
  },
  "surenchere": { "filedGivenInitialAdjudication": 0.10 },
  "finalPrice": {
    "p05Cents": 11800000,
    "p10Cents": 12600000,
    "p20Cents": 13400000,
    "p30Cents": 14100000,
    "p40Cents": 14600000,
    "p50Cents": 15100000,
    "p60Cents": 15800000,
    "p70Cents": 16600000,
    "p80Cents": 17600000,
    "p90Cents": 18800000,
    "p95Cents": 20100000
  },
  "ceiling": null,
  "pressure": {
    "score": 76,
    "label": "élevée",
    "version": "pressure-v1",
    "components": [
      { "key": "discount", "score": 88, "weight": 0.30 },
      { "key": "adjudication", "score": 91, "weight": 0.20 },
      { "key": "qualified_demand", "score": 72, "weight": 0.20 },
      { "key": "history", "score": 64, "weight": 0.15 },
      { "key": "liquidity", "score": 75, "weight": 0.15 }
    ]
  },
  "confidence": {
    "label": "moyen",
    "sampleSize": 47,
    "knownCourtResults": 19
  },
  "delays": {
    "heldWithin30DaysProbability": 0.71,
    "heldWithin60DaysProbability": 0.90,
    "resultKnownWithin48HoursProbability": 0.78,
    "finalityKnownWithin15DaysProbability": 0.83,
    "newRoundWithin4MonthsAfterSurenchereProbability": 0.66
  },
  "explanationFactors": [
    { "label": "Cohorte de référence", "direction": "neutral" },
    { "label": "Décote de départ", "direction": "up" }
  ],
  "limitations": [
    "Prévision statistique, pas une garantie de déroulement ni de prix."
  ],
  "refusalReason": null
}
```

Ce JSON illustre les types et distinctions, pas un droit de retourner des valeurs inventées. Le repository laisse `ceiling` nul; l’UI peut le recalculer localement à partir d’un montant privé. Si une composante est indisponible, la réponse porte un objet de refus avec code, message, échantillon et prochaine condition d’éligibilité.

### Scénario de plafond privé

Entrée : montant en centimes entiers strictement positif, lié à l’utilisateur et à la requête.

Sorties distinctes :

- `finalPriceBelowOrEqualIfAdjudicatedProbability`;
- `adjudicationAndFinalPriceBelowOrEqualProbability`.

Le plafond n’est écrit ni dans `auction_feature_snapshots`, ni dans `cohort_statistics`, ni dans les données d’un autre utilisateur. La formulation « probabilité de gagner » est interdite.

### Refus

Codes initiaux :

| Code | Cas |
|---|---|
| `OUTCOME_GRAPH_NOT_ENTITLED` | Ni administrateur, ni premium manuel, ni abonnement Analyse actif/non expiré |
| `OUTCOME_GRAPH_NOT_LINKED` | Annonce non reliée à un lot/round |
| `OUTCOME_GRAPH_NO_SNAPSHOT` | Aucun snapshot admissible |
| `OUTCOME_GRAPH_LOW_SAMPLE` | Échantillon autonome inférieur à 10 |
| `OUTCOME_GRAPH_LOW_QUALITY` | Preuve, complétude ou fraîcheur insuffisante |
| `OUTCOME_GRAPH_CONFLICT` | Conflit bloquant non résolu |
| `OUTCOME_GRAPH_NO_ACTIVE_MODEL` | Aucune baseline/version approuvée disponible |

Un refus est une sortie normale et observable; il ne doit pas être remplacé par une probabilité par défaut. Un snapshot rejeté ne fournit pas de valeur de marché, et une provenance absente reste représentée par des champs nuls.

## Règles de compatibilité

- L’identifiant UI historique `auction_sales.id` peut sélectionner un lot/round via un pont, mais n’est pas l’identité métier du lot.
- `auction_sales.adjudication_price_eur` ne suffit pas à déterminer prix initial, prix définitif, finalité ou surenchère.
- `valuation_model_versions` estime la valeur de marché; `model_versions` estime les issues judiciaires.
- `auction_sale_history` audite un catalogue mutable; `auction_events` exprime le cycle judiciaire.
- `auction_documents` peut devenir la provenance d’un `raw_artifact`, mais ne devient une preuve A/B qu’après rattachement et revue.
- Les nouvelles données append-only ne sont jamais supprimées lors du nettoyage des annonces expirées.
