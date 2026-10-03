# Audit des sources et définition de la complétude — 2 octobre 2026

Ce rapport conserve l’état initial de l’audit, avant correction. Les 13 écarts sont désormais corrigés et la mesure de 130 critères est publiée sur les fiches. Voir le [rapport de publication et les validations finales](./publication-extraction-profils-2026-10-02.md).

## Résultat

Le contrôle couvre les **dix connecteurs immobiliers** identifiés dans le dépôt. Il compare des annonces effectivement ouvertes le 2 octobre, leurs titres/métadonnées, leurs descriptions, les blocs textuels et les médias avec les fonctions actuelles d'extraction et de normalisation. Les preuves, URL et captures sont conservées dans le dossier de l'audit : **27 visites/tentatives documentées**, comprenant aussi les catalogues, réponses API et écrans de refus.

L'extraction conserve beaucoup de texte et de médias, mais la présence d'une valeur ne garantit pas son sens : code postal du cabinet pris pour celui du bien, chambres froides comptées comme chambres, surface de logement transformée en terrain, terrasse d'un autre niveau attribuée au lot. À l'inverse, certains manques du parseur de détail sont réparés par la fusion du catalogue ou la finalisation déterministe. Le rapport distingue ces étapes.

Le second livrable est une **checklist de 130 critères**, définis en français et fournis en JSON, avec types, unités, applicabilité, importance, provenance, correspondance avec le modèle actuel et règles de score. C'est une proposition de contrat produit pour la future mesure sur les fiches ; son score n'est pas encore intégré aux pages.

## Livrables

