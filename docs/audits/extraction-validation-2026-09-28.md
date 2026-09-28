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
demande une revue humaine. Les captures locales et les documents OCR contiennent des données
personnelles et restent hors Git.

## Régression issue d'une capture réelle

La lecture d'un procès-verbal public a révélé la formulation « libres de toute occupation ».
Elle n'était pas reconnue au pluriel. Les tests ajoutés reproduisent uniquement cette courte
formulation et vérifient que « visite libre » et « photos libres de droits » ne deviennent pas
une preuve de vacance. Le document complet et son texte OCR ne sont pas ajoutés au dépôt.

## Prochaine mesure sur sources réelles

1. Prélever un échantillon stratifié par source, type de bien, document disponible et état
   d'accès. Conserver séparément les sources inaccessibles et les annonces sans preuve ; ne
   jamais les compter comme des extractions exactes.
2. Stocker les captures dans un espace privé avec URL, date, empreinte du document et repère de
   page. Retirer les coordonnées et données personnelles avant toute fixture publiée.
3. Faire annoter indépendamment par deux personnes les champs décisionnels (lot, date,
   mise à prix, surfaces par nature, occupation, pièces, stationnement). Résoudre les désaccords
   en conservant la citation et son emplacement.
4. Publier les dénominateurs et les erreurs par source et par champ : valeur correcte,
   valeur incorrecte, champ omis, absence justifiée, inconnu et confusion de lot. Présenter
   séparément les métriques synthétiques et les métriques réelles, avec la taille des
   échantillons. Une comparaison entre fiche et source sans annotation humaine reste un
   signal de contrôle, jamais un taux de précision.

Cette mesure doit précéder toute affirmation de fiabilité globale ou activation supplémentaire
des sources et des envois à de vrais interlocuteurs.

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

Deux relecteurs distincts consignent chacun leurs `labels` sans consulter l'autre revue.
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
(trois erreurs bornées). Il y a encore 0 double relecture et 0 arbitrage : aucune
précision réelle n'est donc calculée. Les compteurs décrivent la couverture du pilote,
pas la qualité des sources.

Les 73 captures ont ensuite été rejouées sur le code corrigé : 73 prédictions
recalculées, aucune erreur de rejeu. Par rapport aux prédictions figées, les
champs nouvellement renseignés comprennent l'identifiant AGRASC (5 cas), la
ville et la date Avoventes (9 cas chacune), l'adresse Avoventes (5 cas) et les
classes DPE/GES de Notaires (7 cas chacune). Quatre nombres de pièces Avoventes
ont été retirés car l'annonce décrit plusieurs lots ou un bien ambigu. Ce
comparatif est un signal de changement, pas une mesure de justesse. Les
prédictions initiales ne contenaient pas `surface_m2`, `app_surface_m2` ni
`surface_evidence` ; le rejeu ne permet donc pas de quantifier leurs changements.
