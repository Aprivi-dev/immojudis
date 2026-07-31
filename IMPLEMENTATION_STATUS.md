# Outcome Graph — statut d’implémentation

_Mis à jour le 31 juillet 2026. Ce fichier distingue les capacités réellement présentes dans le dépôt et en production des phases cibles du cahier des charges. Une table créée ne signifie pas que son workflow est opérationnel; une UI visible ne signifie pas que la donnée est disponible à l’échelle nationale._

## Légende

| Statut             | Définition                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| **Livré**          | Code présent et chemin principal couvert par un test pertinent            |
| **Partiel**        | Sous-ensemble démontrable; critères de phase non tous satisfaits          |
| **Préparatoire**   | Schéma ou contrat présent, sans producteur/workflow de production complet |
| **Non implémenté** | Aucun parcours complet dans cette livraison                               |
| **Préexistant**    | Capacité du produit avant Outcome Graph; ne compte pas comme phase livrée |

## Résumé honnête

La release livre une **tranche verticale partielle** : audit et contrats, sous-ensemble de fondation relationnelle du registre, baseline descriptive déterministe, contrôle d’accès premium et restitution en lecture sur la fiche Analyse. Elle contient aussi une première chaîne d’ingestion Outcome : connecteurs et parseurs DVF/Judilibre/Justice/Enchères, provenance append-only, bucket privé, file de jobs, checkpoints et CLI bornée. Les 84 migrations ont été rejouées depuis zéro puis appliquées au Supabase de production le 31 juillet 2026. Le pont catalogue a relié les 413 ventes sans recopier de prix ni rendre un résultat entraînable. Une composante n’est considérée livrée ci-dessous qu’après présence de son implémentation et vérification correspondante; la checklist factuelle prévaut sur ce résumé.

Les prototypes transversaux des phases 9 à 11 n’autorisent pas à considérer ces phases validées avant les phases 3 à 8. Ils servent à éprouver le contrat et l’intégration premium, sans contourner l’ordre de construction du registre, des preuves, du matching et des snapshots. La tranche utilise l’entitlement Analyse mais n’ajoute pas encore de kill switch runtime dédié.

Elle ne constitue pas encore :

- un registre national alimenté automatiquement;
- une chaîne complète de preuves et double revue utilisable sans accès base;
- un builder automatique de snapshots T-30/T-14/T-7/T-1/T-2h;
- un modèle entraîné, calibré ou validé en shadow mode;
- des statistiques nationales suffisamment complètes pour produire une prédiction d’adjudication viable;
- un portail cabinet, une administration Outcome Graph, un scheduler de collecte, un janitor d'artefacts orphelins ou un worker de purge physique complet;
- les runbooks détaillés ingestion/revue/restauration et les autres artefacts d’exploitation attendus pour une plateforme complète; une model card, une note sécurité et un runbook Outcome Graph courts sont désormais présents;
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
- `docs/security/outcome-graph.md` sépare les contrôles présents des surfaces encore non livrées;
- `docs/runbooks/outcome-graph.md` couvre refus, monitoring, migration additive et rollback non destructif.
- `openapi.yaml` documente la seule route de lecture premium livrée, sans annoncer les commandes opérateur futures.

### Fondation et registre : socle partiel déployé

La migration `20260730105842_outcome_graph_foundation.sql` crée un sous-ensemble additif de 16 tables : référentiels Outcome, politique source, artefacts, dossier/lot/round, événements/résultats/preuves/revues, snapshots, cohortes, versions de modèle et prédictions. Elle ajoute un pont nullable avec `auction_sales`, active la RLS sur ces 16 tables, retire tout grant et toute policy navigateur, réserve les écritures au `service_role` et installe huit triggers append-only, une garde d’immutabilité et de transition des modèles qui fige la provenance d’approbation après `draft`, une garde durable des entrées d’audience après le premier snapshot, plus trois validations d’insertion pour snapshots, prédictions et versions de modèle. Les validateurs snapshot/prédiction verrouillent le round avec `FOR SHARE` pendant leurs contrôles; une prédiction doit reprendre exactement la taille de sa cohorte. Le contrôle anti-fuite exige aussi une génération après le build, un schéma de features identique, un modèle créé et approuvé avant la prédiction, un cutoff d’entraînement antérieur ou égal au cutoff des features, ainsi qu’une cohorte créée et bornée avant ce même cutoff. Une prédiction `ready` exige enfin un lot actif et un round encore prévisionnel (`scheduled`, `confirmed`, `surenchere_round_scheduled` ou `reiteration_round_scheduled`).

