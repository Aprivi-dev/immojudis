# Audit DVF — estimation locale et comparables

Date : 12 juillet 2026
Périmètre : import DVF, estimation temps réel, moteur de comparables, surfaces, terrains, confiance et backtest.

## Conclusion exécutive

Le système possède déjà de bonnes briques : médiane plutôt que moyenne, élargissement progressif du rayon, séparation visuelle de la surface terrain, score de proximité/récence/surface et backtest chronologique. Elles ne suffisent toutefois pas à sécuriser l'estimation actuelle.

Trois problèmes doivent être traités avant d'affiner le modèle statistique :

1. un terrain peut être valorisé avec un prix au m² résidentiel bâti, car sa surface est placée dans `app_surface_m2`, puis traitée comme une surface bâtie alors que le moteur temps réel ignore le type du bien ;
2. l'import planifié télécharge le format brut officiel, mais le normaliseur et ses tests supposent le format enrichi/géolocalisé ; l'import ne reconstitue pas les mutations et ne fournit pas les coordonnées nécessaires aux requêtes ;
3. les deux moteurs DVF appliquent des règles différentes et peuvent produire deux références contradictoires pour le même bien.

En l'état, la médiane DVF peut servir de signal exploratoire sur certains appartements ou maisons simples, mais elle ne doit pas alimenter automatiquement un plafond de mise pour les terrains, actifs mixtes, mutations complexes ou échantillons faibles.

## Architecture actuelle

### Flux A — estimation principale en temps réel

`src/lib/market.functions.ts` appelle l'API DVF+ Cerema `geomutations` sur 6 millésimes, choisit un rayon selon la population de la commune, conserve la dernière vente de chaque ensemble parcellaire, filtre les mutations simples de codes `111` ou `121`, puis calcule médiane et quartiles.

Cette estimation est celle utilisée par la fiche, les alertes, les rapports et le plafond de mise.

### Flux B — comparables détaillés et backtest

Le workflow `.github/workflows/dvf-import.yml` télécharge les cinq fichiers bruts principaux de data.gouv.fr et les importe dans `dvf_transactions`. `src/lib/dvf-comparables.ts` interroge ensuite cette table et `src/lib/dvf-comparable-engine.ts` sélectionne et note les comparables.

Le backtest utilise ce second moteur avec une séparation chronologique correcte : pour tester une vente, seules les transactions antérieures sont prises comme références.

## Constats prioritaires

### P0 — un terrain peut être multiplié par un prix au m² bâti

Éléments de preuve :

- `services/data-pipeline/src/asset_normalization.py:1962` place `land_surface_m2` dans `app_surface_m2` pour un bien `land` ;
- `src/lib/surface.ts:51` prend `app_surface_m2` comme surface de valorisation prioritaire sans lire `app_surface_kind` ni `surface_scope` ;
- `src/lib/market.functions.ts:123` accepte `propertyType`, mais cette valeur n'est jamais utilisée dans la sélection des mutations ;
- `src/lib/market.functions.ts:378` accepte indistinctement les maisons et appartements simples ;
- la valeur obtenue est ensuite multipliée par la surface applicative dans les calculs de plafond.

Scénario : un terrain de 800 m² peut recevoir une médiane résidentielle de 3 000 €/m², donnant une valeur théorique de 2,4 M€, alors que les 800 m² représentent le terrain et non du bâti.

Action immédiate : interdire l'estimation résidentielle lorsque `app_surface_kind === "land"`, `surface_scope === "land"` ou `property_type === "land"`. Appliquer la même règle aux actifs commerciaux/mixtes dont la seule surface connue est foncière. Cette protection doit être placée côté serveur, pas uniquement dans l'interface.

### P0 — l'import planifié n'est pas compatible avec le fichier qu'il télécharge

Le workflow sélectionne les ressources principales du jeu DGFiP. Le fichier officiel 2025 observé le 12 juillet 2026 commence par les colonnes historiques `Identifiant de document`, `No disposition`, `Date mutation`, `Valeur fonciere`, `Prefixe de section`, `Section`, `No plan`, etc. Il ne contient ni `id_mutation`, ni `id_parcelle`, ni latitude/longitude.

