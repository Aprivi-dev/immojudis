# Statistiques par tribunal — runbook d’exploitation

_Version 0.6 — 20 août 2026. Cette fonctionnalité est une restitution descriptive expérimentale. Elle ne constitue ni une prédiction individuelle, ni une garantie de prix ou d’issue._

## Résumé opérateur

La route `GET /api/v1/tribunals/statistics` restitue des agrégats historiques pour le sous-univers des audiences initiales matures disposant d’un snapshot de features gelé admissible, sur 12, 24 ou 36 mois. Elle est réservée aux comptes disposant de l’entitlement `sales.statistics` (offre Analyse/Premium), protégée par authentification, servie avec `Cache-Control: private, no-store` et désactivée par défaut.

Le kill switch est :

```bash
TRIBUNAL_STATISTICS_ENABLED=false
```

La valeur doit être exactement `true` pour autoriser le builder à démarrer et l’API à lire les snapshots. Le flag doit être configuré séparément dans chaque processus concerné. Le passer à `false`, retirer la variable ou lui donner toute autre valeur ferme le service; cela ne supprime aucune donnée. Même avec le flag actif, le builder n’écrit rien sans `SUPABASE_DB_URL` **et** l’option `--persist`.

### Activité judiciaire publique sur les annonces

La route distincte `GET /api/v1/tribunals/judicial-activity` alimente le bloc tribunal de chaque
annonce, y compris la fiche publique anonyme. Le client fournit soit le code tribunal exact, soit
l'identifiant de l'annonce ; dans ce second cas, le serveur résout le code sans renvoyer la ligne
source. La route `GET /api/v1/tribunals/judicial-activity/directory` alimente l’explorateur public
`/tribunaux` en chargeant une seule fois les tribunaux actifs et les annonces admissibles, puis en
agrégeant côté serveur. Aucune ligne source n’est renvoyée. Ces routes ne dépendent pas des outcomes
et ne produisent aucune probabilité. Elles comptent uniquement
les annonces qui satisfont simultanément les conditions suivantes :

- `sale_venue_type = tribunal` ;
- `sale_verification_status in (verified, cross_checked)` ;
- code exact présent dans un `outcome_courts` actif, lui-même rattaché au référentiel Justice ;
- statut catalogue `upcoming`, `past` ou `adjudicated` cohérent avec la date ;
- date comprise entre le début de la fenêtre historique et les douze prochains mois.

La réponse publique contient le volume passé observé, le volume à venir, les annonces des 90
prochains jours, le nombre de jours d’audience, la prochaine date, la mise à prix médiane, la part
avec visite, le délai médian entre première détection et audience, les lots médians par jour et les
types de biens dominants. Les mises et délais publient également P25, P50 et P75 : la fourchette
centrale P25–P75 contient la moitié des annonces. Des repères par type de bien sont calculés avec le
même seuil. Les médianes, fourchettes et taux exigent cinq observations, sauf les lots ou intervalles
par jour d’audience qui exigent trois observations. Sous le seuil, la valeur est `insufficient_data`
mais la taille de l’échantillon d’annonces publiques reste visible.

Cette route mesure la couverture Immojudis et non l’activité exhaustive du greffe. Elle est publique,
ne renvoie aucune adresse, identité, URL source, texte brut ou dossier individuel, et utilise un cache
partagé de cinq minutes. Une lecture échouée produit une indisponibilité ; elle n’est jamais transformée
en zéro activité.

En cas de doute sur la provenance, les dénominateurs, la revue ou le cutoff :

1. remettre `TRIBUNAL_STATISTICS_ENABLED=false` sur l’API et le builder;
2. arrêter les builds persistants;
3. conserver snapshots, manifestes et preuves append-only;
4. identifier le dernier build et son triplet de versions méthodologiques;
5. corriger en produisant un nouveau snapshot, jamais en modifiant l’ancien;
6. vérifier en dry-run et en staging avant réactivation.

### Diagnostic d'une page vide

Une absence générale de statistiques est attendue tant qu'une des portes suivantes reste fermée :

