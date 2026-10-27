# Pépite v2 : critère éliminatoire « inondation » et nouvelles sources (loyers, zones tendues)

Mission du 26/10/2026, à la suite de l'ouverture du label (`pepite-v1`, mode `on` depuis 18 h 27 UTC). Suite du
compte-rendu `2026-10-26-plafond-tous-types-et-selection.md`.

## Décisions du fondateur (26/10/2026)

- La pépite reste un **oui ou un non**. Pas de note, pas de sous-labels.
- Un **risque d'inondation élevé** est éliminatoire.
- Une **passoire thermique n'est pas éliminatoire** : une rénovation peut créer de la valeur.
- **Ordre des sources** : la carte des loyers de l'ANIL et les zones tendues d'abord, puis l'INSEE et les risques à
  la parcelle.

## Équipe mobilisée (lecture seule)

- `analyste-spatial` : sources officielles du risque d'inondation et définition de « élevé ».
- `qualite-donnees` : mesure sur le catalogue de production (SELECT uniquement).
- `synthese-recherche` : carte des loyers de l'ANIL, zonage tendu (TLV), encadrement des loyers, INSEE.
- `architecte-logiciel` : architecture de la règle `pepite-v2`, stockage par vente, découpage en lots.

## Ce que les données disent

### Un critère au niveau de la commune serait un filtre géographique déguisé

Mesure sur les 1 499 ventes à venir publiées (`qualite-donnees`) :

| Critère appliqué à la commune | Ventes exclues |
|---|---|
| Commune dotée d'un PPRI approuvé | 853 (56,9 %) |
| Au moins un arrêté CatNat « inondation » | 1 482 (98,9 %) |
| Au moins 5 arrêtés | 1 120 (74,7 %) |
| Arrêté inondation de moins de 10 ans | 935 (62,4 %) |

À l'échelle de la France, 35,7 % des communes ont un PPRN inondation opposable, d'après GASPAR
(`analyste-spatial`). La part de PPRI est la même chez les ventes qui sont presque des pépites que dans le reste du
catalogue (57 à 59 %) : ce critère ne trie rien. `commune_risk_profiles` ne porte aucun niveau d'aléa, seulement la
présence d'un plan ou d'un arrêté.

### Un critère au niveau du bien est possible, mais la position est souvent imprécise

| `location_precision` (ventes publiées) | Ventes | Part |
|---|---|---|
| `address` + `parcel` | 115 | 7,7 % |
| `street` | 39 | 2,6 % |
| `municipality` (centre de commune) | 490 | 32,7 % |
| non renseignée | 855 | 57,0 % |

- Les ventes notariales sont mieux placées : 86 en `address` sur 218. Au tribunal : 22 sur 1 222.
- Le code INSEE de la commune n'est pas stocké sur la vente. Il est résolu au rendu.
- Les codes d'arrondissement (751xx, 132xx, 693xx) ne se joignent pas aux profils GASPAR, qui sont indexés sur
  75056, 13055 et 69123.

### Sources officielles de l'inondation au point

