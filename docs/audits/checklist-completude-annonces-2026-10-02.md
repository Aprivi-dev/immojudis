# Checklist de complétude des annonces d’enchères

Version `2026-10-02.v1` — contrat de mesure produit, indépendant de la validité juridique de la vente.

Ce document définit ce que signifie « annonce suffisamment riche » pour une fiche Immojudis. Il sert à mesurer une ligne publiée, une observation source et, lorsque c’est possible, un lot ou un actif séparé. Il ne transforme pas une absence de donnée en preuve d’absence du bien et ne remplace pas la lecture des documents de la procédure.

Le catalogue machine associé est [completude-annonces-2026-10-02.json](./completude-annonces-2026-10-02.json). Les deux fichiers doivent évoluer avec une nouvelle version lorsqu’un champ, un poids, un état ou une règle de passage change.

## Contrat vérifié dans le dépôt

La checklist s’appuie sur les contrats réellement présents au 2 octobre 2026 :

- `services/data-pipeline/src/models.py` et `services/data-pipeline/src/normalize.py` portent le modèle d’ingestion, les surfaces qualifiées, les pièces, l’occupation, les documents, les visites et les signaux de normalisation.
- `services/data-pipeline/sql/schema.sql` porte `auction_sales`, `auction_surfaces`, `auction_features`, `auction_dpe_diagnostics`, les observations et la projection média.
- `src/lib/types.ts` expose `AuctionSale`, `SaleDocumentRich`, `SaleMedia`, les statuts de procédure et les conflits de source.
- `src/lib/sale-listing.ts` définit les règles d’affichage qui nettoient adresse, surface, prix au m², coordonnées, dates, visites et contacts ; une valeur de présentation (`À confirmer`, surface estimée, adresse nettoyée) ne vaut donc pas automatiquement preuve source.
- `services/data-pipeline/src/quality.py` mesure déjà les couvertures par source et distingue les champs requis des champs recommandés.
- `services/data-pipeline/src/catalogue_readiness.py` calcule actuellement `premium_readiness_v1` sur cinq axes : provenance de vente 30, bien 25, preuves 25, pratique 10, analyse 10. Il réserve le statut « vente de l’État » lorsqu’une mise à prix n’est pas disponible et conserve des bloqueurs séparés du score.
- `src/components/sale-detail/ListingDataCoverage.tsx` affiche aujourd’hui douze contrôles de présence : type, description, localisation, surface, occupation, prix, échéance, visites, organisateur, participation, documents et source. Cette checklist ajoute le niveau de détail nécessaire sans modifier ce composant.
- `services/data-pipeline/src/sale_procedure.py` persiste une procédure versionnée dans `sale_procedure` et `source_blocks` : type de lieu, cadre, mode de participation, méthode de vente, avocat requis, consignation, paiement et preuves de classification.
- `services/data-pipeline/src/pdf_document_selection.py`, `pdf_enrichment.py` et `pdf_fact_extraction.py` distinguent notamment procès-verbal, cahier des conditions de vente, diagnostics, annonce et bail, ainsi que les états `rich`, `partial`, `source_only`, `documents_not_extracted`, `extracted`, `incomplete`, `failed` et `empty`.
- `src/lib/dpe.ts` lit les diagnostics ADEME, les blocs source et les documents ; le diagnostic structuré porte classe DPE, classe GES, dates, surface, consommation, émissions, adresse, géolocalisation, méthode de rapprochement et confiance.

Les connecteurs actuellement identifiés sont `avoventes`, `licitor`, `vench`, `info_encheres`, `encheres_publiques`, `petites_affiches`, `cessions_etat`, `agrasc`, `encheres_immobilieres` et `notaires`. Une source nouvelle reprend le profil générique jusqu’à ce qu’une observation documentée justifie une exception. Le nom du portail est un indice : `encheres_immobilieres` peut référencer du judiciaire ou du notarial, et le profil retenu vient de `sale_venue_type`, `sale_legal_framework` et `participation_mode` vérifiés.

## États d’un champ

Un champ évalué doit porter un état explicite. `null`, chaîne vide, tiret ou valeur « à confirmer » seuls ne suffisent pas à distinguer les cas.

| État | Signification opérationnelle | Traitement par le score |
|---|---|---|
| `observed` | Valeur lisible et explicite dans une page ou un document rattaché au lot exact ; preuve conservée. | 100 % du poids |
| `inferred` | Valeur calculée, déduite ou proposée par une heuristique/LLM ; l’extrait et la méthode sont conservés. | 60 % par défaut ; jamais suffisante pour un bloqueur critique |
| `unknown` | La recherche a été effectuée ou le champ est attendu mais aucune valeur exploitable n’a été trouvée. | 0 %, reste au dénominateur si applicable |
| `explicitly_absent` | La source dit explicitement « aucun », « sans », « non soumis », « pas de parking », etc. ; ce n’est pas une absence de scraping. | 100 % pour un attribut binaire répondu ; peut satisfaire une question informative |
| `not_applicable` | Le champ ne concerne pas le bien ou la procédure, ou la procédure documente explicitement une représentation de remplacement. Exemple : étage pour un terrain nu, mise à prix pour un appel d’offres sans prix de départ, localisation par parcelle annoncée comme telle. | Retiré du dénominateur ; aucune pénalité |
| `conflict` | Deux valeurs incompatibles subsistent, ou l’identité du lot/procédure n’est pas résolue. Les valeurs et leurs sources sont conservées. | 0 % et bloque le passage critique |

`explicitly_absent` est autorisé seulement quand la négation porte sur le bon lot et sur l’attribut lui-même (« aucun jardin », « sans garage », « DPE non soumis »). « Aucun résultat dans le HTML », « non communiqué », paywall, refus d’accès et page inaccessible restent `unknown`, avec `availability_reason=not_found`, `source_not_disclosed`, `paywall` ou `page_inaccessible`. Une source qui ne divulgue pas une adresse ne constitue donc pas une absence physique de l’adresse ; `not_applicable` n’est possible que si la procédure de publication documente explicitement une localisation de remplacement par parcelle/commune.

