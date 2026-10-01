# Validation de l'extraction des annonces — 28 septembre 2026

## Ce qui est mesuré

Le corpus versionné `services/data-pipeline/tests/fixtures/extraction_corpus.json` contient
11 cas synthétiques annotés. L'évaluateur
`services/data-pipeline/scripts/evaluate_extraction_corpus.py` compare les champs présents,
les absences, les valeurs explicitement inconnues et l'identité des lots. Le dernier passage
avant cette mise à jour donne 183 valeurs présentes correctes sur 183, 24 absences conservées,
2 inconnues conservées et aucune erreur d'identité de lot. Ces résultats vérifient les règles
sur ces cas ; ils ne mesurent pas la précision des dix sources en production.

Le fichier `services/data-pipeline/config/qualification-sample-20260912.json` fixe 100 URL
réparties sur dix sources. Il ne contient pas de vérité terrain annotée. Le script
`services/data-pipeline/src/quality_sample_audit.py` compare la fiche stockée avec une nouvelle extraction de la
source : une égalité ne prouve pas que la source ou le parseur a raison, et une différence
demande une vérification complémentaire. Les captures locales et les documents OCR contiennent des données
personnelles et restent hors Git.

## Régression issue d'une capture réelle

La lecture d'un procès-verbal public a révélé la formulation « libres de toute occupation ».
Elle n'était pas reconnue au pluriel. Les tests ajoutés reproduisent uniquement cette courte
formulation et vérifient que « visite libre » et « photos libres de droits » ne deviennent pas
une preuve de vacance. Le document complet et son texte OCR ne sont pas ajoutés au dépôt.

## Méthode de la mesure sur sources réelles

1. Prélever un échantillon stratifié par source, type de bien, document disponible et état
   d'accès. Conserver séparément les sources inaccessibles et les annonces sans preuve ; ne
   jamais les compter comme des extractions exactes.
2. Stocker les captures dans un espace privé avec URL, date, empreinte du document et repère de
   page. Retirer les coordonnées et données personnelles avant toute fixture publiée.
3. Faire annoter indépendamment par deux passes IA aveugles les champs décisionnels
   (date, mise à prix, surfaces par nature, occupation, pièces, stationnement). Les
   désaccords et les citations non vérifiables restent signalés ; aucun taux de
   précision humaine n'est revendiqué sous cette politique.
4. Publier les dénominateurs et les écarts par source et par champ : accord entre IA,
   divergence avec le pipeline, preuve littérale, absence et inconnu. Présenter
   séparément les métriques synthétiques et les métriques réelles, avec la taille des
   échantillons. Une comparaison entre fiche et source par IA reste un signal de contrôle,
   jamais un taux de précision démontré.

Le pilote ci-dessous applique cette méthode aux pages accessibles. Son accord entre IA ne
justifie pas une affirmation de précision globale ni l'activation des envois à de vrais
interlocuteurs.

## Revue privée de l'échantillon gelé

Le script `services/data-pipeline/scripts/evaluate_real_extraction_sample.py` prépare le cadre
des 100 cas et produit un rapport agrégé après double annotation. Il n'accède ni aux sources
ni à la base. Créer le manifeste **hors du dépôt** :

```bash
cd services/data-pipeline
python scripts/evaluate_real_extraction_sample.py --prepare /private/tmp/immojudis-real-review.json
```

Pour chaque cas, renseigner `access.state` avec `inaccessible`, `capture_failed` ou `captured`.
Les deux premiers états nécessitent une date de contrôle et un motif. Un cas `captured`
nécessite une capture privée conservée dans un **fichier local absolu hors Git**
(`private_ref`, date, SHA-256 des octets), puis un instantané des valeurs
produites par le pipeline (`prediction.values`, `extracted_at`, `pipeline_revision`,
`capture_sha256`). La capture et la prédiction doivent provenir de la même version gelée.
Le script recalcule l'empreinte du fichier à chaque évaluation. Les liens temporaires signés
et les références non résolubles localement ne conviennent pas.

La voie humaine historique reste disponible dans le schéma, mais n'est pas utilisée pour ce
pilote sous la politique « IA uniquement ». Dans cette voie facultative, deux relecteurs
distincts consignent chacun leurs `labels` sans consulter l'autre revue.
Un troisième identifiant distinct arbitre après les deux relectures ; le script vérifie l'ordre
des dates, mais l'identité et l'indépendance des personnes sont déclarées par l'opérateur et
doivent être contrôlées hors de cet outil local. L'arbitrage consigne les mêmes champs avec
`state: present`, `absent` ou `unknown`. Chaque
étiquette contient `evidence.capture_sha256` et un `locator` précis ; `present` et `unknown`
nécessitent aussi un `excerpt`. Une valeur `present` contient `value`. L'arbitrage ne compte
dans la qualité que si les deux revues et lui couvrent exactement les mêmes champs. Les champs
qui ne sont pas encore annotés restent simplement hors du dénominateur ; il ne faut pas les
transformer en `absent`.

