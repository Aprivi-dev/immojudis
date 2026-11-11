<!-- Rapport du spécialiste `architecte-logiciel`, rendu le 11/11/2026 dans la mission « registre des pièces ». Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

## Rapport de l'architecte logiciel : le registre des pièces (conception, lecture seule)

**Limite de méthode à connaître.** Je n'ai pas d'outil shell dans cette session. Je n'ai donc pas pu lancer `git fetch origin main` ni `git show origin/main:…`. Tout ce qui suit vient du répertoire de travail `/home/user/immojudis`. Les migrations citées, jusqu'à `20261115100000` et `20261111013457`, y sont présentes, donc l'état lu est récent. Le `developpeur` doit quand même confirmer que les fichiers cités ne diffèrent pas d'`origin/main` avant de s'y appuyer. Je n'ai rien modifié et je n'ai touché ni à la base ni à aucune branche. Le brouillon de décision est joint à la fin de ce rapport : je n'ai pas d'outil d'écriture pour le déposer dans le scratchpad.

---

### 1. État des lieux

**Comment une valeur arrive sur une fiche, source par source**

| Source                                           | Chemin d'écriture                                                                                                                                                                                                                                                                                                                                                                | Où la provenance est gardée                                                                                                                                        | Où elle se perd                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Annonce                                          | La collecte construit une ligne complète, puis l'insère ou la remplace par `source_url` sur environ 60 colonnes (`UPSERT_COLUMNS`, `services/data-pipeline/src/storage/column_sets.py:20-90`). Le remplacement est fait par `_transaction_write`, `supabase_client.py:266-285`. Une relecture de la même source repart de la ligne entrante (`publication_identity.py:303-308`). | Colonnes `surface_source`, `surface_confidence`, `surface_evidence`, `app_surface_kind` pour la surface seulement ; `raw_payload.source_factual_snapshot`.         | Aucune provenance par champ pour les pièces, l'occupation, le terrain et les visites.                                       |
| Lecture des PDF                                  | Valeurs écrites dans les mêmes colonnes. Elles sont reprises de la ligne connue à la collecte suivante par `known_document_backfill.py` (surfaces, mise à prix, date, occupation), appelé dans `main.py:1308-1312`.                                                                                                                                                              | `raw_payload.surface_extraction`, `land_surface_extraction`, `pdf_fact_provenance.<champ>`                                                                         | Si la liste des documents change, la reprise est sautée (`main.py:1279-1284`). Le nombre de pièces n'est pas repris.        |
| Avocat (après acceptation par un administrateur) | Écrit **en place** par `app_private.apply_information_agent_fact` (`20261114100000_information_agent_publication_core.sql:243-335`), plus `raw_payload.information_agent_verified_facts`.                                                                                                                                                                                        | Journal `information_agent_fact_publications` (valeurs précédentes et nouvelles), une ligne `auction_fact_claims` « accepted » créée par le pont (lignes 586-815). | Effacé à la collecte suivante, constat du spécialiste du pipeline. Effacé aussi à la fusion de doublons, voir le risque R2. |
| Administrateur                                   | Aucune saisie libre de champ trouvée. Il passe par la relecture d'un fait de l'agent ou d'une observation (`review_auction_fact_claim`), qui **n'écrit pas** la colonne.                                                                                                                                                                                                         |                                                                                                                                                                    |                                                                                                                             |
| Géocodage, estimation                            | Valeurs dérivées : `latitude`/`longitude` et `raw_payload.geocode` d'un côté, estimations précalculées en file (`enqueue_auction_sale_market_estimate`) de l'autre.                                                                                                                                                                                                              |                                                                                                                                                                    | Ce ne sont pas des « pièces du puzzle ». Je propose de les laisser hors du registre.                                        |

**Visites (vérifié).** Le noyau n'a aucune branche pour `visit_information` : un fait « visite » accepté ne touche pas la colonne `visit_dates`. Il ne va que dans `raw_payload.information_agent_verified_facts`, et aucun fichier de `src/` ne lit cette clé (recherche sans résultat). Une visite acceptée aujourd'hui n'apparaît donc sur aucune fiche.