1. `TRIBUNAL_STATISTICS_ENABLED` n'est pas exactement égal à `true` dans l'API ;
2. aucun snapshot national publiable n'a été persisté pour la fenêtre demandée ;
3. les audiences catalogue n'ont pas de tribunal compétent prouvé par la chaîne BAN code INSEE exact
   → référentiel territorial Justice ;
4. les rounds matures n'ont pas de snapshot pré-audience non rétrospectif avec contrôle anti-fuite
   réussi ;
5. les résultats et claims ne disposent pas des preuves A/B, revues humaines et décisions
   d'éligibilité requises ;
6. les seuils de taille, couverture ou qualité ne sont pas atteints.

Corriger le tribunal est donc le premier prérequis de segmentation, mais ne crée aucune observation
de résultat et n'autorise aucune probabilité. L'interface d'une annonce ne doit afficher la rubrique
« Prévision » que lorsqu'un enregistrement `auction_predictions` au statut `ready` a lui-même franchi
toutes les portes de publication.

## Ce que le service mesure

L’unité statistique est une **audience initiale mature et gelée** (`auction_round` avec `round_kind = initial` et snapshot de features admissible au cutoff). Une décision, une preuve, une version de résultat ou plusieurs sources parlant de la même audience ne créent jamais plusieurs observations.

La tranche publique couvre :

- le déroulement : audience tenue, reportée, annulée ou vente non requise;
- parmi les audiences tenues : enchères désertes ou adjudication;
- la surenchère déposée, seulement lorsque la fenêtre est définitivement connue;
- les ratios prix final / mise à prix initiale et mise effective; `finalToMarket` reste supprimé dans le builder v1;
- le délai audience → résultat connu par ImmoJudis; `postponementToNextHearing` reste supprimé dans le builder v1;
- l’univers admissible, le nombre connu, les inconnus, les exclusions, la couverture et le niveau de fiabilité;
- une référence nationale distincte, utilisée pour le lissage lorsque sa cellule est publiable.

Ce service ne classe pas les tribunaux, ne compare pas les magistrats et ne doit contenir aucune identité de magistrat, membre de greffe, débiteur ou occupant.

## Éligibilité des résultats

L’éligibilité est décidée **claim par claim**. Une preuve A/B qui établit le statut ne rend pas automatiquement un prix, une surenchère ou une date admissible.

Pour qu’un claim contribue à une métrique, il faut au minimum :

- une version canonique du résultat rattachée au bon lot et à la bonne audience;
- une preuve de grade A ou B qui cite explicitement ce claim;
- des confiances de rapprochement lot et audience d’au moins `0,95`;
- au moins une revue humaine approuvée, sans rejet ni demande de correction en conflit;
- une décision d’éligibilité append-only prise par un administrateur;
- la présence de la preuve, de la revue et de la décision avant `knowledgeCutoffAt`.

Les claims admis incluent le statut de déroulement, les mises à prix, le prix d’adjudication initial, le prix final, `finality_status`, la surenchère et la date de connaissance. Ils restent indépendants : un `initial_hammer_price_eur` admissible n’est jamais traité comme un `final_hammer_price_eur`.

Une source ou une extraction ne devient donc jamais seule une statistique publiable. Les candidats Judilibre, DVF ou catalogue restent hors calcul tant que cette chaîne n’est pas complète.

### Revue humaine obligatoire

Les décisions humaines passent exclusivement par les RPC authentifiées suivantes :

- `review_judilibre_match_candidate` pour confirmer, rejeter ou remplacer un candidat de rapprochement Judilibre;
- `review_outcome_evidence` pour enregistrer une revue primaire ou indépendante d’une preuve;
- `decide_outcome_claim_eligibility` pour décider l’éligibilité d’un claim et lier exactement ses preuves.

L’appelant doit posséder une session Supabase personnelle et un profil `admin`. Les RPC dérivent l’identité du reviewer de `auth.uid()` et horodatent la décision côté serveur. La clé `service_role` ne doit jamais servir à fabriquer une identité humaine : les insertions terminales directes et tout `reviewer_user_id` fourni par le client sont refusés.

Exemple d’appel depuis un outil interne authentifié, avec les noms de paramètres PostgREST :