```bash
python scripts/evaluate_real_extraction_sample.py \
  --input /private/tmp/immojudis-real-review.json \
  --output /private/tmp/immojudis-real-aggregate.json
```

Le script refuse un échantillon modifié, une capture sans empreinte, une prédiction liée à une
autre capture et les fichiers de sortie dans le dépôt. Les fichiers sont créés en mode `0600`
sans écraser un fichier existant. Le rapport ne contient que les effectifs et taux par source
et par champ ; il sépare les cas inaccessibles, les échecs de capture, les relectures en attente
et les cas arbitrés. `present_exact_rate` utilise uniquement les valeurs `present` arbitrées
comme dénominateur. Un rapport vide ou partiel ne mesure pas la précision globale des sources.
Les compteurs d'identité contrôlent l'URL et l'identifiant externe de l'annonce ; ils ne
prouvent pas l'affectation des valeurs aux lots d'une vente multilot, qui doit être revue
séparément.

Le rapport inclut aussi `readiness`, avec le nombre de captures, de premières relectures,
de doubles relectures et d'arbitrages, ainsi que le nombre de champs annotés par source.
Le pilote de capture du 28 septembre 2026 a traité 82 des 100 cas : 73 captures
réussies sur huit sources, 7 échecs de capture, 2 accès refusés et 18 cas laissés
non tentés après arrêt de leur source. Les sources avec arrêts ont été Enchères
Immobilières (robots indisponible), Enchères Publiques (HTTP 403) et Notaires
(trois erreurs bornées). Les 73 pages capturées ont reçu deux lectures IA indépendantes
sur douze champs, soit 876 comparaisons. Il n'y a aucune annotation humaine arbitrée :
le taux de précision réel reste non estimé. Les compteurs décrivent la couverture du
pilote et l'accord entre IA, pas la qualité de toutes les sources.

Les 73 captures ont ensuite été rejouées sur le code corrigé : 73 prédictions
recalculées, aucune erreur de rejeu. Par rapport aux prédictions figées, les
champs nouvellement renseignés comprennent l'identifiant AGRASC (5 cas), la
ville et la date Avoventes (9 cas chacune), l'adresse Avoventes (5 cas) et les
classes DPE/GES de Notaires (7 cas chacune). Quatre nombres de pièces Avoventes
ont été retirés car l'annonce décrit plusieurs lots ou un bien ambigu. Ce
comparatif est un signal de changement, pas une mesure de justesse. Les
prédictions initiales ne contenaient pas `surface_m2`, `app_surface_m2` ni
`surface_evidence` ; le rejeu ne permet donc pas de quantifier leurs changements.

## Voie de relecture IA sans mesure de précision humaine

Le manifeste v2 accepte une voie `ai_reviews` séparée de `reviews` et
`adjudication`. Elle permet deux passes IA aveugles sur la même capture gelée :
chaque passe lit la capture sans voir la prédiction du pipeline ni l'autre passe.
Le contrôle ne lance aucun modèle ; il valide uniquement un résultat privé déjà
produit par l'opérateur ou par un agent local.

Le paquet destiné à chaque passe peut être produit sans exposer les prédictions,
les URL de fiche ni les autres annotations :

```bash
cd services/data-pipeline
python scripts/prepare_blind_ai_review.py \
  --input /private/tmp/immojudis-real-review.json \
  --output /private/tmp/immojudis-blind-review-input.json
```

Le script revérifie chaque empreinte de capture, publie seulement les chemins
privés et les douze champs demandés, et refuse d'écraser le fichier. Le périmètre
`ai_review_expected_fields` est fixé par le manifeste ; une passe ne peut pas
réduire sa propre liste pour afficher une couverture artificiellement complète. La
séparation des agents qui consomment ce paquet doit également être respectée
dans l'orchestration : le paquet seul n'empêche pas un agent de consulter un
autre fichier si on lui en donne l'accès.

Chaque objet `ai_reviews` doit contenir les métadonnées suivantes :

