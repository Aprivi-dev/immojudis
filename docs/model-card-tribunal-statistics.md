# Statistiques par tribunal — model card

_Version documentaire 0.3 — 1er août 2026. Cette fiche décrit un moteur d’agrégation descriptive expérimental. Elle ne vaut ni validation statistique externe, ni qualification de modèle prédictif fiable, ni autorisation de promesse commerciale._

## Identification

| Élément                   | État actuel                                                                      |
| ------------------------- | -------------------------------------------------------------------------------- |
| Système                   | Statistiques par tribunal ImmoJudis                                              |
| Nature                    | Agrégats historiques déterministes avec seuils et lissage national contrôlé      |
| Unité d’observation       | Une audience initiale mature disposant d’un snapshot de features gelé admissible |
| Périmètre public          | National et tribunal, fenêtres historiques de 12/24/36 mois                      |
| Population utilisatrice   | Comptes Analyse/Premium avec entitlement `sales.statistics`                      |
| État produit              | Expérimental, désactivé par défaut par feature flag                              |
| Apprentissage automatique | Aucun modèle supervisé entraîné dans cette fonctionnalité                        |
| Sortie individuelle       | Aucune prédiction sur une audience ou un prix individuel                         |

## Objectif

La fonctionnalité vise à répondre à une question descriptive : « sur une période close, que sait-on réellement des audiences initiales rattachées à ce tribunal, avec quelle couverture et quelle incertitude ? »

Elle met ensemble :

- des fréquences de déroulement;
- des ratios de prix et des délais sous forme de quantiles;
- la taille de chaque échantillon;
- les inconnus et exclusions;
- le niveau de fiabilité lié au volume;
- la méthode d’ajustement et la référence nationale.

La restitution est conçue pour rendre visible l’insuffisance des données. Une valeur absente ou masquée est préférable à un taux fabriqué.

## Usages prévus

Usages acceptables :

- explorer l’historique agrégé d’un tribunal;
- comparer une statistique locale à une référence nationale présentée séparément;
- mesurer la couverture réelle des résultats connus;
- identifier les métriques qui nécessitent davantage de collecte ou de revue;
- établir une baseline descriptive pour de futures évaluations temporelles.

Usages interdits :

- garantir une adjudication, un prix, une date ou une surenchère;
- présenter la sortie comme une « probabilité de gagner »;
- conseiller un plafond d’enchère individuel à partir de ces seules statistiques;
- classer les tribunaux comme « bons » ou « mauvais »;
- profiler ou comparer magistrats, greffiers, avocats, débiteurs ou occupants;
- transformer un `unknown` en événement négatif;
- contourner un résultat masqué lorsque l’échantillon est inférieur à 10;
- entraîner ou valider un modèle à partir de preuves C, de candidats non revus ou d’annonces.

## Données et chaîne d’éligibilité

Le moteur ne fait pas confiance à une source entière en bloc. L’admissibilité se décide claim par claim pour :

- `outcome_status`;
- `initial_starting_price_eur`;
- `effective_starting_price_eur`;
- `initial_hammer_price_eur`;
- `final_hammer_price_eur`;
- `finality_status`;
- `surenchere_status`;
- `result_observed_at`.

Un claim doit être soutenu par une preuve A/B explicitement liée à ce claim, avec rapprochement lot et audience d’au moins `0,95`, revue humaine approuvée et décision d’éligibilité administrateur. Les conflits, rejets et demandes de correction empêchent son utilisation.

Judilibre, DVF, annonces et catalogues peuvent produire des candidats ou des éléments de rapprochement. Ils ne deviennent pas automatiquement des résultats statistiques. En particulier :

- une mention de mise à prix ne prouve pas le prix final;
- une décision Judilibre pertinente ne prouve que les claims qu’elle contient réellement;
- une mutation DVF « Adjudication » n’identifie pas seule le bon dossier, lot et round;
- une annonce sans constat du résultat reste `unknown`.

Les grades A/B et les revues réduisent le risque de labels erronés; ils ne garantissent ni exhaustivité territoriale, ni absence de biais de publication.