**La provenance est éparpillée en sept endroits** : les colonnes `surface_*`, `raw_payload.*_extraction`, `raw_payload.pdf_fact_provenance`, `raw_payload.source_factual_snapshot`, `raw_payload.information_agent_verified_facts`, `auction_fact_claims` et `information_agent_fact_publications`. Exemple vérifié : le retrait des nombres de pièces faux lus dans les PDF s'est fait par un `UPDATE` de masse qui reconstruit la provenance après coup (`20261111013457_clear_unlocated_pdf_room_counts.sql:19-31`). Avec un registre, ce retrait aurait été un simple changement de statut.

**Ce que fait réellement `auction_fact_claims` (vérifié dans le code)**

- **Structure** : `20260928140000_auction_fact_claims.sql`. La table porte `auction_sale_id` et `lot_id` (clé vers `auction_lots`), `field_key`, `value_jsonb`, six statuts (candidate, accepted, rejected, superseded, conflicted, withdrawn), `evidence_kind`, des pointeurs de preuve, une confiance et l'extracteur. Chaque ligne est une observation qu'on ne peut plus modifier, et toute suppression est interdite (lignes 282-393).
- **Écrivains** :
  - Le pipeline, dans la même transaction que la vente (`supabase_client.py:590-596`, `619-644`), uniquement au statut `candidate`, sans jamais renseigner `lot_id` (`fact_claim_rows.py:22-34`). Il couvre 7 champs : date, mise à prix, surface, surface habitable, surface Carrez, terrain, occupation (`fact_claims.py:29-109`). Le nombre de pièces et les visites n'y sont pas.
  - Le pont de l'agent, pour les faits acceptés, en ajoutant `property.rooms_count` et `property.property_type`.
