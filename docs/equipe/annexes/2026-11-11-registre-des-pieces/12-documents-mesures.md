<!-- Rapport du spécialiste `qualite-donnees`, rendu le 11/11/2026 dans la mission « registre des pièces » : mesures en production sur la file de lecture des documents (lecture seule, comptages seulement). Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Mesures M1 à M6 sur la file de lecture des documents (production, lecture seule)

Mesures prises le 11/11/2026 entre 12:56 et 13:10 UTC. La file bouge pendant la mesure, donc les totaux varient d'une ou deux unités d'une requête à l'autre. Aucune écriture, aucune requête refusée par le garde-fou.

**L'essentiel :** la file ne se vide pas pour trois raisons mesurées, différentes de celles supposées.

- **Boucle de relecture :** 3 ventes absorbent 104 des 200 lectures pdf terminées en 48 h (52 %).
- **Tâches sans travail :** 140 des 180 tâches pdf en attente concernent des ventes dont toutes les pièces sont déjà lues, avec les règles courantes.
- **Échecs « checkpoint » :** pour 57 des 62, la vente a déjà un manifeste complet en base ; ce sont des relectures dont le point d'étape est refusé, pas des téléchargements en échec.

## Adaptations des requêtes

- Les noms de colonnes sont tous conformes ; rien à renommer.
- J'ai ajouté un `LIMIT` partout et lu chaque plan avec `EXPLAIN` avant exécution.
- **M2 :** `dernier_message` est coupé avant toute URL et avant « failed documents ».
- **M4 :** `summary->'enrichment_jobs'` est un objet JSON, pas un entier ; je l'ai lu tel quel.
- **M6 :** le plan fait un parcours séquentiel de `auction_documents`, même en partant des ventes filtrées par statut. Je l'ai exécuté parce que la table est petite (2 751 lignes, 3,9 Mo, une seule passe). À vous de dire si cette table doit être traitée comme « grande ».
- **Requête abandonnée :** les sorties par `updated_at` tous types confondus donnaient un parcours séquentiel de `auction_enrichment_jobs` (30 Mo). Je l'ai remplacée par une variante sur l'index `(job_type, created_at)`.

## M1. Échecs pdf (86 tâches, toutes ventes confondues)

| Famille                                   | Erreurs         | Premier hôte                     | Tâches | Épuisées |
| ----------------------------------------- | --------------- | -------------------------------- | ------ | -------- |
| 3 manifeste partiel, point d'étape refusé | aucune indiquée | aucun                            | 62     | 7 à 8    |
| 1 rien de lu + extraction incomplète      | 2 à 6           | cessions.immobilier-etat.gouv.fr | 9      | 9        |
| 1 idem                                    | 0               | document.vench.fr                | 2      | 1        |
| 1 idem                                    | 2 et 4          | aucun                            | 2      | 0        |
| 4 incomplète, point d'étape écrit         | 0               | document.vench.fr                | 4      | 3        |
| 4 idem                                    | 1               | aucun                            | 1      | 1        |
| 4 idem                                    | 3               | encheresimmobilieres.fr          | 1      | 0        |
| 2 refus + autre erreur                    | aucune          | aucun                            | 1      | 1        |
| 5 autre                                   | aucune          | aucun                            | 4      | 1        |

M1 ne filtre pas sur les ventes à venir : 86 échecs au total, 72 pour les ventes à venir (votre chiffre : 71).

**Croisement de la famille 3 avec les ventes et leurs pièces (62 tâches, 280 pièces) :**

| Mesure                                                               | Valeur                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Par source                                                           | cessions_etat 23, licitor 11, avoventes 10, vench 6, agrasc 5, info_encheres 5, encheres_immobilieres 2 |
| Source retirée                                                       | 6 sur 62 (Vench) ; Petites Affiches 0                                                                   |
| Ventes dont toutes les pièces sont lues avec texte                   | 37 (112 pièces)                                                                                         |
| Ventes lues, dont une pièce « incomplete »                           | 3                                                                                                       |
| Ventes avec une partie des pièces « unknown »                        | 10 (12 pièces sur 65)                                                                                   |
| Ventes avec toutes les pièces « unknown »                            | 12 (88 pièces)                                                                                          |
| Pièces avec un message d'erreur                                      | 0 sur 280                                                                                               |
| Hôtes des 100 pièces « unknown »                                     | cessions.immobilier-etat.gouv.fr 64, cdn.agorastore.fr 27, avoventes.fr 3, trois autres hôtes 2 chacun  |
| Ventes avec manifeste `manifest_complete = true` et 0 pièce en échec | 57 sur 62                                                                                               |
| Manifeste écrit avant l'essai en échec                               | 57 sur 57                                                                                               |
| `document_facts_version` absente parmi ces 57                        | 45 (courante pour 12)                                                                                   |
| Ventes sans `document_analysis`                                      | 5                                                                                                       |

