# Outcome Graph — model card de la baseline

_Version documentaire 0.2 — 31 juillet 2026. Cette fiche décrit le code réellement présent dans le dépôt et le socle déployé. Elle ne vaut ni validation statistique, ni autorisation de lancement commercial._

## Identification

| Élément                              | Valeur actuelle                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Système                              | Outcome Graph ImmoJudis                                                                         |
| Composant décrit                     | Baseline descriptive de cohorte et projection de prédiction persistée                           |
| Implémentation                       | `src/lib/outcome-graph.ts` et `src/lib/outcome-graph-repository.ts`                             |
| Identifiant par défaut hors registre | `cohort_baseline_v1`                                                                            |
| Version servie                       | `model_key@version` de la ligne `model_versions` reliée à la prédiction                         |
| Nature                               | Calcul déterministe; aucun modèle de machine learning entraîné dans cette livraison             |
| État                                 | Prototype transversal partiel, réservé à l’offre Analyse; statistiques nationales insuffisantes |
| Propriétaire métier cible            | Équipe Outcome Graph / données ImmoJudis                                                        |

## Usage prévu

La baseline aide un utilisateur premium à lire une trajectoire statistique de vente judiciaire : déroulement possible de l’audience, quantiles de prix, surenchère, délais, pression concurrentielle et niveau de confiance. Elle restitue une prédiction déjà persistée et traçable vers un round, un snapshot, une cohorte et une version de modèle.

Elle peut servir à :

- éprouver le contrat de restitution avant l’entraînement d’un modèle;
- afficher des statistiques de cohorte lorsque la qualité et l’échantillon sont suffisants;
- fournir une baseline à battre lors d’une future évaluation temporelle;
- vérifier les refus, la provenance et la séparation des probabilités conditionnelles.

Elle ne doit pas servir à :

- garantir un résultat, un prix ou une date;
- fournir un conseil juridique, financier ou d’enchère personnalisé;
- présenter une « probabilité de gagner »;
- classer un magistrat, un membre du greffe ou une pratique individuelle;
- publier une précision autonome pour une cohorte de moins de 10 résultats;
- remplacer la revue des preuves ou la vérification du cahier des conditions de vente.

## Chemin d’inférence réellement livré

La route premium ne calcule pas un modèle à la volée. Le chemin actuel est :

```text
auction_sales.id
→ auction_lots.auction_sale_id
→ dernier auction_rounds par sequence_number
→ dernière auction_predictions `outcome_graph` par generated_at puis created_at décroissants
→ snapshot + modèle + cohorte persistés
→ validations défensives du repository
→ projection API en centimes entiers
```

`buildBaselineOutcomeGraph()` implémente par ailleurs une baseline de cohorte déterministe et testable. Aucun worker ou batch livré dans cette tranche ne l’utilise encore pour produire automatiquement des lignes nationales dans `auction_predictions`. En l’absence de données persistées admissibles, l’API retourne un refus explicite.

## Entrées

### Contexte de vente

- identifiant de vente et, lorsqu’ils existent, identifiants de round, snapshot et prédiction;
- mise à prix initiale et effective;
- estimation de marché disponible avant le cutoff;
- horizon parmi `T-30`, `T-14`, `T-7`, `T-1`, `T-2h`;
- plafond utilisateur optionnel, manipulé en centimes entiers uniquement dans le navigateur.

### Cohorte

- niveau de fallback et période observée;
- taille totale et taille tribunal;
- drapeaux `trainingEligible` et `hasBlockingConflict`;
- probabilités de déroulement séparées;
- ratios P10/P50/P90 du prix initial et définitif sur la mise effective;
- probabilité de surenchère;
- composantes facultatives de pression et de délais.

La baseline refuse une cohorte non éligible, conflictuelle, invalide ou de taille inférieure à 10. Une valeur inconnue reste `null`; elle n’est pas convertie en zéro.

## Sorties actuelles

| Famille        | Contrat actuel                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Déroulement    | `P(audience tenue)`, `P(report)`, `P(annulation ou non requise)`, `P(adjudication \| tenue)`, `P(no-bid \| tenue)` |
| Prix initial   | P10, P50 et P90 en centimes entiers                                                                                |
| Prix définitif | P10, P50 et P90 en centimes entiers                                                                                |
| Surenchère     | Probabilité conditionnelle fournie par la cohorte                                                                  |
| Plafond        | Probabilité conditionnelle sous plafond et probabilité combinée avec adjudication                                  |
| Pression       | Score 0–100, couverture et composantes disponibles                                                                 |
| Confiance      | Libellé, score heuristique, taille de cohorte et taille tribunal                                                   |
| Délais         | Cinq probabilités optionnelles, si présentes dans la prédiction                                                    |
| Explication    | Cohorte, facteurs agrégés, limites et motif de refus éventuel                                                      |

La cible P05…P95 n’est pas encore implémentée. Les refus fonctionnels portent encore un texte libre plutôt qu’un code structuré.