L’univers `eligibleRounds` n’est pas l’ensemble des audiences initiales matures. Il contient uniquement celles qui disposent, avant le cutoff, d’un snapshot de features admissible : `built_at`, `created_at`, `recorded_at` et `feature_cutoff_at` inférieurs ou égaux au cutoff, `retrospective = false` et `leakage_check_status = passed`. Une audience mature sans snapshot répondant à ces conditions est exclue avant la construction des dénominateurs. Le public reçoit uniquement le code statique `round_not_frozen_at_cutoff`; l’effectif exact est conservé dans le champ opérateur privé `unfrozen_round_count`, sans identifiant individuel.

## Définition temporelle

Chaque snapshot possède un `knowledgeCutoffAt`. Le calcul « as of » ne voit que les rounds, snapshots de features, versions de résultat, preuves, revues et décisions d’éligibilité qui existaient à ce cutoff. Une information arrivée plus tard ne peut pas améliorer rétroactivement le snapshot.

Les fenêtres 12, 24 et 36 mois sont des fenêtres d’observation historiques. Elles ne sont pas des horizons de prévision. La fin de période précède le cutoff d’un délai de maturité, fixé à 30 jours par défaut, pour laisser le temps au résultat d’être observé.

La tranche publique agrège uniquement `round_kind = initial`. Une audience reportée, une surenchère et une réitération restent des unités distinctes; elles ne sont pas fusionnées avec l’audience initiale.

## Sorties

### Déroulement

Le moteur décrit :

- audience tenue;
- audience reportée;
- audience annulée;
- vente non requise;
- enchères désertes si l’audience s’est tenue;
- adjudication si l’audience s’est tenue.

Les quatre premiers états ont pour dénominateur les statuts de déroulement admissibles connus. Les deux derniers ont pour dénominateur les audiences tenues admissibles. Cela évite de confondre « aucune adjudication parmi les audiences tenues » avec « audience non tenue ou issue inconnue ».

### Surenchère

Le taux de surenchère déposée utilise seulement les résultats où un dépôt est établi ou l’absence est explicitement confirmée après expiration du délai. Une fenêtre encore ouverte ou un silence de source reste inconnu.

### Prix

Les distributions exposées sont :

- prix final / mise à prix initiale;
- prix final / mise à prix effective;
- prix final / valeur de marché pré-audience.

La sortie contient P10/P50/P90, lorsque la taille et la qualité le permettent. `finalToInitial` et `finalToEffective` exigent trois claims admissibles : `final_hammer_price_eur`, `finality_status = procedurally_definitive` et la mise concernée. Les montants doivent être cohérents et strictement positifs. Un `initial_hammer_price_eur`, même admissible, n’est jamais utilisé comme prix final de substitution.

Le ratio final / mise effective est l’indicateur privilégié lorsque cette mise est disponible; il ne constitue pas une estimation d’un prix futur. Dans `tribunal_statistics_builder_v1`, `finalToMarket` reste systématiquement `suppressed` tant qu’aucune estimation de marché pré-audience versionnée et admissible n’existe; tous ses comptes et quantiles publics sont nuls.

### Délais

Les distributions de délai distinguent :

- audience → moment où le résultat devient connu d’ImmoJudis;
- report → audience suivante.

Le premier mesure aussi la latence de publication, de collecte et de validation. Il ne doit pas être présenté comme la seule durée d’une procédure judiciaire.

Dans la version `tribunal_statistics_builder_v1`, `postponementToNextHearing` reste systématiquement `suppressed`, faute de lien canonique vérifié vers l’audience suivante. Tous ses effectifs et quantiles publics sont donc nuls.

## Inconnus, exclusions et couverture

Une proportion **publiée** expose séparément :

- `numerator`;
- `knownDenominator`;
- `eligibleUniverse`;
- `unknownCount`;
- `excludedCount` et les motifs;
- valeur brute et ajustée;
- intervalle de confiance;
- méthode d’ajustement.

Une distribution **publiée** expose son échantillon, son univers admissible, ses inconnus, ses exclusions, ses quantiles bruts et ajustés, la méthode et la taille de la référence parente. Elle doit vérifier `sampleSize + unknownCount + excludedCount = eligibleUniverse`.

