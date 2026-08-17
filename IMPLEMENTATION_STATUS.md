# Outcome Graph — statut d’implémentation

_Mis à jour le 17 août 2026. Ce fichier distingue les capacités réellement présentes dans le dépôt et en production des phases cibles du cahier des charges. Une table créée ne signifie pas que son workflow est opérationnel; une UI visible ne signifie pas que la donnée est disponible à l’échelle nationale._

## Légende

| Statut             | Définition                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| **Livré**          | Code présent et chemin principal couvert par un test pertinent            |
| **Partiel**        | Sous-ensemble démontrable; critères de phase non tous satisfaits          |
| **Préparatoire**   | Schéma ou contrat présent, sans producteur/workflow de production complet |
| **Non implémenté** | Aucun parcours complet dans cette livraison                               |
| **Préexistant**    | Capacité du produit avant Outcome Graph; ne compte pas comme phase livrée |

## Résumé honnête

La release livre une **tranche verticale partielle** : audit et contrats, sous-ensemble de fondation relationnelle du registre, baseline descriptive déterministe, contrôle d’accès premium et restitution en lecture sur la fiche Analyse. Elle contient aussi une première chaîne d’ingestion Outcome : connecteurs et parseurs DVF/Judilibre/Justice/Enchères, provenance append-only, bucket privé, file de jobs, checkpoints et CLI bornée. Les 84 migrations historiques ont été rejouées depuis zéro puis appliquées au Supabase de production le 31 juillet 2026. Le pont catalogue a relié les 413 ventes sans recopier de prix ni rendre un résultat entraînable. Une composante n’est considérée livrée ci-dessous qu’après présence de son implémentation et vérification correspondante; la checklist factuelle prévaut sur ce résumé.

Le worktree contient désormais une **nouvelle tranche déployée uniquement en Preview sur un staging isolé et sans données** : matching Judilibre vers des candidats de revue, registre d’éligibilité par claim, snapshots statistiques national/tribunal, builder déterministe, API Premium, interface `/tribunaux` et documentation dédiée. Cette tranche ne fait pas partie des migrations déjà appliquées en production. `TRIBUNAL_STATISTICS_ENABLED=false` reste la valeur par défaut côté API et builder; aucun snapshot statistique réel n’a été construit ou persisté et aucune donnée tribunal n’est servie en production.

Le worktree contient aussi un **harnais d'évaluation Outcome** et une migration de promotion fail-closed, désormais appliquée au staging isolé. Il mesure couverture, calibration, prix, biais par segment et stabilité sur un split temporel explicite, en dry-run par défaut. La persistance prospective exige `--persist`, la valeur serveur exacte `OUTCOME_EVALUATION_ENABLED=true`, un modèle `shadow` existant et une lecture base; JSON ne peut jamais être persisté. Le replay historique persistant reste volontairement verrouillé tant qu'aucun exécuteur audité ne sait recharger et rescorrer l'artefact exact d'un modèle `validated`. Le replay local final des 87 migrations et les 485 assertions pgTAP ont réussi le 17 août 2026; aucun modèle n'a obtenu le statut statistique `passed`. La Preview Vercel est déployée contre ce staging avec les trois kill switches fermés.

Les prototypes transversaux des phases 9 à 11 n’autorisent pas à considérer ces phases validées avant les phases 3 à 8. Ils servent à éprouver le contrat et l’intégration premium, sans contourner l’ordre de construction du registre, des preuves, du matching et des snapshots. La restitution Outcome Graph utilise l’entitlement Analyse existant. La nouvelle tranche tribunal ajoute un kill switch dédié `TRIBUNAL_STATISTICS_ENABLED`, fermé par défaut; `JUDILIBRE_ENABLED` reste également fermé pour toute ingestion distante.

Elle ne constitue pas encore :

- un registre national alimenté automatiquement;
- une chaîne complète de preuves et double revue utilisable sans accès base;
- un builder automatique de snapshots T-30/T-14/T-7/T-1/T-2h;
- des snapshots statistiques tribunal réels, revus et disponibles en production;
- un modèle entraîné, calibré ou validé en shadow mode;
- des statistiques nationales suffisamment complètes pour produire une prédiction d’adjudication viable;
- un portail cabinet, une administration Outcome Graph, un scheduler de collecte, un janitor d'artefacts orphelins ou un worker de purge physique complet;
- les runbooks détaillés ingestion/revue/restauration et les autres artefacts d’exploitation attendus pour une plateforme complète; les model cards et runbooks Outcome Graph et statistiques tribunal couvrent seulement les parcours actuellement codés;
- une offre commercialement validée contre les seuils de 1 000 résultats A/B et 300 résultats prospectifs.

## Tranche verticale de cette livraison

