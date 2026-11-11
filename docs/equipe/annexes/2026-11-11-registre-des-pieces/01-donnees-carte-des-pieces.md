<!-- Rapport du spécialiste `qualite-donnees`, rendu le 11/11/2026 dans la mission « registre des pièces ». Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# Registre des pièces : carte des manques, provenance, contradictions, contacts, ordre de confiance (11/11/2026)

Aucune donnée modifiée. Uniquement des SELECT. Base : 1 056 ventes avec `sale_date >= current_date` (reproduit les chiffres du brief : 277 sans surface, 629 sans pièces, 311 sans occupation, 152 sans visites, 109 sans avocat). Aucune donnée personnelle affichée : comptages seulement.

Légende : **[M]** mesuré en base, **[S]** supposé ou déduit.

**Précautions de charge.** Toutes les requêtes partent de `sale_date >= current_date` (index `idx_auction_sales_sale_date`, plan `Index Only Scan` / `Bitmap Index Scan` sur 1 056 lignes, vérifié par EXPLAIN). Jointures vérifiées par EXPLAIN : documents par `source_url` (Nested Loop sur index unique), claims par `auction_sale_id` (Merge Join sur `auction_fact_claims_sale_field_idx`). Trois écarts à signaler. (1) Un `group by` sur toute la table `auction_documents` (2 808 lignes) a été lancé sans EXPLAIN préalable. (2) La jointure des claims fait un parcours complet d'index sur 37 765 lignes. (3) Une jointure OR avec `information_agent_contacts` (211 lignes) a été planifiée en Nested Loop (1 056 x 211), puis réécrite en deux jointures d'égalité. Tout est resté très petit, mais la règle de départ n'a pas été suivie à la lettre sur le point (1).

---

## 1. Carte des pièces manquantes (ventes à venir)

### 1a. Par site source [M]

Requête : `select source_name, count(*), count(*) filter (where coalesce(app_surface_m2,surface_m2,habitable_surface_m2,carrez_surface_m2,0)<=0), count(*) filter (where rooms_count is null), count(*) filter (where bedrooms_count is null), count(*) filter (where occupancy_status is null or occupancy_status in ('','unknown')), count(*) filter (where visit_dates is null or visit_dates in ('[]'::jsonb,'null'::jsonb,'{}'::jsonb)), ... from auction_sales where sale_date >= current_date group by 1`. DPE et charges viennent de `raw_payload->'source_field_observations' ? 'dpe_class'` et `? 'coownership_charges_eur'`.

| Source                | Ventes | Sans surface | Sans pièces | Sans chambres | Sans occupation | Sans visites | Sans DPE    | Sans avocat |
| --------------------- | ------ | ------------ | ----------- | ------------- | --------------- | ------------ | ----------- | ----------- |
| licitor               | 410    | 172 (42 %)   | 332 (81 %)  | 194 (47 %)    | 158 (39 %)      | 55 (13 %)    | 408 (99 %)  | 0           |
| notaires              | 204    | 7 (3 %)      | 34 (17 %)   | 33 (16 %)     | 29 (14 %)       | 42 (21 %)    | 33 (16 %)   | 0           |
| avoventes             | 158    | 26 (16 %)    | 60 (38 %)   | 36 (23 %)     | 26 (16 %)       | 4 (3 %)      | 126 (80 %)  | 0           |
| vench                 | 108    | 39 (36 %)    | 82 (76 %)   | 80 (74 %)     | 62 (57 %)       | 25 (23 %)    | 108 (100 %) | 77 (71 %)   |
| encheres_immobilieres | 71     | 19 (27 %)    | 45 (63 %)   | 37 (52 %)     | 16 (23 %)       | 0            | 70          | 0           |
| info_encheres         | 54     | 13 (24 %)    | 43 (80 %)   | 26 (48 %)     | 13 (24 %)       | 5 (9 %)      | 51          | 0           |
| cessions_etat         | 24     | 1            | 22 (92 %)   | 23            | 4               | 20 (83 %)    | 20          | 24 (tous)   |
| petites_affiches      | 19     | 0            | 6           | 4             | 2               | 0            | 19          | 0           |
| agrasc                | 8      | 0            | 5           | 1             | 1               | 1            | 8           | 8 (tous)    |

Autres champs : mise à prix absente sur 22 ventes (16 sont des `cessions_etat`, soit 67 % de cette source). Adresse absente ou de moins de 5 caractères : 14. Coordonnées absentes : 5. Date d'audience : jamais absente, et 1 043 sur 1 056 ont une heure.

### 1b. Par type de bien, avec les faux manques corrigés [M]