Une valeur `inferred` ne doit jamais écraser la valeur source. Une valeur `conflict` ne doit jamais être résolue par une préférence silencieuse. La valeur sélectionnée peut être publiée uniquement avec une trace de résolution et un état de confirmation.

## Preuve et fraîcheur

Chaque valeur autre que `not_applicable` doit référencer au moins une preuve : URL canonique, type d’artefact, localisateur (sélecteur, clé `source_blocks`, document et page), extrait court, horodatage de capture et version de l’extracteur. Les grades servent à mesurer la confiance, pas à masquer une valeur manquante.

| Grade | Preuve attendue | Utilisation |
|---|---|---|
| `A` | Document ou page primaire rattaché à l’identifiant/lot exact : fiche opérateur, état officiel, procès-verbal, cahier, diagnostic ou pièce source lisible. | Accepté pour un champ critique ; une contradiction doit toujours rester visible. |
| `B` | Page détail primaire structurée avec libellé explicite, ou observation de deux sources concordantes dont l’identité est établie. | Accepté pour les champs critiques de publication ; confirmation recommandée pour prix, date, surface et occupation. |
| `C` | Résumé de liste, texte libre sans localisateur précis, source secondaire concordante ou extraction automatique sans rattachement assez fin. | Mesure utile, mais ne satisfait pas seul un bloqueur critique. |
| `none` | Valeur sans preuve, valeur issue d’un écran non conservé ou preuve illisible. | État `unknown`, `inferred` ou `conflict` selon le cas ; jamais `observed`. |

La fraîcheur est mesurée à part de la présence : une valeur observée il y a longtemps reste observée, mais peut devenir `stale` dans un diagnostic opérationnel. Le catalogue de complétude conserve `checked_at`, `last_seen_at`, `content_hash`, `extractor_version` et le résultat de revalidation quand ils existent. Une source inaccessible, un document protégé ou une image expirée ne doit pas être compté comme « absent » sans état d’accessibilité.

Deux vues doivent être publiées séparément. Le `completeness_score` mesure la richesse du produit : un champ attendu mais inaccessible reste `unknown` et reste au dénominateur. Le `extraction_coverage_score` mesure la qualité de l’extracteur sur les éléments effectivement accessibles ; les champs derrière paywall, refusés par robots, protégés ou absents de l’artefact accessible sont retirés de son dénominateur. La seconde vue ne peut jamais transformer une fiche inaccessible en fiche riche.

## Scoring et niveaux de passage

Le score est une mesure de couverture et de preuve ; il ne juge pas l’intérêt financier du bien et ne remplace pas `investment_score`.

Pour chaque champ applicable, le facteur d’état est combiné avec un facteur d’importance (`critical=3`, `high=2`, `medium=1`, `optional=0,5`). La catégorie est la moyenne pondérée de ses champs effectivement applicables :

```text
contribution = 1.0 observé ou absence explicitement constatée
             = 0.6 inféré
             = 0.0 inconnu ou conflit

ratio_categorie = somme(facteur_importance × contribution)
                  / somme(facteur_importance des champs applicables)

score = somme(poids_categorie × ratio_categorie)
        / somme(poids_des catégories ayant au moins un champ applicable)
```

Les champs `not_applicable` sont retirés du numérateur et du dénominateur, et les catégories entièrement vides sont retirées du dénominateur global. Il n’y a donc pas de pénalité pour un champ ou une catégorie qui ne concerne pas le bien ou la procédure. Un `explicitly_absent` compte comme réponse complète pour les booléens (par exemple « pas de jardin »), mais ne transforme pas en annonce exploitable l’absence explicite d’une adresse, d’une date ou d’une pièce critique.

Les poids par catégorie sont la cible de mesure ; ils sont normalisés si un profil retire des catégories :

| Catégorie | Poids | Finalité |
|---|---:|---|
| Provenance et capture | 10 | Savoir quelle page/observation est mesurée et pouvoir la relire. |
| Vente et procédure | 20 | Comprendre l’événement, le prix et les modalités d’accès. |
| Localisation et lot | 15 | Relier le bien au territoire et au bon lot. |
| Caractéristiques du bien | 20 | Décrire surfaces, pièces, distribution et état matériel. |
| Énergie et équipements | 15 | Décrire chauffage, énergie, DPE/GES et installations. |
| Extérieurs et annexes | 8 | Capturer terrain, stationnement et dépendances. |
| Occupation, copropriété et risques | 7 | Rendre visibles les contraintes d’usage et de due diligence. |
| Documents et médias | 5 | Qualifier les pièces et les images disponibles. |

Niveaux proposés :

- `incomplet` : score inférieur à 55, ou identité de source ou de bien non établie. Cette classe plafonne toute fiche dont les portes `source_identity` ou `property_identity` échouent, quel que soit le score brut.
- `à_enrichir` : score de 55 inclus à 75 exclus, ou score d’au moins 75 plafonné parce qu’une autre porte critique échoue.
- `décision_prête` : score d’au moins 75, toutes les portes critiques levées et aucun conflit d’identité/procédure.
- `riche` : score d’au moins 90, couverture des champs applicables de bien, procédure, preuve et documents/médias ; les valeurs critiques sont `observed` ou explicitement documentées comme non applicables.

Les portes critiques sont indépendantes du score :