### Phase 0 — audit et contrats : livré

- état documenté de l’architecture npm/Next.js et pip/Python;
- cartographie du schéma mutable actuel et de ses flux;
- intégration premium/Stripe existante identifiée;
- architecture cible et plan de migration sans rupture;
- dictionnaire des tables, états, preuves, snapshots et contrats de restitution;
- README existant conservé sans modification.

Fichiers :

- `docs/architecture/current-state.md`;
- `docs/architecture/target-state.md`;
- `docs/data-dictionary.md`;
- `IMPLEMENTATION_STATUS.md`.

Documentation d’exploitation complémentaire :

- `docs/model-card-outcome-graph.md` décrit honnêtement la baseline déterministe, ses tests et l’absence de validation statistique;
- `docs/model-card-outcome-evaluation.md` décrit le protocole temporel, les seuils commerciaux, la persistance prospective verrouillée et l'absence actuelle de modèle promouvable;
- `docs/model-card-tribunal-statistics.md` décrit les agrégats historiques expérimentaux, leurs seuils et l’absence de pouvoir prédictif validé;
- `docs/security/outcome-graph.md` sépare les contrôles présents des surfaces encore non livrées;
- `docs/runbooks/outcome-graph.md` couvre refus, monitoring, migration additive et rollback non destructif.
- `docs/runbooks/tribunal-statistics.md` décrit le dry-run, le persist explicite, le kill switch et les conditions de non-activation;
- `openapi.yaml` documente la route Outcome Graph existante et le contrat local de statistiques tribunal, sans prétendre que cette dernière est active en production.

### Fondation et registre : socle partiel déployé

La migration `20260730105842_outcome_graph_foundation.sql` crée un sous-ensemble additif de 16 tables : référentiels Outcome, politique source, artefacts, dossier/lot/round, événements/résultats/preuves/revues, snapshots, cohortes, versions de modèle et prédictions. Elle ajoute un pont nullable avec `auction_sales`, active la RLS sur ces 16 tables, retire tout grant et toute policy navigateur, réserve les écritures au `service_role` et installe huit triggers append-only, une garde d’immutabilité et de transition des modèles qui fige la provenance d’approbation après `draft`, une garde durable des entrées d’audience après le premier snapshot, plus trois validations d’insertion pour snapshots, prédictions et versions de modèle. Les validateurs snapshot/prédiction verrouillent le round avec `FOR SHARE` pendant leurs contrôles; une prédiction doit reprendre exactement la taille de sa cohorte. Le contrôle anti-fuite exige aussi une génération après le build, un schéma de features identique, un modèle créé et approuvé avant la prédiction, un cutoff d’entraînement antérieur ou égal au cutoff des features, ainsi qu’une cohorte créée et bornée avant ce même cutoff. Une prédiction `ready` exige enfin un lot actif et un round encore prévisionnel (`scheduled`, `confirmed`, `surenchere_round_scheduled` ou `reiteration_round_scheduled`).

La projection premium n’est accessible que par l’API serveur après authentification et entitlement. Une prédiction client `outcome_graph` exige un modèle `active`; une prédiction `shadow` exige un modèle `shadow` et n’est pas sélectionnée par le repository client.

La migration complémentaire `20260730141957_outcome_source_ingestion.sql` ajoute sept tables pour fetches, extractions, checkpoints, jobs, candidats source, matching et purges, ainsi qu’un bucket Storage privé. `20260730163756_outcome_catalogue_bridge.sql` ajoute un pont durable entre le catalogue mutable et Outcome Graph : tous les statuts du catalogue deviennent uniquement une annonce et un résultat `unknown`, non entraînable, sans recopier de prix d’adjudication. La suppression d’une ligne catalogue échoue si ce pont complet n’existe pas.

Le schéma constitue un **socle de production partiel** : replay local depuis zéro des 84 migrations, 274/274 assertions pgTAP, trois migrations distantes appliquées sans dérive, 24 nouvelles tables avec RLS et aucun grant direct `anon`/`authenticated`. Il reste un sous-ensemble du dictionnaire cible : organisations et rôles fins, parcelles/bâtiments normalisés, observations de participation, qualité/audit et plusieurs invariants de workflow restent à ajouter. Le contrat SQL de prédiction sépare le report de l’annulation/non-réquisition, mais valide encore P10/P50/P90 seulement, alors que la cible porte la grille P05…P95.

Ne sont pas inclus par ces migrations : un backfill national de résultats judiciaires vérifiés, les formulaires opérateur, le workflow complet de revue, le scheduler régulier, le worker de purge physique et la résolution automatique des conflits. Aucun artefact DVF ou Judilibre n’a encore été envoyé au Supabase distant. Le code du pipeline et les migrations ont été coordonnés autour de la garde de suppression volontairement fail-closed.