## M2. Tâches pdf en attente (180)

| État     | Dernier message (famille)               | Sources                                                                                          | Source active | Tâches | Anciennes (plus de 4 jours) |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------- | ------ | --------------------------- |
| Due      | jamais prise (0 essai, sans message)    | avoventes 57, licitor 38, info_encheres 28, cessions_etat 18, encheres_immobilieres 15, agrasc 1 | oui           | 157    | 114                         |
| Due      | jamais prise, 1 essai                   | info_encheres                                                                                    | oui           | 1      | 0                           |
| Due      | jamais prise                            | petites_affiches                                                                                 | non, retirée  | 2      | 0                           |
| Due      | PDF bounded deadline reached during OCR | avoventes                                                                                        | oui           | 1      | 1                           |
| Reportée | Source withdrawn from the catalogue     | vench 13, petites_affiches 2                                                                     | non, retirée  | 15     | 15                          |
| Reportée | budget ou délai OCR (3 libellés)        | avoventes 3, info_encheres 1                                                                     | oui           | 4      | 3                           |

Sur les 133 tâches anciennes, 115 sont dues (86 %) et 18 reportées, dont 15 sur une source retirée. Aucune tâche pdf en attente pour Enchères Publiques.

**Compléments :**

- **Rang :** 159 tâches dues ont une priorité 30 et une vente à plus de 7 jours ; âge moyen 105 h, maximum 155 h.
- **Contenu :** sur les 180 tâches en attente des ventes à venir, 140 (78 %) concernent des ventes sans pièce restant à lire et à la version de faits courante. 18 ont encore une pièce à lire, 11 sont à relire pour la version de faits, 11 n'ont aucune pièce en table.
- **Attente observée :** les tâches de priorité 30 hors vente proche terminées en 48 h ont attendu 146 h en moyenne. Elles avancent, lentement.

## M3. Arrivées et sorties pdf (cohorte par jour de création)

| Jour            | Créées | Terminées | Annulées | Ouvertes | Ventes | Terminées ce jour-là | Ventes distinctes terminées |
| --------------- | ------ | --------- | -------- | -------- | ------ | -------------------- | --------------------------- |
| 03/11           | 224    | 111       | 106      | 7        | 157    | 132                  | 132                         |
| 04/11           | 248    | 147       | 101      | 0        | 164    | 161                  | 152                         |
| 05/11           | 410    | 143       | 181      | 86       | 264    | 136                  | 127                         |
| 06/11           | 175    | 66        | 33       | 76       | 119    | 55                   | 20                          |
| 07/11           | 116    | 64        | 42       | 10       | 39     | 77                   | 32                          |
| 08/11           | 107    | 71        | 24       | 12       | 39     | 73                   | 32                          |
| 09/11           | 111    | 91        | 15       | 5        | 39     | 102                  | 44                          |
| 10/11           | 152    | 106       | 29       | 17       | 61     | 115                  | 56                          |
| 11/11 (partiel) | 78     | 44        | 13       | 21       | 42     | 66                   | 45                          |

Les deux dernières colonnes comptent par date de fin, pas par jour de création.

**Sur 8 jours :**

- 1 621 tâches pour 363 ventes : 4,5 tâches par vente, sur 2,5 jours distincts en moyenne.
- 38 ventes reviennent 5 jours ou plus ; le maximum est de 132 tâches pour une seule vente.
- Chaque tâche a une empreinte différente (132 empreintes pour 132 tâches sur la vente la plus relue).
- Annulations : 474 « Superseded by a newer input revision » (152 ventes), 54 « Listing removed », 16 « superseded after durable PDF checkpoint ».

**Concentration des lectures terminées en 48 h (200 tâches créées depuis 4 jours) :**

