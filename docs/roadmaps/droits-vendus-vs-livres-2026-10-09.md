# Droits vendus vs droits livrés (P7-02, partie analyse)

Date : 2026-10-09. Plan de référence : `docs/audits/2026-10-09-plan-correctif.md`, section « P7-02 · Aligner ce qui est vendu sur ce qui est livré ».
Périmètre : lecture seule du dépôt. Aucun fichier de code modifié, aucun commit. Les estimations de charge sont grossières (jours d'un développeur) et à confirmer.

## 0. Méthode et limites

- Liste des droits : `src/lib/plans.ts` définit 42 `FeatureKey` (6 `sales.*`, 3 `alerts.*`, 3 `dpe.*`, 9 `market.*`, 16 `property.*`, 1 `data.*`, 2 `lawyers.*`, 2 `workspace.*`), deux offres (`decouverte`, `analyse`) et 10 limites (`PlanLimits`).
- Contrôle serveur : recherche de `featureIncluded`, `featureAccess`, `assertFeatureEntitlement`, `assertEntitlementIncluded` et de `buildPlanEntitlements` (`src/lib/property-report/entitlements.ts`) dans `src/`.
- Écran : recherche des appelants de chaque fonction de `src/lib/client-api.ts`, puis vérification que chaque composant est importé et monté depuis une page atteignable (`src/app/**/page.tsx` -> `src/routes/*.tsx` -> composants).
- Annonce commerciale : `src/routes/accompagnement.tsx` (page Offres), `src/lib/analysis-offer.ts`, `src/components/PremiumFeaturePreview.tsx`, `src/components/HomeDiscovery.tsx`, `src/routes/conditions-generales.tsx`, `src/app/comment-ca-marche/page.tsx`, `src/components/SavedAlerts.tsx`, `openapi.yaml`, `docs/vercel_setup.md`, `docs/archive/IMPLEMENTATION_STATUS.md`.
- Je n'ai pas lu l'environnement de production : l'état réel des flags (`TRIBUNAL_STATISTICS_ENABLED`, etc.) n'est pas vérifié, je m'appuie sur `.env.example` et `docs/archive/IMPLEMENTATION_STATUS.md`. Je n'ai pas exécuté l'application ni les tests : « livré » signifie « le code est monté et atteignable », pas « vérifié en navigateur ».
- Vocabulaire des verdicts : « livré (écran existant) », « partiel », « sans interface (API/serveur seulement) », « mort (aucun usage) ».

### Constats transversaux (valables pour toute la suite)

1. `featureIncluded()` renvoie `true` pour `limited` (`src/lib/plans.ts:237-239`). Pour `sales.favorites`, `sales.multiPropertyAnalysis`, `alerts.advanced`, `alerts.watchedZones`, Découverte passe donc les contrôles serveur ; c'est la limite chiffrée (`PlanLimits`) qui borne l'usage.
2. Le catalogue d'écrans de fiche est `src/components/SimplifiedSaleDetailView.tsx`, monté par `src/routes/sales.$id.tsx` (variantes `AnalysisSaleDetailView` / `FreeSaleDetailView`) et par `src/routes/annonce-exemple.tsx`. L'ancienne fiche `src/components/SaleDetailView.tsx` n'est importée que par un mock de test (`src/routes/sales.$id.test.tsx:27`). Toute la chaîne qui n'est atteignable que par elle est donc du code mort : `src/components/sale-detail/decision-view.tsx`, `detail-primitives.tsx`, `detail-helpers.ts`, `document-workspace.tsx`, `src/components/FeaturedLawyerPlacement.tsx`. Sont aussi sans importeur hors tests : `src/components/SaleTribunalHistory.tsx` et `src/components/TribunalStatisticsDashboard.tsx`. Preuve : recherche des imports, aucun importeur non-test trouvé.
3. Le calcul de la mise plafond affiché dans l'interface est local (`src/components/BidCeilingAssistant.tsx` importe `@/lib/profitability`) ; la route serveur `/api/bid-ceiling` n'est appelée par aucun écran (`calculateBidCeilingClient`, `src/lib/client-api.ts:274`, n'a aucun appelant).
4. Les contrôles du plan « Analyse » côté écran reposent surtout sur `plan.hasAnalysisAccess` (fiche) et sur `entitlementsData.plan.features.*` (recherche : `src/components/search/SearchPage.tsx:404-414` ; bouton avocat : `src/components/LawyerReferralButton.tsx:41`). Seuls 5 champs de `features` sont lus par l'interface : `salesStatistics`, `dpeExplorer`, `salesCsvExport`, `watchedZones`, `smartAlerts`, plus `lawyerReferrals`. Les autres champs sont lus par le code de génération de rapport (`src/lib/property-report/analysis.ts`, `pdf.ts`, `src/lib/property-reports.ts`).
5. Reliquats de l'ancien nom d'offre « Investisseur » dans des messages : `src/lib/sale-change-monitor.ts:553` (« réservé au plan Investisseur »), `src/lib/lawyer-referrals.ts:143` (« Analyse ou Investisseur »), `normalizePlanCode` (`src/lib/plans.ts:189-192`). Mineur, à nettoyer au passage.

## 1. Ce que la page Offres et les CGV promettent réellement

Les CGV (`src/routes/conditions-generales.tsx:58-68`, §2) décrivent Analyse comme « statistiques des tribunaux, mise plafond, estimation des travaux, valeur du bien et autres analyses présentées sur la page d'offre ». Le périmètre contractuel est donc la liste de la page Offres (`src/routes/accompagnement.tsx:21-39`).

| Promesse page Offres | Écran qui la livre | Verdict |
| --- | --- | --- |
| Découverte : photos, mise à prix, date, surface, localisation | `SimplifiedSaleDetailView` (variante `discovery`) | livré (écran existant) |
| Découverte : Street View et ClimaScore, selon disponibilité | `StreetViewDialog` monté sans condition d'offre (`SimplifiedSaleDetailView.tsx:1318`), `ClimaScoreWidget` via `ListingEnvironmentalRisks` (`:626`) | livré, mais contredit `plans.ts` (`property.streetFacade` = locked pour Découverte) |
| Découverte : sources publiques et Géorisques | `ListingEnvironmentalRisks`, `SaleProcedurePanel` | livré (non audité en détail) |
| Découverte : jusqu'à trois favoris | `FavoriteButton`, `/favoris` ; quota en base (`supabase/migrations/20260909121649_discovery_favorites_quota.sql`) | livré (écran existant) |
| Découverte : annuaire des avocats par barreau | `src/routes/avocats.tsx` (`fetchLawyerDirectory`) | livré (écran existant) |
| Analyse : mise plafond simulée, enveloppe travaux ajustable | `BidCeilingAssistant` (`SimplifiedSaleDetailView.tsx:754`), `ListingWorks` (onglet Travaux) | livré (écran existant), calcul local |
| Analyse : estimation du bien et ventes comparables | `MarketSnapshot`, `MarketEvidence` (onglet Estimation) via `/api/market-estimate` | livré (écran existant) ; les routes `/api/dvf-comparables` et `/api/valuation-backtest` ne sont pas utilisées |
| Analyse : statistiques des ventes et des tribunaux | `ListingStatistics` (onglet Statistiques, ventes au tribunal), `/tribunaux`, panneau « Repères sur cette recherche » | partiel : la partie tribunal dépend de trois flags fermés par défaut (voir §4, écart n°1) |
| Analyse : frais, travaux, risques, pièces | `ListingBudget`, `RisksAndDocuments`, `DocumentsList` | livré (écran existant) |
| Analyse : financement et scénario locatif | `FinancingSimulator`, `ListingRental` (onglet Financement) | livré (écran existant) |
| Analyse : historique météo mensuel (Meteostat) | `ListingWeatherHistory` (`SimplifiedSaleDetailView.tsx:639`), route `/api/sales/[id]/weather` | livré (écran existant) |
| Analyse : rapport PDF du scénario (ventes au tribunal) | `PropertyReportActions` (onglet Démarches, `:951`) | livré (écran existant) |

## 2. Analyse droit par droit (42 droits)

Format : **Serveur** = où le droit est contrôlé ; **Écran** = où l'utilisateur le voit ; **Annonce** = où il est vendu ; **Verdict** ; **Décision**. « Découverte » : valeur de `PLAN_FEATURES.decouverte` entre parenthèses. Toutes les valeurs Analyse sont `included`.

### 2.1 `sales.*`

**`sales.filters`** (Découverte : included)
- Serveur : aucun contrôle (aucune occurrence hors `plans.ts`).
- Écran : filtres de `/sales` (`src/components/search/SearchFilters.tsx`, `AdvancedFiltersPanel.tsx`), monté par `SearchPage`.
- Annonce : implicite (« Explorer gratuitement »).
- Verdict : livré (écran existant) ; le droit lui-même est mort (jamais lu).
- Décision : retirer la clé (identique pour les deux offres, aucun effet). Charge : 0,1 j.

**`sales.statistics`** (locked)
- Serveur : `src/lib/sales-statistics.ts:68` ; `/api/sales/statistics` ; cinq routes `/api/v1/tribunals/*` et `/api/v1/sales/[id]/adjudication-statistics` (`assertFeatureEntitlement`).
- Écran : panneau « Repères sur cette recherche » (`SearchPage.tsx:771-796`, `SearchStatisticsPanel.tsx`), onglet Statistiques de la fiche (`SimplifiedSaleDetailView.tsx:814`, `ListingStatistics`), `/tribunaux` (`TribunalJudicialActivityExplorer`, `PremiumAdjudicationExplorer`, lien de navigation « Statistiques Tribunaux », `Navbar.tsx:29`).
- Annonce : page Offres (« Statistiques des ventes et des tribunaux »), CGV §2, `PremiumFeaturePreview`.
- Verdict : partiel. Les statistiques de recherche et de catalogue sont livrées ; les statistiques tribunal/adjudication sont derrière `TRIBUNAL_STATISTICS_ENABLED=false`, `JUSTICE_ACTIVITY_ENABLED=false` (`.env.example:28,31`) et `ADJUDICATION_PRICE_STATISTICS_ENABLED` (absent de `.env.example`, lu dans `src/app/sales/[id]/page.tsx:88` et `src/lib/adjudication-price-statistics-repository.ts:100`). `docs/archive/IMPLEMENTATION_STATUS.md:19` : « aucune donnée tribunal n'est servie en production ». `TribunalStatisticsDashboard` et `SaleTribunalHistory` ne sont pas montés.
- Décision : garder, mais ne vendre que ce qui est servi (voir §4 et §6, décision A). Ajouter le flag manquant à `.env.example` (P7-02 point 3). Charge : 0,5 j de copy et d'environnement.

**`sales.favorites`** (limited, 3 favoris)
- Serveur : `src/lib/favorites.ts:207` ; quota en base (migration `20260909121649_discovery_favorites_quota.sql`).
- Écran : `FavoriteButton` (fiche, résultats), `/favoris` (`FavoriteSales`), lien de menu (`Navbar.tsx:24`).
- Annonce : Offres, accueil (`HomeDiscovery.tsx:42`).
- Verdict : livré (écran existant). Décision : garder.

**`sales.csvExport`** (locked)
- Serveur : `src/lib/sale-exports.ts:168` ; `/api/sales/export`.
- Écran : bouton d'export dans `SearchHeader.tsx:166` (`exportCsv`, `SearchPage.tsx:622`).
- Annonce : non annoncé sur Offres ni CGV (vu seulement dans le toast « Export CSV réservé au plan Analyse »).
- Verdict : livré (écran existant), non vendu.
- Décision : garder ; l'ajouter à la liste Analyse de la page Offres ou assumer qu'il reste un bonus. Charge : 0,1 j.

**`sales.apiAccess`** (locked)
- Serveur : `src/lib/api-keys.ts:58,83` ; `src/lib/sale-exports.ts:206` (flux `/api/sales/feed`) ; routes `/api/api-keys` et `/api/api-keys/[id]`.
- Écran : aucun. `fetchApiKeys`, `createApiKey`, `revokeApiKey` (`client-api.ts:1560-1590`) n'ont aucun appelant ; ni `AccountPage.tsx` ni `accompagnement.tsx` ni `BillingActions.tsx` ne mentionnent les clés.
- Annonce : `docs/vercel_setup.md` (« Accès API léger ... les abonnés avec `sales.apiAccess` peuvent créer des clés API depuis la page `/accompagnement` ») : faux. `openapi.yaml` ne documente ni `/api/sales/feed` ni `/api/api-keys` (4 chemins `/api/v1/*` seulement). Rien dans Offres/CGV.
- Verdict : sans interface (API/serveur seulement).
- Décision : voir §3.1 (recommandation : retirer avant lancement ; sinon brancher, 1,5 à 2 j).

**`sales.multiPropertyAnalysis`** (limited : 1 ensemble, 3 biens)
- Serveur : `src/lib/sale-analysis-sets.ts:555` ; limites `saleAnalysisSets`, `saleAnalysisItems` appliquées (`:165-252`) ; Découverte limitée au type `comparison` (`:561-568`).
- Écran : `/comparaisons` (`ComparisonsPage`), barre de comparaison de `/sales` (`SaleComparisonBar` -> `SaleComparisonDialog` -> `SavedSaleComparisons`), lien de menu (`Navbar.tsx:26`). Seul le type `comparison` est exposé par l'interface (`SavedSaleComparisons.tsx:96`, `ComparisonsPage.tsx:89`) ; `watchlist` et `portfolio` n'ont pas d'écran.
- Annonce : non annoncé sur Offres ni CGV.
- Verdict : partiel (comparaison livrée ; listes de suivi et portefeuilles sans interface).
- Décision : garder la comparaison ; retirer `watchlist` et `portfolio` des types autorisés (ou brancher, 2 à 3 j). Charge de retrait : 0,3 j.

### 2.2 `alerts.*`

**`alerts.advanced`** (limited)
- Serveur : `src/lib/alert-matches.ts:106,137` ; `src/lib/alert-notifications.ts:94,165` ; trigger de quota en base (`supabase/migrations/20260909121656_discovery_geographic_alerts.sql`) ; crons `smart-alerts` et `alert-notifications` (`vercel.json`).
- Écran : bouton « Enregistrer la recherche » (`SearchHeader.tsx:171`, `saveSearch`), `/alertes` (`SavedAlerts`), cloche `AlertNotificationCenter` dans `Navbar.tsx:145`, `AlertNotificationPanel`. `fetchAlertMatches` n'a pas d'appelant, mais `evaluateAlertMatches` est appelé par `SavedAlerts`.
- Annonce : `SavedAlerts.tsx:53-54` (« Découverte : une alerte et une zone ... Analyse : jusqu'à 25 alertes et zones »). Pas sur Offres ni CGV.
- Verdict : livré (écran existant).
- Décision : garder. Vérifier que « 25 alertes » (texte) correspond au trigger SQL : non vérifié.

**`alerts.realtimeChanges`** (locked)
- Serveur : `src/lib/sale-change-monitor.ts:552` ; routes `/api/sale-change-events` et `/api/cron/sale-change-monitor` (deux entrées dans `vercel.json`, 06:45 et 08:45 UTC).
- Écran : aucun. `fetchSaleChangeEvents`, `monitorSaleChanges`, `updateSaleChangeEvent` (`client-api.ts:541-583`) n'ont aucun appelant. Les événements ne sont ni convertis en notifications ni envoyés par email (le module écrit dans `user_sale_change_events` et `user_sale_watch_snapshots`, aucune écriture vers `user_alert_notifications` trouvée).
- Annonce : `docs/vercel_setup.md` (cron) ; rien dans Offres/CGV.
- Verdict : sans interface (API/serveur seulement) ; le cron consomme de la base pour un résultat invisible.
- Décision : voir §3.3 (recommandation : retirer le cron de `vercel.json` et le droit).

**`alerts.watchedZones`** (limited : 1 zone ; Analyse : 25)
- Serveur : `src/lib/watched-zones.ts:227` + `assertWatchedZoneLimit` (`:111-183`).
- Écran : création implicite lors de « Enregistrer la recherche » (`SearchPage.tsx:579-584`), liste et suppression dans `/alertes` (`SavedAlerts.tsx:21,25`). Pas d'écran de modification (`updateWatchedZone` : pas d'appelant trouvé hors route).
- Annonce : `SavedAlerts.tsx:53-54`.
- Verdict : livré (écran existant), édition absente.
- Décision : garder.

### 2.3 `dpe.*`

**`dpe.latest`** (locked)
- Serveur : `src/lib/dpe-explorer.ts:141` ; `/api/dpe/explorer`.
- Écran : bouton de chargement de l'explorateur DPE dans `SearchStatisticsPanel.tsx` (monté par `SearchPage.tsx:779`), appelé via `fetchDpeExplorer` (`SearchPage.tsx:438`).
- Annonce : non annoncé sur Offres ni CGV ; libellé « Réservé à Analyse » dans le panneau.
- Verdict : livré (écran existant), discret.
- Décision : garder.

**`dpe.filters`** (locked)
- Serveur : `src/lib/dpe-explorer.ts:144` (uniquement pour l'explorateur). Le filtre de la recherche principale est local (`src/lib/search/search-filters.ts:196`), verrouillé côté interface seulement (`AdvancedFiltersPanel.tsx:232`, `analysisLocked`).
- Écran : puces DPE dans `AdvancedFiltersPanel`.
- Annonce : aucune.
- Verdict : livré (écran existant) ; verrou serveur partiel (le filtre de recherche n'est pas protégé côté serveur, impact faible car les données sont publiques dans le catalogue).
- Décision : garder.

**`dpe.map`** (locked)
- Serveur : `src/lib/dpe-explorer.ts:147` (paramètre `includeMap`).
- Écran : l'interface demande toujours `includeMap: true` (`SearchPage.tsx:443`) mais n'affiche que le nombre « Points carte » (`SearchStatisticsPanel.tsx:152`) ; `mapPoints` n'est lu nulle part ailleurs. `MapPanel` affiche la classe DPE par annonce à partir des données de la fiche (`MapPanel.tsx:1036`), via `showDpeLegend: !dpeLocked`.
- Annonce : aucune.
- Verdict : partiel (pas de carte DPE dédiée ; légende DPE sur la carte des ventes).
- Décision : garder comme « légende DPE sur la carte » et retirer `includeMap`/`mapPoints` du contrat, ou brancher une couche DPE (2 j). Recommandation : retirer le droit en le fusionnant avec `dpe.latest`. Charge : 0,3 j.

### 2.4 `market.*` (9 droits)

Trois constats pour tout le groupe : `src/lib/market-analytics.ts` ne contrôle qu'une seule clé (`market.priceDistribution`, `:181`) ; la route `/api/market-analytics` n'a aucun appelant (`fetchMarketAnalytics`, `client-api.ts:943`) ; aucun composant ne les affiche. Les sept droits suivants n'ont aucune occurrence hors `plans.ts` : `market.neighborhood`, `market.priceEvolution`, `market.volumeEvolution`, `market.rotationRate`, `market.saleDelayEvolution`, `market.neighborhoodComparison`, `market.nearbyCommuneComparison` (les champs `volumeEvolution`, `saleDelayEvolution`, `rotationRate` existent dans le type de réponse de `market-analytics.ts:139-141` mais sont protégés par `market.priceDistribution`).

- **`market.priceDistribution`** : serveur `src/lib/market-analytics.ts:181`, champ exposé `marketPriceDistribution` (`entitlements.ts:43`) ; écran : aucun ; annonce : aucune. Verdict : sans interface (API/serveur seulement). Décision : retirer la route et le droit, ou brancher un onglet marché (3 à 5 j). Recommandation : retirer avant lancement.
- **`market.demographics`** : champ `marketDemographics` (`entitlements.ts:42`) jamais évalué ; le bloc démographique (`buildDemographicAnalysis`, `src/lib/property-report/analysis.ts:250`) est inclus dans les rapports sans contrôle de ce droit ; rendu dans la page de rapport partagé (`src/app/reports/shared/[token]/page.tsx`) et le PDF. Verdict : partiel (visible seulement dans le rapport sauvegardé, qui est lui-même réservé à Analyse). Décision : retirer la clé (le rapport suffit).
- **`market.neighborhood`**, **`market.priceEvolution`**, **`market.volumeEvolution`**, **`market.rotationRate`**, **`market.saleDelayEvolution`**, **`market.neighborhoodComparison`**, **`market.nearbyCommuneComparison`** : verdict mort (aucun usage). Décision : retirer les sept clés (0,3 j au total).

### 2.5 `property.*` (16 droits)

**`property.valueEstimate`** (locked)
- Serveur : `/api/market-estimate` (`src/app/api/market-estimate/route.ts:18`).
- Écran : onglet Estimation (`MarketSnapshot`, `MarketEvidence`, `AnalysisDecisionPanel`), via `fetchPrecomputedMarketEstimate` (`client-api.ts:206`).
- Annonce : Offres, CGV, accueil, `PremiumFeaturePreview` (`SimplifiedSaleDetailView.tsx:1700`).
- Verdict : livré (écran existant). Décision : garder.

**`property.bidCeiling`** (locked)
- Serveur : `src/lib/bid-ceiling.ts:279` ; route `/api/bid-ceiling` (aucun appelant côté interface).
- Écran : `BidCeilingAssistant` (`SimplifiedSaleDetailView.tsx:754`), `AnalysisDecisionPanel`, hero. Le calcul est local (`@/lib/profitability`) ; l'interface ne passe pas par le droit serveur mais par `access === "analysis"`.
- Annonce : Offres (première ligne Analyse), CGV, accueil, `PremiumFeaturePreview`.
- Verdict : livré (écran existant) ; le contrôle serveur de ce droit ne protège qu'une route inutilisée. Les données sensibles du calcul (estimation) sont protégées par `property.valueEstimate`.
- Décision : garder le droit comme libellé de l'offre ; retirer la route `/api/bid-ceiling` ou brancher l'interface dessus (1 j). Voir §3.10.

**`property.advancedBidScenarios`** (locked)
- Serveur : `src/lib/bid-ceiling.ts:289,337` uniquement.
- Écran : l'assistant propose scénarios, travaux et hypothèses à tout utilisateur Analyse sans appeler ce droit.
- Annonce : Offres (« enveloppe travaux ajustable »).
- Verdict : partiel (fonctionnalité livrée mais le droit n'est évalué que sur la route inutilisée).
- Décision : retirer le droit (il n'y a pas de palier intermédiaire entre Découverte et Analyse). Charge : 0,2 j avec la route.

**`property.cadastralAnalysis`** et **`property.urbanPlanning`** (locked)
- Serveur : `/api/v1/sales/[id]/urbanisme-cadastre` (`route.ts:23,28`) et `/api/v1/sales/[id]/land-report` (`:34,39`) ; rapports (`analysis.ts:280`, `pdf.ts:183`).
- Écran : `UrbanismeCadastrePanel` (onglet Aperçu, `SimplifiedSaleDetailView.tsx:1187`), `LandPotentialPanel` (`fetchSaleLandReport`), `CadastralPlanDisclosure`. Chargement des données structurées réservé aux utilisateurs Analyse (`loadStructuredUrbanism`, `:622-624`).
- Annonce : Offres (« Sources publiques ... Géorisques » pour Découverte ; urbanisme non nommé pour Analyse), CGV générique.
- Verdict : livré (écran existant). Décision : garder.

**`property.nearbyServices`** (locked)
- Serveur : aucun contrôle ; seulement le champ `nearbyServices` (`entitlements.ts:46`), jamais lu hors définition de type.
- Écran : section « services à proximité » du rapport partagé (`src/app/reports/shared/[token]/page.tsx:765`) et du PDF ; pas de composant dans la fiche.
- Annonce : aucune.
- Verdict : partiel (rapport seulement, non contrôlé).
- Décision : retirer la clé (le rapport sauvegardé est déjà réservé à Analyse). Charge : 0,1 j.

**`property.savedReports`**, **`property.pdfExport`**, **`property.reportEditing`** (locked)
- Serveur : `src/lib/property-reports.ts:224,260,277,492,531` (liste, lecture, sauvegarde, partage), `:407` (édition), `:457` (PDF) ; limites mensuelles `assertReportCreationAvailable`, `assertPdfExportAvailable`.
- Écran : `PropertyReportActions` (onglet Démarches, `SimplifiedSaleDetailView.tsx:951`) : enregistrer, modifier titre et notes, exporter PDF, partager un lien (`/reports/shared/[token]`). Pas de page « mes rapports » (liste uniquement par vente via `fetchPropertyReports({ saleId })`). L'« édition » se limite au titre et aux notes (`property-reports.ts:407-415`).
- Annonce : Offres (« Rapport PDF du scénario »), `comment-ca-marche`.
- Verdict : `pdfExport` et `savedReports` livrés (écran existant) ; `reportEditing` partiel (titre et notes seulement ; la limite `reportEditing: "full"|"limited"` n'est qu'un libellé affiché, `PropertyReportActions.tsx:387`). Dans `src/lib/property-report/serialization.ts:20`, le filigrane « VERSION DECOUVERTE » n'est atteint que si `pdfExport === "limited"`, ce qui n'arrive jamais (Découverte = locked) : code mort.
- Décision : garder `savedReports` et `pdfExport` ; fusionner `reportEditing` dans `savedReports` ; supprimer la branche « extrait limité ». Charge : 0,3 j.

**`property.streetFacade`** (locked)
- Serveur : uniquement la génération du rapport (`analysis.ts:257`, `pdf.ts:184`).
- Écran : Street View et « Quartier 3D » sont montrés à tous (`SimplifiedSaleDetailView.tsx:1318`), y compris Découverte, comme l'annonce la page Offres.
- Annonce : Offres (Découverte : « Street View ... »). Contradiction avec `plans.ts` (locked pour Découverte).
- Verdict : partiel (le droit ne gouverne que la section « façade » du rapport).
- Décision : retirer la clé ou la passer à `included` pour Découverte pour refléter la réalité. Charge : 0,1 j.

**`property.weatherHistory`** (locked)
- Serveur : `/api/sales/[id]/weather` (`route.ts:37`).
- Écran : `ListingWeatherHistory` (Aperçu, `SimplifiedSaleDetailView.tsx:639`), avec aperçu verrouillé pour Découverte (`locked={access !== "analysis"}`).
- Annonce : Offres, CGV générique, `comment-ca-marche`.
- Verdict : livré (écran existant). Décision : garder. À noter : ce droit n'apparaît pas dans `buildPlanEntitlements`.

**`property.saleHistory`** (locked)
- Serveur : `src/lib/sale-history.ts:128` ; `/api/sales/history` ; rapports (`gateMarketComparablesAnalysis`, `entitlements.ts:130`).
- Écran : la route n'a aucun appelant (`fetchSaleHistory`, `client-api.ts:918`) ; l'historique d'adresse n'apparaît que dans les rapports (`addressHistory`). `SaleTribunalHistory` n'est pas monté.
- Annonce : aucune.
- Verdict : sans interface (API/serveur seulement) pour la route ; partiel dans le rapport.
- Décision : retirer la route `/api/sales/history` et la clé, garder `addressHistory` dans le rapport sous `savedReports`. Charge : 0,3 j (ou 1 à 2 j pour brancher un encart « ventes passées »).

**`property.soldComparables`** (locked)
- Serveur : `src/lib/dvf-comparables.ts:99` (`/api/dvf-comparables`) ; `src/lib/valuation-backtest.ts:267` (`/api/valuation-backtest`) ; rapports (`analysis.ts:347`, `property-reports.ts:306`, `pdf.ts:181`).
- Écran : aucun pour les deux routes (`fetchDvfComparables`, `fetchValuationBacktest` sans appelant). Les comparables visibles dans l'onglet Estimation proviennent de l'estimation précalculée (`MarketEvidence`), pas de ces routes.
- Annonce : Offres (« ventes comparables »), accueil (« Estimation et comparables »).
- Verdict : partiel (promesse tenue par l'estimation précalculée ; les deux routes dédiées sont sans interface).
- Décision : garder le droit pour le rapport ; retirer `/api/dvf-comparables` et `/api/valuation-backtest` (ou brancher, voir §3.8 et §3.9).

**`property.activeComparables`** (locked)
- Serveur : rapports seulement (`analysis.ts:269`, `property-reports.ts:298`, `pdf.ts:186`).
- Écran : section du PDF et du rapport partagé ; pas de composant de fiche.
- Annonce : aucune.
- Verdict : partiel (rapport seulement). Décision : garder sous `savedReports`, retirer la clé séparée. Charge : 0,1 j.

**`property.neighborhoodAnalysis`** (locked)
- Serveur : `/api/environment-context` (`route.ts:17`) ; rapports (`property-reports.ts:291`).
- Écran : `fetchEnvironmentalContext` n'est appelé que par `SaleDetailView.tsx` (mort). Visible seulement dans le rapport.
- Annonce : aucune.
- Verdict : sans interface (route) ; partiel (rapport).
- Décision : retirer la route `/api/environment-context`, garder la section de rapport.

**`property.outcomeGraph`** (locked)
- Serveur : `/api/v1/sales/[id]/outcome-graph` (`route.ts:19`), documenté dans `openapi.yaml`.
- Écran : `OutcomeForecast` monté dans « Perspective d'adjudication » (`SimplifiedSaleDetailView.tsx:1121-1133`), affiché uniquement si la prévision est `ready`.
- Annonce : aucune (ni Offres, ni CGV). Chantier Outcome Graph gelé par P7-01 (`OUTCOME_EVALUATION_ENABLED=false`).
- Verdict : partiel (monté mais inactif sans données).
- Décision : garder tel quel et geler (P7-01), ne rien annoncer.

### 2.6 `data.*`, `lawyers.*`, `workspace.*`

**`data.onDemandRefresh`** (locked)
- Serveur : `src/lib/data-refresh.ts:98` ; `/api/data-refresh`. Un worker Python traite la file (`services/data-pipeline/src/storage/supabase_client.py:1909-1977`, table `data_refresh_requests`).
- Écran : aucun (`requestDataRefresh` et `fetchDataRefreshRequests` sans appelant interface).
- Annonce : aucune.
- Verdict : sans interface (API/serveur seulement).
- Décision : voir §3.9 (recommandation : retirer la route et le droit ; garder le worker dormant ou le retirer au prochain nettoyage).

**`lawyers.directory`** (included pour les deux offres)
- Serveur : seul contrôle : `/api/lawyers/placement-events` (`route.ts:17`), avec le message « réservés au plan Analyse » alors que le droit est ouvert à Découverte. `/api/lawyers/directory` et `/featured` n'ont aucun contrôle.
- Écran : `/avocats` (`src/routes/avocats.tsx`), lien de navigation « Avocats », `SearchLawyerPlacement` dans `/sales`. L'événement de placement n'est émis que par `FeaturedLawyerPlacement` (code mort) ; l'emplacement sponsorisé de la recherche n'appelle pas cette route.
- Annonce : Offres (Découverte : « Annuaire des avocats par barreau »).
- Verdict : livré (écran existant) ; le droit est sans effet différenciant.
- Décision : garder l'annuaire ; retirer la clé et le contrôle de `placement-events`, ou rebrancher l'émission d'événements (0,5 j) si le suivi de placement sponsorisé est voulu.

**`lawyers.referrals`** (locked)
- Serveur : `src/lib/lawyer-referrals.ts:142` ; `/api/lawyer-referrals`.
- Écran : `LawyerReferralButton` dans la fiche (`SimplifiedSaleDetailView.tsx:2259`, ventes judiciaires persistées sans statut) et sur `/avocats` (`avocats.tsx:155,391`) ; administration côté `/admin`.
- Annonce : Offres, seulement en passant (« Comparables, frais, risques, pièces et avocat »).
- Verdict : livré (écran existant). Décision : garder, à nommer explicitement dans la liste Analyse.

**`workspace.audienceTracking`** (locked)
- Serveur : deux usages distincts. (a) `/api/sale-workspace` (GET, PUT) et `/api/sale-workspace/professional-pilot` (PUT) contrôlent ce droit (message « Espace de suivi réservé au plan Analyse »), et (b) `/api/audience-tracking` / `src/lib/audience-tracking.ts:129` (tableau de bord).
- Écran : (a) livré : « Préparer le dossier de travail » (`SimplifiedSaleDetailView.tsx:972`, `ProfessionalPilotLauncher` -> `ProfessionalPilotWorkspace` -> `fetchSaleWorkspace` / `saveProfessionalPilotDossier`). (b) aucun : `fetchAudienceTracking` (`client-api.ts:617`) sans appelant.
- Annonce : `TribunalJudicialActivityExplorer.tsx:98` (« audiences suivies ... disponibles dans l'espace Analyse »), ambigu. Rien dans Offres/CGV.
- Verdict : partiel (dossier de travail livré ; tableau de suivi d'audience sans interface).
- Décision : renommer le droit en `workspace.dossier` (il protège en réalité le dossier de travail), retirer `/api/audience-tracking` ou brancher un tableau (2 à 3 j). Recommandation : retirer.

**`workspace.collaboration`** (locked)
- Serveur : `src/lib/sale-workspace-collaboration.ts:290` ; `/api/sale-workspace/collaboration` ; limite `workspaceCollaborators` = 25 (`:305-319`).
- Écran : aucun (les six fonctions `*SaleWorkspace*Client` de `client-api.ts:663-745` n'ont aucun appelant).
- Annonce : `src/routes/privacy.tsx:27` (« espaces collaboratifs ») et `docs/rgpd-processing-register.md:10` (« Fournir Analyse et collaboration »). Rien dans Offres/CGV.
- Verdict : sans interface (API/serveur seulement).
- Décision : voir §3.2 (recommandation : retirer).

## 3. Fonctionnalités sans interface à trancher (liste du plan)

Chaque point : état factuel, risque, recommandation, charge. Les décisions finales appartiennent au propriétaire (§6).

### 3.1 Clés API (`/api/api-keys`, `/api/sales/feed`)
- État : routes et table `user_api_keys` opérationnelles (`src/lib/api-keys.ts`, `src/app/api/api-keys/route.ts`, `src/app/api/api-keys/[id]/route.ts`), authentification par en-tête `X-ImmoJudis-Api-Key` sur `/api/sales/feed`. Aucun écran. Limite : 2 clés (`PlanLimits.apiKeys`).
- Écart : `docs/vercel_setup.md` annonce une création depuis `/accompagnement` ; `openapi.yaml` ne décrit pas ces routes.
- Recommandation : retirer avant lancement (droit `sales.apiAccess`, limite `apiKeys`, routes `/api/api-keys*`, `/api/sales/feed`, corriger `docs/vercel_setup.md`) car jamais vendu et sans demande connue. Retrait : 0,5 j, y compris suppression de la migration/table à décider. Alternative « brancher » : section « Clés API » dans `AccountPage` (liste, création avec secret affiché une fois, révocation) 1,5 j + documentation `openapi.yaml` 0,5 j.

### 3.2 Collaboration (25 personnes)
- État : invitations, acceptation, annotations, révocation implémentées côté serveur (`src/lib/sale-workspace-collaboration.ts`), quota 25. Aucun écran, aucune annonce commerciale ; mentionnée seulement dans les documents RGPD.
- Recommandation : retirer (droit `workspace.collaboration`, limite `workspaceCollaborators`, route, fonctions `client-api.ts:663-745`) ; adapter `src/routes/privacy.tsx:27` et le registre RGPD si les « espaces collaboratifs » ne sont plus fournis. Retrait : 0,5 à 1 j. « Brancher » (invitation par e-mail, annotations) : plus de 5 j, hors périmètre de lancement.

### 3.3 `sale-change-monitor` (cron + route)
- État : cron lancé deux fois par jour (`vercel.json`, 06:45 et 08:45 UTC). `runSaleChangeMonitorBatch` écrit dans `user_sale_change_events` et `user_sale_watch_snapshots` pour les favoris, correspondances d'alertes et dossiers des abonnés Analyse. Aucun écran ne lit ces événements, aucune notification n'en découle.
- Dépendances à retirer ensemble, sinon l'alerte d'exploitation se déclenche : `src/lib/admin-readiness.ts:93` (`EXPECTED_CRONS`), `scripts/check-manual-data-collection.mjs:18`, `supabase/migrations/20261009185000_supervise_all_scheduled_jobs.sql:37` (supervision à 30 h), `docs/vercel_setup.md:117`.
- Recommandation : retirer (P7-02 point 4) : entrées de `vercel.json`, route cron, route `/api/sale-change-events`, droit `alerts.realtimeChanges`, et mettre à jour les quatre références ci-dessus. Retrait : 0,5 j. Alternative : brancher en injectant les événements dans les notifications d'alerte existantes (`AlertNotificationCenter`), 2 à 3 j.

### 3.4 Suivi d'audience
- État : voir `workspace.audienceTracking` (§2.6). Le contrôle de ce droit protège le dossier de travail, qui est livré ; le tableau `/api/audience-tracking` est sans interface.
- Recommandation : retirer le tableau (`src/lib/audience-tracking.ts`, route), conserver le contrôle du dossier de travail sous un nom exact. Charge : 0,5 j.

### 3.5 Historique des ventes
- État : voir `property.saleHistory`. Route `/api/sales/history` sans appelant ; `SaleTribunalHistory` non monté.
- Recommandation : retirer la route et la clé ; conserver l'historique d'adresse du rapport. Charge : 0,3 j.

### 3.6 Analytique de marché
- État : `/api/market-analytics` sans appelant ; sept clés `market.*` sans aucun usage, deux (`priceDistribution`, `demographics`) partiellement.
- Recommandation : retirer la route et les neuf clés `market.*` (0,5 j). Brancher un onglet « Marché » avec courbes de prix, volume et délais : 3 à 5 j, à planifier après lancement si des utilisateurs le demandent.

### 3.7 Comparables DVF
- État : `/api/dvf-comparables` sans appelant. Les comparables visibles viennent de l'estimation précalculée (`/api/market-estimate`).
- Recommandation : retirer la route (0,2 j), ou, si l'on veut montrer la liste détaillée des transactions, ajouter un tiroir dans `MarketEvidence` (1 à 1,5 j).

### 3.8 Backtest
- État : `/api/valuation-backtest` sans appelant ; le backtest est calculé dans la génération de rapport (`src/lib/property-report/analysis.ts`, `repository.ts`) et rendu dans le PDF (`pdf.ts:94-96,228`). L'interface de fiche ne l'affiche pas.
- Recommandation : retirer la route, conserver le calcul pour le rapport. Charge : 0,2 j.

### 3.9 Rafraîchissement à la demande
- État : `/api/data-refresh` sans appelant ; worker Python prêt à traiter `data_refresh_requests`. Aucun bouton.
- Recommandation : retirer la route et le droit `data.onDemandRefresh` ; le worker peut rester dormant (nettoyage ultérieur). Charge : 0,3 j. Brancher un bouton « Actualiser DPE/cadastre » sur la fiche : 0,5 à 1 j (mais le message d'erreur actuel promet « DPE/cadastre » seulement).

### 3.10 `/api/bid-ceiling`
- État : route complète (`src/lib/bid-ceiling.ts`, tests) mais aucun appelant ; l'interface calcule localement. Le droit `property.advancedBidScenarios` n'est évalué que par cette route.
- Risque : double implémentation du calcul (serveur et `@/lib/profitability`), avec dérive possible.
- Recommandation : retirer la route et `property.advancedBidScenarios` (0,3 j), garder `property.bidCeiling` comme étiquette de l'offre. Alternative : faire du serveur la source unique et brancher `BidCeilingAssistant` dessus (1 à 2 j), seulement si l'on veut contrôler le calcul côté serveur.

## 4. Écarts les plus gênants entre ce qui est annoncé (Offres / CGV) et ce qui est livré

1. **Statistiques des tribunaux** : annoncées en tête des bénéfices Analyse (Offres, CGV §2) mais les chemins qui les servent (`/api/v1/tribunals/*`, `ListingStatistics` en mode premium, `/tribunaux`) dépendent de `TRIBUNAL_STATISTICS_ENABLED`, `JUSTICE_ACTIVITY_ENABLED` et `ADJUDICATION_PRICE_STATISTICS_ENABLED`, fermés par défaut ; ce dernier est absent de `.env.example`. `docs/archive/IMPLEMENTATION_STATUS.md:19` indique qu'aucune donnée tribunal n'est servie en production. Risque contractuel le plus fort : il figure dans les CGV. Je n'ai pas pu vérifier l'état réel de la production.
2. **Street View pour Découverte** : promis sur la page Offres et livré, mais `plans.ts` le déclare réservé (`property.streetFacade` = locked) ; incohérence de source de vérité, pas de risque client.
3. **Droits livrés mais non vendus** : export CSV, explorateur DPE, alertes et zones surveillées (25), comparaisons enregistrées, mise en relation avocat ne figurent pas dans la liste Analyse de la page Offres (seule `SavedAlerts.tsx:53-54` en parle). Écart favorable, mais qui sous-vend l'offre et rend la liste des CGV (« autres analyses présentées sur la page d'offre ») plus étroite que le produit.
4. **Droits sans écran mais présents dans la documentation** : clés API (`docs/vercel_setup.md` affirme une création depuis `/accompagnement`, faux) ; collaboration (`src/routes/privacy.tsx:27`, `docs/rgpd-processing-register.md:10`) ; `openapi.yaml` (titre « Premium Analytics API ») ne documente pas `/api/sales/feed` ni `/api/api-keys`, et ses routes de statistiques sont derrière des flags fermés.
5. **Mise plafond** : promesse centrale de l'offre, livrée à l'écran, mais son droit serveur (`property.bidCeiling`, `property.advancedBidScenarios`) ne protège qu'une route qu'aucun écran n'appelle. La protection réelle de l'offre sur la fiche repose sur `/api/market-estimate` (`property.valueEstimate`) et sur le test `access === "analysis"` côté client.
6. **Sept droits `market.*` et `sales.filters`** : décoratifs (aucun usage), ce qui contredit l'objectif « chaque droit correspond à un écran » du plan.
7. **Cron `sale-change-monitor`** : consomme deux exécutions par jour pour une fonction sans écran, tout en étant surveillé par l'exploitation (alerte possible si on l'arrête sans nettoyer).
8. **Libellés** : « plan Investisseur » dans deux messages d'erreur ; message de `/api/lawyers/placement-events` (« réservés au plan Analyse ») faux puisque `lawyers.directory` est ouvert à Découverte ; code mort de filigrane « VERSION DECOUVERTE ».

## 5. Tableau synthétique

Légende des verdicts : L = livré (écran existant), P = partiel, S = sans interface (API/serveur seulement), M = mort (aucun usage). Décisions : G = garder, B = brancher avant lancement (charge), R = retirer.

| Droit | Verdict | Recommandation |
| --- | --- | --- |
| `sales.filters` | L (droit lui-même inutilisé) | R la clé (0,1 j) |
| `sales.statistics` | P (flags tribunal fermés) | G ; ne vendre que ce qui est servi ; ajouter le flag à `.env.example` |
| `sales.favorites` | L | G |
| `sales.csvExport` | L (non vendu) | G ; l'ajouter à l'offre |
| `sales.apiAccess` | S | R (0,5 j) ou B (2 j) |
| `sales.multiPropertyAnalysis` | P (comparaison seule) | G ; R `watchlist` et `portfolio` (0,3 j) |
| `alerts.advanced` | L | G |
| `alerts.realtimeChanges` | S | R avec le cron (0,5 j) |
| `alerts.watchedZones` | L (pas d'édition) | G |
| `dpe.latest` | L | G |
| `dpe.filters` | L (verrou serveur partiel) | G |
| `dpe.map` | P (pas de carte dédiée) | R (fusion avec `dpe.latest`, 0,3 j) |
| `market.neighborhood` | M | R |
| `market.demographics` | P (rapport seul) | R la clé, garder le bloc de rapport |
| `market.priceEvolution` | M | R |
| `market.priceDistribution` | S | R route et clé (ou B, 3 à 5 j) |
| `market.volumeEvolution` | M | R |
| `market.rotationRate` | M | R |
| `market.saleDelayEvolution` | M | R |
| `market.neighborhoodComparison` | M | R |
| `market.nearbyCommuneComparison` | M | R |
| `property.valueEstimate` | L | G |
| `property.bidCeiling` | L (calcul local, route inutilisée) | G comme étiquette ; R la route `/api/bid-ceiling` |
| `property.advancedBidScenarios` | P (évalué sur route inutilisée) | R (0,3 j) |
| `property.cadastralAnalysis` | L | G |
| `property.nearbyServices` | P (rapport seul, non contrôlé) | R la clé (0,1 j) |
| `property.savedReports` | L (pas de page « mes rapports ») | G |
| `property.pdfExport` | L | G ; R la branche « extrait limité » |
| `property.reportEditing` | P (titre et notes) | G fusionné dans `savedReports` |
| `property.urbanPlanning` | L | G |
| `property.streetFacade` | P (incohérent avec Offres) | R la clé ou la passer à `included` (0,1 j) |
| `property.weatherHistory` | L | G |
| `property.saleHistory` | S (route) / P (rapport) | R la route et la clé (0,3 j) |
| `property.soldComparables` | P | G pour le rapport ; R `/api/dvf-comparables` et `/api/valuation-backtest` (0,4 j) |
| `property.activeComparables` | P (rapport seul) | G fusionné dans `savedReports` |
| `property.neighborhoodAnalysis` | S (route) / P (rapport) | R la route `/api/environment-context` |
| `property.outcomeGraph` | P (monté, inactif sans données) | G ; geler (P7-01) ; ne rien annoncer |
| `data.onDemandRefresh` | S | R (0,3 j) ou B (0,5 à 1 j) |
| `lawyers.directory` | L (sans effet différenciant) | G l'annuaire ; R la clé |
| `lawyers.referrals` | L | G ; à nommer dans l'offre |
| `workspace.audienceTracking` | P (dossier livré, tableau non) | G renommé `workspace.dossier` ; R `/api/audience-tracking` |
| `workspace.collaboration` | S | R (0,5 à 1 j) |

Bilan : 42 droits = 16 livrés avec écran (dont `sales.filters`, droit lui-même inutilisé), 12 partiels, 7 sans interface, 7 morts (les sept `market.*` sans aucun usage). Plusieurs droits sont à cheval entre deux verdicts (route sans écran mais bloc de rapport livré) : j'ai retenu le verdict qui décrit le mieux le contrôle serveur actuel.

### Limites chiffrées (`PlanLimits`)

| Limite | Valeurs (Découverte / Analyse) | Contrôle trouvé |
| --- | --- | --- |
| `propertyReportsPerMonth`, `pdfExportsPerMonth` | 0 / illimité | `entitlements.ts:205-226`, `usage.ts:120-128` |
| `savedReports` | 0 / illimité | non trouvé (aucune lecture de `limits.savedReports`) : mort |
| `reportEditing` | limited / full | libellé affiché seulement (`PropertyReportActions.tsx:387`) |
| `favoriteSales` | 3 / illimité | trigger SQL (`20260909121649_discovery_favorites_quota.sql`) |
| `watchedZones` | 1 / 25 | `watched-zones.ts:111-183` |
| `saleAnalysisSets`, `saleAnalysisItems` | 1 et 3 / 20 et 12 | `sale-analysis-sets.ts:165-252` |
| `apiKeys` | 0 / 2 | `api-keys.ts:71-108` (fonction sans interface) |
| `workspaceCollaborators` | 0 / 25 | `sale-workspace-collaboration.ts:305-319` (fonction sans interface) |

## 6. Décisions à prendre par le propriétaire du produit

- **A. Statistiques des tribunaux** : ouvrir les flags et servir des données avant le lancement, ou retirer « statistiques des tribunaux » de la page Offres et du §2 des CGV tant que `TRIBUNAL_STATISTICS_ENABLED` reste fermé. C'est la décision qui a un effet juridique.
- **B. Clés API et collaboration à 25 personnes** : retirer (recommandé, environ 1,5 j au total, avec corrections de `docs/vercel_setup.md`, de la page de confidentialité et du registre RGPD) ou brancher (environ 2 j pour les clés, plus de 5 j pour la collaboration).
- **C. `sale-change-monitor`** : supprimer le cron et ses références d'exploitation (recommandé, 0,5 j) ou en faire des notifications visibles (2 à 3 j).
- **D. Analytique de marché, historique, DVF détaillé, backtest, rafraîchissement à la demande, `/api/bid-ceiling`, suivi d'audience (tableau)** : retirer toutes les routes sans appelant avant lancement (environ 2 j au total avec tests) ou désigner celles à brancher ; aucune n'est vendue aujourd'hui.
- **E. Périmètre de la liste Analyse** : ajouter ou non à la page Offres ce qui est déjà livré (export CSV, DPE, alertes et zones jusqu'à 25, comparaisons, mise en relation avocat) ; en conséquence, décider si Street View reste gratuit (aligner `plans.ts`).
- **F. Règle de gouvernance** : après retrait, ne garder dans `plans.ts` que les droits qui ont un écran (objectif de P7-02) ; si toutes les recommandations de retrait et de fusion ci-dessus sont suivies, il resterait environ 19 droits sur 42.