La projection premium n’est accessible que par l’API serveur après authentification et entitlement. Une prédiction client `outcome_graph` exige un modèle `active`; une prédiction `shadow` exige un modèle `shadow` et n’est pas sélectionnée par le repository client.

La migration complémentaire `20260730141957_outcome_source_ingestion.sql` ajoute sept tables pour fetches, extractions, checkpoints, jobs, candidats source, matching et purges, ainsi qu’un bucket Storage privé. `20260730163756_outcome_catalogue_bridge.sql` ajoute un pont durable entre le catalogue mutable et Outcome Graph : tous les statuts du catalogue deviennent uniquement une annonce et un résultat `unknown`, non entraînable, sans recopier de prix d’adjudication. La suppression d’une ligne catalogue échoue si ce pont complet n’existe pas.

Le schéma constitue un **socle de production partiel** : replay local depuis zéro des 84 migrations, 274/274 assertions pgTAP, trois migrations distantes appliquées sans dérive, 24 nouvelles tables avec RLS et aucun grant direct `anon`/`authenticated`. Il reste un sous-ensemble du dictionnaire cible : organisations et rôles fins, parcelles/bâtiments normalisés, observations de participation, qualité/audit et plusieurs invariants de workflow restent à ajouter. Le contrat SQL de prédiction sépare le report de l’annulation/non-réquisition, mais valide encore P10/P50/P90 seulement, alors que la cible porte la grille P05…P95.

Ne sont pas inclus par ces migrations : un backfill national de résultats judiciaires vérifiés, les formulaires opérateur, le workflow complet de revue, le scheduler régulier, le worker de purge physique et la résolution automatique des conflits. Aucun artefact DVF ou Judilibre n’a encore été envoyé au Supabase distant. Le code du pipeline et les migrations ont été coordonnés autour de la garde de suppression volontairement fail-closed.

### Ingestion des sources : partiel, données locales réelles et chaîne fail-closed

- DVF 2025 DGFiP : 1 604 candidats `Adjudication` issus de 4 938 lignes normalisables, toujours non entraînables ; les ventes de marché restent isolées à toutes les lectures et à l’entraînement de valorisation.
- Référentiels Justice : 35 029 compétences territoriales et 1 470 structures validées.
- Enchères Publiques : 14 550 audiences candidates et 167 références d’organisateur ; le fichier observé ne contient ni prix ni résultat et reste tiers, grade C, manuel et inactif.
- Judilibre : client PISTE typé, bootstrap ciblé et borné sur quatre profils (`saisie immobilière`, `vente forcée`, `adjudication`, `surenchère`), puis synchronisation transactionnelle limitée aux décisions déjà suivies (`tracked-only`), avec corrections/suppressions et projection minimisée ; aucun appel live faute d’identifiants PISTE.
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
- la suite complète de 95 fichiers/387 tests passe également dans ce worktree.

La restitution ne démontre pas encore l’ensemble des écrans opérations, dossier, lot, audience, revue, tribunal, cabinet et administration demandés.

## Statut par phase du cahier des charges