```ts
await adminSupabase.rpc("review_judilibre_match_candidate", {
  p_candidate_id: candidateId,
  p_status: "confirmed",
  p_decision_notes: "Référence, tribunal et date vérifiés.",
});
```

Les notes restent privées, minimales et non personnelles. Ne jamais y recopier le texte brut d’une décision, une adresse complète ou l’identité d’une partie. Une confirmation Judilibre crée uniquement un lien revu; elle ne rend encore aucun outcome ni claim entraînable.

L’éligibilité de l’audience elle-même exige aussi un snapshot de features gelé dont `built_at`, `created_at`, `recorded_at` et `feature_cutoff_at` sont inférieurs ou égaux à `knowledgeCutoffAt`, avec `retrospective = false` et `leakage_check_status = passed`. Une audience initiale mature sans snapshot conforme est exclue de `eligibleRounds` avant tout dénominateur. Le public reçoit uniquement l’avertissement statique `round_not_frozen_at_cutoff`; son effectif exact reste privé dans `unfrozen_round_count`, au national et pour chaque tribunal concerné.

### Contrôle qualité des 500 premiers résultats

La politique d’amorçage exige une revue humaine de 100 % des résultats admissibles et une double revue indépendante d’au moins 20 % des 500 premiers résultats. Le registre vérifie qu’un claim publié possède une approbation humaine puis recalcule la cohorte exacte, ordonnée par date d’audience et identifiant, avant de laisser passer le quality gate. Le seuil est `ceil(20 % × min(n, 500))`.

Un snapshot dont le contrôle qualité échoue reste `insufficient_data`. Un snapshot tribunal dépend en plus d’un snapshot national dont le quality gate est franchi; si la référence nationale n’est pas publiable, toutes les valeurs locales restent masquées.

## Cutoff temporel et fenêtres

Chaque build fixe un `knowledgeCutoffAt` immuable. Seuls les rounds, snapshots de features, résultats, preuves, revues et décisions d’éligibilité connus à cet instant sont visibles par le calcul. Une correction arrivée après le cutoff ne doit pas réécrire le passé; elle apparaîtra dans un build ultérieur.

Les périodes proposées sont 12, 24 et 36 mois. Elles sont historiques et ne représentent pas un horizon de prédiction. La période se termine avant le cutoff selon le délai de maturité configuré, par défaut 30 jours, afin d’éviter de considérer trop tôt une absence de résultat comme un résultat négatif.

La restitution publique est actuellement limitée aux audiences initiales. Les audiences reportées, de surenchère et de réitération restent des rounds distincts et ne doivent pas être mélangées à l’unité initiale.

## Dénominateurs, inconnus et exclusions

Chaque métrique conserve son propre dénominateur :

| Métrique                              | Dénominateur connu                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Tenue, reportée, annulée, non requise | Statuts admissibles connus : tenue + reportée + annulée + non requise                                                              |
| Enchères désertes, adjudication       | Audiences tenues admissibles                                                                                                       |
| Surenchère déposée                    | Surenchères déposées + absences explicitement confirmées après l’expiration du délai                                               |
| Ratio prix final / mise               | `final_hammer_price_eur`, `finality_status = procedurally_definitive` et mise concernée admissibles; montants strictement positifs |
| Ratio prix final / marché             | Même finalité, avec une estimation de marché pré-audience versionnée et admissible                                                 |
| Délai audience → résultat connu       | Audience et date de connaissance admissibles                                                                                       |
| Délai report → audience suivante      | Reports appariés à une audience suivante admissible                                                                                |

`unknown` n’est jamais équivalent à `false`, `0`, « pas de surenchère », « annulation » ou « enchères désertes ». Pour chaque proportion **publiée**, le contrat expose :

- `numerator`;
- `knownDenominator`;
- `eligibleUniverse`;
- `unknownCount`;
- `excludedCount` et `exclusionReasons`;
- valeur brute, valeur ajustée, intervalle et méthode, lorsqu’elles sont publiables.

Une distribution **publiée** expose également son `sampleSize`, ses exclusions, ses P10/P50/P90 bruts et ajustés, sa méthode et la taille de la référence parente.

