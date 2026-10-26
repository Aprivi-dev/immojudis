/**
 * React Query key factory.
 *
 * Every key is built here so that `useQuery`, `invalidateQueries` and
 * `setQueryData` agree on the exact same tuple. The array contents and their
 * order are part of the contract: invalidation relies on prefix matching, and
 * `catalogPlaceholder` reads the access scope at index 2 of the catalogue keys.
 * Do not reorder elements when editing a key.
 */

type Id = string | null | undefined;

/**
 * What the account reads on a sale page: the free view, a sale unlocked with « 3 déblocages par
 * mois », or the full Analyse view. Keys of the data that differs between these views carry it, so
 * unlocking a sale never leaves the free teaser in the cache.
 */
export type SaleAccessMode = "discovery" | "unlocked" | "analysis";

/*
 * Each key is its own named export, and consumers read them through a namespace import
 * (`import * as queryKeys from "@/lib/query-keys"`, then `queryKeys.favorites(userId)`). The bundler
 * then keeps only the keys a chunk actually uses: this module used to be one object literal that was
 * copied whole into ~20 client chunks (about 5 kB each).
 */

// Account, alerts and notifications
export const featureEntitlementsPlan = (userKey: Id) =>
  ["feature-entitlements", userKey, "plan"] as const;
export const savedAlerts = (userId: string) => ["saved-alerts", userId] as const;
export const watchedZones = (userId: string) => ["watched-zones", userId] as const;
export const alertNotifications = (userId: string) => ["alert-notifications", userId] as const;
export const notificationPreferences = (userId: string) =>
  ["notification-preferences", userId] as const;
export const privacyRequests = () => ["privacy-requests"] as const;

// Favorites
export const favorites = (userId: Id) => ["favorites", userId] as const;
export const favoritesAiReview = (userId: Id, saleIds: readonly string[]) =>
  ["favorites-ai-review", userId, saleIds] as const;
/** Changes detected on the sales the account follows (« Mes favoris »). */
export const saleChangeEvents = (userId: Id) => ["sale-change-events", userId] as const;
/** Les changements d'une seule vente (fiche : « plafond à vérifier »), sous le préfixe de la liste. */
export const saleChangeEventsForSale = (userId: Id, saleId: string) =>
  ["sale-change-events", userId, saleId] as const;
export const favoriteStatus = (userId: Id, saleId: string) =>
  ["favorite-status", userId, saleId] as const;
/** « Mon dossier » d'une vente suivie ; sous le préfixe `favorites`, donc rafraîchi avec la liste. */
export const favoriteDossier = (userId: Id, saleId: string) =>
  ["favorites", userId, "dossier", saleId] as const;
/** « Mon démarrage » : favoris du compte et dossiers remplis ; sous le préfixe `favorites`. */
export const accountStart = (userId: Id) => ["favorites", userId, "start"] as const;
/** Ventes suivies dont l'audience est passée (instantanés gardés 6 mois au plus). */
export const followedSaleSnapshots = (userId: Id) => ["followed-sale-snapshots", userId] as const;
export const searchFavoriteStatus = (userId: Id, saleIds: readonly string[]) =>
  ["search-favorite-status", userId, saleIds] as const;
/** Prefix of {@link queryKeys.searchFavoriteStatus} for every id list of a user. */
export const searchFavoriteStatusForUser = (userId: Id) =>
  ["search-favorite-status", userId] as const;

// Catalogue search (index 2 is the access scope, see catalogPlaceholder)
export const salesSearch = (signature: string, accessScope: string | null) =>
  ["sales-search", signature, accessScope] as const;
export const salesSearchCount = (signature: string, accessScope: string | null) =>
  ["sales-search-count", signature, accessScope] as const;
export const salesSearchMap = (signature: string, accessScope: string | null) =>
  ["sales-search-map", signature, accessScope] as const;
export const salesMapDetail = (accessScope: string | null, saleId: string | null) =>
  ["sales-map-detail", accessScope, saleId] as const;
export const salesPhotoMirrors = (accessScope: string | null, saleIds: readonly string[]) =>
  ["sales-photo-mirrors", accessScope, saleIds] as const;
export const salesAiReview = (userKey: Id, saleIds: readonly string[]) =>
  ["sales-ai-review", userKey, saleIds] as const;
export const salesStatistics = (signature: string) => ["sales-statistics", signature] as const;
export const dpeExplorer = (signature: string) => ["dpe-explorer", signature] as const;
export const searchLawyerPlacement = (city: Id, department: Id) =>
  ["search-lawyer-placement", city, department] as const;

// Sale detail
export const saleDetail = (saleId: string, sessionKey: Id, mode: SaleAccessMode) =>
  ["sale-detail", saleId, sessionKey, mode] as const;
/** Liste publique des identifiants des pépites (une lecture par page de résultats ou par fiche). */
export const pepiteSaleIds = () => ["pepite-sale-ids"] as const;
export const pepiteFloodExposedIds = () => ["pepite-flood-exposed-ids"] as const;
/** Repère « Pépite » d'une vente : `criteria` (noms des critères) ou `detail` (avec le montant, selon le droit). */
export const salePepite = (saleId: string, view: "criteria" | "detail", userKey: Id) =>
  ["sale-pepite", saleId, view, userKey] as const;