- **Lecteurs** : aucun affichage de fiche. Elle est lue par la relecture administrateur (`src/lib/admin-auction-fact-claims-review.ts`), les signaux de fiabilité (`src/lib/auction-fact-claims.ts`, route `src/app/api/sales/[id]/facts`) et la préparation des questions aux avocats (`information-agent/draft.ts`, `autopilot-candidates.ts`, `api/sales/[id]/lawyer-questions`).
- **Une logique circulaire** : accepter une observation exige qu'elle soit déjà **égale** à la colonne (`20260928180000_admin_auction_fact_claim_review.sql:87-126`). Le pont fait le même contrôle à l'envers. La table enregistre la colonne, elle ne la commande jamais.
- **Volume** : 17 136 lignes et 11 Mo au 10/10/2026 (`docs/audits/2026-10-10-admin-requetes-lourdes.md:16`), presque toutes au statut `candidate` (supposé, faute d'accès en lecture à la base). La table croît à chaque valeur ou citation nouvelle. Un `SELECT` agrégé par champ, statut et `lot_id` est à faire.
- **Deux défauts bloquants pour en faire le registre** :
  1. Une décision prise est figée (lignes 377-389). Une observation acceptée ne peut donc **jamais** passer à « withdrawn » : le retrait est impossible dans le modèle actuel.
  2. `auction_sale_id ... on delete set null` : une fusion détache les observations de la vente supprimée.

**Mon avis franc.** `auction_fact_claims` peut **stocker les observations** du registre : elle a déjà le lot, la preuve, le caractère immuable et l'écran de relecture. Il lui manque trois choses : un journal des décisions séparé, qui rende le retrait possible ; une projection qui commande la colonne au lieu de la recopier ; et un report des observations lors d'une fusion. Une table neuve ferait doublon avec elle.

---

### 2. Trois architectures comparées

|                                | **A. Les observations font foi, toutes les colonnes deviennent une projection**                                                                                                             | **B. Les colonnes restent la vérité, avec une couche de pièces réappliquées à l'écriture** | **C. Registre limité aux 5 champs demandés aux avocats, projeté dans les colonnes**                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ce que la fiche lit            | Les colonnes, recalculées depuis les observations                                                                                                                                           | Les colonnes                                                                               | Les colonnes, plus une provenance par champ                                                                                                                          |
| Branchement de la collecte     | Toute la normalisation Python (lot, surfaces, cohérence pièces et chambres) doit produire des observations, et la projection doit refaire en SQL ce que fait Python. Double implémentation. | Inchangé. Un déclencheur avant écriture sur `auction_sales` réapplique les valeurs tenues. | Inchangé, sauf un correctif Python (voir R3). Déclencheur avant écriture limité aux 5 champs, avec un chemin rapide pour les ventes sans pièce tenue (plus de 99 %). |
| Conflit entre deux sources     | Visible : deux observations actives                                                                                                                                                         | Invisible : la valeur de l'annonce est écrasée sans trace                                  | Visible : la valeur entrante qui diffère de la pièce tenue est enregistrée comme observation de l'annonce, groupe de conflit, puis relecture                         |
| Retrait d'une pièce            | Décision de retrait, puis nouveau calcul                                                                                                                                                    | Supprimer la valeur tenue, mais la valeur de l'annonce est perdue                          | Décision de retrait, puis nouveau calcul à partir de la valeur de l'annonce gardée à part                                                                            |
| Scoring, recherche, estimation | À reprendre : 58 migrations lisent ces colonnes                                                                                                                                             | Inchangés                                                                                  | Inchangés. Le calcul met l'estimation en file comme aujourd'hui.                                                                                                     |
| Coût, risque, effort           | L+ (plusieurs semaines). Grand soir, risque élevé de faire changer des fiches par accident.                                                                                                 | M. Mais le mécanisme est caché et sans trace de conflit.                                   | M à L, étalé sur des étapes réversibles                                                                                                                              |
| Ce qu'on jette                 | Une large part de la reprise Python                                                                                                                                                         | Rien, mais on garde l'éparpillement                                                        | Le pont, l'écriture en place du noyau, `information_agent_verified_facts`, le correctif 2 bis prévu en Python                                                        |
| Si Supabase tombe              | Plus aucune fiche correcte tant que le calcul n'a pas tourné                                                                                                                                | Sans effet propre                                                                          | Sans effet propre : la colonne garde la dernière valeur calculée                                                                                                     |

**Ce que ne règle aucune des trois sans correctif : l'écho.** Quand la page source n'a pas changé, la collecte recopie dans la ligne entrante la valeur déjà en base pour `surface_*`, `rooms_count`, etc. (liste `KNOWN_UNCHANGED_BACKFILL_FIELDS`, `main.py:145-175`, vérifiée). Une valeur d'avocat revient donc comme si l'annonce la disait, et survit à son retrait. Le correctif tient en une ligne de règle : ne jamais recopier un champ dont la provenance n'est pas l'annonce.

---

### 3. Recommandation : C, en stockant les observations dans `auction_fact_claims`

Chaque étape est livrable seule et réversible.

| Étape                     | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Utile seule                               | Retour arrière                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 0                         | Mesures en `SELECT` seulement (section 7)                                                                                                                                                                                                                                                                                                                                                                                                                                       | Fixe le périmètre des étapes              | Sans objet                                                                                             |
| 1                         | **Journal des décisions** `auction_fact_claim_decisions` (ajout seul : accepted, withdrawn, opposed, contradicted ; auteur, motif, date), table de **préséance par champ** (données, pas de code), fonction unique `app_private.project_sale_fields(sale_id, fields[])` en mode **observation seule** : elle calcule le gagnant de chaque champ sans rien écrire                                                                                                                | Montre les conflits, et prépare l'étape 2 | Supprimer les objets créés : aucune fiche n'a changé                                                   |
| 2                         | **Comparaison sur toute la base** : calcul de la projection contre la valeur des colonnes, sur toutes les ventes. Écart attendu : zéro, en dehors des faits d'avocat. Test pgTAP sur des cas types, plus une requête de lecture en production.                                                                                                                                                                                                                                  | Prouve que rien ne bouge                  | Sans objet                                                                                             |
| 3                         | **Bascule** : déclencheur `BEFORE INSERT OR UPDATE` sur `auction_sales` pour les 5 champs. Une colonne `held_fields`, nulle par défaut, sert de chemin rapide. La valeur entrante de l'annonce est gardée à part. Le noyau écrit la pièce et sa décision, puis appelle la projection au lieu de faire son `UPDATE`. Le pont est retiré. Correctif de l'écho dans `main.py`. Report des observations et des faits de l'agent lors d'une fusion. **Ceci remplace l'étape 2 bis.** | Une réponse acceptée n'est plus effacée   | Désactiver le déclencheur et rétablir le noyau précédent ; les colonnes gardent la dernière projection |
| 4                         | Provenance publique lue dans `field_provenance` (colonne remplie par la projection), sous la même signature `get_public_sale_lawyer_fact_sources`                                                                                                                                                                                                                                                                                                                               | Mention « avocat poursuivant » fiable     | Rétablir la fonction actuelle                                                                          |
| 5                         | **Formulaire structuré** pour les avocats. Il s'ajoute à `/contribuer` (texte libre aujourd'hui, `information-agent-contribution-rules.ts:22-28`) : un bloc par lot et par question, des valeurs typées, une date de visite structurée. Chaque champ donne une observation directe, sans extraction.                                                                                                                                                                            | Fiabilité bien plus haute que l'email     | Masquer le formulaire                                                                                  |
| 6                         | **Validation en un clic** : relecture des observations (une ligne par champ : valeur actuelle, valeur proposée, source, lot), qui écrit une décision                                                                                                                                                                                                                                                                                                                            | Débloque les 0 acceptées                  | Sans effet sur les données                                                                             |
| 7                         | Visites dans la colonne `visit_dates`, une fois la date structurée en place                                                                                                                                                                                                                                                                                                                                                                                                     | Le champ apparaît enfin sur la fiche      | Retirer le champ de la projection                                                                      |
| 8                         | **Automatique champ par champ** : une décision `auto` dans le même journal, aux conditions déjà validées. Les verrous `auto_locked` restent tant que les préalables ne sont pas levés.                                                                                                                                                                                                                                                                                          | Ce que demande le propriétaire            | Décision de retrait, et arrêt d'urgence existant                                                       |
| 9 (plus tard, facultatif) | Lectures des PDF enregistrées comme observations, puis retrait de `known_document_backfill`                                                                                                                                                                                                                                                                                                                                                                                     | Fin de l'éparpillement                    | Garder la reprise Python                                                                               |