## Méthode de la baseline

### Prix

Les quantiles sont obtenus en multipliant la mise à prix effective par les ratios P10/P50/P90 de la cohorte, puis en arrondissant au centime. Les ratios doivent être strictement positifs et monotones.

### Déroulement

Les probabilités sont admises dans `[0,1]`. La somme `tenue + report + annulation/non-requise` et la somme conditionnelle `adjudication + no-bid` doivent être égales à 1 avec une tolérance absolue de 0,02.

### Plafond

La fonction cumulative est une interpolation logarithmique heuristique entre les ancrages suivants :

```text
0 € → 0
0,5 × P10 → 0,01
P10 → 0,10
P50 → 0,50
P90 → 0,90
1,5 × P90 → 0,99
au-delà → 1
```

Cette interpolation n’est pas une calibration empirique. Le repository restitue toujours `ceiling: null`; le composant choisit localement P50 comme seuil d’affichage initial. Lorsque l’utilisateur saisit son propre plafond, le recalcul est effectué dans le navigateur et ce montant n’est ni envoyé à la route Outcome Graph, ni stocké dans les cohortes ou prédictions partagées.

### Pression concurrentielle

Les poids cibles sont : décote 30 %, adjudication 20 %, demande qualifiée 20 %, historique 15 %, liquidité/attractivité 15 %. Le score courant renormalise sur les composantes disponibles et expose cette couverture; une composante absente reste inconnue.

### Confiance

| Taille de cohorte | Libellé actuel |
| ----------------: | -------------- |
|            `< 10` | Refus          |
|           `10–29` | Faible         |
|           `30–99` | Moyen          |
|          `>= 100` | Élevé          |

Le score numérique associé est une heuristique liée à l’échantillon, pas une mesure de calibration.

## Provenance et contrôles avant restitution

Le repository refuse notamment :

- une vente non reliée à un lot ou sans round;
- l’absence de prédiction persistée;
- une provenance incomplète entre round, snapshot, modèle et cohorte;
- un snapshot rétrospectif ou dont le contrôle anti-fuite n’est pas `passed`;
- un cutoff ou une génération postérieurs à l’audience;
- une audience sans date planifiée;
- un lot inactif ou un round sorti de l’un des quatre états prévisionnels admis;
- un modèle qui n’est pas `active` pour la restitution client;
- une cohorte non éligible, conflictuelle ou de taille inférieure à 10;
- des probabilités absentes, hors limites ou incohérentes;
- des quantiles absents ou non monotones.

Le DDL ajoute les mêmes familles de garde à l’insertion : date d’audience obligatoire, lot actif et round encore prévisionnel, chronologie snapshot/prédiction, manifeste pré-cutoff, compatibilité de schéma de features, cohorte admissible, égalité stricte entre `prediction.sample_size` et la taille de cette cohorte, probabilités et quantiles P10/P50/P90. La prédiction ne peut précéder le build; le modèle doit partager le schéma du snapshot et avoir été créé puis approuvé avant la génération; son cutoff d’entraînement ainsi que la création et la période de la cohorte ne peuvent dépasser le cutoff des features. Dès le premier snapshot, les entrées prédictives du round deviennent immuables et une correction exige un nouveau round. Les validations snapshot/prédiction verrouillent le round avec `FOR SHARE` pour éviter une modification concurrente pendant le contrôle. Le DDL relie exclusivement une prédiction client `outcome_graph` à un modèle `active` et une prédiction `shadow` à un modèle `shadow`; le repository client filtre explicitement `prediction_kind = outcome_graph` et réapplique défensivement ces contrôles de provenance.

Une correction insère une nouvelle prédiction qui référence la précédente par `supersedes_prediction_id`. La chaîne conserve le même round, type et horizon, progresse strictement en `generated_at` et ne peut avoir qu’un successeur; `superseded_by` reste nul. La lecture ne filtre donc pas ce pointeur réservé et départage les versions par `generated_at`, puis `created_at`, décroissants.

Les refus restent minimaux : les features d’un snapshot rejeté ne servent pas à calculer `marketValueCents`, et un refus sans provenance n’invente ni `generatedAt`, ni `horizon`, ni `modelVersion`.

## Données et représentativité

Aucun dataset d’entraînement national n’est livré avec cette tranche. Les tests utilisent des fixtures synthétiques; elles ne démontrent ni couverture territoriale, ni précision, ni calibration. Le registre SQL permet de conserver période, taille, horizon et statut d’éligibilité, mais aucun producteur batch national ou tribunal n’est encore livré. Les statistiques nationales disponibles aujourd’hui sont donc insuffisantes pour qualifier la baseline de modèle prédictif viable.

Les données réelles inspectées ou préparées ne changent pas ce constat :