Elle expose aussi `eligibleUniverse` et `unknownCount`; l’égalité `sampleSize + unknownCount + excludedCount = eligibleUniverse` doit être vérifiée pour toute cellule publiée.

Une cellule `suppressed` ne doit révéler aucun de ses comptes exacts. Pour une proportion, toutes les valeurs et tous les comptes sont `null`, `exclusionReasons = {}` et `method = suppressed`. Pour une distribution, `sampleSize`, `eligibleUniverse`, `unknownCount`, `raw`, `adjusted`, `parentSampleSize` et `excludedCount` sont `null`, `exclusionReasons = {}` et `method = suppressed`. Les compteurs de premier niveau dans `samples` valent eux aussi `null` sous 10 ou lorsque le quality gate échoue; `coverage` vaut `null` si `eligibleRounds` ou `status` est masqué.

Les comptes exacts et les motifs détaillés restent disponibles dans les snapshots et manifestes privés. Le résumé d’un dry-run est un outil opérateur privé : il ne décrit pas ce que l’API publique est autorisée à révéler.

Les ratios `finalToInitial` et `finalToEffective` utilisent exclusivement le prix final admissible d’un résultat `procedurally_definitive`. Le prix d’adjudication initial n’est jamais utilisé comme substitut. Dans `tribunal_statistics_builder_v1`, `finalToMarket` et `postponementToNextHearing` restent entièrement masqués, respectivement faute d’estimation de marché pré-audience et de lien canonique vers l’audience suivante. Tous leurs champs publics sont nuls, hors `method = suppressed` et `exclusionReasons = {}`.

La couverture globale est `status / eligibleRounds` dans le sous-univers gelé admissible. Elle ne mesure ni la part de toutes les audiences initiales matures qui a été gelée à temps, ni la représentativité des audiences exclues; la valeur opérateur privée `unfrozen_round_count` doit être analysée séparément.

Le champ privé `freeze_coverage = eligible_round_count / (eligible_round_count + unfrozen_round_count)` mesure cette perte en amont. Sous `0,80`, le quality gate doit échouer et toutes les cellules publiques rester `suppressed`, quel que soit `status_sample_size`.

## Seuils de publication

Les seuils s’appliquent à chaque métrique, pas seulement au snapshot global :

| Échantillon connu | Comportement attendu                                                                                                                                               |
| ----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|            `< 10` | Cellule et comptes exacts masqués (`suppressed`)                                                                                                                   |
|           `10–29` | Proportion nationale bêta-binomiale avec a priori de Jeffreys versionné; distribution nationale supprimée; cellule locale seulement avec parent national publiable |
|           `30–99` | Statistique descriptive; tout ajustement reste déclaré                                                                                                             |
|           `≥ 100` | `robust` global seulement si le quality gate passe et si la couverture atteint 80 %; sinon `descriptive` avec avertissement                                        |

« Robuste » exige donc `n ≥ 100`, `qualityGatePassed = true` et `coverage ≥ 0,80`. Les seuils de 80 % sont comparés sur les compteurs entiers exacts; l’arrondi à six décimales ne sert qu’à la restitution. Pour un tribunal, le quality gate national compatible doit également être franchi. Ce libellé ne prouve ni absence de biais, ni représentativité, ni pouvoir prédictif.

Sous `n < 10`, **ou dès que le quality gate global échoue**, la valeur, les quantiles, les comptes exacts et les motifs chiffrés de la cellule sont masqués selon le contrat ci-dessus. Un volume élevé ne contourne jamais un contrôle qualité non franchi.

Pour les proportions, le builder v1 utilise le lissage bêta-binomial. Au national, il emploie l’a priori fixe de Jeffreys; en local, il exige une cellule nationale publiable. Pour les ratios et délais, une distribution nationale de 10 à 29 observations est supprimée, car elle n’a pas de parent indépendant. Une distribution locale exige un parent national publiable; sinon elle est supprimée. `national_fallback` reste réservé dans l’énumération du contrat pour compatibilité, mais le builder v1 ne l’émet pas lorsqu’un parent manque.