La migration `20260731143651_tribunal_statistics_snapshots.sql` est postérieure à ce socle de production. Elle prépare des décisions d’éligibilité et leurs preuves par claim, ainsi que des snapshots statistiques et leurs membres append-only, avec RLS, accès réservé au `service_role`, validations temporelles et contrôles de cohérence. La migration complémentaire `20260731154054_judilibre_match_review_guard.sql` réserve les décisions humaines terminales à des RPC administrateur authentifiées qui dérivent l’identité de `auth.uid()`. Ces migrations n’ont pas été appliquées au Supabase de production; elles ont été appliquées le 1er août 2026 à une branche Supabase éphémère, isolée et sans copie de données. Les deux flags de la Preview associée restent fermés. Le staging contient donc le schéma et les contrôles, mais aucun dossier, lot, round, résultat, candidat ou snapshot permettant une validation statistique réelle.

### Ingestion des sources : partiel, données locales réelles et chaîne fail-closed

- DVF 2025 DGFiP : 1 604 candidats `Adjudication` issus de 4 938 lignes normalisables, toujours non entraînables ; les ventes de marché restent isolées à toutes les lectures et à l’entraînement de valorisation.
- Référentiels Justice : 35 029 compétences territoriales et 1 470 structures validées.
- Enchères Publiques : 14 550 audiences candidates et 167 références d’organisateur ; le fichier observé ne contient ni prix ni résultat et reste tiers, grade C, manuel et inactif.
- Judilibre : client PISTE typé, bootstrap ciblé sur six profils v2 (`saisie immobilière`, `vente forcée`, `adjudication`, `adjuge`, `mise à prix`, `surenchère`), avec plafonds distincts par fenêtre et par run, subdivision adaptative et double lecture stable des métadonnées. L'extraction déterministe produit uniquement des claims candidats de mise à prix, prix d'adjudication ou événement procédural, avec provenance sans texte. Le canary et des audits PISTE bornés en lecture seule ont validé le contrat sans écriture Supabase/Storage ; sur les 11 résultats récents du profil expérimental exact `adjuge`, 5 prix d'adjudication et 5 événements ont été extraits comme candidats non entraînables. L'ingestion reste désactivée.
- Matching Judilibre local : une commande bornée et dry-run par défaut rapproche uniquement des projections minimisées avec les audiences candidates à partir de signaux objectifs de tribunal, date et référence exacte. Même avec `--persist`, elle ajoute seulement un candidat append-only nécessitant une revue humaine; elle ne confirme aucun lien, ne crée aucun outcome et ne modifie jamais l’éligibilité d’entraînement. Cette commande n’a pas été exécutée contre la production.
- Pont catalogue : quel que soit leur statut — notamment `upcoming`, `past` ou `adjudicated` — les 413 lignes distantes sont préservées comme annonces avec résultat `unknown`, sans prix et avec `training_eligible = false`. Le backfill du 31 juillet 2026 est complet et idempotent : 413 ponts, aucune filiation cassée, aucun prix recopié et aucune ligne entraînable. Les quatre prix affichés dans le catalogue restent exclus des labels.
- Les adapters raccordent ces sorties au service commun, lequel vérifie la politique source avant Storage et dans la transaction de provenance. La CLI impose une limite ou un `--all` explicite pour les imports réels.

Chaque candidat source est verrouillé à `training_eligible = false`. Par sécurité, les résultats canoniques restent eux aussi non entraînables tant que le workflow rattachement + preuve A/B + revue n'est pas livré. Le modèle n’a pas été réentraîné avec ces données.

### Baseline descriptive : partiel

`src/lib/outcome-graph.ts` fournit une baseline de cohorte déterministe, pas un modèle de machine learning entraîné. Le calcul :

- refuse une cohorte non éligible, conflictuelle ou de moins de 10 résultats;
- valide des probabilités conditionnelles et des quantiles monotones;
- produit P10/P50/P90 à partir de ratios de cohorte;
- sépare probabilité conditionnelle sous plafond et probabilité combinée avec adjudication;
- calcule une pression concurrentielle explicable et une confiance liée à l’échantillon;
- préserve `unknown` au lieu de le convertir en zéro;
- expose des limitations et un motif de refus.

Cette baseline ne prétend ni battre les baselines du cahier des charges, ni être calibrée, ni être entraînée sur 1 000 résultats vérifiés. Les cohortes de démonstration ou fixtures ne sont pas des statistiques nationales de production. Les statistiques disponibles aujourd’hui restent insuffisantes pour annoncer une prédiction nationale fiable.

Elle expose actuellement P10/P50/P90, et non encore toute la grille P05 à P95. Les sorties de déroulement séparent désormais `P(report)` et `P(annulation ou non requise)`.