- [Checklist complète](./checklist-completude-annonces-2026-10-02.md).
- [Catalogue machine](./completude-annonces-2026-10-02.json).
- [Captures et inventaires](./sources-2026-10-02/captures.md).
- [Licitor, Avoventes, Enchères Publiques](./sources-2026-10-02/primary/rapport.md), avec [revue indépendante](./sources-2026-10-02/primary/independent-review.md).
- [Info Enchères, Vench, Petites Affiches, AGRASC](./sources-2026-10-02/secondary/README.md).
- [Cessions de l'État, Notaires, Enchères Immobilières](./sources-2026-10-02/dynamic/README.md).
- [Journal des tests](./sources-2026-10-02/test-results.txt) et [résultats JUnit](./sources-2026-10-02/test-results.xml).

## Ce qui a réellement été vérifié

| Source | Échantillon | Accès actuel observé | Ce que permet la preuve |
|---|---|---|---|
| Licitor | 2 fiches + catalogue Sud-Ouest | Public 200 | Comparaison HTTP réel, détail, normalisation, équipements, identité, contacts. Photos/documents absents sur ces pages. |
| Avoventes | 3 fiches + catalogue national | Public 200 | Comparaison liste/détail, surfaces, pièces, diagnostics, contacts, 70 photos distinctes et 20 liens de documents. |
| Info Enchères | 2 fiches + catalogue | Public 200 | Comparaison blocs riches, surfaces de pièces/maison/terrain, identité et pièces documentaires. |
| Vench | 2 fiches + catalogue | Public partiel 200 | Contrôle des faits publics, vignette, prix, surface et calendrier ; description complète réservée aux abonnés. |
| Petites Affiches | 2 fiches + catalogue | Public partiel 200 | Contrôle des titres, prix, date, ville, contacts disponibles, tribunal et image issus de la liste ; détail réservé aux abonnés. |
| AGRASC | 2 cartes + opérateurs | Auchel 200 ; Évry 410 | Comparaison fiche opérateur riche pour Auchel ; conservation des faits de catalogue pour Évry, dont le détail a disparu. |
| Cessions de l'État | 2 fiches | Public 200 | Terrain agricole et ancien immeuble de bureaux ; description, documents, photos, cadastre et procédure. |
| Notaires | 2 annonces + 2 réponses API | Public/API 200 | Comparaison page Immo-Interactif, API réellement consommée et parseur JSON ; données riches et médias. |
| Enchères Immobilières | 2 URL de référence | Délais réseau dépassés | Échec de capture/transport conservé ; extraction actuelle non validée et référencement vivant non confirmé. |
| Enchères Publiques | 2 catalogues, routes ancienne et actuelle | Protection 403 | Refus conservé ; aucune fiche actuelle extraite et validée dans cette session. |

Cela représente **16 fiches de détail accessibles**, complètes ou publiques partielles, **une carte AGRASC supplémentaire dont l'opérateur est devenu indisponible**, et les tentatives bloquées. Ce petit échantillon couvre des cas réels utiles ; il ne fournit pas un taux de précision/rappel représentatif du catalogue entier. Les attentes sont issues d'une revue par agents, sans revues humaines indépendantes en double aveugle.

Le périmètre est le code local actuel, déjà modifié avant ce travail. Il ne certifie pas la valeur actuellement publiée pour chaque ligne de production. Les campagnes de récupération PDF/OCR/IA, l'accessibilité de chaque pièce, le géocodage, les conflits entre sources et la restitution finale d'une ligne en production nécessitent leurs propres contrôles.

## Corrections prioritaires étayées

1. **Rattacher chaque fait au bon sujet.** Sur Licitor Poitiers, `86002` vient du cabinet et deux chambres froides deviennent `bedrooms_count=2`. Sur Avoventes Marseille, une terrasse du cinquième étage du bâtiment devient un équipement de l'appartement au premier étage. Sur Saint-Cloud, rez-de-jardin suffit à créer un jardin ; sur AGRASC Évry, ce même contexte fait passer les 140 m² du logement en surface de terrain.
2. **Conserver la qualification et la portée des surfaces.** Carrez 10,10 m² à Saint-Cloud ressort seulement en surface générique. À Ceyreste, 51,04 m² affichés et 51 a 04 ca cadastraux sont contradictoires ; la valeur 51,04 m² est retenue sans conflit terrain dédié. Le droit privatif ne permet pas de remplacer automatiquement cette valeur par 5 104 m². À Poitiers, la surface globale de lots commerciaux reste seulement une preuve textuelle après la politique de surface mixte. À Arcachon (Notaires), 117,58 m² au total se répartissent entre un appartement de 83,21 m² et un studio de 34,37 m² : ces portées doivent rester distinctes. Sur Cessions Saint-Junien, les 13 037 m² sont conservés en surface générique, mais le champ terrain reste vide après finalisation.
3. **Sécuriser les replis liste/détail.** La liste Licitor fournit un prix comme date lorsque la carte ne contient pas de date ; le détail retrouve ensuite la bonne audience. Le département connu sur la carte de Savigné disparaît après traitement du détail. Pour les Petites Affiches, tribunal et image sont bien récupérés par la fusion catalogue/détail : un test limité au détail seul donnerait une fausse conclusion.
4. **Séparer contacts et dimensions juridiques.** Le téléphone de visite Ceyreste devient le contact du cabinet. Les mentions d'occupation physique et de disponibilité juridique ne sont pas toujours des contradictions : elles doivent être conservées dans des champs distincts, avec leur date et leur preuve.
5. **Écarter le texte de navigation des classifications.** La fiche Cessions de Bordeaux ne fournit pas un type dans le parseur de détail ; la normalisation déduit ensuite `house` du mot « Maisons » dans la navigation. La catégorie source et le descriptif d'ancien immeuble de bureaux doivent primer, avec leur preuve.
6. **Structurer ce qui est déjà conservé.** Étage, chauffage individuel/collectif, énergie, orientation, année, charges avec périodicité, syndic/copropriété, cadastre, état et travaux, revêtements, frais et consignation sont encore souvent du texte brut ou des blocs source. La checklist décrit comment les qualifier plutôt que compter tout texte non vide comme un champ renseigné.

## Résultats positifs à préserver

- Sur les trois Avoventes, les **55 + 1 + 14 photos distinctes** correspondent exactement aux galeries, après déduplication des variantes recadrées/redimensionnées. Les 56/2/15 URL brutes ne prouvent pas une contamination par un autre bien.
- Les **20 liens documentaires Avoventes** passent la normalisation ; DPE/GES sont conservés au bon emplacement dans `raw_payload.source_energy_diagnostics`.
- L'occupation contradictoire de Ceyreste reste inconnue avec le marqueur `ambiguous_occupancy`.
- La surface partielle Info Enchères 6051, 24,10 m² au niveau parseur/normalisation de base, est **corrigée à 110,80 m² par le raisonnement de surface du pipeline complet**. Le test de l'étape intermédiaire et celui du résultat final sont séparés.
- Notaires restitue les 12 URL média par annonce, les pièces/chambres, prix et fenêtres d’offres. Le premier média de galerie n’a pas été décodé par Chromium : les captures ne certifient pas que toutes les photos sont utilisables.
- AGRASC Auchel conserve les liens de six pièces et ses médias, et le terrain de 164 m² est retrouvé par la finalisation. Les images de logos/tuiles cartographiques ne sont pas prises pour des photos des biens sur les fiches Info Enchères contrôlées.

## Définition de « complète »

La checklist s'organise en huit familles : provenance, vente/procédure, localisation/lot, description du bien, énergie/technique, extérieurs/terrain, occupation/risques, documents/médias. Elle couvre notamment :

- Adresse, commune, code postal, INSEE, position et précision, références cadastrales, identification du lot et des droits.
- Habitable, Carrez, bâti, terrain, périmètre de chaque surface, annexes ; pièces, chambres, salles de bains, salles d'eau, WC, étage, ascenseur, année et état.
- Mode individuel/collectif, énergie et distribution du chauffage, mode et énergie de l’eau chaude, isolation du bâtiment, menuiseries, revêtements, orientation, DPE/GES et mesures/date/identité du diagnostic.
- Jardin, terrasse, balcon, garage, parking, dépendances, piscine, jouissance et raccordements ; occupation physique, juridique, bail, loyers, copropriété, charges, travaux, diagnostics et risques.
- Prix, date ou fenêtre, méthode de vente, participation, avocat, contacts, visites, consignation, frais, modalités ; documents qualifiés, photos distinctes, plans et provenance.

Chaque champ distingue **observé, inféré, inconnu, explicitement absent, non applicable et conflit**. Une annonce ne devient pas complète grâce à des valeurs `false` inventées, à des informations d'un autre lot ni à une seule description longue. Les champs `not_applicable` sont retirés du dénominateur avec une raison ; les données simplement non publiées, payantes ou inaccessibles restent inconnues pour la richesse produit.

Le score est proposé par catégorie, pondéré et accompagné de portes critiques : identité, localisation précise, surface adaptée, calendrier/procédure, prix lorsque la méthode de vente en prévoit un, et preuve. Le JSON définit les branches ALL/ANY/conditionnelles et des exemples de calcul. Le pourcentage doit s'afficher avec les lacunes et conflits, jamais seul.

**Deux mesures différentes sont nécessaires :** rappel de l'extracteur parmi les faits réellement visibles et applicables ; richesse de l'annonce parmi les informations utiles et applicables. Une source pauvre ou verrouillée peut être parfaitement extraite tout en donnant une annonce incomplète.

## Rejeu et suite proposée

La validation ciblée totalise **261 tests réussis et 13 écarts connus reproduits**, sans échec inattendu. Les trois nouvelles suites représentent 48 vérifications positives et 13 écarts ; les autres tests couvrent les régressions existantes des connecteurs. Un écart est limité à une étape intermédiaire d’Info Enchères et corrigé par la finalisation ; les autres contrôles documentent des défauts persistants ou un chemin de repli incorrect. Le [rejeu avec `--runxfail`](./sources-2026-10-02/semantic-defects.txt) expose explicitement les 13 assertions en échec.

Les nouvelles suites rejouent les réponses sauvegardées sans appel réseau, base de données ou modèle payant. Les défauts confirmés sont marqués `xfail(strict=True)` : ils sont listés séparément des réussites. `--runxfail` les transforme en échecs ordinaires ; après une correction, le marqueur strict doit être retiré. Un écart corrigé par une étape ultérieure est explicitement identifié.

```sh
services/data-pipeline/.venv/bin/python -m pytest services/data-pipeline/tests/test_live_primary_source_audit_20261002.py services/data-pipeline/tests/test_live_secondary_source_audit_20261002.py services/data-pipeline/tests/test_dynamic_source_audit_20261002.py -q -rx
services/data-pipeline/.venv/bin/python -m pytest services/data-pipeline/tests/test_live_primary_source_audit_20261002.py services/data-pipeline/tests/test_live_secondary_source_audit_20261002.py services/data-pipeline/tests/test_dynamic_source_audit_20261002.py -q --runxfail
```

Pour la suite : corriger les défauts sémantiques prioritaires avec ces cas réels, implémenter le contrat de preuve par champ, puis intégrer la checklist aux fiches et constituer un corpus plus large par type de bien/procédure et richesse de source. Enchères Publiques et Enchères Immobilières restent à recontrôler après rétablissement de l'accès. Les diagnostics contenus dans les PDF doivent faire l'objet d'une validation documentaire dédiée.