- **TRI, scénario « forte probabilité »** (crue fréquente, de l'ordre de dix ans).
  - API Géorisques `GET /api/v1/tri_zonage?latlon=lon,lat` : seul point d'accès qui porte le scénario.
  - Il est décrit dans l'OpenAPI officielle, mais il n'a **pas pu être appelé** depuis l'environnement des agents
    (refus du serveur). Son comportement « point dans la zone » reste à confirmer.
  - Repli : les fichiers de formes du rapportage TRI, testés en local (PostGIS).
- **PPRI au point** : servitude PM1 du Géoportail de l'urbanisme (API Carto), avec `code_alea` = 11.
  - **Vérifié en réel** : 5 points en zone inondable sur 5 renvoient un PM1 inondation, et 4 points hors zone dans les
    mêmes communes n'en renvoient aucun.
  - Limite : c'est le **périmètre** du plan, sans couleur ; zones rouges et bleues y sont confondues.
- **Zone rouge** : aucune source nationale au point n'a été trouvée. Il n'existe que des jeux départementaux
  hétérogènes.
- **EAIP et remontées de nappes** : des enveloppes et des cartes de sensibilité, pas des zonages. Elles ne
  conviennent pas à un critère éliminatoire.
- Le code a déjà un client Géorisques et un client GPU (`src/lib/land-risks-provider.ts`,
  `src/lib/land-planning-provider.ts`). Le premier respecte les quotas : 5 appels par seconde en v1, 20 en v2 avec
  un jeton. Défauts relevés :
  - le TRI est interrogé dans un rayon de 1 000 m, ce qui donne une proximité et non une appartenance ;
  - `parsePprn` peut afficher « true » ou « false » comme niveau ;
  - `location_precision` n'est pas transmise ;
  - les 15 couches sont toujours interrogées, sans option « inondation seule ».

### Loyers et zones tendues (`synthese-recherche`, sources vérifiées)

- **Carte des loyers 2025** (data.gouv.fr, jeu `693aa2feed1bf4da603faa49`, Licence Ouverte 2.0).
  - Contenu : 4 fichiers CSV (appartements, T1-T2, T3 et plus, maisons), un loyer d'annonce en €/m² **charges
    comprises**, avec un intervalle à 95 %, le nombre d'observations, le R² et la maille de calcul.
  - Couverture : par commune, et par arrondissement à Paris, Lyon et Marseille ; pas Mayotte. Mise à jour annuelle,
    en décembre.
  - Mention obligatoire : « Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin ».
- **Zonage tendu** (data.gouv.fr, « Liste des communes selon le zonage TLV »).
  - Une ligne par commune, avec les versions 2013, 2023 et après le décret du 22/12/2025.
  - Trois catégories : zone tendue, zone touristique et tendue, non tendue. Format CSV UTF-8.
- **Encadrement des loyers** : 9 territoires ; l'expérimentation s'arrête le 25/11/2026, sauf loi en cours de vote.
  Aucun jeu national n'existe. On ne l'utilise pas comme critère.
- **INSEE** : recensement 2022 (taux de vacance), Filosofi 2023 (médiane et pauvreté à la commune), BPE 2024.
- **Ce qu'ils remplaceraient** : `src/lib/rent-reference.ts`, codé en dur pour 24 départements. Il alimente le filtre
  « rendement minimal », les alertes, le simulateur et les rapports. Un libellé du simulateur annonce par ailleurs un
  loyer « hors charges » alors que la source est charges comprises.

## Définition proposée du critère d'inondation (`pepite-v2`)

**Le bien est exclu quand sa position est précise et qu'elle se trouve dans la zone que la crue fréquente d'un TRI
inonderait** (scénario « forte probabilité » de la cartographie officielle).

| Position du bien | TRI forte probabilité | Périmètre PPRI (PM1) | Verdict | Pépite |
|---|---|---|---|---|
| Précise | dans la zone | indifférent | `high` | **Exclue** (signal bloquant, sortie immédiate même à J-7) |
| Précise | hors zone ou hors TRI | dedans | `exposed` | Possible, avec la mention « périmètre d'un PPRI, zonage à vérifier » |
| Précise | hors zone ou hors TRI | dehors | `none_found` | Possible |
| Imprécise | commune sans TRI | — | `no_signal` | Possible |
| Imprécise | commune avec un TRI | — | `unknown` | Pas d'entrée (aucune nouvelle pépite) |
| Quelconque | source indisponible | — | dernière valeur de moins de 180 jours, sinon `unknown` | idem |

- **Position précise** : `address` ou `parcel`. Pour `street`, un tampon est appliqué autour du point ; il n'est
  retenu que s'il est entièrement dedans ou entièrement dehors.
- **Une pépite déjà publiée dont le verdict devient inconnu reste affichée.** Seul `high` la fait sortir.
- Une passoire thermique n'entre pas dans la règle, comme décidé.
- La formulation publique ne promet jamais l'absence de risque. Par exemple : « d'après la cartographie officielle
  des TRI, sans valeur d'expertise ». À faire relire par `juridique-rgpd`.

**Architecture** (`architecte-logiciel`) :
- Le verdict est stocké par vente dans une table privée, alimentée par un traitement planifié horaire distinct de
  celui des pépites. Le calcul des pépites ne fait jamais d'appel réseau.
- Le module de dérivation du verdict est pur (testable sans réseau).
- La règle passe en `pepite-v2`, avec deux codes de motif : `no_high_flood_risk`, bloquant, et `flood_risk_known`,
  qui conditionne l'entrée.
- Les pépites v1 restent publiables pendant la bascule, puisque la lecture publique ne contrôle pas la version de
  règle : la bascule se fait sans trou.

## Propositions numérotées

| N° | Agent | Proposition | Priorité | Effort | Avis du chef |
|---|---|---|---|---|---|
| 1 | architecte-logiciel | Filet de la v1 : table figée des verdicts v1 avec empreinte par version de règle, avant tout changement | Haute | S | Garder |
| 2 | qualite-donnees, synthese-recherche | Stocker le code INSEE sur chaque vente dans le pipeline (arrondissements de Paris, Lyon et Marseille compris, ramenés à la commune pour GASPAR) ; prérequis de l'inondation et des loyers | Haute | S à M | Garder |
| 3 | analyste-spatial | Vérifier en réel l'API `tri_zonage` (3 appels de test et millésime servi) ; si elle ne convient pas, importer les fichiers de formes TRI et tester avec PostGIS | Critique | S (ou L en repli) | Garder (condition du reste) |
| 4 | architecte-logiciel | Table privée du risque d'inondation par vente et traitement planifié horaire. Il réutilise le client Géorisques avec une option « inondation seule », se rafraîchit tous les 90 jours et à chaque changement de position, et n'écrase jamais un verdict connu par un inconnu. Il est supervisé (`cron.stale`) | Critique | L | Garder |
| 5 | architecte-logiciel, analyste-spatial | Règle `pepite-v2` : critère bloquant `no_high_flood_risk`, table de décision ci-dessus, entrée stricte et maintien tolérant, tests de caractérisation | Critique | M | Garder |
| 6 | analyste-spatial | Verdict « exposé » (périmètre PPRI au point, GPU PM1) affiché dans le bloc pépite, sans exclure | Moyenne | M | Garder |
| 7 | analyste-spatial | Calibration avant la bascule : environ 40 ventes à position précise relues à la main sur Géorisques et le GPU ; mesure de la part des pépites publiées qui ont un verdict | Haute | M | Garder |
| 8 | analyste-spatial | Corriger le client existant : TRI en appartenance et non en rayon, `parsePprn` (niveau « true »), transmission de `location_precision` | Moyenne | S | Garder |
| 9 | juridique-rgpd (à saisir) | Formulation publique du critère, page de méthode, registre des traitements (coordonnées envoyées à Géorisques), conservation | Haute | S | Garder |
| 10 | synthese-recherche | Import de la carte des loyers ANIL (4 CSV, table de référence privée, workflow `reference-data-import`, liste blanche d'hôtes, mention obligatoire) | Haute | M | Garder |
| 11 | synthese-recherche | Remplacer les loyers départementaux par ceux de l'ANIL à la commune (simulateur, filtre « rendement minimal », alertes, rapports). Cela change visiblement les résultats. Libellé « charges comprises » | Haute | L | Garder |
| 12 | synthese-recherche | Import du zonage tendu (TLV) avec la référence du décret | Moyenne | S à M | Garder |
| 13 | synthese-recherche | Enregistrer chaque source dans `data_sources` (licence, fréquence, mention) | Moyenne | S | Garder |
| 14 | synthese-recherche | Usage des loyers dans la pépite (rendement brut minimum au prix probable, borne basse, seuil de fiabilité). Ce serait une `pepite-v3`, à décider après l'import et une mesure en `shadow` | Moyenne | M | Discutable (plus tard) |
| 15 | qualite-donnees | Améliorer la précision de position (57 % non renseignée, tribunal surtout). C'est ce qui rendra le critère d'inondation applicable à plus de ventes | Haute | M à L | Discutable (mission à part) |
| 16 | chef d'orchestre | Exploitation : plafond de durée et interdiction des requêtes sans index pour les agents qui lisent la production ; documentation de planification à mettre à jour (`docs/operations/planification.md` décrit encore le mode `shadow`) | Haute | S | Garder |

**Ordre proposé** :
- 1 et 2 ;
- 3, condition du reste ;
- 4, 8 et 9 ;
- 7 ;
- 5 et 6, bascule en `pepite-v2` ;
- en parallèle, 10, 12 et 13, puis 11.

## Points écartés

- **Critère au niveau de la commune** (PPRI, arrêtés CatNat) : exclurait de 57 % à 99 % du catalogue sans mesurer le
  risque du bien.
- **« Zone rouge » d'un PPRI** : aucune source nationale au point ; seulement des jeux départementaux hétérogènes.
- **EAIP et remontées de nappes comme exclusion** : ce sont des enveloppes et des cartes de sensibilité, pas des
  zonages.
- **Encadrement des loyers comme critère** : fin d'expérimentation au 25/11/2026 sauf loi ; aucun jeu national.
  Information seulement, après avis juridique.
- **Revenus (Filosofi) comme critère** : seulement deux indicateurs à la commune, absent des DOM sauf La Réunion, et
  risque d'exclure systématiquement les territoires modestes. À garder comme information.

## Points à trancher par le fondateur

1. **Définition** : l'exclusion se limite-t-elle au TRI « forte probabilité » (recommandé), ou couvre-t-elle aussi
   tout bien dans le périmètre d'un PPRI, zones bleues comprises ?
2. **Position imprécise dans une commune qui a un TRI** : pas de pépite (recommandé, cela respecte le oui ou non) ?
3. **Pépite déjà publiée dont le verdict devient inconnu** : elle reste jusqu'à la vente (recommandé) ?

## Incident d'exploitation (26/10/2026)

- **Ce qui s'est passé** : pendant la mesure, une requête de lecture de `qualite-donnees` a fait un parcours
  séquentiel par vente, faute d'index sur les coordonnées de `reference_communes`. La base de production a refusé les
  connexions pendant environ une minute, entre 18 h 35 et 18 h 45 UTC. Aucune écriture n'était en jeu.
- **Contrôle à 18 h 58** :
  - site en ligne ;
  - toutes les tâches pg_cron réussies sur la période ;
  - mode des pépites `on` ;
  - calcul de 18 h 35 passé (600 ventes évaluées).
- **Seul effet visible** : l'historique des réponses `pg_net` a été vidé.
- **Mesure** : proposition n° 16.

## Validation (26/10/2026)

Le fondateur suit les recommandations du chef d'orchestre :

- **Validés** : n° 1 à 13 et 16.
- **Reportés** : n° 14 (rendement locatif dans la pépite, une `pepite-v3`) et n° 15 (précision des positions, mission à
  part).
- **Points tranchés** :
  1. L'exclusion se limite au scénario « forte probabilité » d'un TRI ; le périmètre d'un PPRI est seulement affiché.
  2. Une position imprécise dans une commune qui a un TRI ne peut pas devenir pépite.
  3. Une pépite déjà publiée dont le verdict devient inconnu reste affichée jusqu'à la vente ; seul un risque élevé la
     fait sortir.

## Vérification réelle de l'API TRI (n° 3, 26/10/2026)

`GET https://www.georisques.gouv.fr/api/v1/tri_zonage?latlon=<lon>,<lat>` répond sans jeton. L'API rend une entrée
par type d'inondation, avec le scénario le plus probable dont la zone contient le point.

| Point testé | Entrées rendues (type / scénario) |
|---|---|
| Loire à Tours (0.6890, 47.3990) | `01/01For` |
| Bordeaux (-0.5590, 44.8460) | `01/04Fai`, `03/02Moy` |
| Quai d'Austerlitz, Paris (2.3640, 48.8443) | `01/04Fai` |
| Montmartre (2.3420, 48.8867) | aucune |

Conclusion : le point est bien testé à l'intérieur de la zone. Le critère « élevé » est donc « au moins une entrée de
scénario `01For` ». Aucun repli sur les fichiers de formes n'est nécessaire. Les cartes datent du premier cycle
(arrêtés de 2013).

## Exécution

- **Lot inondation** (n° 1, 2, 4, 5, 6, 8, 16) : confié à `developpeur`, sur la branche `claude/pepite-v2`. La règle v2
  est livrée derrière un interrupteur, désactivé par défaut. La bascule aura lieu après l'alimentation du traitement et
  la calibration (n° 7).
- **Lot loyers et zones tendues** (n° 10 à 13) : confié à un second `developpeur`, dans une copie séparée.
- **Relecture juridique** (n° 9) : confiée à `juridique-rgpd`.

## Relecture juridique (n° 9) et décision sur les CGU

- **Retenu par `juridique-rgpd` et transmis aux développeurs :**
  - libellés selon ce qui a été réellement contrôlé : une seule coche, pour « aucun risque élevé identifié à la position
    connue » ; les cas « non vérifié » et « exposé » restent sans coche ;
  - mention « exposé » publique, à côté du badge ;
  - section « Le risque d'inondation » et historique des versions sur la page de méthode ;
  - mise en garde : ni état des risques, ni certificat ;
  - registre des traitements, matrice de conservation et politique de confidentialité mis à jour avant le premier
    appel réel, y compris pour trois flux existants non déclarés ;
  - mentions de source : Géorisques, IGN, ANIL, TLV ;
  - correction du libellé « hors charges », puisque les loyers ANIL sont charges comprises ;
  - aucun affichage de l'encadrement des loyers.
- **Décision du fondateur (26/10/2026)** : aucun email d'information sur les CGU n'est envoyé. Les CGU ne sont pas
  modifiées. Le paragraphe proposé pour l'article 8, sur les limites des cartes de risques, n'est pas ajouté :
  l'information passe par la page de méthode et les mentions légales.

## Mise en production (26 et 27/10/2026)

- **Fusion** : #318 (les deux lots), le 26/10 à 23 h 17 UTC, CI verte.
- **CI de `main` en échec après la fusion** : un test ancien de « Mon planning » (`FavoriteSales`) comptait « J-3 »
  avec l'horloge réelle et échouait entre minuit à Paris et minuit UTC. Correctif : #324, horloge du test fixée.
  Relance de la CI de `main` après minuit UTC, verte.
- **Migrations** : `20261106*` et `20261107*`, le 27/10 à 4 h 20 UTC, par le workflow « Apply Supabase Migrations ».
  1 555 ventes ont leur commune ; la tâche `immojudis-sale-flood-risk` est planifiée à :25.
- **Alertes** : `ALERT_RENT_BASIS_SWITCH_AT = 2026-10-27T00:10:00Z` (production Vercel), base silencieuse jusqu'au
  29/10 à 0 h 10 UTC. Le premier passage des alertes de 6 h 15 tombe dans la fenêtre. La variable peut être retirée
  ensuite.
- **Imports** : carte des loyers ANIL 2025, 139 600 lignes (34 900 communes, quatre segments) ; zonage tendu, 34 875
  communes.
- **Incident du traitement d'inondation** : les passages de 4 h 21 et 4 h 25 UTC ont échoué (code 23502). Un paquet
  mêlait des verdicts complets et des lignes « inconnu » sans `tri_scenarios` ni `ppri_checked` ; PostgREST y mettait
  NULL au lieu de la valeur par défaut. Correctif : #325 (`defaultToNull: false`, faux client du test aligné sur
  PostgREST). Aucun verdict écrit avant le correctif ; la pépite n'est pas concernée (v2 derrière son interrupteur).