1. `source_name`, `source_url` et un identifiant de lot ou une URL stable sont observés.
2. Un titre ou une description du bien est observé, avec un extrait source conservé.
3. Le type de bien est observé ou confirmé par une preuve A/B.
4. Une localisation précise est observée : adresse rue/numéro avec `location_precision=address|exact` pour un bien bâti, ou parcelle cadastrale et code INSEE avec `location_precision=cadastral|parcel` pour un terrain/une localisation masquée. Une commune seule reste utile mais ne lève pas la porte de richesse.
5. Au moins une des deux formes de calendrier est observée : `sale_date` pour une audience/date ponctuelle, ou `sale_schedule` pour une fenêtre d’ouverture/fermeture. Une procédure d’État sans calendrier publié reste `unknown` avec `availability_reason=source_not_disclosed` et la porte échoue.
6. Une surface qualifiée est observée : surface habitable/Carrez/bâtie pour un logement ou local, surface de terrain et portée pour un terrain, surface ou place/dimension rattachée pour un parking, surface agrégée qualifiée ou surfaces rattachées à chaque lot pour un bien mixte. Une surface d’un seul lot ne qualifie pas toute la vente ; une valeur déduite des pièces ne satisfait pas cette porte.
7. La mise à prix est observée pour une enchère qui en publie une ; elle est `not_applicable` uniquement si la méthode de cession publiée indique qu’il n’y a pas de prix de départ (par exemple appel d’offres ou cession amiable) et qu’une preuve de cette règle est conservée. Une simple omission dans la page reste `unknown` et bloquante.
8. La preuve d’origine est lisible (`source_blocks`, texte capturé, document, ou `photos_usable_count>=1`) et l’identité du lot est cohérente ; `photos_count` seul ne prouve pas un artefact lisible.
9. Le cahier/les conditions de vente ou de cession sont observés ou explicitement non applicables avec une raison contrôlée lorsque la procédure les rend applicables ; une absence explicite, `unknown` et `conflict` restent bloquants.
10. Tout conflit sur source, identifiant, lot, procédure, date, prix, surface principale ou occupation est résolu ou reste bloquant, y compris lorsqu’il provient d’une source secondaire.

Les seuils ne modifient pas `premium_readiness_v1` dans le pipeline existant ; ils servent de contrat de mesure plus fin. Les deux diagnostics doivent afficher la politique et la version qui ont produit le résultat.

### Exemples de calcul

Ces exemples utilisent un sous-ensemble de champs pour rendre visibles les effets de `not_applicable`, `unknown`, `inferred` et `conflict`. En production, tous les champs applicables du catalogue entrent dans le calcul.

- Appartement : procédure `sale_date=observed`, `sale_schedule=not_applicable`, `starting_price_eur=observed`, `visit_dates=unknown`, `sale_fees=conflict` donnent un ratio de catégorie procédure `(3+3+0+0)/(3+3+2+2)=60 %`. Localisation (`address`, `city`, `department`, `location_precision`) observée vaut 100 %. Bien (`surface_habitable_m2` observée, `rooms_count` observé, `bedrooms_count` inféré, `floor_number` en conflit) vaut `(3+2+1,2+0)/(3+2+2+2)=68,9 %`. Documents (`conditions_sale` observé, extraction inconnue, une photo observée) valent `4/6=66,7 %`. Sur les catégories actives et leurs poids 20/15/20/5, le score illustratif est `(60×20 + 100×15 + 68,9×20 + 66,7×5)/(20+15+20+5)=73,5`. Le conflit de frais reste un bloqueur procédure même si le score était supérieur.
- Terrain en cession d’État par appel d’offres : `starting_price_eur=not_applicable` avec `state_sale_method=appel_offres` et citation « sans mise à prix », adresse exacte `not_applicable` parce que la source annonce une localisation par parcelle, `cadastral_references`, `insee_code`, `land_surface_m2` et `land_surface_scope` observés. La localisation et la surface peuvent donc atteindre 100 % sans inventer une rue. `land_use= inferred` et `boundary_access=unknown` donnent 40 % pour la catégorie extérieurs `(1,2+0)/(2+1)`. Avec procédure 100 % (20), localisation 100 % (15), bien 100 % (20), extérieurs 40 % (8) et documents 50 % (5), le score illustratif est `89,3`. `conditions_sale=unknown` fait échouer la porte `conditions_document` ; le score brut reste affiché, mais la classe riche est plafonnée à `à_enrichir`.

## Checklist détaillée

Les champs marqués « existant » correspondent à un chemin réellement observé dans le modèle Python, le schéma SQL, le payload ou l’API. Les champs marqués « nouveau » sont des propositions structurées ; tant qu’ils ne sont pas ajoutés au schéma, une extraction dans `source_blocks` ou `raw_payload` ne vaut que preuve intermédiaire, pas contrat canonique.

### 1. Provenance et capture

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `listing_id` | chaîne/UUID | Tous | critique | identifiant interne stable | `auction_sales.id`, `AuctionSale.id` — existant |
| `source_name` | enum chaîne | Tous | critique | nom du connecteur + URL autorisée | `auction_sales.source_name`, `AuctionSale.source_name` — existant |
| `source_url` | URL | Tous | critique | URL canonique de la fiche ou du lot | `auction_sales.source_url`, `AuctionSale.source_url` — existant |
| `primary_source` | chaîne | doublons/multi-source | élevé | source retenue et motif | `primary_source` — existant |
| `source_urls` | tableau d’URL | doublons/multi-source | élevé | toutes les observations concordantes | `source_urls`, `observations` — existant |
| `external_id` | chaîne | sources ayant un identifiant | élevé | identifiant de la source | `external_id` — existant backend/SQL |
| `source_title` | texte | Tous | élevé | `h1`, titre structuré ou titre de lot | `title`, `source_blocks.*` — existant |
| `source_description` | texte | Tous | critique | bloc descriptif rattaché au lot, pas le chrome de page | `description`, `source_description`, `raw_text` — existant |
| `capture_text` | texte brut | Tous | élevé | texte capturé conservant les libellés | `raw_text` — existant backend/SQL |
| `source_blocks` | objet clé/valeur | Tous | critique | clés et valeurs brutes avec localisateur | `raw_payload.source_blocks` — existant |
| `source_presence` | objet d’état | champs clés/multi-source | élevé | champ vu, non vu, inaccessible ou expiré | `raw_payload.source_presence`, projection API — existant |
| `source_conflicts` | tableau de conflits | Tous | critique si présent | champ, valeur, sources et décision | `raw_payload.source_conflicts`, `AuctionSale.source_conflicts` — existant |
| `capture_checked_at` | timestamp ISO-8601 | Tous | élevé | horodatage du contrôle | `raw_payload.source_checks.*.checked_at` — existant imbriqué |
| `extractor_version` | chaîne | Tous | moyen | version ayant produit les champs | `raw_payload.source_checks.*.extractor_version` — existant imbriqué |
| `source_detail_status` | enum | sources avec liste + détail | élevé | `complete`, `restricted` ou `failed` accompagné de la raison | `raw_payload.source_detail_status` / `source_checks` — existant imbriqué |
| `source_last_seen_at` | timestamp | Tous | moyen | dernière observation de la fiche | `last_seen_at` — existant |