Une cellule `suppressed` ne publie aucun effectif permettant de la reconstruire. Pour une proportion, `rawValue`, `adjustedValue`, `numerator`, `knownDenominator`, `eligibleUniverse`, `unknownCount`, `excludedCount` et `confidenceInterval` valent `null`, `exclusionReasons` vaut `{}` et `method` vaut `suppressed`. Pour une distribution, `sampleSize`, `eligibleUniverse`, `unknownCount`, `raw`, `adjusted`, `parentSampleSize` et `excludedCount` valent `null`, `exclusionReasons` vaut `{}` et `method` vaut `suppressed`. Les invariants de partition publics ne s’appliquent donc qu’aux cellules publiées.

Les compteurs publics de premier niveau (`samples`) sont masqués indépendamment : ils valent `null` sous 10 ou lorsque le quality gate échoue. La couverture publique vaut également `null` lorsque `eligibleRounds` ou `status` est masqué. Les comptes exacts restent disponibles uniquement dans le snapshot privé et le manifeste opérateur; ils peuvent apparaître dans un dry-run privé, jamais dans la réponse publique lorsqu’ils sont supprimés.

La couverture globale du statut est `statusSampleSize / eligibleRounds`. Elle mesure donc la couverture **dans le sous-univers gelé admissible**, et non parmi toutes les audiences initiales matures. Elle ne remplace pas les couvertures propres aux prix, à la surenchère et aux délais. Un tribunal peut avoir une bonne couverture de statut et une couverture de prix faible.

La couverture du gel est contrôlée séparément et reste privée : `freeze_coverage = eligible_round_count / (eligible_round_count + unfrozen_round_count)`. Si elle est inférieure à 80 %, le quality gate échoue et toutes les cellules sont supprimées, même avec un grand échantillon connu. Le public reçoit seulement un avertissement statique, jamais les comptes permettant de reconstruire les audiences non gelées.

`unknown` reste toujours hors du dénominateur connu. Cette règle évite un biais optimiste ou pessimiste artificiel, mais une forte proportion d’inconnus peut encore rendre l’échantillon connu non représentatif.

## Seuils et lissage

Les seuils s’appliquent à chaque métrique :

| `n` connu | Publication publique                                                                                                                                                 |
| --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    `< 10` | Cellule et effectifs exacts entièrement masqués; méthode `suppressed`                                                                                                |
|   `10–29` | Proportion nationale bêta-binomiale avec a priori de Jeffreys versionné; distribution nationale supprimée; cellule locale publiée seulement avec un parent publiable |
|   `30–99` | Statistique descriptive; l’ajustement reste signalé                                                                                                                  |
|   `≥ 100` | `robust` global seulement avec quality gate réussi et couverture globale ≥ 80 %; sinon `descriptive`                                                                 |

Les proportions utilisent un lissage bêta-binomial; au national, l’a priori de Jeffreys est fixe et versionné. Les distributions publiables utilisent un rétrécissement sur l’échelle logarithmique, sauf au national à partir de 100 observations où les quantiles sont bruts. Une distribution nationale de 10 à 29 observations est strictement supprimée, car elle n’a pas de parent indépendant. Une distribution locale exige une référence nationale publiable; sinon elle est supprimée.

`fallback.localWeight` est un signal global de qualité du snapshot tribunal, dérivé de l’échantillon de statuts. Il n’est ni le poids d’une cellule, ni la force de l’a priori bêta-binomial, ni le coefficient exact du rétrécissement. L’interface le présente sous le libellé « Qualité globale ». Pour interpréter une cellule, les seuls signaux publics sont sa méthode et son `n` lorsqu’ils sont publiables.

Pour une cellule tribunal insuffisante, la référence nationale peut fournir un contexte séparé, mais elle n’est pas présentée comme une mesure locale observée. La valeur `national_fallback` reste dans l’énumération du contrat pour compatibilité; le builder v1 ne l’émet pas lorsqu’un parent publiable manque et supprime alors la cellule. Le national est toujours affiché séparément et ne sert pas à produire un classement.