Le normaliseur attend notamment `id_mutation`, `id_parcelle`, `adresse_numero`, `latitude` et `longitude`. Conséquences :

- chaque ligne reçoit un hash différent de la ligne complète comme identifiant de mutation ;
- les lignes d'une même mutation ne sont pas regroupées ;
- le prix total répété sur chaque ligne est divisé par la surface d'un seul local ;
- la parcelle et les coordonnées restent nulles ;
- les requêtes détaillées par bounding box ne peuvent donc pas retrouver ces lignes ;
- une surface bâtie officielle égale à `0` reste `0`, alors que la table impose `built_surface_m2 > 0`, ce qui peut faire échouer un lot d'import ;
- si une ligne officielle est corrigée lors d'une republication, son hash change et l'ancienne version reste en base.

Reproduction sur les trois premières lignes officielles 2025 : une vente unique à 468 000 € est normalisée en trois identifiants différents ; les surfaces bâties obtenues sont `null`, `0` et `111`, toutes sans parcelle ni coordonnées.

Action recommandée : ingérer une source agrégée à la mutation et géolocalisée, de préférence DVF+ Cerema, puis la matérialiser dans PostGIS. Si le fichier brut DGFiP reste la source d'archivage, sa transformation doit d'abord reconstituer chaque mutation et ses locaux/parcelles avant tout calcul de prix au m².

### P0 — le modèle de stockage est à la mauvaise granularité

La clé unique actuelle est `(source, source_mutation_id, parcel_id)`, et `price_per_m2` est généré par `total_price_eur / built_surface_m2` sur chaque ligne. Or la valeur foncière appartient à la mutation/disposition, tandis qu'une mutation peut contenir plusieurs locaux et plusieurs parcelles.

Le Cerema recommande de raisonner au niveau de la mutation ; dans DVF+, `sbati` correspond à la somme des surfaces bâties des locaux distincts ayant muté. Une mutation mixte ne permet pas d'attribuer proprement une fraction du prix à chaque local.

Action : une ligne canonique par mutation avec listes de parcelles, compte des locaux, surfaces agrégées par type, surface terrain totale, typologie, géométrie, et un statut explicite `eligible_for_valuation` accompagné d'un motif d'exclusion.

### P1 — le moteur principal mélange maisons et appartements

`propertyType` est transmis, mais jamais appliqué. Une maison est donc estimée à partir d'un mélange de maisons et d'appartements simples, et inversement. La fenêtre de surface ne corrige pas cette différence de marché.

Dans le moteur détaillé, le mode de secours `expanded_fallback` abandonne également la contrainte de type si moins de quatre ventes du même type sont disponibles.

Action : ne jamais franchir la frontière appartement/maison/terrain/activité pour augmenter artificiellement l'échantillon. Un manque de données doit déclencher un modèle de repli du même segment, pas un mélange de segments.

### P1 — pagination et erreurs réseau silencieuses

Le client Cerema demande `page_size=500` mais ne suit pas le champ `next`. Sur une requête testée à Bordeaux, rayon 600 m, millésime 2025, l'API annonçait 566 mutations et n'en renvoyait que 500. La coupure peut donc biaiser le résultat dans les zones denses.

Les erreurs, timeouts et réponses 5xx sont transformés en tableau vide. `Promise.allSettled` fusionne ensuite les millésimes réussis sans signaler qu'une ou plusieurs années manquent. Un échantillon incomplet peut ainsi recevoir un score de qualité normal.

Action : paginer jusqu'à épuisement avec une limite de sécurité, tracer `expected_count`, `fetched_count` et les millésimes manquants, puis échouer fermé ou dégrader explicitement la confiance si la collecte est partielle.

### P1 — une estimation à deux ventes alimente automatiquement le plafond

Le moteur principal produit médiane et quartiles dès deux valeurs. Avec deux observations, la médiane est leur moyenne interpolée et les quartiles ne décrivent pas une fourchette statistiquement solide. Le score devient « fragile », mais la médiane reste consommée par le calcul du plafond de mise.

Action : distinguer `estimate_available` de `estimate_actionable`. Par défaut, une référence fragile ou issue de moins de trois mutations indépendantes ne doit pas piloter automatiquement le plafond ; elle doit exiger une hypothèse manuelle confirmée.