export const saleUnlock = (saleId: string, userKey: Id) =>
  ["sale-unlock", saleId, userKey] as const;
/** Compteur du mois et ventes débloquées du compte (Mon compte, résultats de recherche). */
export const saleUnlocksOverview = (userKey: Id) => ["sale-unlocks-overview", userKey] as const;
export const documentReading = (saleId: string, access: SaleAccessMode, userKey?: Id) =>
  ["document-reading", saleId, access, userKey ?? "anonymous"] as const;
export const salePassages = (saleId: string, access: SaleAccessMode, userKey?: Id) =>
  ["sale-passages", saleId, access, userKey ?? "anonymous"] as const;
export const auctionScenarios = (saleId: string, access: SaleAccessMode, userKey?: Id) =>
  ["auction-scenarios", saleId, access, userKey ?? "anonymous"] as const;
export const saleAiReview = (saleId: string, userKey: Id) =>
  ["sale-ai-review", saleId, userKey] as const;
export const saleFactReliability = (saleId: string, userKey: Id) =>
  ["sale-fact-reliability", saleId, userKey] as const;
export const saleUrbanismeCadastre = (saleId: string, sourceUrl: string | null | undefined) =>
  ["sale-urbanisme-cadastre", saleId, sourceUrl] as const;
export const saleWeather = (saleId: string) => ["sale-weather", saleId] as const;
export const saleRisks = (saleId: string) => ["sale-risks", saleId] as const;
export const streetViewPanorama = (lat: number, lng: number) =>
  ["street-view-panorama", lat.toFixed(6), lng.toFixed(6)] as const;
export const saleWorkspace = (saleId: string) => ["sale-workspace", saleId] as const;
// The mode is part of the key: Analyse gets the detailed estimate, an unlock only the value the
// bid ceiling reads, and an account that changes offer must not be served the other one.
export const precomputedMarketEstimate = (
  saleId: string,
  userKey?: Id,
  mode: SaleAccessMode = "analysis",
) => ["precomputed-market-estimate", saleId, userKey ?? "anonymous", mode] as const;
export const outcomeGraph = (saleId: string) => ["outcome-graph", saleId] as const;
export const listingStatistics = (saleId: string, historyMonths: number, mode: "demo" | "live") =>
  ["listing-statistics", saleId, historyMonths, mode] as const;
export const listingStatisticsPrices = (saleId: string) =>
  ["listing-statistics-prices", saleId] as const;
export const propertyReports = (userKey: Id, saleId: string) =>
  ["property-reports", userKey, saleId] as const;
export const professionalPilotWorkspace = (userId: Id, saleId: string) =>
  ["professional-pilot-workspace", userId, saleId] as const;
export const lawyerReferrals = (userKey: Id, saleId: string) =>
  ["lawyer-referrals", userKey, saleId] as const;
export const lawyerReferralPreview = (userKey: Id, saleId: string, lawyerId: Id) =>
  ["lawyer-referral-preview", userKey, saleId, lawyerId] as const;
export const lawyerDirectory = (
  saleId: string | undefined,
  bar: string | undefined,
  city: string | undefined,
  department: string | undefined,
) => ["lawyer-directory", saleId, bar, city, department] as const;
/** Ventes à venir des avocats d'une page de l'annuaire (comptes payants) : propres au compte. */
export const lawyerProsecutedSales = (userKey: Id, lawyerIds: readonly string[]) =>
  ["lawyer-prosecuted-sales", userKey, lawyerIds.join(",")] as const;

// Saved comparisons
export const saleAnalysisSets = (userId: string) => ["sale-analysis-sets", userId] as const;

// Tribunal and adjudication statistics
export const tribunalJudicialActivityPlan = (userId: Id) =>
  ["tribunal-judicial-activity-plan", userId] as const;
export const tribunalJudicialActivityDirectory = (historyMonths: number) =>
  ["tribunal-judicial-activity-directory", historyMonths] as const;
export const adjudicationStatisticsPlan = (userId: Id) =>
  ["adjudication-statistics-plan", userId] as const;
export const adjudicationPriceStatisticsDirectory = (userId: Id) =>
  ["adjudication-price-statistics-directory", userId] as const;

// Publication requests
export const publicationRequests = (userId: Id) => ["publication-requests", userId] as const;
/** Prefix of every publication-requests key (all users and workspaces). */
export const publicationRequestsAll = () => ["publication-requests"] as const;
export const publicationRequestsWorkspace = (userId: Id) =>
  ["publication-requests", "workspace", userId] as const;
export const publicationRequest = (requestId: string | null | undefined) =>
  ["publication-request", requestId] as const;

// Admin quality dashboards
export const adminQualityReport = () => ["admin-quality-report"] as const;
export const adminValuationOverview = () => ["admin-valuation-overview"] as const;