### Évaluation et promotion du modèle : préparatoire local, désactivé

`services/data-pipeline/src/outcome_evaluation/` fournit un évaluateur déterministe sans effet de bord par défaut. Il impose un split entraînement/validation/test groupé par lot, des labels A/B disponibles au cutoff, des snapshots et prédictions strictement antérieurs à l'audience, des baselines choisies sur validation puis verrouillées sur test, et des métriques de classification, prix, calibration, couverture, segments et stabilité. Les segments de moins de 30 labels restent supprimés.

La politique immuable `outcome-commercial-v1` exige notamment 1 000 labels A/B au total, 300 labels et 300 prédictions scorées dans le test ou la période prospective, 100 prix définitifs admissibles, au moins 30 labels par classe, 80 % de couverture snapshot/prédiction, ECE ≤ 0,05, couverture P10–P90 entre 75 % et 85 %, deux trimestres qualifiés, PSI < 0,20 et amélioration stricte face aux baselines verrouillées. Une métrique, une classe ou une période manquante produit `insufficient_data`, jamais une réussite implicite.

La migration locale `20260801133817_outcome_evaluation_gate.sql` prépare un registre agrégé append-only et les transitions `validated → shadow → active`, sous RLS et sans accès navigateur. La CLI reste en dry-run sauf demande de persistance prospective explicitement autorisée. Les manifestes lient les données source, segments, horizon, prix de départ, prédictions et résultats; l'insertion est paramétrée et idempotente. Le résumé persisté est fermé, agrégé et sans identifiant individuel. Le calcul courant ne dispose toutefois d'aucun corpus réel suffisant et aucun exécuteur d'artefact validé n'est livré pour le replay historique : l'état justifié reste `insufficient_data`, `OUTCOME_EVALUATION_ENABLED=false`, sans promotion ni activation.

### Statistiques descriptives par tribunal : préparatoire local, désactivé

Cette fonctionnalité est distincte de la baseline prédictive Outcome Graph. Elle décrit un historique agrégé; elle ne calcule aucune probabilité individuelle d’adjudication ni aucun prix futur.

Le worktree contient :

- la migration locale `20260731143651_tribunal_statistics_snapshots.sql`, qui prépare l’éligibilité A/B par claim, les manifestes privés, les snapshots national/tribunal et leurs membres append-only;
- `services/data-pipeline/src/outcome_statistics/`, builder déterministe limité aux audiences initiales, fenêtres 12/24/36 mois, cutoff temporel et délai de maturité, avec inconnus/exclusions explicites, finalité procédurale pour les ratios de prix, seuils de suppression/lissage et quality gate de revue;
- une CLI dry-run par défaut, bornée par `--max-rounds`; la persistance exige à la fois `TRIBUNAL_STATISTICS_ENABLED=true`, une base explicitement configurée et `--persist`;
- `GET /api/v1/tribunals/statistics`, qui authentifie puis vérifie l’entitlement `sales.statistics` avant toute lecture, valide un DTO public strict et répond en `private, no-store`;
- la page authentifiée `/tribunaux`, avec aperçu Découverte entièrement fictif et chargement des données réelles réservé aux comptes Analyse/Premium;
- une model card, un runbook et un contrat OpenAPI dédiés.

État opérationnel : **aucun de ces éléments n’est déployé ou activé en production**. Le flag reste à `false`, les migrations n’ont pas été appliquées à distance, aucun snapshot réel n’existe et aucune statistique tribunal réelle n’est actuellement affichée. La tranche finale passe les suites TypeScript, Python et PostgreSQL locales, ainsi qu’un dry-run réel sans donnée et sans écriture. Cela valide un chemin logiciel fail-closed; cela ne valide ni couverture, ni représentativité, ni fiabilité prédictive.

### Restitution premium : partiel, TypeScript et tests ciblés validés

La fonctionnalité s’intègre à la matrice existante sous la clé `property.outcomeGraph` :

- Découverte : `locked`;
- Analyse : `included`;
- l’accès effectif continue de couvrir administrateur, premium manuel ou abonnement Analyse actif/non expiré;
- la route API source authentifie avant la lecture et doit rester la frontière d’autorisation; le masque client n’est qu’une présentation;
- le composant de fiche Analyse prévoit une restitution et un état d’indisponibilité;
- le repository lit le pont vente/lot, le dernier round, la prédiction et sa provenance, puis refuse toute cohorte non éligible ou chronologie incohérente;
- il sélectionne la dernière prédiction `outcome_graph` par `generated_at`, puis `created_at`, décroissants; la supersession append-only pointe vers la version précédente avec `supersedes_prediction_id` et ne dépend pas de `superseded_by`;
- un snapshot refusé ne fournit aucune valeur de marché issue de ses features, et un refus sans provenance conserve `generatedAt`, `horizon` et `modelVersion` à `null`;
- le repository restitue `ceiling: null`; le P50 initial et tout calcul utilisant un plafond privé restent strictement dans le navigateur;
- les tests ciblés, TypeScript et le build Next de développement passent dans le worktree audité;
- la suite complète courante de 100 fichiers/439 tests passe également dans ce worktree.