### 2. Vente et procédure

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `property_type` | enum | Tous | critique | libellé explicite ou classification confirmée | `property_type` — existant |
| `sale_venue_type` | enum `tribunal/notary/state/online/unknown` | Toutes procédures | critique | page, organisme ou procédure concordante | `sale_venue_type` — existant |
| `sale_legal_framework` | enum | Toutes procédures | élevé | corpus/organisme exprimé dans la source | `sale_legal_framework` — existant |
| `sale_verification_status` | enum | Tous | critique | résultat de la vérification de procédure | `sale_verification_status` — existant |
| `procedure_record` | objet structuré | Toutes procédures | critique | cadre, mode de participation, règles et preuves de classification | `auction_sales.sale_procedure`, `AuctionSale.sale_procedure`, `source_blocks.sale_procedure` — existant |
| `listing_status` | enum | Tous | élevé | statut publié et observation datée | `status` — existant |
| `auction_round` | objet/enum | reports, surenchères, réitérations | élevé | identifiant ou libellé du tour | nouveau structuré ; indices dans `sale_procedure`/`source_blocks` |
| `sale_date` | date/heure avec fuseau | Toutes ventes datées | critique | date et heure ou date seule explicitement libellée | `sale_date`, `source_sale_schedule` — existant |
| `sale_schedule` | objet `{opens_at, closes_at, timezone}` | en ligne, État, procédures à fenêtre | élevé | bloc calendrier exact | `sale_procedure`/`raw_payload.source_sale_schedule` — existant imbriqué |
| `tribunal` | texte + code éventuel | procédures judiciaires | élevé | juridiction rattachée à l’audience | `tribunal`, `tribunal_code`, `tribunal_name` — existant |
| `visit_dates` | tableau de dates/créneaux | tous biens si visites publiées | élevé | date, heure et lieu du créneau | `visit_dates`, `source_blocks.visites` — existant |
| `starting_price_eur` | nombre décimal, EUR | enchères avec mise à prix | critique | libellé « mise à prix »/prix de départ | `starting_price_eur` — existant |
| `adjudication_price_eur` | nombre décimal, EUR | ventes terminées/adjudiquées | élevé | résultat source, jamais déduit d’un autre montant | `adjudication_price_eur` — existant |
| `outcome_status` | enum | ventes passées | élevé | résultat explicitement observé | `status`/`source_blocks` — existant partiel ; nouveau enum dédié recommandé |
| `venue_name` | texte | audience présentielle | élevé | nom du tribunal, étude ou site | `sale_procedure.venue_name` ou bloc source — existant imbriqué |
| `venue_address` | texte | audience présentielle | moyen | adresse du lieu | `sale_procedure.venue_address` — existant imbriqué |
| `participation_mode` | enum `in_person/online/hybrid/unknown` | Toutes procédures | critique | modalité explicite | `sale_procedure.participation_mode` — existant imbriqué |
| `bid_method` | enum/texte | enchères | critique | méthode de dépôt ou d’enchère | `sale_procedure.rules.bid_method` — existant imbriqué |
| `lawyer_required` | booléen | judiciaire/si la source le précise | élevé | règle de procédure avec preuve | `sale_procedure.rules.lawyer_required` — existant imbriqué |
| `eligible_bar` | texte | judiciaire | élevé | barreau/qualificatif publié | `sale_procedure.rules.eligible_bar` — existant imbriqué |
| `lawyer_name` | texte | judiciaire et source qui en publie un | élevé | nom libellé « avocat »/organisateur | `lawyer_name` — existant |
| `lawyer_contact` | texte | idem | élevé | téléphone, courriel ou site actionnable | `lawyer_contact` — existant |
| `consignation` | nombre EUR ou taux % + modalité | enchères où publiée | élevé | montant/taux dans conditions | `source_blocks.consignation`/`sale_procedure` — existant imbriqué ; type structuré recommandé |
| `sale_fees` | objet, EUR/% | Toutes ventes si publié | élevé | frais préalables, adjudication, taxes, commission séparés | `source_blocks.frais*` — existant textuel ; nouveau structuré |
| `payment_terms` | objet texte + délai jours | Toutes procédures | élevé | délai/mode de paiement source | `sale_procedure.rules.payment_deadline_days`, blocs paiement — existant partiel |
| `surenchere_window` | objet dates/statut | procédures concernées | moyen | dates et statut explicitement publiés | nouveau ; indices `sale_procedure`/blocs |