### P1 — la récence ne modifie pas la référence du moteur principal

Le système garde la dernière vente par parcelle, puis pondère de la même façon une vente 2021 et une vente 2025. Il ne corrige ni l'évolution locale du marché, ni l'inflation, alors que le Cerema recommande de ramener les prix à une période comparable.

Action : ramener chaque vente à la date d'estimation avec un indice local dérivé de DVF ou un indice externe documenté, puis appliquer une décroissance temporelle continue.

### P1 — la surface du sujet et celle de DVF ne sont pas sémantiquement identiques

Pour un appartement, la surface applicative privilégie actuellement la Carrez. La surface DVF utilisée pour le comparable est la `surface réelle bâtie`, qui n'est pas une surface Carrez. Pour une maison, DVF ne donne pas directement la surface habitable issue des pièces du dossier. Comparer ces valeurs sans conserver leur nature crée un biais invisible.

Action : propager `surface_kind` dans tout le moteur, afficher la base utilisée et calibrer les écarts Carrez/habitable/surface réelle bâtie sur un jeu où plusieurs mesures sont connues. Ne pas présenter le prix obtenu comme strictement homogène si les bases diffèrent.

### P1 — le terrain d'une maison n'est pas valorisé

Pour une maison, la sélection ne tient compte que de la surface bâtie. Deux maisons de 110 m², l'une sur 150 m² et l'autre sur 2 000 m², sont considérées équivalentes si elles sont proches.

Action : intégrer `land_surface_m2` avec un effet marginal décroissant, et sélectionner prioritairement des maisons de surfaces bâtie et foncière comparables. La valeur du terrain ne doit pas être ajoutée linéairement au prix au m² bâti.

### P2 — autres biais et incohérences

- Le rayon initial dépend de la population de toute la commune, indicateur trop grossier pour la densité du micro-marché.
- L'élargissement s'arrête dès trois parcelles exploitables, avant de vérifier la compatibilité de type et de surface.
- Les bornes mondiales 500–25 000 €/m² peuvent exclure des ventes légitimes dans les marchés très bas ou très hauts.
- Le filtre IQR n'est activé qu'à partir de sept valeurs, donc précisément pas sur les petits échantillons les plus sensibles.
- Les transactions affichées ne sont pas forcément celles utilisées dans la médiane : la liste vient de `perParcel`, avant fenêtre de surface et filtre des valeurs extrêmes.
- L'« historique de l'adresse » est en réalité un historique de l'ensemble parcellaire ; dans une copropriété, il ne s'agit pas du même appartement.
- Le centroïde géométrique est une moyenne des sommets du premier polygone, pas un centroïde surfacique de toute la mutation.
- Le moteur détaillé qualifie à tort le mode de `surface_matched` lorsque la surface du sujet est absente, car une fenêtre nulle accepte toutes les surfaces.
- Le filtre départemental exclut des ventes très proches situées de l'autre côté d'une frontière administrative.
- Les périodes annoncées ou utilisées divergent : 6 millésimes pour le moteur principal, 36 mois par défaut pour les comparables, et plusieurs textes produit mentionnent 24 ou 36 mois.
- L'absence structurelle de DVF en Alsace, Moselle et Mayotte n'est pas distinguée d'une simple absence de ventes.

## Proposition de moteur V2

### 1. Une source canonique unique

Matérialiser DVF+ au niveau mutation dans PostGIS et servir estimation, comparables détaillés et backtest depuis la même table/version de données. Le temps réel Cerema peut rester une source de contrôle ou de rattrapage, mais pas une seconde vérité métier.

Champs minimaux : identifiant invariant, date, valeur, nature/VEFA, typologie, comptes de maisons/appartements/activités/dépendances, surfaces bâties par type, surface terrain, liste de parcelles, géométrie, centroïde, qualité de géocodage, version de source, date d'import et motif d'éligibilité.

Segments d'évaluation séparés :

- appartement unique ancien/récent/neuf ;
- maison individuelle ancienne/récente/neuve ;
- terrain non bâti ;
- immeuble ou plusieurs logements ;
- activité/commercial ;
- mutation mixte ou complexe, non valorisable automatiquement.

### 2. Sélection adaptative sans mélange de segments

