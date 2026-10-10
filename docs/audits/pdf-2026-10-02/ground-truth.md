# Vérité terrain — corpus PDF du 2 octobre 2026

Ce relevé est une référence visuelle pour comparer une extraction déterministe à la page source. Les numéros sont les numéros de page du fichier PDF; lorsqu'un document imprime une pagination interne différente, elle est signalée dans le texte. Chaque ligne cite 2 à 4 champs ou cellules observables et conserve la portée du lot, de l'unité ou du tableau. Les captures PNG correspondantes sont locales sous `pages/` et ne sont pas destinées à la publication.

La classe DPE n'est retenue que lorsqu'elle est lisible visuellement sur la page du diagnostic. Une lettre rencontrée dans une phrase juridique, une notice RGPD, une recommandation de rénovation ou un seuil réglementaire est une occurrence textuelle sans portée de classe.

## AGRASC / Agorastore — Auchel

**Fichier :** `corpus/agrasc-auchel-urbanisme.pdf` — fiche technique texte avec image, 1 page.

| Page | Capture | Portée | Preuves visuelles |
| ---: | --- | --- | --- |
| 1 | `pages/agrasc-auchel-urbanisme-1.png` | Maison et parcelle à Auchel | Référence cadastrale `AC 354`; contenance cadastrale `164 m²`; surface Carrez `62,60 m²`; DPE `G`. |

La même page affiche aussi la zone d'urbanisme `UB` et l'état de ruine. La surface cadastrale et la surface Carrez ont des portées distinctes et ne doivent pas être fusionnées.

## Avoventes / tribunal — Saint-Cloud DPE

**Fichier :** `corpus/avoventes-saint-cloud-dpe.pdf` — 10 pages, entièrement scanné. La page 1 est la couverture DPE; les pages internes portent une pagination DPE 1/9 à 9/9.

| Page PDF | Capture | Portée | Preuves visuelles |
| ---: | --- | --- | --- |
| 1 | `pages/avoventes-saint-cloud-dpe-01.png` | Lot 6, pièce en rez-de-jardin | Surface `10,1 m²`; classe énergie `F`; classe GES `F`; consommation `445 kWh/m²/an` et émissions `94 kg CO₂/m²/an`. |
| 7 | `pages/avoventes-saint-cloud-dpe-07.png` | Fiche technique du même lot | Référence DPE `D26034`; visite `03/02/2026`; section cadastrale `AL`, parcelle `204`; surface `10,1 m²`. |
| 8 | `pages/avoventes-saint-cloud-dpe-08.png` | Chauffage de l'unité / installation collective | Énergie `gaz naturel`; chaudière collective avant `1981`; émetteur `radiateur`; chauffage `central`, intermittence `centrale collective`. |
| 9 | `pages/avoventes-saint-cloud-dpe-09.png` | Notice RGPD du DPE | La phrase contient `observatoire DPE à des fins de contrôles`; la lettre `à` est dans la notice; la page ne donne pas une nouvelle classe; la classe de l'unité reste celle de la page 1 (`F`). |

La page 9 est donc une preuve directe contre une extraction qui prend le `à` de « à des fins » pour une classe `A`. Les classes retenues ici sont celles visibles dans les encadrés DPE, pas celles reconstruites par OCR ou par texte voisin.

## Avoventes / tribunal — Saint-Cloud procès-verbal

**Fichier :** `corpus/avoventes-saint-cloud-pv.pdf` — 11 pages, entièrement scanné.

| Page PDF | Capture | Portée | Preuves visuelles |
| ---: | --- | --- | --- |
| 1 | `pages/avoventes-saint-cloud-pv-01.png` | Procédure et lot 6 | Date du constat `03/02/2026`; lot `n°6`; commune `Saint-Cloud`; document identifié comme procès-verbal descriptif. |
| 4 | `pages/avoventes-saint-cloud-pv-04.png` | Pièce du lot 6 | Superficie `10,10 m²`; niveau `rez-de-jardin`; destination `pièce`; absence de bail ou loyer constatée. |
| 5 | `pages/avoventes-saint-cloud-pv-05.png` | Éléments physiques de la pièce | Accès par une porte; sol carrelé; fenêtre PVC double vitrage; radiateur de chauffage central. |
| 11 | `pages/avoventes-saint-cloud-pv-11.png` | Copropriété et diagnostics annexes | Charges trimestrielles `160 €`; syndic indiqué; attestation de surface privative `10,10 m²`; liste incluant amiante, électricité, gaz, DPE et risques. |

Les pages de photos et d'accès communs ne sont pas utilisées pour inventer des pièces ou des surfaces supplémentaires.

## Cessions de l'État — cahier de vente Saint-Junien