| Type       | Ventes | Sans surface | Sans terrain            | Sans pièces | Sans chambres | Sans occupation | Sans visites | Sans DPE   | Charges inconnues |
| ---------- | ------ | ------------ | ----------------------- | ----------- | ------------- | --------------- | ------------ | ---------- | ----------------- |
| house      | 410    | 105 (26 %)   | **175 (43 %)**          | 230 (56 %)  | 104 (25 %)    | 109 (27 %)      | 50 (12 %)    | 289 (70 %) | n/a               |
| apartment  | 398    | 61 (15 %)    | n/a (398 = faux manque) | 168 (42 %)  | 117 (29 %)    | 95 (24 %)       | 35 (9 %)     | 324 (81 %) | **354 (89 %)**    |
| building   | 69     | 42 (61 %)    | 52 (75 %)               | n/a         | n/a           | 30 (43 %)       | 14           | 61         | n/a               |
| land       | 63     | 25 (40 %)    | 27 (43 %)               | n/a         | n/a           | 27              | 34 (54 %)    | n/a        | n/a               |
| mixed      | 52     | 24 (46 %)    | 34 (65 %)               | n/a         | n/a           | 25              | 6            | 47         | n/a               |
| commercial | 48     | 8 (17 %)     | 36                      | n/a         | n/a           | 16 (33 %)       | 7            | 43         | n/a               |
| parking    | 16     | 12 (75 %)    | n/a                     | n/a         | n/a           | 9               | 6            | n/a        | n/a               |

**Corrections des faux manques.**

- Terrain : les 738 manques tombent à environ 288 sur les 594 biens où un terrain a un sens (house, land, building, mixed), soit 48 %. En restreignant à house et land : 202 sur 473 (43 %). Les 398 appartements et les 16 parkings sont à exclure.
- Pièces et chambres : n'ont de sens que pour house et apartment. Pièces : 398 manques sur 808 (49 %). Chambres : 221 sur 808 (27 %).
- Surface d'un terrain nu : le champ est la surface du terrain elle-même.
- Une pièce "présente" n'est pas toujours explicite [M]. Parmi les 427 ventes qui ont un nombre de pièces, 169 sont marquées `inferred` dans `source_field_observations` (donc déduites, pas lues), contre 254 `explicit`. Même chose pour les chambres : 164 `inferred` contre 156 `explicit`. Le vrai taux de complétude "prouvé" des pièces est d'environ 24 %, pas 40 %.
- Visites : 43 ventes sont marquées explicitement `unknown/unavailable` par la source. Ce manque est sûr, pas un oubli de collecte.
- DPE : 843 ventes sans classe (80 %). La classe est portée par `raw_payload.source_field_observations.dpe_class` et `source_energy_diagnostics`. Il n'existe pas de colonne dédiée sur `auction_sales`. Chaque source a une couverture très inégale : notaires 171/204, licitor 2/410, vench 0/108.
- Charges de copropriété : connues sur 48 ventes seulement, dont 46 viennent de `notaires`. Les 354 appartements restants n'ont aucune donnée.

**Précision de l'adresse [M]** : 116 ventes ont un géocodage `municipality` seulement (adresse imprécise), 44 `street`, 24 `parcel`, 419 `address`, 453 sans niveau de précision enregistré (`raw_payload->'geocode'->>'precision'`).

**Quarantaine [M]** : 224 des 1 056 ventes (21 %) sont `catalogue_quarantined`. Hors quarantaine (832 ventes) : sans surface 198, sans pièces 479, sans occupation 207, sans visites 117, sans avocat 31. Les 78 ventes sans avocat en quarantaine viennent surtout de vench et cessions_etat.

### 1c. Ce qu'on peut vraiment demander à un avocat [S, d'après `src/lib/information-agent-inventory.ts` et le runbook]

L'inventaire de l'agent liste 13 clés : audience, lieu, mise à prix, surface, occupation, visites, photos, CCV, PV descriptif, diagnostics, cadastre, composition, modalités.

| Champ                                        | Demandable à l'avocat ?                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Surface (Carrez ou habitable)                | Oui, mais il vaut mieux demander le PV ou le CCV                                   |
| Occupation                                   | Oui, fait précis, mais voir §6 sur le risque de données de tiers                   |
| Dates de visite                              | Oui, périssable, l'avocat est la bonne source                                      |
| Nombre de pièces                             | Oui, en second choix (la réponse est vague)                                        |
| Terrain                                      | Seulement en demandant le CCV (le chiffre vient du cadastre)                       |
| DPE, charges                                 | Non en valeur : demander la pièce (diagnostics, état daté) ou aller chercher ADEME |
| Chambres                                     | Faible intérêt (information déjà dans le PV)                                       |
| Mise à prix, audience, adresse, type de bien | À confirmer seulement, jamais à demander à nouveau                                 |

---

## 2. D'où viennent les pièces aujourd'hui

### 2a. Provenance par champ [M]

| Champ            | Colonne de provenance                        | Ce qu'elle dit (ventes à venir)                                                                                                                                                                                    |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Surface          | `surface_source` (renseignée sur 770 ventes) | `source_text` (annonce) environ 419 ventes ; `notaires.*` environ 156 ; `pdf` 106 (10 % des ventes) ; `deterministic_surface_reasoning` 49 ; `llm_structured_verified` 4 ; vide 286 (dont 264 sans aucune surface) |
| Pièces, chambres | `source_field_observations.*.provenance`     | `explicit` (annonce), `inferred` (déduit, 40 % des pièces présentes). **Jamais "pdf"**                                                                                                                             |
| Occupation       | `source_field_observations.occupancy_status` | `explicit` 687 ventes, `conflict` 8. Aucune colonne ne dit si l'occupation vient d'un PDF                                                                                                                          |
| Visites          | idem                                         | `explicit` 166, `parser_field` 13, `unknown/unavailable` 43                                                                                                                                                        |
| Avocat           | idem                                         | `explicit` 606, `parser_field` 204, `structured_contact` 798                                                                                                                                                       |
| Terrain          | idem                                         | `parser_field` 295 ventes (annonce) ; le PDF fournit des candidats à part (voir 2c)                                                                                                                                |
| DPE              | idem                                         | `parser_field` 175 + `explicit` 38 (213 ventes)                                                                                                                                                                    |
| Mise à prix      | `auction_fact_claims`                        | listing : 1 036 ventes ; document : 192 ventes                                                                                                                                                                     |