Ordre conseillé :

1. même segment, micro-zone, 24–36 mois, surfaces proches ;
2. même segment, rayon élargi ;
3. même segment, période élargie avec correction temporelle ;
4. repli hiérarchique vers IRIS/commune/EPCI ou modèle régional du même segment ;
5. estimation indisponible si l'incertitude reste trop grande.

Le nombre pertinent est un effectif effectif pondéré, pas seulement le nombre brut de lignes. Plusieurs ventes du même ensemble parcellaire ou du même programme ne doivent pas donner une illusion d'indépendance.

### 3. Estimateur robuste et explicable

Pour les appartements : médiane pondérée ou régression quantile, avec poids de distance, récence, surface, nombre de pièces et segment neuf/ancien.

Pour les maisons : modèle hédonique ou appariement pondéré incluant surface bâtie, `log(1 + surface terrain)`, pièces, récence et micro-zone. L'effet du terrain doit être non linéaire.

Pour les terrains : prix au m² de terrain uniquement sur des ventes non bâties homogènes, avec surface de parcelle, zonage et constructibilité, accès/viabilisation lorsque disponibles. Sans information d'urbanisme, retourner une fourchette foncière fragile plutôt qu'une valeur résidentielle.

La fourchette doit intégrer à la fois la dispersion des comparables et l'erreur historique du modèle. Sur un petit échantillon, elle doit s'élargir automatiquement.

### 4. Confiance calibrée par backtest

Conserver le principe actuel de test chronologique, mais l'exécuter sur des mutations correctement agrégées et par sous-groupes : type, urbain/rural, tranche de surface, quantité de terrain, rayon et taille d'échantillon.

Mesures : erreur absolue médiane, erreur P75/P90, biais signé, part à ±10/20 %, et couverture réelle de l'intervalle annoncé. Le label de confiance doit être dérivé de ces résultats hors échantillon, non d'un score heuristique fixe.

## Au-delà de DVF : estimation multi-sources

DVF doit fournir le socle de marché vendu, pas l'intégralité de la valorisation. Une estimation plus précise doit combiner trois familles d'informations : le micro-marché, les caractéristiques physiques du bien et son état juridique/technique.

### Séparer trois valeurs

Le produit devrait afficher trois résultats distincts :

1. **Valeur de marché libre et en état standard** : prix probable dans une vente amiable normale ;
2. **Valeur du bien en l'état** : marché corrigé des travaux, du DPE, de l'occupation, des servitudes et des défauts documentés ;
3. **Plafond d'enchère** : valeur en l'état diminuée des frais, incertitudes, marge de sécurité et rendement cible.

Cette séparation évite de faire porter au « prix local au m² » des décotes qui relèvent en réalité du dossier judiciaire.

### Un ensemble de modèles plutôt qu'une formule unique

Combiner :

- une médiane pondérée de comparables vendus ;
- un modèle hédonique/gradient boosting prédisant le prix et ses quantiles ;
- un niveau de marché hiérarchique IRIS/commune/EPCI pour les zones peu liquides ;
- si une source contractuelle est disponible, un signal d'annonces actives corrigé de l'écart observé entre prix affiché et prix vendu.

Le poids de chaque composante doit varier avec la qualité des données. Dans une rue liquide, les comparables dominent. Dans une zone rurale, le modèle hiérarchique et les caractéristiques du bien prennent davantage de poids.

### Caractéristiques physiques à intégrer

Le pipeline extrait déjà une partie des champs suivants, mais ils ne participent pas encore à l'estimation : pièces, chambres, salles d'eau, jardin, terrasse, garage, parking, piscine, climatisation et double vitrage.

À ajouter ou fiabiliser :

- étage, ascenseur, étage total et position dans l'immeuble ;
- exposition, luminosité, vue et vis-à-vis ;
- balcon/terrasse et surface des annexes ;
- cave, parking, garage et dépendances valorisés séparément ;
- année/période de construction, nombre de logements et typologie du bâtiment ;
- état intérieur, parties communes, toiture/façade et niveau réel de rénovation ;
- charges de copropriété, travaux votés, procédure de copropriété et taxe foncière ;
- occupation libre/louée/sans droit, bail, loyer et délai probable de libération.