`fallback.localWeight` est uniquement un indicateur global basé sur l’échantillon de statuts, affiché comme « Qualité globale ». Ce n’est pas un poids par métrique et il n’expose ni la force de l’a priori bêta-binomial, ni le coefficient du rétrécissement. Pour chaque cellule, vérifier sa méthode et son `n` publiable.

Versions exactes attendues pour cette tranche :

- `builderVersion = tribunal_statistics_builder_v1`;
- `eligibilityRuleVersion = claim_ab_reviewed_frozen_round_as_of_v1`;
- `smoothingRuleVersion = jeffreys_beta_log_shrinkage_v1`.

## Préflight d’un build

Avant tout build :

1. confirmer que la migration des snapshots tribunal est appliquée et que les tables restent privées (`service_role` uniquement);
2. confirmer que le référentiel des tribunaux contient les codes et noms attendus;
3. choisir un cutoff UTC, une fenêtre parmi 12/24/36 et conserver `round_kind = initial`;
4. vérifier que les snapshots de features éligibles respectent les quatre dates ≤ cutoff, `retrospective = false` et `leakage_check_status = passed`;
5. mesurer les audiences matures exclues faute de gel avec le champ privé `unfrozen_round_count` au national et par tribunal;
6. vérifier que les claims A/B et leurs revues sont complets à ce cutoff;
7. confirmer que les sources en attente ou de grade C ne sont pas promues;
8. vérifier l’absence d’identité personnelle dans les agrégats et logs;
9. conserver `TRIBUNAL_STATISTICS_ENABLED=false` côté API pendant la validation initiale.

Avant toute nouvelle collecte Judilibre, régénérer sur PISTE les identifiants qui ont été exposés pendant la configuration, remplacer les secrets dans le coffre de l’environnement visé, puis révoquer les anciennes valeurs. Ne jamais placer un secret PISTE dans Git, une commande documentée, une capture, un log ou une variable publique du frontend.

Le builder doit toujours commencer en **dry-run**. Ce mode calcule les agrégats et les manifestes, affiche uniquement un résumé opérateur non personnel — qui peut contenir des effectifs exacts privés — et n’insère ni snapshot ni membre.

Depuis `services/data-pipeline`, exemple borné sur 36 mois avec cutoff explicite :

```bash
TRIBUNAL_STATISTICS_ENABLED=true python -m src.outcome_statistics.cli \
  --max-rounds 5000 \
  --window-months 36 \
  --knowledge-cutoff-at 2026-07-31T00:00:00Z \
  --maturity-days 30 \
  --round-kind initial
```

Contrat CLI :

- `--max-rounds` est une borne dure positive sur l’univers mature complet, audiences gelées et non gelées comprises; le build s’arrête si elle est dépassée;
- `--window-months` accepte `12`, `24` ou `36` et peut être répété; sans option, les trois fenêtres sont construites;
- `--knowledge-cutoff-at` accepte un instant ISO-8601; son défaut est l’instant UTC courant, mais un cutoff explicite est recommandé pour la reproductibilité;
- `--maturity-days` accepte 1 à 365, avec 30 par défaut;
- `--round-kind` accepte uniquement la valeur `initial` dans cette tranche;
- `SUPABASE_DB_URL` doit être présent dans l’environnement et ne doit jamais être imprimé;
- `TRIBUNAL_STATISTICS_ENABLED` doit être exactement la chaîne `true`; toute autre valeur arrête le builder;
- sans `--persist`, aucune écriture n’est autorisée.

Le builder acquiert d’abord le verrou transactionnel partagé par tous les writers, puis effectue lecture et persistance sur la même connexion en `READ COMMITTED`. Il voit ainsi tous les commits antérieurs au verrou et bloque toute mutation source jusqu’au commit ou rollback global.

Les hashes et les membres sont traités par lots déterministes, et non par une requête distante par membre. `--max-rounds` reste néanmoins une limite de sécurité, pas une promesse de capacité : avant d’utiliser la borne 5 000 sur une base distante, mesurer en staging la durée totale, la durée de détention du verrou et le coût des validations SQL sur un jeu représentatif.

## Validation du dry-run

Vérifier au minimum :