**Quand retirer l'écriture en place.** À l'étape 3, et seulement si la comparaison de l'étape 2 ne montre aucun écart inexpliqué.

**Coexistence.** De l'étape 1 à l'étape 2, l'ancien chemin écrit et le nouveau ne fait que calculer. À partir de l'étape 3, le nouveau écrit et l'ancien journal reste en lecture.

---

### 4. Cadre de préséance (les ordres eux-mêmes reviennent au spécialiste des données)

1. **Ordre des sources, par champ**, rangé dans une table et non dans le code. Sources : annonce, PDF, avocat (email), avocat (formulaire), administrateur, lecture IA. Chaque champ a son propre ordre.
2. **Statut de la pièce** : seules les pièces actives (acceptées, ni retirées ni opposées) entrent en compétition. Une pièce contredite reste active mais met le champ en relecture. L'affichage, contredit ou non, est à trancher.
3. **Spécificité du lot** : une pièce rattachée au lot passe avant une pièce valable pour toute la page. Une pièce sans lot, sur une vente à plusieurs lots, ne gagne jamais.
4. **Fraîcheur** : la date de l'observation à la source (date de la réponse, date du document), pas la date d'enregistrement. Elle ne départage que des pièces de même rang.
5. **Nature de la valeur** : la surface a plusieurs natures (habitable, Carrez, totale, terrain). La pièce doit déclarer la sienne, et la préséance entre natures relève du spécialiste des données.
6. **Retrait et opposition** : un retrait relance le calcul, qui retombe sur la meilleure pièce restante, en général l'annonce, gardée à part. Une opposition de l'avocat retire toutes ses pièces sur la vente.
7. **Règle déjà validée à reprendre telle quelle** (décision 2 bis du propriétaire) : si l'annonce dit autre chose que l'avocat, l'annonce l'emporte et le cas part en relecture.