La [BDNB](https://www.data.gouv.fr/datasets/base-de-donnees-nationale-des-batiments) peut compléter les caractéristiques bâtimentaires à la maille du bâtiment. Les attributs non présents dans les données publiques doivent venir des pièces, du PV descriptif, des diagnostics et, si nécessaire, d'une saisie utilisateur contrôlée.

### DPE et travaux : utiliser un coût de remise à niveau

Le DPE ne devrait pas produire un bonus/malus arbitraire. Il faut estimer :

- le coût de passage vers une classe cible ;
- la contrainte locative et le délai de travaux ;
- la décote historique observée par classe DPE dans le même segment/localité ;
- la part des travaux déjà captée dans l'état apparent du bien.

Le dépôt dispose déjà du connecteur [DPE ADEME](https://www.data.gouv.fr/dataservices/dpe-logements-existants-depuis-juillet-2021). Ces données sont déclaratives et doivent conserver un score de rattachement au bon logement. Le coût technique doit être retiré après la valeur de marché standard pour produire la valeur en l'état.

### Micro-localisation mesurée, pas seulement décrite

Les modules actuels repèrent surtout des mentions textuelles comme « proche transports » ou « quartier calme ». Les transformer en variables mesurées :

- temps à pied vers transports, commerces, écoles, santé et espaces verts ;
- fréquence/desserte réelle des transports, pas uniquement distance à un arrêt ;
- distance-temps vers le centre d'emploi ou le pôle urbain pertinent ;
- densité et diversité des équipements autour du bien ;
- nuisances routières/ferroviaires, bruit, pollution, vis-à-vis et coupures urbaines ;
- profondeur du marché, rotation des biens et stabilité des prix dans la micro-zone.

La [Base permanente des équipements de l'Insee](https://www.insee.fr/fr/metadonnees/source/serie/s1161?debut=0) fournit des équipements géolocalisés, et le [Point d'accès national transport](https://transport.data.gouv.fr/) les données de mobilité. Ces signaux doivent être appris dans le modèle, non transformés en bonus fixes décidés manuellement.

### Bâtiment, parcelle, urbanisme et risques

À partir du cadastre déjà connecté, calculer : emprise bâtie, surface libre, nombre de parcelles, forme/fragmentation, accès à la voie et ratio terrain/bâti.

Pour les maisons et terrains, enrichir avec le Géoportail de l'urbanisme : zone PLU, constructibilité, emprise maximale, hauteur, protections et servitudes. L'[API Carto Urbanisme](https://www.geoportail-urbanisme.gouv.fr/image/UtilisationAPI_GPU_1-0.pdf) permet des requêtes à partir d'une géométrie parcellaire.

Ajouter les risques qui ont un effet économique vérifiable : inondation, retrait-gonflement des argiles, cavités, pollution des sols, risques technologiques et recul du trait de côte. Les [API Géorisques](https://www.georisques.gouv.fr/doc-api) exposent ces thématiques. Un risque ne doit modifier la valeur que si son effet est calibré sur les ventes ou traduit en coût/assurabilité/liquidité.

### Méthodes spécifiques par actif

**Appartement** : prix du logement + valeurs séparées du parking, garage, cave et terrasse ; ajustements étage/ascenseur, DPE, période du bâtiment et copropriété.

**Maison** : composante bâtie + effet non linéaire du terrain + dépendances/piscine + accessibilité ; comparer simultanément surface bâtie et terrain.

**Immeuble de rapport** : capitalisation des loyers normalisés, vacance, charges non récupérables et travaux, recoupée par un prix par logement et par m².

**Local commercial** : revenu locatif, durée/qualité du bail, valeur locative de marché, emplacement et taux de capitalisation ; ne pas utiliser le modèle résidentiel.

**Terrain** : deux approches à recouper : comparables de terrains homogènes et bilan promoteur/résiduel fondé sur les droits à construire, coûts de viabilisation/démolition, délais et marge opérateur.

### Exploiter les photos et documents avec prudence

Le PV descriptif, les diagnostics, devis et photos peuvent alimenter un score d'état structuré : neuf/rénové, habitable, rafraîchissement, rénovation lourde, péril. Le modèle ne doit pas déduire seul une valeur depuis une image ; il doit transformer les défauts observables en postes de travaux vérifiables, avec preuve et possibilité de correction humaine.

### Afficher une explication de valeur

Pour chaque estimation :

- socle local vendu ;
- ajustement surface/type ;
- effet terrain ou annexes ;
- effet DPE/état ;
- effet micro-localisation ;
- coûts et risques du dossier appliqués après la valeur standard ;
- intervalle bas/central/haut et raisons de son amplitude.

Les ajustements appris par le modèle doivent être bornés, audités et présentés comme contributions estimées, pas comme vérités exactes.

## Plan de livraison recommandé

### Étape 0 — sécurité immédiate

- bloquer les surfaces foncières dans le moteur résidentiel ;
- faire respecter strictement le type du sujet ;
- ne pas utiliser automatiquement une estimation fragile dans le plafond ;
- signaler collecte partielle et couverture géographique absente ;
- ajouter des tests terrain, actif mixte, une/deux ventes, millésime en erreur et pagination.

### Étape 1 — fondation data

- remplacer ou refondre l'import à la granularité mutation ;
- ajouter tests contractuels sur le vrai fichier officiel téléchargé par le workflow ;
- normaliser zéro en `null` lorsque nécessaire ;
- contrôler doublons, complétude géographique, fraîcheur et compte source/importé ;
- exposer un RPC PostGIS `ST_DWithin` plutôt qu'une bounding box limitée avant filtrage.

### Étape 2 — moteur résidentiel V2

- unifier estimation et comparables ;
- ajouter correction temporelle, poids continus et effectif effectif ;
- intégrer surface terrain pour les maisons ;
- produire une incertitude calibrée.

### Étape 3 — moteur foncier

- créer le segment terrain séparé ;
- enrichir avec cadastre et Géoportail de l'urbanisme ;
- distinguer terrain à bâtir, agricole, naturel et mutation foncière complexe.

### Étape 4 — validation et bascule

Faire tourner V1 et V2 en parallèle, sans exposer V2 au plafond au départ. Bascule après amélioration relative démontrée de l'erreur médiane, absence de régression majeure par segment et couverture correcte de la fourchette.

## Critères d'acceptation

- zéro estimation résidentielle pour une surface de nature `land` ;
- zéro mélange appartement/maison/terrain ;
- une ligne canonique par mutation et aucun prix global répété comme prix d'un local ;
- compte paginé complet ou statut explicite `partial` ;
- test contractuel réussi sur la ressource officielle réellement téléchargée ;
- aucune médiane automatique actionnable sous le seuil de preuve défini ;
- confiance liée à une erreur hors échantillon mesurée ;
- fraîcheur, millésimes chargés et exclusions visibles dans l'interface ;
- amélioration relative mesurable du backtest V2 et résultats publiés par segment.

## Vérifications effectuées

- lecture des deux moteurs, du pipeline d'import, du schéma SQL, du workflow, du backtest et de la sélection des surfaces ;
- exécution de 8 tests ciblés : tous passent ;
- inspection de la ressource officielle 2025 téléchargée par le workflow ;
- normalisation des premières lignes réelles ;
- appel de l'API Cerema et contrôle de la pagination sur plusieurs zones.

Les tests passants ne couvrent actuellement ni le format officiel réellement importé, ni le moteur temps réel, ni les scénarios terrain/mixte.

## Sources officielles

- [Jeu DVF de la DGFiP — couverture, cinq ans et mises à jour semestrielles](https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres)
- [API Données foncières — DVF+ agrégé et géolocalisé à la mutation](https://www.data.gouv.fr/dataservices/api-donnees-foncieres)
- [Cerema — calculer un prix de marché, surfaces, segmentation, médiane et euros constants](https://doc-datafoncier.cerema.fr/doc/guide/dv3f/calculer-un-prix-de-marche)
- [Cerema — format mutation et champs `sbati`, `sterr`, `nblocmut`, `codtypbien`](https://doc-datafoncier.cerema.fr/doc/guide/dv3f/format-csv-de-dv3f)
- [data.gouv.fr — FAQ DVF et distinction surface réelle bâtie/Carrez](https://explore.data.gouv.fr/fr/immobilier?onglet=faq)