| Lectures terminées par vente | Ventes | Tâches |
| ---------------------------- | ------ | ------ |
| 1                            | 41     | 41     |
| 2 ou 3                       | 23     | 47     |
| 4 à 9                        | 1      | 8      |
| 10 et plus                   | 3      | 104    |

- **Deux ventes Petites Affiches** (source retirée) : 82 lectures terminées en 48 h, attente moyenne 1,1 h, priorité 40. Leurs pièces non lues sont sur document.vench.fr et www.vench.fr (6 pièces « unknown », jamais lisibles) ; leurs pièces lues sont sur www.licitor.com. Le manifeste « complet » datait de 10 minutes à la mesure.
- **Une vente Enchères Immobilières** : 22 lectures en 48 h, toutes ses pièces sont lues, mais `document_analysis` est absent du payload.

## M4. Ticks des dernières 24 h et budget

| Mesure             | Valeur                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- |
| Runs               | 20, dont 19 réussis et 1 en cours                                                  |
| Durée moyenne      | 1 756 s (de 1 522 à 2 086 s, pour un budget de 1 500 s)                            |
| État de fin        | `partial_success` sur les 19                                                       |
| Tâches terminées   | 485 (de 13 à 47 par tick)                                                          |
| Ticks sans vidage  | 1, celui en cours ; les 19 autres ont un code de vidage 0                          |
| Terminées par type | source_detail 314, pdf 129 (70 ventes), display_description 22, fact_extraction 18 |

| Reports « budget » sur 48 h                            | Valeur                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Tâches en attente avec un message contenant « budget » | 3, toutes le 11/11 à 12 h UTC                                   |
| Nature                                                 | budget OCR par passe (pages ou documents), pas budget de modèle |
| Budget IA quotidien configuré                          | 6 USD, plafond de 90 prédictions par tick                       |
| Dépense estimée                                        | 1,63 USD le 09/11, 1,61 USD le 10/11                            |
| Somme des réservations                                 | 5,14 et 5,29 USD                                                |
| Prédictions par tick                                   | 30 au maximum                                                   |
| Dernière prédiction du jour                            | 23:26 à 23:56 UTC                                               |

## M5. source_detail, descriptions et faits

| Source (source_detail) | Active | Retirée | Suspendue | En attente | Dues | Plus de 48 h | Plus ancienne |
| ---------------------- | ------ | ------- | --------- | ---------- | ---- | ------------ | ------------- |
| licitor                | oui    | non     | non       | 404        | 404  | 0            | 10/11         |
| notaires               | oui    | non     | non       | 186        | 186  | 0            | 09/11         |
| encheres_publiques     | non    | non     | non       | 20         | 20   | 20           | 16/09         |

| Type                | En attente | Reportées | Retenues par une tâche pdf | Libres | Plus ancienne | Plus récente |
| ------------------- | ---------- | --------- | -------------------------- | ------ | ------------- | ------------ |
| display_description | 328        | 0         | 190 (58 %)                 | 138    | 13/10         | 09/11        |
| fact_extraction     | 251        | 10        | 208 (83 %)                 | 43     | 13/10         | 11/11        |

- Les 138 descriptions libres datent du 03 au 07/11, priorité 20, ventes à venir, source active.
- Créations de descriptions par jour : 128 le 05/11, 49, 12, 6, 2 le 09/11, puis aucune depuis le 10/11.

## M6. Pièces « unknown » des ventes à venir

| Lecture | Pièces | Ventes |
| ------- | ------ | ------ |
| pending | 138    | 53     |

Pour situer : 322 ventes à venir ont des pièces, soit 1 328 pièces. 1 175 sont extraites (88 %), 144 jamais lues, 9 « incomplete » ou « partial ». 59 ventes ont encore une pièce à lire.

## Verdicts

**H1 : confirmée sur la famille, infirmée sur la cause.**

- Les 62 échecs « checkpoint » sont tous de la famille 3.
- Le message ne masque pas un téléchargement en échec : aucune erreur sur les 280 pièces, 0 pièce en échec dans les manifestes.
- L'hébergement par une source retirée ne l'explique pas : 6 tâches Vench sur 62, aucune Petites Affiches.
- Ce sont surtout des relectures : 57 ventes ont déjà un manifeste complet antérieur à l'échec, et 45 n'ont pas de `document_facts_version`.
- Le déclenchement est dans `services/data-pipeline/src/queued_runner.py` (lignes 679 à 718) : relecture forcée, manifeste de la passe jugé incomplet, point d'étape refusé.
- Les téléchargements en échec existent, mais en famille 1 : 9 tâches sur cessions.immobilier-etat.gouv.fr, 2 à 6 erreurs, toutes épuisées.