**Fichier :** `corpus/cessions-saint-junien-cahier.pdf` — 1 page, texte avec plan/image.

| Page | Capture | Portée | Preuves visuelles |
| ---: | --- | --- | --- |
| 1 | `pages/cessions-saint-junien-cahier-1.png` | Lot non bâti de la cession | Type `cession d'immeuble non bâti`; lot `n°1`; référence cadastrale `BR 104`; contenance `1 ha 30 a 37 ca`. |

La même page donne la nature `lande` et le zonage PLU `A`; la date du 1er décembre 2026 est une échéance de candidature, pas une date de vente aux enchères.

## Cessions de l'État — diagnostic réglementaire Saint-Junien

**Fichier :** `corpus/cessions-saint-junien-diagnostic.pdf` — 7 pages, texte et images de cartes/tableaux.

| Page PDF | Capture | Portée | Preuves visuelles |
| ---: | --- | --- | --- |
| 1 | `pages/cessions-saint-junien-diagnostic-1.png` | État des risques de la parcelle | Date d'établissement `02/10/2026`; commune `Saint-Junien`; code parcelle `000-BR-85`; document `État des risques`. |
| 2 | `pages/cessions-saint-junien-diagnostic-2.png` | Tableau des risques obligatoires | Sismicité `2/5`; radon `3/3`; présence d'un tableau de niveaux; périmètre rattaché à la parcelle, pas à une unité habitable. |
| 5 | `pages/cessions-saint-junien-diagnostic-5.png` | Risque argile | Aléa retrait-gonflement des argiles `1/3`; information qualifiée de non obligatoire; valeur distincte des niveaux sismique et radon. |
| 6 | `pages/cessions-saint-junien-diagnostic-6.png` | Historique catastrophes naturelles | Total `8` arrêtés; sécheresse `2`; inondations/coulées de boue `4`; mouvement de terrain `1` et tempête `1`. |

Les comptes sont ceux du tableau CAT-NAT; ils ne doivent pas devenir un nombre de sinistres propres au bâtiment sans conserver la portée réglementaire du tableau.

## Cessions de l'État — plan parcellaire Saint-Junien

**Fichier :** `corpus/cessions-saint-junien-plan-parcellaire.pdf` — 3 pages, mélange de texte et plan scanné.

| Page PDF | Capture | Portée | Preuves visuelles |
| ---: | --- | --- | --- |
| 1 | `pages/cessions-saint-junien-plan-parcellaire-1.png` | Plan cadastral, section BR | Commune `Saint-Junien`; section `BR`, feuille `1`; document d'arpentage `n°3385 E`; labels visibles `BR 104` et `BR 103`. |
| 2 | `pages/cessions-saint-junien-plan-parcellaire-2.png` | Procès-verbal de délimitation/division | Réception `23/01/2026`; visa cadastral `26/01/2026`; section `BR`; référence de document `3385 E`. |
| 3 | `pages/cessions-saint-junien-plan-parcellaire-3.png` | Tableau de division parcellaire | Ancienne `BR85` `1 ha 46 a 88 ca`; nouvelle `BR103` `16 a 51 ca`; nouvelle `BR104` `1 ha 30 a 37 ca`; total de compensation `124`. |

La ligne BR104 est donc la sous-parcelle issue de BR85. Les unités `ha/a/ca` du tableau cadastral ne doivent pas être converties en surface habitable ou Carrez.

## Info-Enchères / tribunal — Meyzieu

**Fichier :** `corpus/info-meyzieu-pvd-diags.pdf` — 19 pages, document mixte (pages scannées et pages texte).

| Page PDF | Capture | Portée | Preuves visuelles |
| ---: | --- | --- | --- |
| 1 | `pages/info-meyzieu-pvd-diags-01.png` | En-tête du PV descriptif | Date du constat `06/06/2025`; commune `Meyzieu`; adresse du bien affichée; document identifié comme PV descriptif. |
| 2 | `pages/info-meyzieu-pvd-diags-02.png` | Maison et parcelle | Section cadastrale `DN`, parcelle `345`; terrain `5 ares 01 ca`; usage `maison d'habitation`; énumération salon/séjour/cuisine/chambre et annexes. |
| 4 | `pages/info-meyzieu-pvd-diags-04.png` | Décomposition des surfaces du bâti | Surface totale au sol `137,63 m²`; partie sans toiture `57,14 m²`; partie couverte `20,51 m²`; cave `16,48 m²`. |
| 8 | `pages/info-meyzieu-pvd-diags-08.png` | Attestation de surface privative | Dossier `25/IMO/0271`; repérage `06/06/2025`; Carrez `0,00 m²`; total au sol `137,63 m²`. |
| 9 | `pages/info-meyzieu-pvd-diags-09.png` | Tableau des parties | Lignes séparées pour couvert `20,51 m²`, non couvert `57,14 m²`, cave `16,48 m²` et extension `43,50 m²`; colonne Carrez à `0`. |