Le registre existe déjà en partie [M]. `auction_fact_claims` contient 37 765 lignes au total. Pour les ventes à venir : 10 389 claims issues de l'annonce (`source_listing`, 1 056 ventes) et 450 issues d'un document (`source_document`, 261 ventes). **Les 10 839 sont toutes au statut `candidate`** : aucune `accepted`, aucune `conflict`. `lot_id` est nul partout. Seuls six champs sont couverts : surface, Carrez, habitable, terrain, occupation, mise à prix, plus la date de vente. `information_agent_fact_candidates` contient 0 ligne et `information_agent_fact_publications` 0 ligne.

### 2b. Documents officiels possédés [M]

Requête : jointure `auction_sales.source_url = auction_documents.source_url` bornée par `sale_date >= current_date`. Types officiels retenus : `cahier_conditions_vente`, `conditions_vente`, `pv_huissier`, `proces_verbal`, `pv_notaire`, `procedure_saisie`. "Lu" = `download_status in ('verified','downloaded')` et `extraction_status = 'extracted'`.

| Indicateur                                 | Ventes  | Part des 1 056 |
| ------------------------------------------ | ------- | -------------- |
| Au moins un document (n'importe quel type) | 372     | 35 %           |
| Au moins un document officiel référencé    | 353     | 33 %           |
| dont CCV                                   | 321     | 30 %           |
| dont PV (huissier ou notaire)              | 310     | 29 %           |
| Document officiel téléchargé               | 314     | 30 %           |
| Document officiel lu avec succès           | **310** | **29 %**       |

Taux de lecture parmi les téléchargés : 310/314 = 98,7 % **[M]**. Écart téléchargé/référencé : 39 ventes ont un officiel référencé mais jamais téléchargé (statut `unknown`, extraction `pending`). Sur toute la table `auction_documents`, 227 CCV sur 601 sont en attente de téléchargement (38 %) **[M]**.

Lecture IA par vente (`auction_document_readings`) : 356 `completed` (moyenne 8,4 points), 10 `no_text`, 6 `LLMTaskDeadlineExceeded`, 1 `ValueError` **[M]**.

Couverture par source (ventes avec document officiel lu / ventes) : licitor 56/410 (14 %), avoventes 149/158, info_encheres 53/54, cessions_etat 24/24, vench 12/108, encheres_immobilieres 12/71, petites_affiches 3/19, agrasc 1/8, **notaires 0/204** **[M]**. Licitor concentre 172 des 277 surfaces manquantes et n'a presque aucun PDF. Les 204 ventes notaires n'ont aucun document. Limite : la jointure par `source_url` ne voit que le document de l'URL principale ; une vente fusionnée de plusieurs sources (350 ventes ont 2 sources ou plus) peut avoir des PDF sous une autre URL [S].

### 2c. Quelle part des manques est peut-être déjà dans un document possédé ? [M]

Ventes avec manque et document officiel lu (colonne "lu"), et ventes avec manque ayant déjà un candidat PDF extrait non promu (`raw_payload.pdf_*_candidates`, listes `{value, evidence, lot_labels, page_number, document_url}`) :

| Champ manquant          | Manques     | Avec officiel lu | Avec candidat PDF déjà extrait, non promu |
| ----------------------- | ----------- | ---------------- | ----------------------------------------- |
| Surface                 | 277         | 46 (17 %)        | **6**                                     |
| Nombre de pièces        | 629         | 177 (28 %)       | **101** (16 %)                            |
| Chambres                | 650 environ | n/m              | **56**                                    |
| Occupation              | 311         | 46 (15 %)        | **31** (10 %)                             |
| Visites                 | 152         | 32 (21 %)        | n/m (pas de candidat PDF)                 |
| Terrain (house et land) | 202         | n/m              | 4                                         |

Lecture : pour la surface, le PDF ne règle presque rien (6 sur 277). Pour les pièces, **101 ventes ont déjà un candidat PDF non promu** : c'est le gain le plus rapide, sans déranger personne, à condition de régler la fiabilité (voir 3b). Pour les ventes avec officiel lu mais sans candidat (40 sur 46 en surface, 76 en pièces), le chiffre n'a probablement pas été trouvé par l'extracteur ou n'est pas dans le document **[S]**. À vérifier sur un échantillon de PDF avant de demander quoi que ce soit.

Limite : `with_official_read` ne dit pas que l'information est dans le document. Les "candidats" sont des occurrences de chiffres brutes, pas des faits validés.

---

## 3. Contradictions actuelles

### 3a. Entre sources d'annonces : `raw_payload.source_conflicts` [M]

Renseigné (tableau non vide) sur **361 ventes** (34 %), dont 350 sont multi-sources. Requête : `jsonb_array_elements(raw_payload->'source_conflicts')` regroupé par `field`, avec `limit` et filtre `sale_date >= current_date`.

| Champ                                  | Ventes concernées | Nature, mesurée sur les paires `selected` / `alternative`                                                                                                                                   |
| -------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface_m2`                           | 116 (141 écarts)  | 109 écarts dans les 5 % (arrondi : 100,9 contre 101) ; 26 écarts de plus de 20 %, dont **24 à un facteur proche de 2 ou 1/2** (typiquement un lot contre l'ensemble, ou Carrez contre bâti) |
| `rooms_count`                          | 32 (49)           | sur 35 paires chiffrées, **aucune dans les 5 %**, 29 écarts de plus de 20 % : vrais désaccords                                                                                              |
| `bedrooms_count`                       | 20 (36)           | 32 de 36 écarts de plus de 20 %, 19 proches d'un facteur 2                                                                                                                                  |
| `occupancy_status`                     | 38 (73)           | Presque tous des écarts de libellé (`occupied` contre `owner_occupied`) : faux conflits en partie                                                                                           |
| `sale_date`                            | 41 (77)           | **Tous le même jour** (écart d'heure) : aucun vrai conflit                                                                                                                                  |
| `starting_price_eur`                   | 2                 | dans les 5 %                                                                                                                                                                                |
| `property_type`                        | 28 (75)           | non analysé                                                                                                                                                                                 |
| `address`, `title`, `lawyer_*`, scores | 150 à 350         | surtout de la mise en forme (exemple : adresse complète contre "code postal + commune")                                                                                                     |

Conflits par champ dans `source_field_observations` (état `conflict`), en ventes [M] : cellier 81, copropriété 73, chauffage 43, orientation 15, avocat (contact) 13, chambres 10, pièces 10, occupation 8, salles de bains 8, charges 7, étage 3.

### 3b. Annonce contre document PDF [M]

- **Surface** : `pdf_surface_candidates` contre les colonnes : sur 155 ventes où les deux existent, 137 concordent (à 3 % près), **18 divergent (12 %)**. Quand la surface retenue vient du PDF (`surface_source = pdf`), 4 sur 77 divergent. Quand elle vient de l'annonce (`source_text`), **6 sur 51 divergent**. Les écarts vont dans les deux sens (le PDF est tantôt 1,5 fois plus grand, tantôt 1,5 fois plus petit), typique d'un confusion lot/ensemble. **Je ne peux pas dire qui a raison sans lire les PDF** : non mesurable en base.
- **Nombre de pièces** : sur 94 ventes avec valeur et candidat PDF, 24 divergent (26 %).
- **Chambres** : sur 174, 27 divergent (16 %).
- **Mise à prix** (`auction_fact_claims`, `source_document` contre `source_listing`) : 192 ventes avec les deux, 185 identiques, **5 divergent franchement** (par exemple 1 700 contre 5 000, 250 000 contre 150 000, 10 000 contre 40 000, 49 500 contre 18 000). Sur 2 de ces 5, l'annonce elle-même a deux valeurs (lots multiples ou sources différentes). La mise à prix est le champ où le document confirme le plus souvent l'annonce : 96 %. Un désaccord ici est un signal grave.
- **Terrain** : sur 78 ventes avec les deux sources, 24 divergent de plus de 5 % et seulement 24 sont identiques. **Les candidats "terrain" issus des PDF sont bruités** : on y trouve des valeurs absurdes pour des appartements (8 547 m2, 207 700 m2, 460/800 m2), très probablement des tantièmes, surfaces cadastrales de la parcelle entière ou numéros de lot [S]. Aucune règle ne devrait promouvoir un terrain PDF sans lien avec le lot.
- **Qui a raison ?** Mesurable uniquement sur la mise à prix, où le document confirme l'annonce 185 fois sur 192 (mais il peut citer un autre lot : cause possible des 5 écarts [S]). Pour la surface, les pièces et le terrain : indéterminé en base.

### 3c. Autres contradictions graves [M]

`raw_payload.publication_conflict_evidence` : **162 ventes à venir** (15 %), toutes en quarantaine : 98 `source_identity_mismatch`, 55 `property_identity_conflict`, 9 `conflicting_sale_procedure`. Ce sont les contradictions les plus lourdes : deux sources décrivent des biens différents sous la même annonce. Elles sont déjà bloquées, mais aucune pièce ne doit y être rangée sans lever le conflit d'identité d'abord.

`auction_fact_claims` en statut conflictuel : **0** ligne. Le statut `conflict` n'est jamais produit aujourd'hui, alors que les claims listing contre document divergent. Les conflits existent en base, sous une autre forme (`source_conflicts`, `pdf_*_candidates`).

---

## 4. Ventes à plusieurs lots

**Marquage actuel [M].** Il n'y a ni colonne `lot_count` ni table de lots. Le seul marqueur est `raw_payload.source_field_observations.lot_count`, écrit par `services/data-pipeline/src/sources/licitor_lots.py` (`"lot_count": len(page.lots)`, ligne 456), et uniquement pour **licitor** (410 ventes). Le détail par lot est dans `raw_payload.source_lots`.

| Nombre de lots (licitor)   | Ventes                  | Avec détail des lots | Sans surface  | Sans occupation |
| -------------------------- | ----------------------- | -------------------- | ------------- | --------------- |
| 1                          | 367                     | 0                    | 139 (38 %)    | 116             |
| 2                          | 30                      | 7                    | 22 (73 %)     | 13              |
| 3                          | 3                       | 1                    | 1             | 3               |
| 4                          | 4                       | 0                    | 4             | 4               |
| 5                          | 6                       | 2                    | 6             | 6               |
| **Total à plusieurs lots** | **43 (4 % des ventes)** | **10**               | **33 (77 %)** | **26 (60 %)**   |

- 43 ventes sont marquées multi-lots, mais seules 10 ont le détail des lots. Pour 33, on sait seulement qu'il y a plusieurs lots, pas lesquels.
- Les ventes multi-lots manquent de surface deux fois plus que les autres (77 % contre 38 %) : la surface n'est pas rattachable sans lot, donc le pipeline la laisse vide ou prend celle d'un seul lot.
- **Pour les autres sources, le multi-lot est invisible** : aucun marqueur pour notaires, avoventes, vench, etc. **[S]** Le nombre réel est donc supérieur à 43. L'écart de mise à prix, de surface et de terrain entre annonce et PDF (§3) est cohérent avec des lots mélangés.
- `auction_fact_claims.lot_id` est nul sur 100 % des 10 839 claims à venir.

**Implication pour le registre.** Une pièce doit porter un identifiant de lot, ou "toute la vente" explicitement. Règle recommandée : sur une vente à plusieurs lots (ou de lot inconnu), aucune valeur d'un document ou d'un avocat n'est rangée comme "valeur de la fiche" sans lot identifié par la citation. Elle reste une pièce visible mais non affichée. Cela rejoint la condition 5 du document du 10/11 (une seule vente ou la phrase nomme le lot).

---

## 5. Qui peut-on contacter

**Définition de "au moins une pièce demandable manquante" [S, choix de ma part]** : surface manquante (hors land et parking) OU occupation manquante OU visites manquantes OU pièces manquantes (house et apartment). **674 ventes sur 1 056** (64 %) sont concernées **[M]**. Cette définition est large, car 152 ventes sans visites ou 311 sans occupation suffisent. Un seuil plus strict (surface seule ou occupation seule) donnerait environ 450 à 480 ventes.

| Canal pour ces 674 ventes                                    | Ventes         | Remarques                                                                                                                                                                 |
| ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avocat avec adresse email exploitable                        | **62** (9 %)   | 58 via `information_agent_contacts` (lawyer, `source_observed`, sans opposition, sans rebond), 4 via un email dans `lawyer_contact`                                       |
| Greffe seul (`court_registry_contacts`, par `tribunal_code`) | **442** (66 %) | dont licitor 275, avoventes 52, encheres_immobilieres 43, info_encheres 37, notaires 16                                                                                   |
| Personne                                                     | **170** (25 %) | dont 100 environ sans avocat du tout (vench 73, cessions_etat 22, agrasc 5) et 66 avec un avocat connu uniquement par téléphone (45 notaires, 11 avoventes, 6 licitor...) |

Constat structurel [M] : dans `lawyer_contact` (1 056 ventes), seules **24 valeurs contiennent un `@`**, 862 sont un téléphone seul, 50 autre chose, 10 ont un nom sans contact. Les adresses emails viennent presque toutes de `information_agent_contacts` : 211 lignes de rôle `lawyer`, 123 emails distincts, issues de `source_blocks.avocats` de licitor. Il y a 1 ligne `manual_professional`. Aucune opposition ni rebond enregistré (`unknown` / `none`).

Le 442 "greffe seul" est une porte large mais discutable : le greffe détient le CCV mais répond rarement sur la surface ou l'occupation [S]. Le registre des tribunaux couvre 110 des 113 tribunaux concernés (762 des 777 ventes de tribunal) **[M]**.

**Nombre d'avocats distincts.**

- Avocats avec email, sur les ventes à demander : **46 adresses distinctes pour 58 ventes** (35 avec une seule vente, 10 avec 2 à 4, 1 avec 5 à 9, maximum 6 ventes pour une adresse) **[M]**. Un avocat n'a jamais 15 ventes aujourd'hui dans cette population.
- Sur toutes les ventes à venir avec avocat nommé : 612 noms distincts (normalisés par `lower(trim())`) pour 947 ventes : 433 avec une seule vente, 159 avec 2 à 4, 18 avec 5 à 9, **2 avec 10 ou plus, maximum 11** **[M]**. Plafond haut : un même cabinet peut apparaître sous plusieurs graphies [S].
- **Greffes** : 113 tribunaux pour 777 ventes de tribunal, maximum **61 ventes pour un seul tribunal**, 25 tribunaux avec 10 ventes ou plus **[M]**. Le plafond actuel du runbook (3 demandes par jour et une par vente) donnerait 61 courriels au même greffe : il faut **un seul message par tribunal, regroupant toutes ses ventes**.
- Règle du runbook (`docs/runbooks/information-agent.md`) : une sollicitation par professionnel et par 30 jours, toutes ventes confondues (hors greffe). Elle est cohérente avec ces chiffres, à condition de **regrouper dans un seul message toutes les ventes du même avocat** plutôt que d'en demander une par mois.

**Volume réel de la file [M].** `information_agent_cases` 5, `information_agent_missions` 5, `information_agent_messages` 2, `information_agent_fact_candidates` 0, `information_agent_fact_publications` 0. Aucune réponse exploitable n'existe : **taux de réponse, délai et taux de contradiction des réponses sont immesurables aujourd'hui.**

---

## 6. Ordre de confiance proposé par champ [S, à valider]

Principe : le rang dépend de la **nature du fait**, pas d'une source unique pour tout. Les sources : A = document officiel lu (CCV, PV descriptif, procès-verbal), B = avocat poursuivant ou greffe (réponse écrite), C = annonce du site source, D = administrateur (saisie), E = estimation ou déduction (`inferred`, calcul du pipeline).

| Champ                                 | Ordre (du plus fiable au moins fiable)                                                | Justification                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mise à prix, date et lieu d'audience  | A > B > C > E                                                                         | Le CCV fait foi. L'annonce confirme le document dans 185 cas sur 192. Écart toujours montré, jamais tranché                                                                            |
| Surface (habitable ou Carrez)         | A (PV, diagnostic Carrez, lot nommé) > B > C > E                                      | Le PV est mesuré. Mais 12 % de désaccords annonce/PDF viennent du lot ou de la nature de la surface : toute valeur doit porter sa nature (Carrez, habitable, bâti, terrain) et son lot |
| Surface du terrain                    | A (désignation cadastrale du lot) > B > C                                             | Les candidats PDF actuels sont bruités (faux terrains d'appartements) : A seulement si le lot et la parcelle sont nommés                                                               |
| Nombre de pièces, chambres            | A (PV descriptif) > B > C > E                                                         | 40 % des valeurs actuelles sont `inferred`. Une valeur déduite ne doit jamais l'emporter sur une valeur lue, même ancienne                                                             |
| Occupation                            | A (PV, bail) > B > C                                                                  | La date compte énormément : l'état occupé ou libre change. Voir fraîcheur ci-dessous                                                                                                   |
| Dates de visite                       | B (avocat, le plus récent) > C > A                                                    | Un PV ou un CCV est périmé pour les visites. L'annonce est souvent la source officielle republiée                                                                                      |
| Classe DPE, GES                       | A (diagnostic daté) > source externe ADEME [S] > C                                    | Le document ou l'ADEME priment sur l'annonce ; l'avocat n'est pas une source utile pour une classe                                                                                     |
| Charges de copropriété, taxe foncière | A (état daté, pré-état daté) > C > B                                                  | L'avocat ne connaît pas ces montants                                                                                                                                                   |
| Adresse précise                       | A (CCV, désignation) > C > B                                                          | L'avocat donne rarement une adresse ; le CCV est la désignation légale                                                                                                                 |
| Type de bien                          | A > C                                                                                 | Seulement en cas de désaccord de 28 ventes ; jamais demandé à un avocat                                                                                                                |
| Avocat, contact                       | C (annonce) > D                                                                       | L'annonce est la seule source publique de l'avocat poursuivant                                                                                                                         |
| Administrateur (D)                    | **Au-dessus de tout, mais seulement avec une preuve rattachée** (document ou échange) | Une saisie sans preuve ne doit pas écraser une pièce officielle                                                                                                                        |

**Quand la fraîcheur l'emporte sur le rang** [S] :

1. **Visites** : la date la plus récente gagne, quel que soit le rang.
2. **Occupation** : une réponse d'avocat datée de moins de 30 jours l'emporte sur un PV plus ancien si elle dit que l'état a changé (par exemple "libéré depuis").
3. **Mise à prix et date d'audience** : un rectificatif récent officiel (greffe, avis modificatif) l'emporte sur le CCV d'origine, mais est toujours montré à un humain.
4. **Annonce, redéfinie après une nouvelle collecte** (toutes les 5 à 23 heures d'après le document du 10/11) : une valeur d'annonce plus récente n'écrase jamais une valeur A ou B ; elle ouvre une contradiction.
5. Toute valeur plus ancienne que la dernière collecte de l'annonce perd son rang pour les champs périssables (occupation, visites, prix après report).

**Contradictions à toujours montrer à un humain, jamais tranchées automatiquement** [S] :

- Mise à prix, date et lieu d'audience, tribunal (écart de 5 sur 192 constaté ; conséquence directe sur l'enchère).
- Type de bien et identité du bien (162 ventes en quarantaine pour `source_identity_mismatch`, `property_identity_conflict`).
- Toute surface ou tout nombre de pièces qui diverge de plus de 20 % (surface : 26 paires, pièces : 29), ou à un facteur proche de 2 (24 cas de surface : confusion lot/ensemble).
- Occupation entre "libre" et "occupé" (hors faux conflits de libellé comme `occupied` contre `owner_occupied`).
- Tout champ sur une vente à plusieurs lots sans lot identifié.
- Toute valeur issue d'un document que la source "administrateur" contredit.

Les écarts d'arrondi (surface à moins de 5 %, 109 des 141 paires) peuvent être absorbés sans humain : on affiche la valeur du rang le plus haut.

---

## 7. Indicateurs de suivi (3 à 5)

Toutes les requêtes sont bornées par l'index de `sale_date`. À planifier une fois par jour, pas à la demande.

**I1. Complétude "prouvée" par champ** (part des ventes à venir où le champ est présent et d'origine explicite, par source et par type applicable). Cible indicative : surface 90 %, pièces 70 %.

```sql
select source_name,
 count(*) n,
 round(100.0*count(*) filter (where coalesce(app_surface_m2,surface_m2,habitable_surface_m2,carrez_surface_m2,0)>0)/count(*),1) pct_surface,
 round(100.0*count(*) filter (where rooms_count is not null and raw_payload->'source_field_observations'->'rooms_count'->>'state'='observed')/count(*),1) pct_rooms_explicit,
 round(100.0*count(*) filter (where occupancy_status is not null and occupancy_status not in ('','unknown'))/count(*),1) pct_occupancy,
 round(100.0*count(*) filter (where visit_dates is not null and visit_dates not in ('[]'::jsonb,'null'::jsonb))/count(*),1) pct_visits
from auction_sales where sale_date >= current_date group by 1 order by 2 desc limit 20;
```

**I2. Part des manques déjà couverts par un document possédé** (potentiel sans avocat). Aujourd'hui : surface 17 %, pièces 28 %, occupation 15 %, visites 21 % (§2c). À faire baisser en promouvant les candidats PDF vérifiés. Requête de base : voir §2b/§2c (jointure `auction_documents.source_url` + `extraction_status = 'extracted'`).

**I3. Délai de complétion** : jours entre l'envoi d'une demande et la publication de l'information correspondante, par canal (avocat, greffe). Non mesurable aujourd'hui (aucune réponse en base).

```sql
select m.recipient_kind, count(*) n,
 percentile_cont(0.5) within group (order by extract(epoch from (c.replied_at - c.sent_at))/86400) median_days
from information_agent_cases c join information_agent_missions m on m.case_id = c.id
where c.sent_at >= now() - interval '90 days' and c.replied_at is not null
group by 1 limit 10;
```

**I4. Taux de réponse** : part des demandes envoyées qui reçoivent une réponse sous 30 jours, par canal.

```sql
select recipient_kind, count(*) sent, count(*) filter (where replied_at is not null) replied,
 round(100.0*count(*) filter (where replied_at is not null)/count(*),1) response_rate_pct
from information_agent_cases where sent_at >= now() - interval '90 days' group by 1 limit 10;
```

Ces deux requêtes lisent `information_agent_cases` (5 lignes). Elles sont sans risque de charge.

**I5. Taux de contradiction** : part des ventes à venir ayant au moins une contradiction ouverte (conflit entre rangs, valeur divergente de plus de 20 %). Aujourd'hui, `source_conflicts` non vide : 361 ventes, mais surtout du bruit de forme. Cible : mesurer seulement les contradictions de champ réel.

```sql
select count(*) total,
 count(*) filter (where jsonb_typeof(raw_payload->'source_conflicts')='array' and jsonb_array_length(raw_payload->'source_conflicts')>0) with_source_conflicts,
 count(*) filter (where raw_payload ? 'publication_conflict_evidence') with_identity_conflict
from auction_sales where sale_date >= current_date limit 1;
```

Le taux de contradiction "utile" requiert de distinguer le bruit (arrondi, libellé) : voir proposition 5 ci-dessous.

---

## Propositions numérotées

| N°  | Proposition                                                                                                                                                                                                                                                                                                               | Priorité | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 1   | Étendre `auction_fact_claims` (déjà 10 839 claims à venir) pour qu'il tienne lieu de registre : ajouter les champs manquants (pièces, chambres, visites, DPE, charges, adresse), un identifiant de lot explicite ou "toute la vente", un rang de source et une date d'observation, plutôt que de créer une nouvelle table | Haute    | L      |
| 2   | Brancher les statuts : produire `conflict` quand un document diverge de l'annonce (aujourd'hui toujours `candidate`, 0 conflit) et `accepted` après validation                                                                                                                                                            | Haute    | M      |
| 3   | Promouvoir les candidats PDF déjà extraits, d'abord le nombre de pièces (101 ventes) puis l'occupation (31) et les chambres (56), après un contrôle de l'extrait et du lot, sur la règle "champ vide seulement"                                                                                                           | Haute    | M      |
| 4   | Bloquer la promotion des candidats "terrain" PDF qui ne nomment pas le lot (apartment avec 8 547 m2) ; restreindre à house, land, building, mixed et exiger une parcelle cadastrale                                                                                                                                       | Critique | S      |
| 5   | Normaliser avant de comparer : arrondi de surface à 5 %, `occupied` contre `owner_occupied`, écart d'heure seul sur `sale_date`. Cela ramène `source_conflicts` (361 ventes) aux contradictions réelles et rend l'indicateur I5 exploitable                                                                               | Haute    | S      |
| 6   | Marquer le multi-lot pour toutes les sources (colonne `lot_count` et table de lots), pas seulement licitor ; lier chaque pièce à un lot                                                                                                                                                                                   | Haute    | L      |
| 7   | Ne jamais afficher une valeur de document ou d'avocat sur une vente multi-lots sans lot nommé : la garder visible comme pièce, non affichée comme valeur de la fiche                                                                                                                                                      | Critique | S      |
| 8   | Télécharger les 39 ventes à officiel référencé mais jamais téléchargé, et les CCV en attente (227 sur 601) ; traiter les 7 lectures en échec                                                                                                                                                                              | Moyenne  | S      |
| 9   | Chercher la source d'un PDF pour licitor (14 % de couverture, 172 surfaces manquantes) et notaires (0 document sur 204) avant d'envoyer des demandes d'avocat                                                                                                                                                             | Haute    | M      |
| 10  | Demander en priorité des pièces (CCV, PV, diagnostics) plutôt que des valeurs : un document lu règle plusieurs champs d'un coup et donne un rang A                                                                                                                                                                        | Haute    | S      |
| 11  | Regrouper les demandes : un seul message par avocat (toutes ses ventes) et un seul message par tribunal (jusqu'à 61 ventes pour un greffe). Remplacer le plafond de 3 greffes par jour par un regroupement                                                                                                                | Haute    | M      |
| 12  | Ajouter DPE via ADEME (source publique) et charges via l'état daté, plutôt que de les demander à l'avocat                                                                                                                                                                                                                 | Moyenne  | L      |
| 13  | Persister l'ordre de confiance du §6 (table de règles par champ, fraîcheur, drapeaux "humain obligatoire") et l'appliquer au moment d'afficher, sans écraser la colonne                                                                                                                                                   | Haute    | M      |
| 14  | Enregistrer la provenance de l'occupation, des pièces et des visites dans une colonne lisible (aujourd'hui seule `surface_source` existe)                                                                                                                                                                                 | Moyenne  | S      |
| 15  | Passer les indicateurs I1 à I5 en tableau de bord quotidien                                                                                                                                                                                                                                                               | Moyenne  | S      |

## Décisions qui relèvent du propriétaire

1. **Un registre neuf ou l'extension de la table existante ?** J'en recommande l'extension (moins de risque, 10 839 pièces déjà dedans), mais cela dépend de votre appétit pour une migration lourde.
2. **Le greffe est-il un interlocuteur acceptable** pour 442 ventes (66 % de la population à compléter), alors qu'il répond rarement sur la surface ou l'occupation ? Ou limite-t-on les demandes aux ventes qui ont un avocat avec un email (62 ventes) ?
3. **Que faire des 170 ventes sans interlocuteur** (vench sans avocat, cessions de l'État, notaires avec téléphone seul) : les laisser incomplètes et le dire sur la fiche, ou chercher une autre voie (téléphone, courrier) ?
4. **Les pièces déduites ("inferred", 40 % des nombres de pièces affichés) restent-elles affichées comme des faits**, ou avec la mention "estimé" ? Aujourd'hui rien ne les distingue d'une valeur lue.
5. **Les ventes en quarantaine (224, dont 162 en conflit d'identité)** : veut-on les enrichir ou attendre la levée du conflit ?
6. **En cas de désaccord de mise à prix entre annonce et document (5 cas sur 192)**, qui l'emporte à l'affichage : le document, ou l'écran reste-t-il masqué jusqu'à une vérification humaine ? Je propose la seconde option.
7. **Dates de visite** : l'avocat l'emporte-t-il toujours sur l'annonce quand il est plus récent ?
8. **Limite de recouvrement** : une vente à plusieurs lots sans lot identifié peut-elle afficher la surface de l'un des lots ? Je propose que non (proposition 7).

## Limites générales

- Tout est mesuré sur la photographie du 11/11/2026 ; `auction_sales` n'a pas d'historique des valeurs précédentes, donc impossible de dire qui avait raison dans le temps.
- Les contradictions annonce/PDF sont mesurées sur les candidats extraits (`pdf_*_candidates`), pas sur des PDF relus à la main : un candidat peut venir d'un autre lot ou d'une autre pièce du dossier.
- Les "demandables" et l'ordre de confiance sont des propositions de conception, non des mesures.
- La population "à demander" (674) dépend de ma définition, volontairement large.
- La jointure documents se fait sur `source_url` : les ventes multi-sources (350) peuvent avoir des pièces sous une autre URL, non comptées.
- Les chiffres de réponse et de délai sont immesurables : 5 dossiers, 2 messages, 0 réponse analysée.

Fichiers consultés : `/home/user/immojudis/docs/equipe/2026-11-10-enrichissement-automatique-fiches.md`, `/home/user/immojudis/src/lib/information-agent-inventory.ts`, `/home/user/immojudis/docs/runbooks/information-agent.md`, `/home/user/immojudis/services/data-pipeline/src/sources/licitor_lots.py`, `/home/user/immojudis/supabase/migrations/` (index et tables).