- cutoff, période et maturité;
- nombre exact privé d’audiences initiales dans l’univers gelé national et valeur privée `unfrozen_round_count` exclue;
- nombre de tribunaux et présence de leur référence nationale parente;
- échantillons distincts par statut, prix, surenchère et délai;
- inconnus et exclusions par motif;
- couverture, seuil de fiabilité et résultat du quality gate;
- taux et identité logique des doubles revues sans exporter d’identité humaine;
- méthodes de lissage, signal global `localWeight` et tailles de référence publiables;
- suppression complète de `finalToMarket`, `postponementToNextHearing`, des distributions nationales de 10 à 29 observations et des cellules locales sans parent publiable;
- stabilité des champs `python_preview_*` lors d’un second dry-run identique. Ces hashes de prévisualisation ne sont pas présentés comme les hashes canoniques PostgreSQL;
- après persistance, stabilité des hashes canoniques lus dans les snapshots privés lors d’un second passage identique.

Une variation inexpliquée, un dénominateur nul présenté comme 0 %, un ratio non positif ou une incohérence entre snapshot et manifeste bloque la persistance.

## Persistance et vérification

Après validation du dry-run :

1. conserver le flag actif uniquement dans le processus contrôlé du builder;
2. relancer le même cutoff et la même configuration en ajoutant `--persist`;
3. vérifier le résumé `inserted/reused` et l’idempotence d’un second passage;
4. contrôler d’abord le snapshot national, puis ses snapshots tribunal enfants;
5. tester le décodage API en staging avant d’activer le flag de l’application.

Exemple de persistance du build précédent, uniquement après validation et sur l’environnement visé :

```bash
TRIBUNAL_STATISTICS_ENABLED=true python -m src.outcome_statistics.cli \
  --max-rounds 5000 \
  --window-months 36 \
  --knowledge-cutoff-at 2026-07-31T00:00:00Z \
  --maturity-days 30 \
  --round-kind initial \
  --persist
```

Requête de contrôle agrégée, à exécuter avec un rôle d’exploitation autorisé :

```sql
select
  scope_type,
  window_months,
  reliability_status,
  quality_gate_passed,
  count(*) as snapshots,
  min(status_sample_size) as min_status_n,
  max(status_sample_size) as max_status_n,
  min(unfrozen_round_count) as min_unfrozen_n,
  max(unfrozen_round_count) as max_unfrozen_n,
  min(freeze_coverage) as min_freeze_coverage,
  min(market_price_sample_size) as min_market_n,
  max(postponement_delay_sample_size) as max_postponement_n
from public.tribunal_statistics_snapshots
where round_kind = 'initial'
  and knowledge_cutoff_at = '<CUTOFF_UTC>'::timestamptz
group by 1, 2, 3, 4
order by 1, 2, 3;
```

Ne jamais utiliser `update`, `delete`, `truncate` ou un reset distant pour corriger un snapshot. Les tables de décisions, liens de preuves, snapshots et membres sont append-only.

## Vérification API et contrôle d’accès

Ordre attendu côté serveur : authentification → entitlement `sales.statistics` → validation des paramètres → lecture service-role → événement d’usage.

Tester au minimum :

| Cas                                                 | Réponse attendue                                |
| --------------------------------------------------- | ----------------------------------------------- |
| Sans session                                        | `401 AUTH_REQUIRED`, aucune lecture de snapshot |
| Compte Découverte                                   | `403 FORBIDDEN`, aucune lecture de snapshot     |
| `windowMonths=18` ou code invalide                  | `400 INVALID_REQUEST`                           |
| Flag désactivé ou snapshot national absent/invalide | `503`, aucune donnée partielle                  |
| Compte Analyse, snapshot valide                     | `200`, `private, no-store`, `x-request-id`      |

Paramètres :

- `windowMonths` : `12`, `24` ou `36`; défaut `36`;
- `courtCode` : filtre facultatif, un seul code normalisé en minuscules.

Le client Découverte ne doit pas appeler cette API. Son aperçu éventuel doit utiliser uniquement des valeurs fictives; masquer par CSS des valeurs réelles ne constitue pas un contrôle d’accès.

Sur une réponse `200`, vérifier aussi que :

