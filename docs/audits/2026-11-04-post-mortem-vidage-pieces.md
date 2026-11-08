# Post-mortem : vidage des pièces jointes, 03 au 05/11/2026 (#413 à #430)

Post-mortem sans reproche, rédigé le 08/11/2026 (T8 de l'état des lieux du jour). Il décrit des
mécanismes, pas des personnes. **Sources : uniquement les messages et les diffs des commits #413 à
#430.** Ce qui n'y figure pas est marqué « à confirmer ». Les heures sont celles écrites dans les
messages de commit, sans fuseau précisé ; celles des commits sont en heure de Paris (+01:00). Procédure
d'exploitation : [runbook du vidage des pièces](../runbooks/vidage-des-pieces.md).

## Résumé

Du 04/11 au matin au 05/11 au soir, le vidage des pièces jointes (`src/document_backlog.py`) a mal
rendu, pour des raisons successives : d'abord il ne sélectionnait rien, ensuite il abandonnait des ventes
à moitié lues, puis, une fois la lecture en avance ajoutée (#417), il bouclait sur des passes « PDF
document manifest is partial » sans lire de pièce. Dix correctifs ont été fusionnés en 36 heures. La
cause de la boucle (une revalidation HTTP jamais soldée) a été trouvée et corrigée par #421. Deux
défauts de la collecte effaçaient en parallèle la lecture déjà faite (#422, #425). La lecture en avance,
coupée le 04/11 (#421), a été remise avec 3 processus le 05/11 (#428).

## Impact

Faits relevés dans les commits :

- 04/11, 02:14 : 0 vente sélectionnée alors que 270 ventes à venir devaient être relues après les
  invalidations du 03/11 (#415).
- 04/11, 11:20 et 12:39 : 8 lectures finies en environ 45 minutes par vidage, contre environ 12 ventes
  en 40 minutes le matin sans lecture en avance (#421). À 11:20, 53 passes partielles pour 27 ventes
  sans lire de pièce (#420). À 12:39, 8 points d'étape refusés (#421).
- 04/11 : le compteur de ventes à jour sur leurs pièces passe de 184 (16:26) à 156 (19:05) ; 99 ventes
  lues dans la journée sont de nouveau à relire (#422).
- 04/11, 19:38 : 9 ventes sur 34 échouent avec « PDF document checkpoint was not persisted » ; une vente
  en échec attend ensuite un jour avant d'être reprise (#423).
- 05/11 : environ 70 ventes perdent leur lecture à 06:39 puis à 08:23 (#425).
- 04/11, 07:51 : dix téléchargements au-dessus de 50 Mo (Avoventes, Licitor) retentés à chaque vidage
  (#418).
- 05/11 (cliché de la sentinelle) : 14 ventes avec une pièce « incomplete » depuis plus de 3 jours
  (#430).

À confirmer : l'effet sur les fiches publiques (occupation, dates de visite et autres faits lus dans les
pièces affichés en retard ou absents), le nombre total de ventes touchées, et le coût OCR ou réseau des
passes répétées. Aucun commit ne le chiffre.

## Chronologie

| Quand (commit)                     | Constat                                                                                                                                                               | Réponse                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 03/11 (#413, 03/11 17:19)          | Le recalcul s'arrête après 8 lots sur 75 : un lot a attendu plus de 15 s le verrou de publication tenu par la collecte horaire.                                       | Le lot est réessayé après 20, 60 puis 120 s. Contexte : le verrou du catalogue est très disputé.                                                                                |
| 04/11 02:14 (#415, 08:00)          | Le vidage trouve 0 vente sur 270 à relire : une tâche pdf annulée (« Superseded by a newer input revision ») comptait comme un essai et bloquait la vente 24 h.       | Seul un essai réel fait attendre. Sélection mesurée en production : de 0 à 189 ventes.                                                                                          |
| 04/11 07:00 (#416, 08:49)          | Le vidage sélectionne, mais une passe qui réécrit la vente voit sa tâche remplacée par une nouvelle génération ; le vidage prenait cette annulation pour une fin.     | La génération courante est suivie, dans la limite de `--max-passes`.                                                                                                            |
| 04/11 matin (#417, 11:36)          | Mesure sur 42 minutes : 60 % du temps à télécharger et lire (1 974 pages), 33 % à attendre le verrou du catalogue, une seule vente à la fois sur un des 4 cœurs.      | Lecture en avance : 3 processus préparent les ventes suivantes hors du verrou, sans écriture en base (`DOCUMENT_BACKLOG_PREFETCH_WORKERS`).                                     |
| 04/11 07:51 (#418, 11:56)          | Dix pièces de plus de 50 Mo levaient une erreur passagère, retentée à chaque vidage.                                                                                  | Une pièce trop lourde au téléchargement est un échec définitif (`document_too_large`).                                                                                          |
| 04/11 10:37 (#419, 12:16)          | Premier vidage avec #417 : une collecte Notaires prend le verrou à 10:45 pour toute sa durée ; avec une vente d'avance par processus, les processus restent inactifs. | Quatre ventes d'avance par processus (12 au total).                                                                                                                             |
| 04/11 11:20 (#420, 13:38)          | 53 passes « manifest is partial » sans lire de pièce pour 27 ventes (3 pour 55 ventes le matin), points d'étape refusés.                                              | Hypothèse : la préparation écrivait le manifeste local de la vente, périmé dès qu'un autre traitement la mettait à jour. La préparation ne restaure plus que le cache de pages. |
| 04/11 12:39 (#421, 14:44)          | Toujours 8 lectures en environ 45 minutes, 8 points d'étape refusés.                                                                                                  | Lecture en avance coupée dans le workflow (`0`). Cause trouvée et corrigée dans le même commit (voir « Cause racine »), avec un test qui reproduit la boucle.                   |
| 04/11 16:26-19:05 (#422, 20:38)    | Le compteur de ventes à jour recule de 184 à 156.                                                                                                                     | Une collecte n'efface plus `document_facts_version` sans changement de la page ; un changement de source est daté.                                                              |
| 04/11 19:38 (#423, 23:35)          | 9 ventes sur 34 en « checkpoint was not persisted », sans détail.                                                                                                     | Chaque refus écrit sa raison dans le journal. Aucun changement de comportement.                                                                                                 |
| 05/11 06:39 et 08:23 (#425, 12:27) | Environ 70 ventes perdent leur lecture à chaque collecte de la source secondaire d'une vente fusionnée (Licitor).                                                     | Pour une source secondaire, seule une pièce absente de la ligne enregistrée est un changement.                                                                                  |
| 05/11 12:48-15:21 (#428, 19:55)    | Vidage de référence sans lecture en avance : 43 ventes traitées sur 80 candidates en 150 minutes.                                                                     | Lecture en avance remise à 3 processus.                                                                                                                                         |
| 05/11 (#430, 22:48)                | Rattrapage fait : 14 ventes avec une pièce « incomplete » depuis plus de 3 jours.                                                                                     | Seuil de la sentinelle `catalogue.quality.documents_incomplete` abaissé de 80 à 30 (décision du propriétaire).                                                                  |

Les commits #414, #424 et #426 ne concernent pas les pièces jointes. Aucun commit ne porte le numéro
#427 dans l'historique de `main`. #429 corrige des nombres de pièces (au sens de chambres) et le recalcul,
sans lien avec le vidage.

## Cause racine de la boucle « manifest is partial »

Extrait de #421. Une pièce déjà lue dont la vérification HTTP a expiré est notée dans
`http_revalidation_pending_urls` (manifeste de la vente, `raw_payload->'document_analysis'`). La passe
sous verrou ne la reprenait que si son fichier local `.http.json` était périmé, et seule une passe qui
reprend la pièce la retire de la liste. La lecture en avance retéléchargeait ces pièces : fichiers
`.http.json` frais, mais liste enregistrée inchangée, puisqu'elle n'écrit rien en base. La passe sous
verrou ne reprenait donc plus ces pièces, et le manifeste restait partiel indéfiniment. Exemple : une
vente à Vaujours, 11 pièces lues, 5 URL en attente de revalidation.

Correctif : `stale_complete_document_urls` (`src/pdf_progress.py`) renvoie aussi les URL encore en
attente. La passe les reprend depuis le cache local si la vérification est fraîche, sans nouvelle
requête, puis les retire de la liste. Le test (`tests/test_pdf_http_revalidation.py`) reproduit 10 URL
en attente indéfiniment sans le correctif et vérifie qu'elles se résolvent en deux passes.

Causes distinctes de la même période : la sélection vide (#415), l'abandon des générations remplacées
(#416), les pièces trop lourdes (#418), et l'effacement de la lecture par la collecte (#422, #425). Ces
défauts existaient déjà avant la lecture en avance.

## Pourquoi plusieurs correctifs avant la cause

Analyse tirée des commits ; elle décrit le système, pas les personnes.

1. **Un symptôme commun à plusieurs causes.** « Manifest is partial » est aussi l'issue normale d'une
   vente de plus de six pièces (`PDF_MAX_DOCUMENTS_PER_SALE`). Une passe partielle légitime et une
   boucle se lisaient de la même façon dans le journal.
2. **Des refus muets.** Jusqu'à #423, un point d'étape refusé ne disait pas pourquoi : la validation et
   l'écriture conditionnelle renvoyaient `None` ou `False` en silence. #420 a donc corrigé une hypothèse
   plausible (le manifeste écrit en avance), réelle mais insuffisante : le vidage de 12:39 bouclait
   encore.
3. **Une interaction nouvelle.** La lecture en avance a introduit un second écrivain des fichiers de
   suivi HTTP. La boucle n'apparaît que si un autre processus rafraîchit ces fichiers sans toucher à la
   liste enregistrée. Le test qui la reproduit n'a été écrit qu'avec #421.
4. **Aucune mesure de rendement.** Le vidage n'avait ni bilan des passes partielles ni alerte. Chaque
   constat est venu de la lecture du journal d'un vidage, puis d'un correctif, puis d'un nouveau vidage
   pour vérifier. La référence sans lecture en avance (43 ventes en 150 minutes) n'a été mesurée que le
   05/11.
5. **Des causes empilées.** L'effacement de la lecture par la collecte (#422, #425) remettait des ventes
   dans la file pendant qu'on mesurait le vidage. Il brouillait le compteur de ventes à jour.
6. **Un interrupteur qui demandait un commit.** Couper puis remettre la lecture en avance a demandé deux
   commits (#421, #428) dans le workflow.

## Actions

| #   | Action                                                                                                                                                                                    | État                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Seul un essai réel fait attendre une vente un jour (#415).                                                                                                                                | Fait                                                                           |
| 2   | Une passe remplacée par une nouvelle génération est suivie (#416).                                                                                                                        | Fait                                                                           |
| 3   | Lecture des ventes suivantes hors du verrou (#417), quatre ventes d'avance par processus (#419).                                                                                          | Fait                                                                           |
| 4   | Pièce trop lourde : échec définitif (#418).                                                                                                                                               | Fait                                                                           |
| 5   | La lecture en avance n'écrit plus le manifeste de la vente (#420).                                                                                                                        | Fait                                                                           |
| 6   | Revalidation HTTP en attente toujours reprise, test de la boucle (#421).                                                                                                                  | Fait                                                                           |
| 7   | La collecte n'efface plus la lecture sans changement de la page (#422), ni par une source secondaire (#425).                                                                              | Fait                                                                           |
| 8   | Un point d'étape refusé dit pourquoi (#423).                                                                                                                                              | Fait                                                                           |
| 9   | Lecture en avance remise à 3 processus (#428).                                                                                                                                            | Fait                                                                           |
| 10  | Seuil de la sentinelle des pièces non lues abaissé à 30 (#430).                                                                                                                           | Fait                                                                           |
| 11  | Nombre de processus de lecture en avance réglé par la variable de dépôt `DOCUMENT_BACKLOG_PREFETCH_WORKERS` (T8).                                                                         | Fait dans le code (branche du 08/11) ; variable facultative, défaut 3          |
| 12  | Bilan de fin de vidage (ventes lues, passes partielles, points d'étape refusés, durée, lecture en avance) et alerte `pipeline.documents_backlog.low_yield` (T9).                          | Fait dans le code ; migration `20261111131500` à appliquer par le propriétaire |
| 13  | Runbook du vidage des pièces et README du pipeline (T8).                                                                                                                                  | Fait                                                                           |
| 14  | Clore la série sur preuve : journal d'un vidage complet depuis le 05/11 avec la lecture en avance (passes partielles, points d'étape refusés) et état de `pipeline.enrichment.exhausted`. | À faire. Le rendement après #428 est à confirmer                               |
| 15  | Lire les raisons des refus de point d'étape journalisées depuis #423 et corriger les causes restantes.                                                                                    | À confirmer : aucun commit ne rapporte ces raisons                             |
| 16  | Recalibrer les seuils de l'alerte (60 min, 5 ventes, 30 %) sur les premiers vidages mesurés.                                                                                              | À faire : seuils supposés (état des lieux du 08/11)                            |