La restitution Outcome Graph ne démontre pas encore l’ensemble des écrans opérations, dossier, lot, audience, revue, cabinet et administration demandés. La page tribunal locale constitue une restitution descriptive séparée et non une validation de ces parcours.

## Statut par phase du cahier des charges

| Phase                | Statut                       | Ce qui existe                                                                                                                                                    | Ce qui manque pour déclarer la phase terminée                                                                                                               |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Audit            | **Livré**                    | État actuel, cible, dictionnaire, risques et migration                                                                                                           | Maintenir ces documents à chaque évolution                                                                                                                  |
| 1 — Fondation        | **Partiel**                  | Migrations historiques additives déployées, RLS sans grant navigateur, validations d’insertion et append-only; replay local et pgTAP réussis                     | Monorepo cible, pnpm/uv, rôles complets, stockage preuve et observabilité dédiée                                                                            |
| 2 — Registre         | **Partiel**                  | Dossier, lot, round, événements, versions de résultat, preuves/revues et pont catalogue fail-closed; 413 ventes pontées en production                            | CRUD complet, entités auxiliaires et parcours E2E opérateur sans SQL direct                                                                                 |
| 3 — Administration   | **Non implémenté**           | Admin générique ImmoJudis préexistant seulement                                                                                                                  | Listes, formulaires, timeline, revue et conflits Outcome                                                                                                    |
| 4 — Worker           | **Partiel**                  | `ingestion_jobs`, leases CAS, retries/dead-letter, checkpoints CAS et commandes d’ingestion bornées                                                              | Scheduler, exécuteur durable de queue, supervision, janitor d'artefacts orphelins et worker de purge physique                                               |
| 5 — Sources ouvertes | **Partiel**                  | Connecteurs/parseurs DVF, Judilibre, Justice et Enchères; extraction Judilibre candidate et canary borné en lecture seule; schéma et bucket historiques déployés | Gouverner l'archive DVF complète, approuver la première ingestion Judilibre ciblée, puis organiser imports distants et collecte régulière                   |
| 6 — Matching         | **Partiel local**            | Matcher DVF explicable; matcher Judilibre borné, dry-run par défaut et strictement producteur de candidats à revue humaine                                       | Déployer le producteur, exécuter les revues, couvrir dossier/lot/round national et résoudre les conflits sans lien automatique                              |
| 7 — Snapshots        | **Préparatoire**             | `auction_feature_snapshots`, horizons, manifeste et validation d’insertion anti-fuite                                                                            | Builder aux horizons, manifestes réels, versions temporelles et tests anti-fuite bout en bout                                                               |
| 8 — Cabinet          | **Non implémenté**           | Comptes B2B/publication génériques préexistants                                                                                                                  | Organisations, isolation cabinet, soumission résultat/preuve et rappels J+1/J+10/J+45                                                                       |
| 9 — Analytics        | **Partiel staging, désactivé** | Migration appliquée sur staging sans données, builder déterministe national/tribunal, fenêtres 12/24/36, dénominateurs/inconnus, lissage, QA et documentation                                  | Constituer des claims A/B revus et des snapshots réels; mesurer couverture, fraîcheur, biais et stabilité avant toute activation                            |
| 10 — Baseline        | **Partiel**                  | Refus `n < 10`, P10/P50/P90, déroulement séparé, plafond, pression et confiance sur fixtures; harnais local d'évaluation temporelle et baselines verrouillées      | Cohortes A/B réelles, grille complète et exécution sur un corpus atteignant les seuils commerciaux                                                           |
| 11 — Restitution     | **Partiel Preview**          | Route Outcome Graph existante; API et page Premium tribunal déployées en Preview derrière `TRIBUNAL_STATISTICS_ENABLED=false`                                    | Alimenter des snapshots vérifiés, rejouer le parcours Premium authentifié, puis compléter historique client, horizons et refus structurés                  |
| 12 — Shadow mode     | **Préparatoire staging, désactivé** | Registre d'évaluations agrégées appliqué sur staging, garde de transition, CLI prospective persistable sous flag exact et rapport de calibration fail-closed       | Exécuter le scoring prospectif avant audience, obtenir 300 résultats scorés et livrer un exécuteur d'artefact audité pour le replay historique              |

