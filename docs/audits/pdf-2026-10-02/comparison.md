# Comparaison extraction PDF — baseline / patch

Rejeu local hors réseau, sans LLM, avec Tesseract fra+eng. Le baseline est l'archive Git 21913e8; le patch correspond à un checkout isolé de la même tête avec les modifications d’extraction en cours au moment du rejeu. L’identifiant de la version finale publiée et ses validations figurent dans le rapport d’audit.

Les entrées ne conservent pas le texte OCR brut. Elles conservent la page source, le SHA du PDF, la méthode, les longueurs, un SHA du texte extrait, des indicateurs de contexte et les champs DPE retournés par le parseur. La vérité de classe vient de l'inspection visuelle référencée dans ground-truth.md.

## Résultat ciblé

Les six pages suivantes produisaient DPE A au baseline alors que le A est une occurrence non classificatoire; le patch les laisse à vide : Saint-Cloud p9 (RGPD), jTYZDDT p29 (catégorie légale a), cabinet132 p22 (RGPD), DDT VION p21 (RGPD), MHFN p97 (RGPD) et MHFN p115 (scénarios A/B et seuil 450).

| Page | Attendu visuel | Baseline | Patch | Verdict |
| --- | --- | --- | --- | --- |
| dpe-fp-cabinet132-p22 | D / contexte non-classificatoire | DPE A | — | **faux_positif_corrige** |
| dpe-fp-ddt-vion-p21 | F / contexte non-classificatoire | DPE A | — | **faux_positif_corrige** |
| dpe-fp-jtyzddt-p29 | — / contexte non-classificatoire | DPE A | — | **faux_positif_corrige** |
| dpe-fp-mhfndiags-p115 | — / contexte non-classificatoire | DPE A, 450 kWh/m²/an | — | **faux_positif_corrige** |
| dpe-fp-mhfndiags-p97 | G / contexte non-classificatoire | DPE A | — | **faux_positif_corrige** |
| saint-cloud-dpe-p9 | — / contexte non-classificatoire | DPE A | — | **faux_positif_corrige** |

Le patch supprime donc le faux A sur les six preuves demandées. Les pages DPE courantes restent toutefois à compléter : la classe visuelle F/D/F/G n'est retrouvée ni par le baseline ni par le patch dans les quatre pages scannées ou mixtes ci-dessous, car la lettre est dessinée dans le graphique et n'est pas voisine d'un libellé textuel compatible avec le parseur.

| Page | Classe visuelle attendue | Baseline | Patch | Limite observée |
| --- | --- | --- | --- | --- |
| dpe-fp-cabinet132-p22 | D | DPE A | — | **faux_positif_corrige**; valeur dans le graphique visuel |
| dpe-fp-ddt-vion-p21 | F | DPE A | — | **faux_positif_corrige**; valeur dans le graphique visuel |
| dpe-fp-mhfndiags-p97 | G | DPE A | — | **faux_positif_corrige**; valeur dans le graphique visuel |
| saint-cloud-dpe-p1 | F | — | — | **classe_visuelle_non_extraite**; valeur dans le graphique visuel |

## Images, tableaux et filigranes

Le patch déclenche OCR lorsqu'une page possède une image couvrant une part substantielle de la page, même si sa couche texte native dépasse le seuil court. Sur les pages mixtes, il conserve la couche native et ajoute le résultat OCR; la longueur augmente donc parfois fortement et peut contenir des doublons à dédupliquer en aval.

| Famille | Pages | Effet observé |
| --- | --- | --- |
| Saint-Cloud DPE/PV | p1, p4, p5, p7, p8, p9, p11 | Pages scannées: OCR Tesseract des deux côtés; p9 corrige le faux A. |
| Cessions risques/plan | risques p2/p5; plan p2/p3 | Le patch passe plusieurs pages image/table à OCR; les champs DPE restent absents comme attendu. |
| Meyzieu | p2, p4, p8, p9 | Le patch OCR les pages mixtes et augmente le texte disponible pour les tableaux de surfaces; le périmètre Carrez/sol reste à traiter par le parseur de tableaux. |
| AGRASC | p1 | OCR activé sur une fiche avec image; la sortie est plus longue, sans promotion DPE supplémentaire. |
| Filigrane Avoventes | cabinet132 p22, Saint-Cloud p8/p9 | Le filigrane est visible; il ne doit pas devenir un champ ni une classe. Le patch conserve les signaux de contexte sans produire de DPE A. |

## Limites et suite

- Le test appelle l'extraction de page sur une copie PDF d'une seule page afin de limiter l'OCR et de conserver la géométrie; le numéro de page source est réinjecté uniquement dans la provenance du résultat.
- L'absence de classe DPE dans la sortie patchée est sûre pour les six faux positifs, mais elle montre aussi un manque de rappel pour les classes dessinées dans les graphiques. Une étape spécialisée doit lire le bloc visuel de classe et l'associer au même encadré DPE, avec preuve de page.
- Les tableaux de surfaces, risques et cadastre sont mieux alimentés en OCR sur les pages images, mais cette comparaison ne promeut aucune surface: les unités Carrez, sol, cave, parcelle et hectares restent des portées distinctes.
- Les captures et PDF complets restent locaux et sont masqués par le .gitignore du dossier; comparison.json et ce rapport ne contiennent pas le texte OCR brut.

Les détails machine par page, y compris méthodes, SHA du texte et indicateurs, sont dans comparison.json.