```json
{
  "reviewer_type": "ai",
  "reviewer": "codex-pass-a",
  "provider": "codex",
  "model": "modele-epingle",
  "prompt_version": "real-source-ai-review-v1",
  "prompt_sha256": "<empreinte du prompt exact conservé>",
  "reviewed_at": "2026-09-28T11:00:00Z",
  "capture_sha256": "<empreinte de capture>",
  "output_sha256": "<empreinte canonique des labels>",
  "blind_to_prediction": true,
  "blind_to_other_reviews": true,
  "expected_fields": ["starting_price_eur"],
  "labels": {
    "starting_price_eur": {
      "state": "unknown",
      "evidence": {
        "capture_sha256": "<empreinte de capture>",
        "locator": "page 1",
        "excerpt": "<extrait conservé uniquement dans le fichier privé>"
      }
    }
  }
}
```

`output_sha256` est le SHA-256 du JSON des `labels`, sérialisé en UTF-8 avec
les clés triées et sans espaces. La fonction
`src.real_extraction_review.ai_review_output_sha256` fournit cette convention
aux producteurs. `expected_fields` déclare le périmètre demandé à la passe ;
les champs attendus mais absents des `labels` sont comptés comme couverture
incomplète. Les valeurs et citations restent dans le manifeste privé en mode
`0600` ; le rapport agrégé ne conserve ni cas, ni URL, ni valeur, ni extrait.
Si le texte exact du prompt d'un pilote n'a pas été conservé, indiquer
`prompt_record_status: "not_retained"` et omettre `prompt_sha256` au lieu
d'inventer une empreinte. Le rapport expose alors `prompt_provenance.hashes_missing`.
Une absence peut être annotée sans `evidence` ou citation : elle reste une
déclaration IA dont la portée se limite à la capture examinée. Une preuve
présente ou inconnue exige toujours l'empreinte, un repère et une citation.

Le rapport ajoute `ai_review.aggregate` et `ai_review.by_source`, avec les
compteurs de passes, l'accord entre passes, la couverture des champs et des
preuves, la comparaison avec la prédiction et les cas `needs_review`. Une
citation `excerpt` doit être littérale : l'évaluateur normalise les espaces et
les entités HTML, puis cherche le passage dans la capture gelée ; il accepte
aussi un fragment brut HTML littéralement présent s'il contient du texte non vide
hors des blocs `script`, `style`, `template` et `noscript`,
notamment autour d'une classe énergétique à une lettre. Pour AGRASC seulement,
il décode sans exécuter le JSON de l'unique appel `FicheProduitApp` et accepte
une citation dans `ficheProduitModel` si l'identifiant du produit correspond à
l'URL figée. Les scripts génériques et les identités divergentes sont rejetés.
Une balise vide ne suffit pas. Le nombre
`verbatim_found` est publié séparément de `with_excerpt` ; une paraphrase non
retrouvée ajoute `unverified_excerpt` aux motifs de revue. Les
compteurs `fields_compared`, `fields_agree` et `pipeline_comparison` sont des
compteurs de cohérence, jamais des taux de précision. Les raisons prévues sont
`missing_passes`, `missing_second_pass`, `incomplete_field_coverage`,
`pass_disagreement`, `pipeline_disagreement` et `unverified_excerpt`. Une divergence entre les deux
passes ne devient jamais une adjudication implicite.

Une troisième IA peut examiner les **seuls champs en désaccord**, après les deux
passes, tout en restant aveugle à la prédiction du pipeline. `ai_adjudication`
consigne une valeur sourcée, une absence, un inconnu explicite ou `unresolved`
avec motif. Le rapport garde les désaccords initiaux et publie séparément le nombre
de champs arbitrés, non résolus et encore en attente. Une décision IA reste un
signal de cohérence avec preuve vérifiable, pas une vérité terrain humaine.
La troisième passe déclare aussi son fournisseur, son modèle, sa version de
prompt et l'état de conservation du texte exact ; une empreinte SHA-256 du
prompt est exigée lorsqu'il a été conservé. Son rapport de provenance reste
distinct de celui des deux passes initiales.

Pour les douze champs du pilote, `sale_date_date` désigne l'audience ou,
lorsqu'une fenêtre d'enchères en ligne est explicitement publiée, la **clôture**
et non l'ouverture. `property_type` est comparé à l'énumération du catalogue
(`apartment`, `house`, `building`, `land`, `commercial`, `parking`, `mixed`,
`other`, `unknown`) et `occupancy_status` à son énumération (`vacant`,
`rented`, `occupied`, `owner_occupied`, `squatted`, `unknown`). Les citations
conservent les mots de la source. Cette normalisation évite de compter
« appartement » contre `apartment` ou « loué » contre `rented` comme des erreurs.
Les premières passes du pilote, lancées avant cette précision du protocole,
restent identifiables comme telles et leurs écarts de date doivent être relus.
Le rejeu local du pilote lit les **captures de détail seulement**. Il ne
reconstitue pas les données que le pipeline fusionne depuis les cartes de
liste ; ses différences avec l'IA ne prouvent donc pas à elles seules une
omission dans la fiche complète.