| Phase                | Statut                    | Ce qui existe                                                                                                                         | Ce qui manque pour déclarer la phase terminée                                                                                                                |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — Audit            | **Livré**                 | État actuel, cible, dictionnaire, risques et migration                                                                                | Maintenir ces documents à chaque évolution                                                                                                                   |
| 1 — Fondation        | **Partiel**               | Migrations additives déployées, RLS sans grant navigateur, validations d’insertion et append-only; replay local et pgTAP réussis      | Monorepo cible, pnpm/uv, rôles complets, stockage preuve et observabilité dédiée                                                                             |
| 2 — Registre         | **Partiel**               | Dossier, lot, round, événements, versions de résultat, preuves/revues et pont catalogue fail-closed; 413 ventes pontées en production | CRUD complet, entités auxiliaires et parcours E2E opérateur sans SQL direct                                                                                  |
| 3 — Administration   | **Non implémenté**        | Admin générique ImmoJudis préexistant seulement                                                                                       | Listes, formulaires, timeline, revue et conflits Outcome                                                                                                     |
| 4 — Worker           | **Partiel**               | `ingestion_jobs`, leases CAS, retries/dead-letter, checkpoints CAS et commandes d’ingestion bornées                                   | Scheduler, exécuteur durable de queue, supervision, janitor d'artefacts orphelins et worker de purge physique                                                |
| 5 — Sources ouvertes | **Partiel**               | Connecteurs/parseurs DVF, Judilibre, Justice et Enchères; schéma et bucket déployés; provenance et politiques fail-closed             | Gouverner l’archive DVF complète, fournir les credentials PISTE, approuver le premier sync live ciblé, puis organiser imports distants et collecte régulière |
| 6 — Matching         | **Partiel**               | Matcher DVF parcelle/date explicable, prix exclu du score, adresse seule plafonnée; table append-only de candidats/revues             | Producteur DB automatique, matching dossier/lot/round national, interface de revue et résolution des conflits                                                |
| 7 — Snapshots        | **Préparatoire**          | `auction_feature_snapshots`, horizons, manifeste et validation d’insertion anti-fuite                                                 | Builder aux horizons, manifestes réels, versions temporelles et tests anti-fuite bout en bout                                                                |
| 8 — Cabinet          | **Non implémenté**        | Comptes B2B/publication génériques préexistants                                                                                       | Organisations, isolation cabinet, soumission résultat/preuve et rappels J+1/J+10/J+45                                                                        |
| 9 — Analytics        | **Prototype transversal** | Contrat de cohorte, décodeur repository et fixtures; lecture défensive d’une cohorte persistée                                        | Calcul batch national/tribunal, fallback exhaustif, délais et couverture de production                                                                       |
| 10 — Baseline        | **Partiel**               | Refus `n < 10`, P10/P50/P90, déroulement séparé, plafond, pression et confiance sur fixtures                                          | Cohortes A/B réelles, grille complète, évaluation temporelle et comparaison aux baselines                                                                    |
| 11 — Restitution     | **Partiel**               | Route premium, repository et composant sur la fiche Analyse; TypeScript, tests et build Next validés                                  | Historique client, tous horizons, refus structurés et données nationales validées                                                                            |
| 12 — Shadow mode     | **Préparatoire**          | `model_versions`, transition `validated → shadow → active` et séparation SQL `shadow`/`outcome_graph`                                 | Exécution du scoring prospectif avant audience, collecte du résultat et rapports de calibration                                                              |

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