## Capacités préexistantes, non comptées comme Outcome Graph

Les éléments suivants sont des accélérateurs mais ne valident aucune phase Outcome Graph à eux seuls :

- Auth Supabase, offre Analyse et paiements Stripe;
- RLS premium sur les données d’analyse existantes;
- catalogue `auction_sales` et projections `properties`/`judicial_sales`;
- comparables DVF, cadastre, DPE et valeur de marché;
- `valuation_model_versions` et estimations immobilières;
- `auction_sale_history`, suivi d’audience utilisateur et changements d’annonce;
- pipeline multi-source actuel et GitHub Actions planifiées;
- admin, espaces de travail et publication professionnelle existants.

En particulier, la valeur de marché n’est pas une prédiction d’adjudication, l’historique d’une ligne mutable n’est pas un registre d’événements et un statut catalogue `adjudicated` ne prouve ni la finalité ni l’absence de surenchère.

## Vérification factuelle de la livraison

Cette section doit rester synchronisée avec le worktree final.

Les lignes mentionnant explicitement la production décrivent le socle historique déjà déployé. Les lignes « local » décrivent la nouvelle tranche validée dans ce worktree mais non promue; elles ne constituent pas une preuve de validation sur données réelles.

| Élément                       | Preuve attendue dans le dépôt                                                                                                                    | État                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Audit Phase 0                 | Quatre documents listés ci-dessus                                                                                                                | Présent                                                                                                                       |
| Model card                    | `docs/model-card-outcome-graph.md`                                                                                                               | Présent                                                                                                                       |
| Sécurité                      | `docs/security/outcome-graph.md`                                                                                                                 | Présent                                                                                                                       |
| Runbook                       | `docs/runbooks/outcome-graph.md`                                                                                                                 | Présent                                                                                                                       |
| OpenAPI                       | `openapi.yaml` pour Outcome Graph et le contrat local de statistiques tribunal                                                                   | Présent; contrat tribunal non activé en production                                                                            |
| Entitlement                   | Clé `property.outcomeGraph` et DTO Analyse/Découverte                                                                                            | Présent                                                                                                                       |
| Baseline                      | `src/lib/outcome-graph.ts`                                                                                                                       | Présent                                                                                                                       |
| Tests baseline/repository/API | Tests ciblés du moteur, du repository et de la route                                                                                             | Réussis le 31 juillet 2026                                                                                                    |
| Suite complète                | Vitest, 100 fichiers et 439 tests                                                                                                                | Réussi le 1er août 2026 dans le worktree final                                                                                |
| Qualité/build                 | TypeScript, ESLint et build Next                                                                                                                   | Réussis le 1er août 2026; build local de 75 pages. Les budgets de taille préexistants restent au-dessus de leurs seuils.      |
| Fondation SQL                 | `supabase/migrations/20260730105842_outcome_graph_foundation.sql` — 16 tables, contrôles append-only, workflow modèle, RLS sans grant navigateur | Présent; replay local et application production réussis                                                                       |
| Ingestion SQL                 | `supabase/migrations/20260730141957_outcome_source_ingestion.sql` — 7 tables, bucket privé, jobs, provenance, matching, purge et checkpoints CAS | Présent; replay local et application production réussis                                                                       |
| Pont catalogue SQL            | `supabase/migrations/20260730163756_outcome_catalogue_bridge.sql` — annonce durable, résultat inconnu/non entraînable et garde de suppression    | Présent; 413/413 ventes pontées en production, contrôle idempotent réussi                                                     |
| Tests base/RLS                | Suites `supabase/tests/`                                                                                                                         | Replay final local réussi le 17 août 2026 : 15 fichiers et 485 assertions pgTAP; migration finale également appliquée et contrôlée sur staging isolé |
| Connecteurs et pipeline       | `services/data-pipeline/src/official_sources/` et `src/outcome_ingestion/`                                                                       | Contrats client et extraction couverts par tests ; canary Judilibre live en lecture seule réussi, sans ingestion distante     |
| CLI source                    | `src.outcome_sources_cli` : plan, validation locale, ingestion, matching DVF et commandes Judilibre                                              | Plan et validations locales réussis; import distant non exécuté                                                               |
| Matching Judilibre local      | `services/data-pipeline/src/outcome_ingestion/judilibre_matching.py` et `services/data-pipeline/scripts/match_judilibre_candidates.py`           | Validé localement; dry-run par défaut, candidats de revue seulement; jamais exécuté en production                             |
| Manifeste/runbook source      | `docs/runbooks/outcome-source-ingestion.md`                                                                                                      | Présent, avec SHA-256, volumes, licences, limites et activation                                                               |
| Migration statistiques        | `supabase/migrations/20260731143651_tribunal_statistics_snapshots.sql` et `supabase/tests/130_tribunal_statistics.sql`                           | Validée localement puis appliquée sur staging isolé sans données; non appliquée en production                                 |
| Revue Judilibre SQL           | `supabase/migrations/20260731154054_judilibre_match_review_guard.sql` et `supabase/tests/140_judilibre_match_review_guard.sql`                   | Validée localement puis appliquée sur staging isolé sans données; non appliquée en production                                 |
| Builder statistiques          | `services/data-pipeline/src/outcome_statistics/`                                                                                                 | Dry-run local réel réussi sans écriture; flag fermé, staging vide, aucun snapshot réel                                        |
| API statistiques Premium      | `src/app/api/v1/tribunals/statistics/route.ts`, DTO et repository                                                                                | Tests locaux réussis; déployée en Preview avec flag fermé, aucun snapshot et aucune donnée servie                             |
| UI statistiques tribunal      | `src/app/tribunaux/`, `src/routes/tribunaux.tsx` et `src/components/TribunalStatisticsDashboard.tsx`                                             | Déployée en Preview; aperçu gratuit fictif, aucun snapshot réel et accès Premium non activé                                   |
| Documentation tribunal        | `docs/model-card-tribunal-statistics.md` et `docs/runbooks/tribunal-statistics.md`                                                               | Présente; décrit explicitement un outil descriptif expérimental désactivé                                                     |
| Évaluateur Outcome local      | `services/data-pipeline/src/outcome_evaluation/` et `services/data-pipeline/tests/test_outcome_evaluation.py`                                    | Dry-run par défaut; persistance prospective sous flag exact; résultat réel encore `insufficient_data`, aucun modèle promu    |
| Gate d'évaluation SQL         | `supabase/migrations/20260801133817_outcome_evaluation_gate.sql` et `supabase/tests/150_outcome_evaluation_gate.sql`                             | Appliqué et contrôlé sur staging isolé; replay local et pgTAP réussis; non appliqué en production                            |
| Preview fermée                | Déploiement Vercel relié au staging et variables de branche                                                                                      | `immojudis-dezt-b928pynvy-antoine-s-projects7.vercel.app` prêt; trois kill switches à `false`; smoke HTTP externe à rejouer   |
| Model card évaluation         | `docs/model-card-outcome-evaluation.md`                                                                                                           | Présente; seuils, limites et verrou du replay historique documentés                                                          |
| API premium                   | `src/app/api/v1/sales/[id]/outcome-graph/route.ts`, auth puis `assertFeatureEntitlement`                                                         | Présent; TypeScript et tests ciblés réussis                                                                                   |
| Restitution UI                | `OutcomeForecast` intégré uniquement à `AnalysisSaleDetailView`                                                                                  | Présent                                                                                                                       |