Le niveau `robust` exige que l’échantillon de statut atteigne au moins 100, que le contrôle qualité soit franchi, que la couverture globale atteigne au moins 80 % et que la couverture privée du gel atteigne elle aussi 80 %. Ces deux frontières sont évaluées par produits croisés sur les compteurs entiers, avant tout arrondi d’affichage. Pour un snapshot tribunal, le parent national compatible doit lui aussi avoir franchi son quality gate; sinon toutes les valeurs locales sont supprimées. Une couverture du gel inférieure à 80 % supprime entièrement la publication. Même `robust` ne signifie pas « fiable pour prédire ».

Sous `n < 10`, ou lorsque le quality gate du snapshot n’est pas franchi, aucune valeur ni aucun effectif exact de la cellule ne peut être exposé : toutes les valeurs et tous les comptes sont `null`, les motifs chiffrés sont remplacés par `{}`, et la méthode est `suppressed`. Le quality gate prime sur la taille apparente de l’échantillon.

## Quality gate et revue

La politique d’amorçage prévoit :

- 100 % des résultats admissibles couverts par une revue humaine;
- au moins 20 % des 500 premiers résultats doublement revus de façon indépendante;
- au moins 80 % des audiences matures munies d’un gel admissible avant le cutoff;
- aucun conflit bloquant;
- un rattachement lot/round confirmé;
- une décision d’éligibilité propre à chaque claim.

Le registre impose une approbation sur les preuves utilisées et recalcule, depuis le manifeste privé, la cohorte chronologique exacte des 500 premiers résultats. Au moins `ceil(20 % × min(n, 500))` de cette cohorte doit être doublement revu pour franchir le quality gate.

## Méthode et reproductibilité

Le calcul est déterministe pour un ensemble d’entrées, un cutoff et trois versions exactes dans cette tranche :

- `builderVersion = tribunal_statistics_builder_v1`;
- `eligibilityRuleVersion = claim_ab_reviewed_frozen_round_as_of_v1`;
- `smoothingRuleVersion = jeffreys_beta_log_shrinkage_v1`.

Chaque snapshot conserve un hash canonique PostgreSQL du manifeste source — incluant le manifeste privé des audiences matures non gelées — et un hash des statistiques. Les champs CLI `python_preview_*` servent uniquement à comparer les dry-runs. Les snapshots et leurs membres sont append-only. Un changement de donnée, de règle ou de calcul produit une nouvelle ligne; il ne réécrit pas l’ancienne.

Le snapshot national est construit avant les snapshots tribunal. Chaque enfant référence son national compatible et doit partager période, cutoff, maturité et versions méthodologiques.

Le builder est dry-run par défaut. Son démarrage exige que `TRIBUNAL_STATISTICS_ENABLED` soit exactement la chaîne `true`, ainsi que la présence de `SUPABASE_DB_URL`; la persistance exige en plus l’action explicite `--persist`. Le CLI v1 n’accepte que `--round-kind initial`. L’API applique le même feature flag en lecture.

Le builder attend le verrou partagé des writers avant d’établir sa vue de lecture, puis lit et persiste sur une connexion et une transaction uniques. Les membres et leurs hashes sont traités par lots déterministes. Ces propriétés réduisent les courses et les allers-retours réseau; elles ne remplacent pas un benchmark représentatif en staging avant activation.

## Contrôle d’accès et confidentialité

L’API est réservée au plan Analyse/Premium. L’ordre serveur est : authentification, contrôle de l’entitlement `sales.statistics`, validation des paramètres, puis lecture avec le client serveur. Les rôles `anon` et `authenticated` n’ont pas d’accès direct aux tables de snapshots, membres ou décisions d’éligibilité.

Les revues humaines et décisions d’éligibilité passent par des RPC administrateur authentifiées. L’identité du reviewer est dérivée de `auth.uid()` et horodatée côté serveur; une clé de service ne peut pas insérer directement une décision terminale ni choisir une identité humaine.

La réponse est `private, no-store` et ne contient pas :