| Élément                       | Preuve attendue dans le dépôt                                                                                                                    | État                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Audit Phase 0                 | Quatre documents listés ci-dessus                                                                                                                | Présent                                                                   |
| Model card                    | `docs/model-card-outcome-graph.md`                                                                                                               | Présent                                                                   |
| Sécurité                      | `docs/security/outcome-graph.md`                                                                                                                 | Présent                                                                   |
| Runbook                       | `docs/runbooks/outcome-graph.md`                                                                                                                 | Présent                                                                   |
| OpenAPI                       | `openapi.yaml` pour la route de lecture premium                                                                                                  | Présent                                                                   |
| Entitlement                   | Clé `property.outcomeGraph` et DTO Analyse/Découverte                                                                                            | Présent                                                                   |
| Baseline                      | `src/lib/outcome-graph.ts`                                                                                                                       | Présent                                                                   |
| Tests baseline/repository/API | Tests ciblés du moteur, du repository et de la route                                                                                             | Réussis le 31 juillet 2026                                                |
| Suite complète                | Vitest, 95 fichiers et 387 tests                                                                                                                 | Réussi le 31 juillet 2026                                                 |
| Qualité/build                 | TypeScript, ESLint, build Next et budgets                                                                                                        | Réussis le 31 juillet 2026 en local et en CI                              |
| Fondation SQL                 | `supabase/migrations/20260730105842_outcome_graph_foundation.sql` — 16 tables, contrôles append-only, workflow modèle, RLS sans grant navigateur | Présent; replay local et application production réussis                   |
| Ingestion SQL                 | `supabase/migrations/20260730141957_outcome_source_ingestion.sql` — 7 tables, bucket privé, jobs, provenance, matching, purge et checkpoints CAS | Présent; replay local et application production réussis                   |
| Pont catalogue SQL            | `supabase/migrations/20260730163756_outcome_catalogue_bridge.sql` — annonce durable, résultat inconnu/non entraînable et garde de suppression    | Présent; 413/413 ventes pontées en production, contrôle idempotent réussi |
| Tests base/RLS                | Suites `supabase/tests/`                                                                                                                         | 274/274 assertions pgTAP réussies après replay des 84 migrations locales  |
| Connecteurs et pipeline       | `services/data-pipeline/src/official_sources/` et `src/outcome_ingestion/`                                                                       | Suite complète réussie en CI Python 3.11/3.12; aucun appel live Judilibre |
| CLI source                    | `src.outcome_sources_cli` : plan, validation locale, ingestion, matching DVF et commandes Judilibre                                              | Plan et validations locales réussis; import distant non exécuté           |
| Manifeste/runbook source      | `docs/runbooks/outcome-source-ingestion.md`                                                                                                      | Présent, avec SHA-256, volumes, licences, limites et activation           |
| API premium                   | `src/app/api/v1/sales/[id]/outcome-graph/route.ts`, auth puis `assertFeatureEntitlement`                                                         | Présent; TypeScript et tests ciblés réussis                               |
| Restitution UI                | `OutcomeForecast` intégré uniquement à `AnalysisSaleDetailView`                                                                                  | Présent                                                                   |

## Vérifications de release

```bash
npm run test
npm run lint
npx tsc --noEmit
npm run check:migrations
npm run build
```

La base a été validée localement par un replay depuis zéro et pgTAP. `npm run check:migrations` ne vérifie que les versions de fichiers; il complète cette vérification SQL sans la remplacer.

Les résultats des commandes ne doivent être marqués réussis ici qu’après leur exécution dans le worktree final.

Vérifié localement et en CI le 31 juillet 2026 :

```text
npm run test                              → 95 fichiers, 387 tests réussis
npx tsc --noEmit                          → réussi
npm run build:dev                         → build Next réussi
npm run test:security-invariants          → réussi, y compris les invariants d’ingestion source
npm run check:migrations                  → 84 versions locales uniques
supabase db reset --local --no-seed       → 84 migrations rejouées depuis zéro
supabase test db                          → 274/274 assertions pgTAP réussies
pytest hors test_valuation_training.py    → 609 tests réussis
```

`test_valuation_training.py` n’est pas collectable sous l’interpréteur local Python 3.14, mais la suite complète a réussi dans la CI cible sous Python 3.11 et 3.12. Cette validation logicielle ne constitue pas une validation statistique du modèle.

Écarts connus du DTO prototype : P10/P50/P90 seulement et motif de refus encore en texte libre. Le contrat cible exige la grille P05…P95 et des codes de refus structurés.

## Risques et travaux suivants

1. Surveiller le socle déployé et conserver le pont catalogue complet avant toute suppression; aucun environnement Supabase de staging distant n’est actuellement disponible.
2. Fournir les credentials PISTE et approuver un premier bootstrap Judilibre ciblé avant d’activer le suivi `tracked-only`; aucun sync live ne doit démarrer par défaut.
3. Valider DVF sans écriture tant que l’archive complète n’est pas conservée comme artefact gouverné et que le matching ne dispose pas d’un mode preview sans persistance.
4. Livrer le scheduler, l’exécuteur de queue, le janitor d'artefacts orphelins et le worker de purge physique avant toute activation régulière de Judilibre.
5. Implémenter les rôles opérateur/reviewer/cabinet/analyste et leur RLS.
6. Construire les snapshots pré-audience sur des versions temporelles réelles.
7. Régénérer les types Supabase TypeScript après chaque évolution du schéma.
8. Maintenir les montants Outcome Graph en centimes entiers sûrs à toutes les frontières API.
9. Mesurer la couverture A/B, la calibration et les seuils commerciaux avant activation large.