**H2 : infirmée.**

- 115 des 133 tâches anciennes sont dues, dont 114 jamais prises, sur des sources actives.
- La boucle de report de 24 h pour source retirée existe mais ne pèse que 15 tâches (Vench 13, Petites Affiches 2).
- Elles attendent parce qu'elles ont la priorité 30 et une vente lointaine.

**H3 : infirmée telle que formulée.**

- Depuis le 07/11, les sorties (terminées plus annulées) équilibrent les arrivées ; le stock ouvert vient des cohortes du 05 et du 06/11 (162 des 234 ouvertes).
- Ce n'est pas « une tâche par vente et par jour » : 2,5 jours par vente en moyenne, et 322 ventes à pièces pour 39 à 61 ventes servies par jour.
- Le déséquilibre vient de la concentration : 3 ventes prennent 52 % des lectures terminées.
- Le mécanisme « chaque lecture réussie crée une nouvelle génération » est en revanche confirmé par les données (une empreinte par tâche). `pdf_enrichment_input_hash_for_sale` (`services/data-pipeline/src/storage/supabase_client.py`, lignes 288 à 330) inclut `last_successful_check_at` dans l'empreinte.

**H4 : infirmée sur 48 h, avec une réserve.**

- Aucun report pour budget de modèle n'est visible ; les 3 occurrences sont des budgets OCR.
- La dépense estimée reste à 27 % du plafond et les prédictions continuent jusqu'en fin de journée.
- Réserve : je n'ai pas vérifié si le garde-fou additionne les estimations ou les réservations. Dans le second cas, le 10/11 serait à 88 % du plafond.

**H5 : première partie confirmée, seconde partiellement.**

- Les seules tâches source_detail anciennes sont les 20 d'Enchères Publiques, source désactivée : elles sont garées. Elles restent « dues » par leur date, donc tout indicateur qui ne regarde pas l'état de la source les compte en retard.
- Les 590 autres (Licitor, Notaires) ont moins de 48 h.
- Les descriptions sont bien un reliquat (plus aucune création depuis le 10/11), mais seules 190 sur 328 sont retenues par une tâche pdf. Les 138 autres sont libres et simplement peu servies (22 terminées en 24 h).

## Ce qui n'a pas pu être mesuré

- **Motif du refus du point d'étape :** il n'est écrit que dans les journaux du worker (`_refused`, `services/data-pipeline/src/storage/pdf_checkpoint_rules.py`, ligne 252), jamais en base.
- **Reports de budget passés :** `last_error` est remis à vide à chaque prise. La requête ne voit que les reports encore en file.
- **Qui recrée la tâche pdf après chaque lecture réussie** des ventes en boucle. Le filtre de sélection du vidage (`services/data-pipeline/src/document_backlog.py`, lignes 154 à 180) laisse repasser une vente dès qu'une tâche plus récente existe ; je n'ai pas établi quel chemin crée cette tâche.
- **« Jamais prise »** est déduit de 0 essai et d'un message vide. Il n'existe pas de journal des prises.
- **Exemples de ventes :** aucun identifiant fourni, conformément à la consigne.

## Trois corrections qui aideraient le plus

1. **Sortir de la boucle les ventes dont les pièces restantes ne seront jamais lisibles** (pièces hébergées par une source retirée, manifeste déjà complet). Elles prennent la moitié de la capacité pdf. Fichier : `services/data-pipeline/src/document_backlog.py`. Effort M.
2. **Écrire le motif de refus du point d'étape dans `last_error`**, et ne pas compter en échec une relecture dont le manifeste en base est déjà complet. Fichiers : `services/data-pipeline/src/queued_runner.py` et `pdf_checkpoint_rules.py`. Effort S à M.
3. **Ne pas créer de tâche pdf pour une vente entièrement lue aux règles courantes**, ou la terminer sans passe : 140 des 180 tâches en attente sont dans ce cas. Fichier : `services/data-pipeline/src/storage/supabase_client.py`. Effort M.