### 3. Localisation et lot

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `address` | texte | bien bâti/commercial/terrain si divulguée | critique | adresse de l’actif, nettoyée du chrome | `address`, `normalize_listing_address` — existant |
| `postal_code` | chaîne 5 caractères | biens localisés en France | élevé | code postal explicite | `postal_code` — existant |
| `city` | texte | Tous | critique | commune explicite | `city` — existant |
| `department` | chaîne 2/3 caractères | Tous | élevé | département source ou normalisé | `department` — existant |
| `insee_code` | chaîne 5 caractères | terrain/localisation masquée, puis tout bien géocodé | élevé | code commune rattaché au lot | nouveau ; disponible dans certains diagnostics/cadastre mais pas dans `AuctionSale` |
| `coordinates` | paire lat/lon | géocodage possible | moyen | géocodage séparé de l’adresse et confiance | `latitude`, `longitude` — existant |
| `location_precision` | enum `exact/address/cadastral/parcel/city/department/hidden` | Tous | élevé | preuve de la granularité réellement publiée | nouveau ; ne pas confondre avec coordonnées calculées |
| `lot_reference` | chaîne | lotissement, copropriété, parcelle, dossier | élevé | numéro/référence de lot exact | nouveau ; indices `external_id`, `lot_number`, `source_blocks` |
| `lot_count` | entier >= 1 | ensembles immobiliers | élevé | nombre de lots/actifs composant la vente | nouveau ; `source_blocks` si publié |
| `cadastral_references` | tableau de chaînes | terrain/bâti avec cadastre | élevé | section, numéro, commune, source cadastre | nouveau ; `cadastre`/documents existants, pas de champ `AuctionSale` canonique |
| `land_surface_m2` | nombre > 0, m² | terrain/maison avec terrain | critique pour terrain ; élevé sinon | contenance explicitement qualifiée et portée | `land_surface_m2`, `auction_surfaces`, blocs — existant |
| `land_surface_scope` | enum `parcel/lot/coprop/common/unknown` | surface foncière | critique si surface affichée | extrait indiquant la portée | `surface_scope`, `source_blocks.operator_land_surface_scope` — existant partiel |

### 4. Caractéristiques du bien

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `surface_habitable_m2` | nombre > 0, m² | logement/bâti habitable | critique | surface explicitement habitable ou comparable sans ambiguïté | `habitable_surface_m2` — existant |
| `surface_carrez_m2` | nombre > 0, m² | lots de copropriété/bâti soumis à mesure Carrez publiée | élevé | libellé Carrez et lot exact | `carrez_surface_m2` — existant |
| `surface_built_m2` | nombre > 0, m² | bâti/local/parking lorsque la nature est différente | élevé | surface bâtie/utile avec portée | `surface_m2`, `app_surface_m2` — existant, portée à contrôler |
| `surface_scope` | enum `asset/dwelling/parcel/lot/annex/unknown` | toute surface | critique | qualification du nombre | `surface_scope`, `app_surface_kind` — existant |
| `surface_provenance` | enum `source/pdf/cadastre/ademe/llm/inferred` | toute surface | élevé | chemin de production + preuve | `surface_source`, `surface_evidence`, `surface_confidence` — existant |
| `rooms_count` | entier >= 0, pièces principales | logement/immeuble | critique | nombre explicitement décrit ; ne pas compter cuisine, WC, cave | `rooms_count` — existant |
| `bedrooms_count` | entier >= 0, chambres | logement avec chambres | élevé | chambres explicitement mentionnées ; ne pas déduire du T3 | `bedrooms_count` — existant |
| `bathrooms_count` | entier >= 0 | logement/bâti | moyen | salles de bains avec baignoire explicitement identifiées ; les douches restent séparées | `bathrooms_count` — existant, preuve partielle si la source fusionne bains et eau |
| `shower_rooms_count` | entier >= 0 | logement/bâti | moyen | salles d’eau/douches explicitement identifiées | nouveau ; `description`/`source_blocks` |
| `wc_count` | entier >= 0 | logement/bâti | moyen | WC explicites | nouveau ; aujourd’hui description/blocs seulement |
| `floor_number` | entier ou enum `ground/basement/attic/unknown` | appartement/local | élevé | étage explicite ; conserver rez-de-chaussée séparément | nouveau |
| `building_floor_count` | entier >= 0 | appartement/immeuble | moyen | nombre de niveaux du bâtiment | nouveau |
| `elevator` | booléen | appartement/immeuble | moyen | ascenseur présent ou absent explicitement | nouveau |
| `layout` | tableau de pièces ou texte structuré | logement/bâti | élevé | composition rattachée au lot | nouveau ; texte dans `description`/blocs existants |
| `flooring` | enum/tableau de revêtements | logement/bâti | moyen | type de sol par pièce ou zone, sans déduction depuis une photo seule | nouveau |
| `ceiling_height_m` | nombre, m | logement/bâti si publié | optionnel | mesure explicitement qualifiée | nouveau |
| `year_built` | entier, année | bâti | moyen | année ou période source | nouveau |
| `condition` | enum/texte `neuf/bon/à_rafraîchir/à_rénover/ruine/unknown` | bâti | élevé | état décrit par source ou PV | nouveau ; signaux `risk_notes`/LLM ne sont pas un champ canonique |
| `works_needed` | texte structuré + coût si publié | bâti | élevé | désordres/travaux distincts de l’analyse | `risk_notes` et payload LLM — existant textuel ; structuration recommandée |
| `accessibility` | objet booléens/texte | tous les bâtiments | moyen | PMR, accès, escaliers, largeur si publié | nouveau |
| `orientation` | enum/tableau de points cardinaux | logement/terrain | optionnel | orientation explicitement indiquée | nouveau |
| `view` | texte contrôlé | logement/terrain | optionnel | vue dégagée, vis-à-vis, etc. avec extrait | nouveau |

