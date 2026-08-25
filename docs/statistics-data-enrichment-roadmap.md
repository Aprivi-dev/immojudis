# Enrichissement des statistiques Premium

_Version 1.0 — 24 août 2026_

## Ordre de restitution retenu

L’observatoire suit un parcours **France entière → ressort judiciaire → tribunal → type de bien**.
Le niveau national est calculé depuis les annonces unitaires admissibles ; il ne moyenne jamais les
médianes des tribunaux. Un profil tribunal peut être listé pour documenter la couverture tout en
gardant ses cellules statistiques masquées lorsque l’échantillon minimal n’est pas atteint.

Deux familles restent séparées :

1. l’**activité du catalogue** (audiences, mises à prix, délais de découverte, visites), alimentée
   par les annonces vérifiées ou recoupées ;
2. les **issues judiciaires** (adjudication, report, prix final, surenchère), qui exigent une preuve
   A/B, une revue humaine, un gel temporel et les seuils du modèle statistique.

Une annonce marquée `adjudicated` dans le catalogue ne suffit jamais à alimenter une statistique
d’issue.

## Sources ouvertes prioritaires

| Priorité | Source                                                                                                                                    | Apport                                                        | Clé de rapprochement                        | Règle de publication                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| P0       | [Référentiel des juridictions — Justice](https://www.data.gouv.fr/fr/datasets/liste-des-juridictions-competentes-pour-une-commune/)       | Tribunal compétent et rattachement territorial                | Code commune + code juridiction exact       | Référentiel, jamais preuve d’issue                                   |
| P0       | [Judilibre](https://www.courdecassation.fr/acces-rapide-judilibre)                                                                        | Décisions, événements et montants candidats                   | Décision + dossier/lot/audience             | Candidat seulement avant preuve A/B et revue                         |
| P0       | [DVF — DGFiP](https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/)                                                        | Mutations `Adjudication`, prix/date candidats et marché local | Parcelle, adresse normalisée, date, montant | Prix final seulement après rattachement non ambigu et revue          |
| P0       | [Données Enchères Publiques](https://www.data.gouv.fr/fr/datasets/calendrier-des-ventes-aux-encheres-publiques/)                          | Calendrier et organisateurs d’audiences                       | Date, organisateur, adresse, URL            | Source de découverte de niveau C ; pas de résultat implicite         |
| P1       | [StatJur — activité par juridiction](https://www.stats.justice.gouv.fr/statjur/html/index.php)                                            | Contexte d’activité historique du tribunal (2004–2019)        | Code/libellé juridiction + année            | Contexte et contrôle de représentativité, pas dénominateur ImmoJudis |
| P1       | [DPE — ADEME](https://data.ademe.fr/datasets/dpe-v2-logements-existants)                                                                  | Performance énergétique et surface déclarée                   | Adresse/parcelle avec date de validité      | Feature du bien datée avant audience                                 |
| P1       | [RNB](https://rnb.beta.gouv.fr/) et [BDNB](https://bdnb.io/)                                                                              | Identité bâtiment, âge, morphologie et usages                 | Identifiant bâtiment/parcelle               | Feature du bien ; conserver source et date                           |
| P1       | [Géorisques](https://www.georisques.gouv.fr/donnees/bases-de-donnees)                                                                     | Risques naturels, technologiques et retrait-gonflement        | Coordonnées/parcelle                        | Feature géographique, jamais causalité sur le prix final             |
| P2       | [INSEE BPE](https://www.insee.fr/fr/metadonnees/source/serie/s1161) et [Filosofi](https://www.insee.fr/fr/metadonnees/source/serie/s1172) | Équipements, accessibilité et contexte socio-économique       | IRIS/commune millésimés                     | Segmentation agrégée ; suppression des petites cellules              |
| P2       | [ANIL — Observatoires des loyers](https://www.observatoires-des-loyers.org/)                                                              | Repère locatif local                                          | Zone, type et surface                       | Indicateur de marché distinct d’un rendement garanti                 |

Les licences, conditions de réutilisation, fréquences de mise à jour et politiques de correction
doivent être enregistrées dans `data_sources` avant la première ingestion persistante.

## Tranches de production

### Tranche A — livrée dans le code

- agrégat national calculé sur le corpus unitaire contrôlé ;
- synthèses par ressort avec taux de profils tribunal publiables ;
- navigation France → ressort → tribunal ;
- fenêtre 12/24/36 mois ;
- plafond de lecture national explicite et échec fermé ;
- prix finaux et issues toujours séparés et masqués sans corpus qualifié.

### Tranche B — pilote données en production technique

1. **livré** : parseur StatJur versionné pour les ventes/saisies immobilières nouvelles et
   terminées, avec conservation distincte de `NC`, zéro et valeur absente ;
2. **livré, activation fermée** : stockage privé append-only, registre de source en revue juridique
   et CLI dry-run/persistance protégée par `JUSTICE_ACTIVITY_ENABLED` ;
3. **livré** : rapprochement exact et rapport côte à côte entre millésime Justice et catalogue
   ImmoJudis sur 36 mois, sans ratio d’exhaustivité ;
4. **livré** : sélection déterministe de 3 à 5 ressorts couvrant les bandes de volume faible,
   moyen et élevé, sous réserve d’au moins trois tribunaux rattachés et d’activité catalogue ;
5. **audit et réconciliation exécutés** : les 123 TJ actifs ont un ressort officiel, les 29
   ventes judiciaires admissibles sont rattachées sans ambiguïté et deux profils catalogue
   franchissent le seuil minimal ([rapport du 24 août
   2026](./statistics-pilot-readiness-2026-08-24.md)) ;
6. exécuter Judilibre et le rapprochement DVF en dry-run, puis faire revoir les candidats ;
7. publier uniquement les cellules dont les seuils et le contrôle de stabilité sont franchis.

### Tranche C — enrichissement bien et marché

Ajouter DPE, RNB/BDNB, Géorisques, INSEE et loyers uniquement dans des snapshots datés avant
l’audience. Mesurer ensuite la couverture, le taux de valeurs manquantes, la dérive par millésime et
les écarts territoriaux avant toute utilisation Premium.

## Indicateurs de qualité à afficher

- nombre d’annonces/audiences admissibles et taille propre à chaque métrique ;
- part connue, inconnue et exclue ;
- fraîcheur et fenêtre observée ;
- couverture de rattachement exact au tribunal ;
- proportion de profils tribunal publiables par ressort ;
- source, millésime et version de méthode ;
- niveau `insufficient_data`, `indicative`, `descriptive` ou `strong` ;
- avertissement explicite : observation historique, non prédiction individuelle.

## Porte d’activation

Le déploiement du code n’autorise pas l’ouverture des statistiques d’issue. Le flag
`TRIBUNAL_STATISTICS_ENABLED` reste fermé jusqu’à l’existence de snapshots réels, à la réussite des
contrôles de preuve/revue/couverture, au smoke test Premium authentifié et à la validation du
rollback décrite dans le runbook.