- identifiants internes de snapshot, round, outcome, preuve ou reviewer;
- texte brut d’une décision ou d’une preuve;
- identité de magistrat, greffier, débiteur ou occupant;
- détail permettant de reconstruire une cellule de moins de 10.

L’aperçu d’un utilisateur non Premium doit rester fictif et ne doit jamais charger les données réelles avant de les flouter.

## Évaluation disponible

Les schémas TypeScript et SQL vérifient notamment :

- cohérence numérateur/dénominateur/univers;
- masquage sous 10;
- cohérence des quantiles;
- compatibilité d’un snapshot tribunal avec son parent national;
- seuils de niveau de fiabilité;
- contrôle de l’accès premium avant lecture;
- fermeture par feature flag;
- caractère append-only et accès service-role des registres.

Ces tests vérifient des invariants logiciels. Ils ne démontrent pas :

- la couverture nationale ou par tribunal;
- la représentativité des résultats publiés;
- la calibration d’une probabilité future;
- la précision d’un prix futur;
- la stabilité temporelle ou l’absence de biais de source;
- l’utilité économique pour une stratégie d’enchère.

À la date de cette fiche, aucune évaluation prospective complète ni mesure de calibration ne permet de qualifier cet outil de modèle prédictif fiable.

## Biais et risques connus

- **Biais de publication** : les résultats publiés rapidement ou dans des sources faciles à collecter peuvent être surreprésentés.
- **Biais territorial** : la couverture et les pratiques de publication varient selon les tribunaux.
- **Biais de sélection A/B** : les cas faciles à prouver peuvent différer des cas qui restent inconnus.
- **Biais de sélection du gel** : les audiences disposant à temps d’un snapshot de features sans fuite peuvent différer des autres audiences matures. La couverture publiée ne mesure pas cette perte en amont; l’avertissement `round_not_frozen_at_cutoff` doit être surveillé séparément.
- **Délai d’observation** : `result_observed_at` mélange délai source, collecte et validation.
- **Rapprochement** : une erreur dossier/lot/round peut attribuer un résultat au mauvais univers malgré les seuils de confiance.
- **Dérive temporelle** : réglementation, pratiques et composition du marché peuvent évoluer dans une fenêtre de 36 mois.
- **Valeur de marché** : le ratio final / marché dépend d’une estimation pré-audience distincte, avec ses propres erreurs.
- **Petit échantillon** : le lissage stabilise une valeur mais ne crée pas d’information locale.
- **Inconnus non aléatoires** : les résultats absents peuvent avoir une distribution différente des résultats connus.

Les métriques doivent donc toujours être lues avec `n`, couverture, période, exclusions et méthode.

## Seuils avant toute promesse prédictive

Le passage de statistiques descriptives à une communication prédictive nécessite une évaluation distincte. Les seuils cibles du programme Outcome Graph sont au minimum :

- 1 000 résultats A/B canoniques et revus;
- 300 résultats prospectifs récents en shadow mode;
- snapshots temporels sans fuite de données;
- calibration acceptable et intervalle 80 % proche de sa couverture nominale;
- comparaison aux baselines descriptives;
- absence de segment critique dégradé;
- revue des biais, de la couverture territoriale et du workflow des 500 premiers résultats.

Atteindre un volume ne suffit pas : ces critères doivent être mesurés, documentés et approuvés. Avant cela, les formulations autorisées sont « statistique historique », « échantillon connu », « valeur ajustée » et « expérimental ». Les termes « prévision fiable », « chance de gagner », « prix attendu garanti » ou équivalents sont interdits.

## Gouvernance et arrêt

Le propriétaire métier doit approuver les règles d’éligibilité et de publication. Toute évolution de dénominateur, de seuil, de lissage ou de grade exige une nouvelle version et une nouvelle validation temporelle.

Le kill switch `TRIBUNAL_STATISTICS_ENABLED` doit rester disponible côté API et builder. En cas d’incident, le mettre à `false`, préserver les lignes append-only et reconstruire un snapshot correct. Les procédures détaillées sont dans [`docs/runbooks/tribunal-statistics.md`](runbooks/tribunal-statistics.md).