## Vérifications de release

```bash
npm run test
npm run lint
npx tsc --noEmit
npm run check:migrations
npm run build
```

Le socle antérieur a été validé localement par un replay depuis zéro et pgTAP. La dernière migration d'évaluation a été appliquée au staging isolé, puis l'ensemble des 87 migrations a été rejoué localement depuis zéro avec succès le 17 août 2026. `npm run check:migrations` ne vérifie que les versions de fichiers; il complète cette vérification SQL sans la remplacer.

Les résultats des commandes ne doivent être marqués réussis ici qu’après leur exécution dans le worktree final.

Checkpoint historique vérifié localement et en CI le 31 juillet 2026, avant intégration complète de la nouvelle tranche statistiques tribunal et matching Judilibre :

```text
npm run test                              → 95 fichiers, 387 tests réussis
npx tsc --noEmit                          → réussi
npm run build:dev                         → build Next réussi
npm run test:security-invariants          → réussi, y compris les invariants d’ingestion source
npm run check:migrations                  → 84 versions locales uniques
supabase db reset --local --no-seed       → 84 migrations rejouées depuis zéro
supabase test db                          → 274/274 assertions pgTAP réussies
pytest hors test_valuation_training.py    → 694 tests réussis
```

Au 1er août, `test_valuation_training.py` n’était pas collectable sous l’interpréteur local Python 3.14, mais la suite complète réussissait dans la CI cible sous Python 3.11 et 3.12. L’environnement local a depuis été reconstruit sous Python 3.11.16 et la suite complète passe. Cette validation logicielle ne constitue pas une validation statistique du modèle.

Validation initiale de la tranche locale le 1er août 2026 (historique) :