---

### 5. Rattachement à la bonne vente et au bon lot

- **Aujourd'hui, une ligne `auction_sales` correspond de fait à un lot.** Les pages Licitor à plusieurs lots donnent une vente par URL de lot, avec `raw_payload.source_lot_selection` à « selected » ou « ambiguous » (`lot_scope.py:19-43`). Les autres annonces à plusieurs lots sont mises en quarantaine (`admission.py:186-231`). Le numéro de lot n'existe que dans `raw_payload`, sans colonne.
- **`auction_lots`** relie au plus un lot à une vente (`auction_sale_id unique`, `20260730105842_outcome_graph_foundation.sql:106`). Elle n'est remplie que par le pont Outcome, et on ne sait pas combien de ventes à venir elle couvre. Son vocabulaire d'occupation diffère de celui des ventes (`tenant_occupied` contre `rented`).
- **Les dossiers et les faits de l'agent n'ont aucun lot** (`information_agent_fact_candidates`, `20260825103748…:113-138`).
- **Proposition** : la pièce porte `auction_sale_id` (obligatoire), `lot_ref` (le numéro de lot tel qu'énoncé par la source) et un statut de rattachement (certain, ambigu, non rattaché). Elle n'est projetée que si la vente n'a qu'un lot, ou si `lot_ref` correspond au lot de la vente. `auction_lots.id` reste facultatif. Le formulaire présente un bloc par vente sœur d'une même procédure.
- **Ce qui manque** : une colonne de numéro de lot et de nombre de lots sur la vente ; un lien de « fratrie » entre les ventes d'une même annonce ; le lot sur les faits de l'agent.

---

### 6. Ce que deviennent les étapes déjà en production

| Élément                                                | Sort                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noyau `apply_information_agent_fact`                   | **Adapté.** Les contrôles restent ; l'`UPDATE` en place est remplacé par « observation, puis décision, puis projection ». Photos et documents ne changent pas. |
| Journal `information_agent_fact_publications`          | **Gardé**, avec un lien vers l'observation. Sa clé `sale_id ... on delete cascade` (ligne 62) doit passer à un report lors de la fusion.                       |
| Pont `bridge_accepted_information_agent_fact_claim`    | **Remplacé** : son contrôle d'égalité casserait dès que l'annonce l'emporte                                                                                    |
| `review_auction_fact_claim`                            | **Adapté** : l'acceptation n'exige plus l'égalité avec la colonne                                                                                              |
| Mention publique `get_public_sale_lawyer_fact_sources` | **Même signature, autre implémentation** (lecture de `field_provenance`)                                                                                       |
| `raw_payload.information_agent_verified_facts`         | **Plus écrit** après l'étape 3. Une lecture subsiste dans `catalogue_readiness.py:359` (documents), à reprendre.                                               |
| Moteur de simulation, réglages, verrous `auto_locked`  | **Gardés tels quels**. La décision automatique s'inscrira dans le journal des décisions à l'étape 8.                                                           |
| Jeu d'évaluation                                       | **Gardé** : il teste l'extraction, indépendante du stockage. Ajouter des cas de lot.                                                                           |
| Correctif 2 bis prévu en Python                        | **À ne pas faire** : il serait jeté à l'étape 3                                                                                                                |

---

### 7. Risques et inconnues

- **R1, l'offre de réponses** (vérifié par vos chiffres : 5 dossiers, 1 réponse de test, 0 acceptée). Le registre est surtout un effort de moyen terme pour un flux encore nul. Sans lui, pourtant, toute réponse acceptée est effacée en 5 à 23 heures. Les étapes 1 à 3 restent justifiées ; le formulaire structuré de l'étape 5 est sans doute le meilleur levier pour obtenir des réponses.
- **R2, la fusion de doublons.** Vérifié dans les migrations : le déclencheur de report à la fusion (`20261028110000_carry_user_data_on_sale_merge.sql`) déplace favoris, notes, alertes et estimations, mais **ni** les dossiers de l'agent **ni** les observations. Or `information_agent_fact_candidates.sale_id` et le journal sont en `on delete cascade`, et `auction_fact_claims` en `set null`. Une fusion efface donc la réponse de l'avocat et sa trace.
- **R3, l'écho de la collecte** (section 2). Risque qu'une valeur retirée revienne présentée comme celle de l'annonce.
- **R4, la table la plus sollicitée**, qui a déjà 16 déclencheurs. Le chemin rapide `held_fields` est indispensable, et le coût est à mesurer sur une base jetable.
- **R5, la logique de préséance en PL/pgSQL.** Elle se teste avec pgTAP, mais c'est une règle métier dans la base. Je l'accepte, car c'est le seul endroit commun à tous les écrivains (collecte Postgres, collecte REST de secours, fusion, migrations de masse). En contrepartie, la préséance doit rester une table de données.
- **À mesurer avant de décider** (en `SELECT` seulement) :
  - répartition des observations par champ, statut et `lot_id` ;
  - part des ventes à venir à plusieurs lots, avec rattachement « selected » ou « ambiguous » ;
  - couverture des ventes à venir par `auction_lots` ;
  - fréquence de réécriture d'une vente par jour ;
  - nombre de changements de valeur de l'annonce sur les 5 champs, d'une collecte à l'autre ;
  - nombre de fusions par semaine.

---

### Propositions

| N°  | Proposition                                                                                          | Priorité | Effort | Dépend de                 |
| --- | ---------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------- |
| 1   | Mesures en `SELECT` seulement (section 7)                                                            | Haute    | S      | Aucune                    |
| 2   | Report des dossiers, faits, journal et observations de l'agent lors d'une fusion                     | Critique | M      | Aucune                    |
| 3   | Journal des décisions en ajout seul, table de préséance, projection en observation seule             | Critique | M      | 1                         |
| 4   | Comparaison complète de la projection avec les colonnes (pgTAP et lecture en production)             | Critique | M      | 3                         |
| 5   | Bascule : déclencheur sur les 5 champs, noyau adapté, pont retiré, valeur de l'annonce gardée à part | Critique | L      | 4                         |
| 6   | Correctif de l'écho dans la reprise de la collecte                                                   | Critique | S      | 5 (même livraison)        |
| 7   | Rattachement au lot : colonnes lot et nombre de lots, `lot_ref` sur les pièces et les faits          | Haute    | M      | 1                         |
| 8   | Provenance par champ et mention publique sous la même signature                                      | Haute    | S      | 5                         |
| 9   | Formulaire structuré pour les avocats, un bloc par lot                                               | Haute    | M      | 5, 7                      |
| 10  | Validation en un clic sur les observations                                                           | Haute    | M      | 5                         |
| 11  | Visites structurées projetées dans `visit_dates`                                                     | Moyenne  | M      | 9                         |
| 12  | Automatique champ par champ, dans le journal des décisions                                           | Moyenne  | M      | 10, préalables juridiques |
| 13  | Lectures des PDF enregistrées comme observations, puis retrait de `known_document_backfill`          | Moyenne  | L      | 5                         |

**Points écartés.** A, trop risquée et sans étapes réversibles. B pure, parce qu'elle laisse les conflits invisibles et rend un vrai retrait impossible. Une table de pièces neuve, qui ferait doublon avec `auction_fact_claims`. Le correctif 2 bis en Python, qui serait jeté à la bascule. Géocodage et estimation dans le registre : ce sont des valeurs calculées, pas des pièces.

### Décisions qui relèvent du propriétaire

1. Remplacer le correctif 2 bis par le registre (étapes 3 à 5), quitte à attendre environ une à deux semaines avant qu'une réponse acceptée tienne sur la fiche ?
2. Quand l'annonce et l'avocat se contredisent, l'annonce reste-t-elle affichée, avec une relecture, comme vous l'aviez validé ?
3. Une réponse qui ne nomme pas le lot, sur une vente à plusieurs lots, part-elle toujours en relecture, sans jamais être publiée ?
4. Une opposition de l'avocat retire-t-elle immédiatement toutes ses informations sur la fiche ?
5. Les visites : n'accepter que des dates structurées, saisies dans le formulaire, et ne jamais publier de texte libre ?
6. Faut-il ensuite ranger aussi les lectures des PDF dans le registre (étape 13), ou s'arrêter aux 5 champs ?
7. Faut-il traiter en priorité le report lors des fusions (proposition 2), même avant le registre ? Aujourd'hui, une fusion efface les réponses des avocats.

---

### Brouillon de décision d'architecture (statut : proposée)

**Titre.** Registre des pièces : `auction_fact_claims` stocke les observations, les colonnes de `auction_sales` sont une projection limitée aux 5 champs demandés aux avocats.

**Contexte.** La collecte réécrit toute la ligne d'une vente, et les valeurs des avocats sont perdues. La provenance est répartie en sept endroits. `auction_fact_claims` existe déjà, mais elle ne commande aucune colonne et ne permet pas de retirer une décision.

**Décision.**

- Les observations restent immuables dans `auction_fact_claims`, et un journal des décisions en ajout seul porte l'acceptation, le retrait et l'opposition.
- Une fonction SQL unique calcule le gagnant de chaque champ selon une table de préséance. Un déclencheur sur `auction_sales` l'applique aux 5 champs à chaque écriture, et la valeur de l'annonce est gardée à part.
- Scoring, recherche, estimation et pages continuent de lire les colonnes.

**Ce qui devient plus facile.** Retirer une pièce, voir un conflit, ouvrir l'automatique champ par champ, ajouter une source.

**Ce qui devient plus difficile.** Une règle métier vit en PL/pgSQL, sur la table la plus sollicitée. Toute écriture directe des 5 colonnes est réinterprétée par le déclencheur, ce qui doit être documenté dans `docs/architecture/current-state.md`.

**Ce qui rendrait la décision caduque.** Si la collecte devait écrire champ par champ au lieu de remplacer la ligne, ou si une vente pouvait porter plusieurs lots publiés, il faudrait faire de la projection une table par lot.

**Fichiers cités** (chemins absolus) :

- /home/user/immojudis/supabase/migrations/20260928140000_auction_fact_claims.sql
- /home/user/immojudis/supabase/migrations/20260928180000_admin_auction_fact_claim_review.sql
- /home/user/immojudis/supabase/migrations/20260928200000_information_agent_fact_claim_bridge.sql
- /home/user/immojudis/supabase/migrations/20261114100000_information_agent_publication_core.sql
- /home/user/immojudis/supabase/migrations/20261115100000_information_agent_auto_publication_simulation.sql
- /home/user/immojudis/supabase/migrations/20261028110000_carry_user_data_on_sale_merge.sql
- /home/user/immojudis/supabase/migrations/20261111013457_clear_unlocated_pdf_room_counts.sql
- /home/user/immojudis/supabase/migrations/20260730105842_outcome_graph_foundation.sql
- /home/user/immojudis/supabase/migrations/20260825103748_centralize_information_agent_cases.sql
- /home/user/immojudis/services/data-pipeline/src/fact_claims.py
- /home/user/immojudis/services/data-pipeline/src/storage/fact_claim_rows.py
- /home/user/immojudis/services/data-pipeline/src/storage/supabase_client.py
- /home/user/immojudis/services/data-pipeline/src/storage/column_sets.py
- /home/user/immojudis/services/data-pipeline/src/main.py
- /home/user/immojudis/services/data-pipeline/src/known_document_backfill.py
- /home/user/immojudis/services/data-pipeline/src/lot_scope.py
- /home/user/immojudis/services/data-pipeline/src/publication_identity.py
- /home/user/immojudis/services/data-pipeline/src/catalogue_readiness.py
- /home/user/immojudis/src/lib/auction-fact-claims.ts
- /home/user/immojudis/src/lib/information-agent-contribution-rules.ts