### 5. Énergie, chauffage et équipements techniques

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `heating_mode` | enum `individual/collective/mixed/none/unknown` | bâti habitable | élevé | « chauffage individuel/collectif » explicite | nouveau ; `description`, `source_blocks`, diagnostics aujourd’hui |
| `heating_energy` | enum/texte `electric/gas/oil/wood/heat_pump/network/other` | bâti habitable | élevé | énergie explicitement qualifiée | nouveau |
| `heating_distribution` | enum/texte radiateurs, sol, autre | bâti habitable | moyen | système explicitement décrit | nouveau |
| `hot_water_mode` | enum `individual/collective/unknown` | logement/bâti | moyen | eau chaude explicitement qualifiée | nouveau |
| `hot_water_energy` | enum/texte `electric/gas/solar/heat_pump/network/other/unknown` | logement/bâti | moyen | énergie de l’eau chaude explicitement qualifiée | nouveau |
| `dpe_class` | enum `A`–`G` ou `not_submitted` | bâti soumis/diagnostic disponible | élevé | classe DPE avec date ou document | `auction_dpe_diagnostics.dpe_class`, `source_blocks`, `extractDpe` — existant enrichissement |
| `ges_class` | enum `A`–`G` ou `not_submitted` | bâti soumis/diagnostic disponible | élevé | classe GES avec date ou document | `auction_dpe_diagnostics.ges_class`, blocs — existant enrichissement |
| `energy_consumption_kwh_m2_year` | nombre >= 0, kWh/m²/an | diagnostic énergétique | moyen | valeur et unité dans diagnostic | `auction_dpe_diagnostics.energy_consumption_kwh_m2_year` — existant |
| `emissions_kg_co2_m2_year` | nombre >= 0, kgCO₂/m²/an | diagnostic énergétique | moyen | valeur et unité dans diagnostic | `auction_dpe_diagnostics.emissions_kg_co2_m2_year` — existant |
| `dpe_established_at` | date | diagnostic énergétique | élevé | date d’établissement | `auction_dpe_diagnostics.established_at` — existant |
| `dpe_valid_until` | date | diagnostic énergétique | moyen | date de validité si publiée | `auction_dpe_diagnostics.valid_until` — existant |
| `dpe_number` | chaîne | diagnostic énergétique | moyen | numéro source | `auction_dpe_diagnostics.diagnostic_number` — existant |
| `windows_insulation` | enum/texte | bâti si décrit | moyen | simple/double vitrage, menuiseries | `has_double_glazing` — existant booléen partiel ; détail nouveau |
| `building_insulation` | objet murs/toiture/plancher | bâti si décrit | moyen | isolation explicitement décrite, séparée du vitrage | nouveau |
| `ventilation` | enum/texte | bâti si décrit | optionnel | ventilation explicitement décrite | nouveau |
| `cooling` | booléen/texte | bâti si décrit | optionnel | climatisation présente/absente | `has_air_conditioning` — existant booléen partiel |
| `utilities_connections` | objet eau/électricité/gaz/assainissement | bâti/terrain | moyen | branchements et type d’assainissement | nouveau |

### 6. Extérieurs, stationnement et annexes

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `garden` | booléen + surface si publiée + droit/périmètre | appartement avec droit ou lot rattaché, maison/terrain | moyen | jardin présent ou absent explicitement et sujet identifié | `has_garden` — existant ; surface et droit nouvelles |
| `terrace` | booléen + surface si publiée | logement/maison | moyen | terrasse présente ou absente explicitement | `has_terrace` — existant ; surface nouvelle |
| `balcony` | booléen + surface si publiée | appartement | moyen | balcon présent ou absent explicitement | nouveau |
| `garage` | booléen + nombre/surface | maison/immeuble | moyen | garage/box distinct du parking | `has_garage` — existant ; détail nouveau |
| `parking` | entier + type | tous biens concernés | moyen | nombre et nature des places | `parking_count` — existant ; type nouveau |
| `cellar` | booléen + lot/surface | logement/copropriété | moyen | cave explicitement identifiée | nouveau |
| `attic` | booléen + aménagé/non aménagé | maison/immeuble | moyen | grenier/comble explicite | nouveau |
| `pool` | booléen + type + droit/périmètre | appartement avec droit ou équipement rattaché, maison/terrain | optionnel | piscine présente ou absente explicitement et sujet identifié | `has_pool` — existant ; droit et périmètre nouveaux |
| `outbuildings` | tableau type/surface | maison/terrain/ferme | moyen | dépendances séparées | nouveau |
| `land_use` | enum/texte | terrain/maison/ferme | élevé pour terrain | constructible, agricole, loisir, mixte avec source | nouveau ; indices urbanisme/cadastre |
| `boundary_access` | texte/booléens | terrain | moyen | accès, façade, clôture, réseaux | nouveau |

### 7. Occupation, copropriété, urbanisme et risques

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `occupancy_status` | enum `vacant/occupied/rented/owner_occupied/squatted/unknown` | logement/local/maison | critique | mention source ou document exact | `occupancy_status` — existant |
| `occupancy_details` | objet/texte | occupation non libre | élevé | occupant, bail, échéance, réserve sans données personnelles inutiles | payload LLM/source blocks — existant textuel ; structuration recommandée |
| `lease_status` | enum | bien loué | élevé | bail publié ou mention source | nouveau |
| `rent_eur` | montant EUR/mois ou an | bien loué | moyen | loyer et périodicité explicites | nouveau |
| `lease_end_date` | date | bien loué | moyen | échéance explicite | nouveau |
| `coownership` | booléen | appartement/lot | élevé | copropriété explicitement établie | `llm_extraction.copropriete` — existant payload, pas champ canonique |
| `coownership_lot_description` | texte | copropriété | élevé | lots vendus et annexes | nouveau ; `source_blocks`/documents |
| `coownership_charges_eur` | montant + périodicité | copropriété | moyen | charges et exercice | nouveau |
| `coownership_works` | texte + montant si publié | copropriété | moyen | travaux votés/prévus | nouveau |
| `easements` | tableau/texte | terrain/bâti | élevé | servitudes citées dans pièce ou annonce | `llm_extraction.servitudes`, `urban_planning` — existant payload/analysis |
| `urban_planning` | objet zonage/permis/risques | terrain/bâti | élevé | document ou bloc source | analyses `urban-planning`/cadastre — existant enrichissement, nouveau contrat de champ |
| `environmental_risks` | tableau type + niveau + source | tous si publié | élevé | ERP/diagnostic/mention source | `risks`/`auction_risks` — existant ; catalogue détaillé recommandé |
| `technical_diagnostics` | tableau type/statut | bâti | élevé | amiante, plomb, électricité, gaz, termites, assainissement, DPE | `documents_rich`, `auction_dpe_diagnostics`, `risks` — existant partiel |
| `property_tax_eur` | montant + année | bâti si publié | moyen | taxe foncière et année explicites | nouveau |

### 8. Documents et médias