```text
npm run test                              → 100 fichiers, 439 tests réussis
npm run lint                              → réussi
npx tsc --noEmit                          → réussi
npm run build:dev                         → réussi, 75 pages générées
npm run test:security-invariants          → 18 invariants réussis
npm run check:migrations                  → 87 versions locales uniques
supabase db reset --local --no-seed       → checkpoint réussi avant la migration d'évaluation; rejeu final bloqué par l'environnement local
supabase test db --local                  → checkpoint 409/409 avant le dernier durcissement; suite finale à relancer
pytest hors test_valuation_training.py    → 834 tests réussis
ruff + compileall                         → réussis
dry-run builder local                     → réussi, 0 round et 0 écriture
API sans session                          → 401, private/no-store, Vary: authorization
```

Le rendu non connecté a aussi été vérifié sans erreur console ni débordement horizontal en 1280 px et 390 px. Le parcours Premium authentifié reste couvert par les tests automatisés; il devra être rejoué avec un vrai compte de staging avant activation.

Validation ciblée du harnais d'évaluation dans le worktree final :

```text
pytest tests/test_outcome_evaluation.py                         → 44 tests réussis
pytest outcome_evaluation + outcome_statistics                 → 95 tests réussis
ruff check . + compileall src/outcome_evaluation               → réussis
git diff --check                                                → réussi
```

À cette date, ces résultats validaient le contrat logiciel local et ses refus fail-closed, mais le replay SQL final restait ouvert. La revalidation ci-dessous clôt ce point sans constituer une évaluation statistique sur données réelles.

Revalidation corrective locale du 17 août 2026 :

```text
npm run test                              → 100 fichiers, 439 tests réussis
npm run lint                              → réussi
npx tsc --noEmit                          → réussi
npm run build:dev                         → réussi, 75 pages générées
npm run test:security-invariants          → 18 invariants réussis
npm run check:migrations                  → 87 versions locales uniques
Python                                    → 3.11.16, environnement conforme
pytest                                    → 840 tests réussis, suite complète
ruff check .                              → réussi
supabase db reset --local --no-seed       → 87 migrations rejouées depuis zéro
npm run check:schema-drift                → schéma local conforme aux migrations
npm run test:db-concurrency               → réussi
supabase test db                          → 15 fichiers, 485 assertions pgTAP réussies
```

Le replay SQL local final est désormais établi. Ces résultats ne remplacent ni une validation fonctionnelle sur staging avec un compte Premium réel, ni une évaluation statistique sur données réelles; le statut modèle reste non validé.

Écarts connus du DTO prototype : P10/P50/P90 seulement et motif de refus encore en texte libre. Le contrat cible exige la grille P05…P95 et des codes de refus structurés.

## Risques et travaux suivants

1. Surveiller le socle déployé et conserver le pont catalogue complet avant toute suppression. La branche Supabase de staging est éphémère, isolée et sans données; son rejeu initial a nécessité un bootstrap de schéma propre au staging parce que l’historique ancien des migrations de production ne permettait pas une création automatique complète. Ne jamais fusionner cette réparation de staging vers la production.
2. Régénérer et révoquer les identifiants PISTE exposés pendant la configuration, stocker les nouvelles valeurs uniquement dans le coffre de secrets, conserver `JUDILIBRE_ENABLED=false`, puis faire approuver un premier bootstrap ciblé avant d'activer le suivi `tracked-only`; aucune ingestion live ne doit démarrer par défaut.
3. Exécuter le matching Judilibre uniquement en dry-run puis soumettre ses candidats à une revue humaine; ne jamais transformer un signal objectif en lien canonique ou en label entraînable automatiquement.
4. Valider DVF sans écriture tant que l’archive complète n’est pas conservée comme artefact gouverné et que son matching n’est pas opéré en preview bornée.
5. Conserver `TRIBUNAL_STATISTICS_ENABLED=false`; le schéma est présent sur staging mais il faut encore y constituer un jeu de données gouverné, exécuter le builder en dry-run, mesurer couverture/biais/stabilité/temps de verrouillage, puis contrôler auth Premium, RLS, redaction et rollback avant toute application distante de production.
6. Constituer des claims A/B réellement revus avant tout snapshot tribunal persistant; ne pas activer l’API tant qu’aucun snapshot réel ne satisfait le quality gate et les contrôles de couverture.
7. Livrer le scheduler, l’exécuteur de queue, le janitor d'artefacts orphelins et le worker de purge physique avant toute activation régulière de Judilibre.
8. Implémenter les rôles opérateur/reviewer/cabinet/analyste et leur RLS.
9. Construire les snapshots pré-audience sur des versions temporelles réelles.
10. Régénérer les types Supabase TypeScript après chaque évolution du schéma.
11. Maintenir les montants Outcome Graph en centimes entiers sûrs à toutes les frontières API.
12. Mesurer la couverture A/B, la calibration et les seuils commerciaux avant activation large. Les statistiques tribunal restent descriptives même après leur future activation.