Cette voie produit un signal de consensus IA opérationnel. Elle fixe
`ai_review.accuracy_claim` à `not_estimated` et `human_accuracy_claim` à `null`
tant qu'aucune annotation humaine arbitrée n'est disponible. Les compteurs
`readiness`, `quality`, `source_identity_cases_verified` et
`source_identity_error_cases` restent exclusivement alimentés par les champs
humains `reviews` et `adjudication`. En v2, ces deux champs humains doivent
déclarer `reviewer_type: human` ; l'absence reste tolérée uniquement pour les
anciens manifestes v1. Une sortie IA ne peut donc pas fabriquer un taux de
précision humaine en étant insérée dans le manifeste.

Les cas sans deux passes, les désaccords et les divergences avec le pipeline
restent signalés. Les cas inaccessibles ou non capturés restent hors du
dénominateur ; ils ne sont pas transformés en erreurs d'extraction. Cette
voie ne prouve toujours ni l'exactitude de la source, ni la complétude d'une
absence, ni une interprétation juridique. Une mise en production sous cette
politique doit donc présenter le résultat comme un consensus IA avec risque
résiduel accepté, jamais comme une précision mesurée.

## Résultat du pilote IA

Les 73 captures disponibles ont été lues deux fois, indépendamment, sur les
12 champs fixés avant annotation : 1 752 étiquettes sur 1 752 attendues. Les
deux passes s'accordent sur 746 des 876 couples annonce/champ (85,2 %). Elles
divergent sur 130 champs répartis dans 53 annonces. Une troisième passe IA,
limitée à ces désaccords, a résolu 109 champs ; 21 restent explicitement
`unresolved`, sans valeur imposée par défaut. Sur les 746 champs où les deux
premières passes s'accordent, 706 correspondent au rejeu du parseur de la page
de détail et 40 en diffèrent. Sur les 109 champs arbitrés, 88 correspondent
à ce même rejeu et 21 en diffèrent. Ces nombres décrivent une concordance,
**pas une exactitude démontrée** : la fiche complète peut aussi intégrer les
valeurs de la carte de liste, absentes de ce rejeu.
Au total, 65 annonces portent au moins un motif de revue automatique :
53 ont un désaccord entre les deux premières IA et 34 une divergence entre
leur consensus et le rejeu du détail ; ces ensembles se recoupent. Onze
citations supplémentaires sont refusées par le contrôle de visibilité décrit
ci-dessous, dans des annonces déjà signalées. Elles ne deviennent pas des
preuves validées par simple accord entre IA.

| Champ              | Accord des deux IA, sur 73 | Concordance du consensus avec le détail |
| ------------------ | -------------------------: | --------------------------------------: |
| Type de bien       |                         60 |                                   58/60 |
| Ville              |                         73 |                                   73/73 |
| Date de vente      |                         64 |                                   64/64 |
| Mise à prix        |                         73 |                                   72/73 |
| Surface habitable  |                         46 |                                   39/46 |
| Surface Carrez     |                         64 |                                   63/64 |
| Surface du terrain |                         59 |                                   56/59 |
| Occupation         |                         67 |                                   62/67 |
| Nombre de pièces   |                         56 |                                   45/56 |
| Stationnement      |                         67 |                                   57/67 |
| Classe DPE         |                         59 |                                   59/59 |
| Classe GES         |                         58 |                                   58/58 |

Sur les 1 230 citations exigées par les états `present` et `unknown`, 1 219
ont été retrouvées par le vérificateur dans le texte de la capture hors
`script`, `style`, `template`, `noscript` et attributs HTML ou, pour AGRASC,
dans l'objet JSON du produit à identité vérifiée. Les 11 autres sont signalées
`unverified_excerpt` : leur texte ne doit pas être présenté comme preuve
visible. Ce contrôle
ne démontre ni la pertinence de la citation pour le champ, ni l'exactitude de
l'interprétation. Le texte exact des 146 prompts initiaux et des 53 prompts
d'arbitrage n'ayant pas été conservé, le rapport indique séparément 146 et 53
empreintes de prompt manquantes. Les deux
sources sans capture ne participent pas à ces dénominateurs. Le rapport agrégé
reste privé et ne contient ni URL, ni valeur de bien, ni citation.