| Champ | Type / unité | Pertinence | Importance | Preuve minimale | Mapping vérifié |
|---|---|---|---|---|---|
| `documents_inventory` | tableau URL + label + type | Tous | critique | URL sûre, label, type normalisé | `documents`, `documents_rich`, `collectSaleDocuments` — existant |
| `document_extraction_status` | enum + compteurs | annonces avec pièces | élevé | `manifest_complete`, documents échoués, pages extraites | `raw_payload.document_analysis` — existant imbriqué |
| `pv_description` | document/état | judiciaire | élevé | document type `pv_huissier`, `pv_notaire` ou équivalent | taxonomie PDF existante ; champ de mesure recommandé |
| `conditions_sale` | document/état | procédures publiant des conditions de vente ou de cession | critique | cahier/conditions et statut d’extraction | `documents_rich.document_type` + analyse — existant |
| `diagnostics_documents` | tableau/état | bâti si disponibles | élevé | document diagnostics et extraction | `documents_rich` + diagnostics — existant |
| `lease_documents` | tableau/état | bien loué | moyen | bail/avenant si disponible | document type `bail` — existant taxonomie |
| `photos_count` | entier >= 0 | Tous | moyen | liste dédupliquée `source_images`/`media` | `raw_payload.source_images`, `media` — existant |
| `photos_usable_count` | entier >= 0 | Tous avec images | moyen | URL accessible, image non logo/placeholder | nouveau métrique |
| `floorplan_media` | tableau/état | bâti | moyen | plan identifié comme tel, image ou PDF | nouveau ; conserver dans media/documents |
| `cadastre_media` | tableau/état | terrain/bâti | moyen | plan cadastral ou carte rattaché au lot | nouveau ; analyses cadastre existantes |
| `media_origin` | enum `source/operator/derived/unknown` | Tous | moyen | provenance de chaque image | `SaleMedia.source` — existant partiel |
| `media_rights_status` | enum | images affichées | moyen | statut de réutilisation connu | nouveau ; ne pas inférer une licence depuis l’URL |

## Profils de pertinence par source et procédure

Cette matrice décrit les champs à contrôler pour la richesse de la fiche. Elle ne dit pas qu’une source doit légalement publier chaque champ. « Attendu » signifie : chercher dans la page détail, les blocs texte, les images et les documents avant de conclure `unknown`.

| Profil | Sources | Champs critiques de publication | Champs à enrichir en priorité | `not_applicable` typiques |
|---|---|---|---|---|
| Judiciaire tribunal | `licitor`, `avoventes`, `vench`, `info_encheres`, `petites_affiches`, `encheres_publiques`, `encheres_immobilieres` si la procédure vérifiée est judiciaire | source/lot, type, commune, date/audience, mise à prix, preuve source, occupation si publiée | adresse, surface qualifiée, pièces/chambres, visites, avocat/contact, conditions, PV, diagnostics, photos | DPE pour terrain nu ou bien explicitement hors périmètre ; étage pour terrain |
| Enchères publiques structurées | `encheres_publiques` | lot exact, type, localisation, mise à prix, date/fenêtre, procédure, texte de lot | surface habitable/terrain, pièces/chambres, DPE/GES, occupation, visites, conditions/frais/paiement, images | avocat si organisme non judiciaire ; étage pour terrain |
| Cession de l’État | `cessions_etat` | source, référence, titre, type, commune/département, surface/terrain si publiée, calendrier lorsqu’il existe | prix/conditions de cession, documents, visites, adresse, DPE, photos, règles de candidature | mise à prix si aucun prix de départ n’est publié ; tribunal/avocat |
| Domaine/AGRASC et opérateur | `agrasc` + opérateurs liés | source opérateur, référence, type, localisation, prix/calendrier si publiés, preuve de rattachement | documents, photos, surface, occupation, conditions et modalités, diagnostics | tribunal si non judiciaire ; avocat sauf mention |
| Notarial | `notaires`, `encheres_immobilieres` si la procédure vérifiée est notariale | source, référence, type, localisation, calendrier, prix, modalité en ligne/présentiel | acte/conditions, diagnostics, surface Carrez, copropriété, charges, DPE, pièces, photos, visites | tribunal si non judiciaire ; DPE si terrain nu |
| En ligne | toute source avec `sale_venue_type=online` | ouverture/fermeture avec fuseau, mode de participation, méthode d’enchère, prix et conditions | consignation, frais, paiement, lots, documents, images, occupation | adresse exacte si masquée par la source |

Les exceptions sont pilotées par `source_name`, `sale_venue_type`, `sale_legal_framework`, `property_type`, `source_presence` et l’évidence du champ. Un même champ peut donc être critique pour un terrain (`land_surface_m2`) et seulement moyen pour un parking (`bedrooms_count` est `not_applicable`).

## Procédure de mesure d’une page

Pour chaque URL de test ou annonce en production :

1. Capturer l’URL, l’horodatage, le statut HTTP/accessibilité, le HTML et un screenshot desktop/mobile lorsque la page est rendue.
2. Extraire séparément les titres (`title`, `h1`–`h3`), les métadonnées, les blocs descriptifs, les tableaux, les listes, les accordéons, les liens, les boutons, les PDF et toutes les images candidates. Le texte de navigation et les mentions génériques doivent rester séparés du texte du lot.
3. Construire l’inventaire attendu à partir des éléments visibles, des données structurées, des `source_blocks` et des pièces accessibles. Chaque élément reçoit un champ du catalogue ou `unmapped_source_fact` avec extrait et localisateur.
4. Comparer l’inventaire à `AuctionSale`, `source_blocks`, `documents_rich`, `media`, aux diagnostics DPE et à `sale_procedure`. Signaler une perte, une valeur contaminée par le chrome, une mauvaise portée de surface, une image manquante ou une pièce non extraite.
5. Résoudre l’état de chaque champ selon le tableau d’états. Une valeur capturée dans le texte mais non normalisée reste une preuve `observed` avec `canonical_value=null`, pas une valeur inventée.
6. Calculer score par catégorie, score global, portes critiques, champs inconnus, absences explicites, champs non applicables, conflits et valeurs inférées. Enregistrer le détail du calcul.
7. Vérifier la cohérence croisée : pièces >= chambres ; surface du logement séparée du terrain, garage, cave et balcon ; prix en EUR séparé des frais/consignation ; date d’annonce séparée de date de vente ; DPE/GES associés au bon bien ; images et documents rattachés à la bonne URL/au bon lot.
8. Conserver un échantillon de régression par source : au moins une page riche, une page pauvre, une page avec documents/images, une page reportée ou terminée, et une page dont l’adresse est partiellement masquée lorsque ces cas existent.