- DVF 2025 fournit 1 604 candidats dont la nature de mutation est `Adjudication`; ils restent tous non entraînables tant qu’un rattachement dossier/lot/round, une preuve et une revue ne les ont pas qualifiés;
- Judilibre dispose d’un bootstrap borné sur quatre profils (`saisie immobilière`, `vente forcée`, `adjudication`, `surenchère`) puis d’un suivi limité aux décisions déjà enregistrées; aucun appel live n’a été effectué faute de credentials PISTE;
- le catalogue Supabase distant contient 413 lignes, dont 4 avec un prix d’adjudication affiché, mais ces prix ne sont pas des preuves de résultat final et ne doivent pas devenir des labels;
- le pont catalogue de production transforme les 413 statuts en simples annonces avec résultat `unknown`, sans prix et non entraînables. Le backfill du 31 juillet 2026 est complet et son second passage a réutilisé les 413 ponts sans créer de doublon.

Les biais à surveiller avant toute activation commerciale sont :

- sous-couverture de certains tribunaux, types de biens ou procédures;
- délai de publication différent du délai judiciaire réel;
- sélection des résultats disposant d’une preuve A/B;
- erreurs de rapprochement dossier/lot/round;
- données d’occupation, surface ou valeur de marché manquantes;
- dérive temporelle et changements de pratique/source;
- pression artificiellement dominée par les seules composantes disponibles.

Aucune identité de magistrat ou de membre du greffe ne doit entrer dans les features, segments, explications ou exports. Les analyses de performance futures doivent comparer périodes, territoires et types de procédure agrégés, avec seuils d’échantillon.

## Évaluation disponible

Vérifications exécutées le 31 juillet 2026 :

- suite Vitest complète : 95 fichiers et 387 tests réussis;
- TypeScript avec `npx tsc --noEmit` et build Next de développement réussis;
- 84 migrations locales rejouées depuis zéro, puis 274/274 assertions pgTAP réussies;
- `npm run check:migrations` et les invariants de sécurité réussis;
- suite Python : 609 tests réussis hors `test_valuation_training.py`.

`test_valuation_training.py` ne peut pas être collecté sous l’interpréteur local Python 3.14, mais la suite complète a réussi dans la CI cible sous Python 3.11 et 3.12. Ces résultats vérifient le logiciel et ses garde-fous, pas la précision, la calibration ni la représentativité statistique du système.

Ne sont pas encore mesurés :

- log loss, Brier score, précision, rappel et calibration;
- pinball loss, erreur absolue/logarithmique, couverture et largeur d’intervalle;
- performance par segment et stabilité temporelle;
- comparaison aux six baselines du cahier des charges;
- évaluation prospective en shadow mode.

## Seuils de promotion cibles

- avant 300 résultats : cohortes, médianes, quantiles et lissage seulement;
- de 300 à 999 : modèles statistiques simples et calibration;
- à partir de 1 000 : candidats plus complexes, après comparaison aux baselines;
- lancement commercial : 1 000 résultats A/B, 300 résultats prospectifs récents, snapshots disponibles, calibration acceptable, intervalle 80 % proche de 80 % et aucun segment critique dégradé.

Le registre impose 300 observations pour un modèle `statistical`, 1 000 pour `machine_learning`, conserve le contenu d’une version et prévoit le workflow `draft → validated → shadow → active → retired` avec une seule version active par clé et segment. Toute version est insérée comme brouillon non approuvé; une promotion publiée exige `approved_at` et `approved_by`, qui ne peuvent plus être modifiés après la sortie de `draft`. La présence de ce workflow ne signifie pas qu’un modèle a franchi ces étapes.

## Limites connues et décisions de sûreté

1. P10/P50/P90 seulement; la grille P05…P95 reste cible.
2. Interpolation du plafond heuristique, sans calibration empirique.
3. Pas de builder de cohorte, producteur de prédictions ou modèle entraîné livré.
4. Pas de métriques nationales, tribunal ou segment validées.
5. Refus encore exprimés en texte libre dans le DTO prototype.
6. Fixtures de scénarios utiles au contrat, mais insuffisantes comme preuve de performance métier.
7. Pas de publication commerciale avant shadow mode et seuils validés.
8. Migrations et backfill Outcome Graph déployés sur le Supabase distant; aucune donnée de ce pont ne constitue toutefois un label judiciaire vérifié ni une statistique prédictive.
9. Aucun sync Judilibre live avant fourniture des credentials PISTE et activation explicite du bootstrap ciblé.

En cas de doute, le comportement attendu est le refus `insufficient_data`, jamais une probabilité par défaut.

## Gouvernance et changement

Toute promotion d’une version doit conserver : artefact/hash lorsqu’applicable, schéma de features, cutoff d’entraînement, échantillon, métriques, approbateur et date d’approbation. Une correction de contenu crée une nouvelle version. Une version défaillante est retirée; elle n’est pas réécrite.

Les procédures d’accès, d’incident, de migration et de rollback sont décrites dans [`docs/security/outcome-graph.md`](security/outcome-graph.md) et [`docs/runbooks/outcome-graph.md`](runbooks/outcome-graph.md).