Le `0,00 m²` Carrez est une mesure certifiée du périmètre privatif dans ce dossier; il ne remplace pas les surfaces au sol détaillées du PV.

## Pièces ciblées contre les faux positifs DPE

Ces quatre fichiers sont une augmentation ciblée du corpus principal. Ils servent à vérifier qu'une classe ne soit jamais déduite d'un « A » isolé dans une phrase non classificatoire.

### Info-Enchères — définition légale

**Fichier :** `corpus/dpe-fp/info-jTYZDDT.pdf`, page PDF 29 — `pages/dpe-fp/info-jTYZDDT-29.png`.

La page est une page de portée légale du DPE pour un appartement à Toulon. Elle montre :

- la catégorie d'exception `a)` des constructions provisoires;
- la durée maximale `≤ 2 ans` dans cette définition;
- la liste des catégories exemptées du DPE;
- aucune classe énergétique de bien à déduire à partir de cette lettre.

La preuve visuelle impose un contexte de rubrique avant de considérer une lettre `A` comme classe.

### Avoventes — observatoire DPE / RGPD

**Fichier :** `corpus/dpe-fp/avoventes-cabinet132-6a5e013c3afdettt.pdf`, page PDF 22 — `pages/dpe-fp/avoventes-cabinet132-p-22.png`.

La page DPE interne 1/16 montre pour une maison à Hautefontaine :

- surface `116,31 m²`;
- date d'établissement `29/12/2025`;
- validité jusqu'au `28/12/2035`;
- phrase RGPD contenant `observatoire DPE à des fins de contrôles`.

La lettre après `DPE` appartient à la phrase RGPD et ne constitue pas une classe. La classe courante n'est pas promue depuis cette phrase.

### Info-Enchères — DDT VION, classe lisible par inspection

**Fichier :** `corpus/dpe-fp/info-DDT_VION.pdf`, page PDF 21 — `pages/dpe-fp/info-DDT_VION-21.png`.

La première page DPE scannée de l'appartement (lot `2015-172-14`) montre visuellement :

- surface `37,58 m²`;
- date du diagnostic `26/09/2025`;
- classe énergie `F`;
- consommation `374 kWh/m²/an`, avec GES `C` et `12 kg CO₂/m²/an`.

Cette classe est une observation de l'encadré de la page 21, pas une valeur issue du texte des 32 autres pages ni une ancienne valeur recopiée.

### Info-Enchères — audit énergétique et seuil de 450

**Fichier :** `corpus/dpe-fp/info-MHFNDiags-internetok.pdf`, page PDF 115 — `pages/dpe-fp/info-MHFNDiags-p-115.png`.

La page 115, page interne 2 de l'audit énergétique, montre :

- des scénarios de travaux visant `A` ou `B` (ou `C` selon la contrainte);
- le seuil réglementaire `450 kWh/m²/an`;
- les échéances de location/vente par classes et années;
- une recommandation d'audit, pas la classe actuelle du bien.

Les lettres `A` et `B` de scénarios et le nombre `450` sont donc des recommandations/seuils. Aucun de ces éléments ne doit être émis comme la classe DPE courante.

### Info-Enchères — page DPE courante du même dossier

Même fichier, page PDF 97 — pages/dpe-fp/info-MHFNDiags-p-97.png.

Cette page est la page 1/14 du DPE courant, distincte de la page d'audit 115. L'encadré visuel montre :

- classe énergie G ;
- consommation 421 kWh/m²/an ;
- maison individuelle, surface de référence 116,72 m² ;
- date d'établissement 05/12/2025.

La comparaison baseline/patch conserve cette page comme contrôle de rappel : le patch élimine le faux A provenant de la phrase RGPD, mais ne récupère pas encore la classe G dessinée dans le graphique.

## Limites de transport

Les détails Licitor capturés le 2 octobre 2026 (`109932` et `110031`) contiennent `documents: []` et aucun lien PDF public. Les probes Licitor conservées dans `transport-failures/` sont des réponses d'erreur ou HTML; elles ne sont pas des PDF exploitables.

Les deux détails Notaires/Immo-Interactif observés (Arcachon `2083008`, Bordeaux `2074289`) répondent en HTTP 200 côté API et fiche publique, mais n'exposent aucun document PDF téléchargeable dans les captures. Le manifeste les marque comme absence de document, pas comme échec du parseur PDF. Le rapport source est `../sources-2026-10-02/dynamic/rapport.md`.