- toute cellule `method = suppressed` ne contient que des valeurs et comptes `null`, avec `exclusionReasons = {}`;
- chaque compteur `samples` inférieur à 10 dans le registre privé est `null` dans l’API;
- `coverage` est `null` dès que `eligibleRounds` ou `status` est masqué;
- `roundKind` vaut toujours `initial` et le triplet méthodologique correspond exactement à la version v1 documentée.

## Monitoring

Surveiller sans collecter de données personnelles :

- statuts HTTP et latence du scope de log `tribunal.statistics`;
- événement d’usage `tribunal.statistics_viewed` par fenêtre et fiabilité nationale;
- fraîcheur du dernier snapshot national et cohérence de ses enfants;
- couverture, volume d’inconnus/exclusions et distribution des niveaux de fiabilité;
- champs privés `unfrozen_round_count` et `freeze_coverage` national et par tribunal, suivis séparément de la couverture des résultats dans le sous-univers gelé;
- proportion doublement revue et échecs du quality gate;
- dérive par tribunal, fenêtre et période sans classement nominatif de personnes;
- erreurs de validation du contrat ou incompatibilité de versions builder/éligibilité/lissage.

Ne jamais journaliser : jeton Bearer, clé Supabase, IDs de membres/snapshots/outcomes, texte brut d’une décision, preuve intégrale ou identité d’un reviewer.

## Incident et rollback

### Donnée suspecte ou provenance incomplète

1. désactiver immédiatement `TRIBUNAL_STATISTICS_ENABLED` côté API;
2. arrêter les builds persistants;
3. conserver le `x-request-id`, la fenêtre, le cutoff et les versions méthodologiques;
4. auditer le manifeste privé, les claims et leurs preuves/revues;
5. créer les décisions correctives append-only;
6. reconstruire un nouveau couple national/tribunaux et le valider en dry-run;
7. réactiver seulement après contrôle Analyse/Découverte et revue métier.

### Erreur de déploiement applicatif

Revenir au déploiement applicatif précédent et laisser le flag à `false`. Les snapshots étant additifs et privés, un rollback applicatif ne nécessite pas leur suppression.

### Snapshot récent incorrect

La lecture choisit le snapshot national le plus récent et uniquement ses enfants compatibles. En l’absence de mécanisme de retrait d’un snapshot, maintenir le flag à `false` jusqu’à la création d’un snapshot correct plus récent. Ne jamais modifier l’historique pour forcer la sélection.

## Conditions de réactivation

Réactiver uniquement si :

- le build est reproductible et ses hashes sont stables;
- le snapshot national et tous les enfants servis partagent période, cutoff, maturité et versions;
- tous les claims publiés sont A/B, revus et rattachés au bon lot/round;
- l’univers ne contient que des snapshots de features gelés admissibles au cutoff et les exclusions `round_not_frozen_at_cutoff` ont été examinées comme risque de sélection;
- le quality gate et les seuils sont correctement appliqués;
- les inconnus, exclusions et dénominateurs sont exposés uniquement pour les cellules publiées; toute cellule supprimée et tout compteur public sous 10 sont intégralement masqués;
- les tests 401/403/400/503/200 et `private, no-store` réussissent;
- l’interface affiche clairement le caractère historique et expérimental.
- un build représentatif respecte en staging le budget d’exploitation convenu sans bloquer durablement l’ingestion;
- les anciens identifiants PISTE exposés ont été révoqués et les nouvelles valeurs sont stockées uniquement dans le coffre de secrets.

Procéder environnement par environnement : migrations et tests sur une base locale neuve, dry-run puis persistance en staging, revue des manifestes et du biais territorial, smoke test Premium/Découverte, puis seulement application des mêmes migrations en production avec les deux flags encore fermés. Activer d’abord le builder contrôlé, vérifier le snapshot persisté, puis ouvrir l’API. `JUDILIBRE_ENABLED` et `TRIBUNAL_STATISTICS_ENABLED` ne doivent jamais être activés ensemble par simple déploiement automatique.

L’activation technique ne vaut pas validation commerciale. Aucun message de « modèle fiable » ou de garantie prédictive ne doit être publié avant les seuils et évaluations décrits dans la model card.