### Garde-fous de rattachement

Les tests de source doivent contrôler le sujet auquel se rapporte chaque bloc avant de compter une valeur. Les erreurs suivantes sont particulièrement coûteuses pour une fiche riche en apparence :

- un code postal, une adresse ou un téléphone du cabinet, du tribunal ou du lieu de visite repris comme adresse du bien ; l’adresse du bien et l’adresse de procédure ont des champs et des preuves séparés ;
- « chambres froides », « chambre technique » ou un local décrit avec le mot chambre compté comme `bedrooms_count` ; une chambre doit être une pièce d’habitation explicitement rattachée au lot ;
- « rez-de-jardin » transformé en `garden=true` alors que le texte ne dit pas que le jardin est privatif, rattaché au lot ou même présent ; le niveau et le jardin sont deux champs indépendants ;
- un étage du bâtiment ou d’une annonce voisine attribué au lot courant ; le sujet doit être le même lot, en particulier quand une page contient plusieurs cartes ou plusieurs niveaux ;
- une surface de terrain, de parcelle, de copropriété ou de dépendance injectée dans `surface_habitable_m2` ; chaque nombre conserve sa portée (`asset`, `dwelling`, `parcel`, `lot`, `annex`) ;
- chauffage, étage, année, orientation ou charges trouvés seulement dans `raw_text` sans rattachement de bloc ; ils restent une preuve à qualifier et ne deviennent pas automatiquement des champs canoniques ;
- variantes d’une même image (miniature, `srcset`, `og:image`, URL signée) comptées plusieurs fois ; le compteur s’appuie sur une identité média normalisée et conserve les variantes comme références ;
- un champ booléen mis à `false` parce qu’aucun mot n’a été trouvé ; `false` exige une négation explicite (« sans garage », « aucun jardin »), sinon l’état est `unknown` ;
- deux chiffres qui ont le même libellé mais une périodicité différente, par exemple charges annuelles de 160 € et résumé trimestriel de 160 € ; l’unité et la période font partie de la valeur, et la divergence déclenche `conflict` jusqu’à résolution.

Ces garde-fous sont des contrôles de cohérence du catalogue. Ils doivent être exécutés sur les pages riches et sur les pages à répétition de blocs, avant de conclure qu’un extracteur couvre un champ.

## Format minimal d’une observation de champ

```json
{
  "field": "floor_number",
  "state": "observed",
  "value": 2,
  "canonical_value": 2,
  "unit": "floor",
  "evidence": [{
    "grade": "A",
    "source_url": "https://source.example/lot-123",
    "artifact": "page_html",
    "locator": "#description .caracteristiques",
    "quote": "Appartement situé au 2e étage",
    "captured_at": "2026-10-02T10:00:00Z"
  }],
  "inference": null,
  "conflicts": []
}
```

Pour `unknown`, `evidence` doit contenir la tentative et, si possible, `availability_reason` (`not_found`, `page_inaccessible`, `document_locked`, `source_not_disclosed`). Pour `explicitly_absent`, `quote` doit contenir la négation. Pour `not_applicable`, `reason` est obligatoire. Pour `inferred`, `inference.method`, `inference.input_fields` et `inference.confidence` sont obligatoires. Pour `conflict`, chaque valeur concurrente doit garder sa source et son extrait.

## Revue de cohérence effectuée

- Aucun champ de cette checklist ne traite une absence d’extraction comme une absence du bien.
- Les surfaces bâties, Carrez et terrain restent distinctes ; une estimation depuis le nombre de pièces ne satisfait pas un champ de surface observée.
- `rooms_count` et `bedrooms_count` restent indépendants, conformément aux consignes d’extraction existantes ; une chambre n’est pas déduite d’un T2/T3.
- Le chauffage distingue mode individuel/collectif, énergie et distribution ; un champ « chauffage » unique ne peut plus masquer ces trois dimensions.
- Le DPE distingue classe, GES, valeurs numériques, dates, numéro et source ; un simple texte « DPE à lire » reste une preuve de document, pas une classe.
- Les booléens d’équipements acceptent `explicitly_absent` seulement avec une négation source ; `null`/`unknown` reste mesuré comme non renseigné.
- Les documents sont comptés par type et état d’extraction ; un lien PDF présent mais illisible n’est pas une pièce vérifiée.
- Les images sont comptées comme inventaire média et comme médias utilisables ; une URL de logo ou de placeholder ne satisfait pas `photos_usable_count`.
- Les champs `not_applicable` sont exclus du dénominateur ; l’exception « cession de l’État sans mise à prix » reprend le comportement déjà présent dans `catalogue_readiness.py` mais exige une raison enregistrée.
- Les portes d’identité, procédure, date, prix, localisation et preuve restent bloquantes même avec un score élevé, conformément à la séparation existante entre score et `blockers`.

Les seuils de classement s’appliquent au score avant arrondi : `[0,55[`, `[55,75[`, `[75,90[` et `[90,100]`. L’affichage peut arrondir le pourcentage, sans modifier sa classe ; les portes critiques restent évaluées séparément.

Les listes de sources des profils sont des indices, pas des classifications de procédure. Un portail comme Enchères Immobilières ou Enchères Publiques peut relayer plusieurs modalités : les exigences judiciaires/notariales/en ligne suivent la procédure vérifiée et sa preuve. Une mise à prix non publiée reste inconnue ; elle devient non applicable seulement si la méthode de vente confirmée n’utilise pas de prix de départ.
