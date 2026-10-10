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

export const queryKeys = {
  // Account, alerts and notifications
  featureEntitlementsPlan: (userKey: Id) => ["feature-entitlements", userKey, "plan"] as const,
  savedAlerts: (userId: string) => ["saved-alerts", userId] as const,
  watchedZones: (userId: string) => ["watched-zones", userId] as const,
  alertNotifications: (userId: string) => ["alert-notifications", userId] as const,
  notificationPreferences: (userId: string) => ["notification-preferences", userId] as const,
  privacyRequests: () => ["privacy-requests"] as const,

  // Favorites
  favorites: (userId: Id) => ["favorites", userId] as const,
  favoritesAiReview: (userId: Id, saleIds: readonly string[]) =>
    ["favorites-ai-review", userId, saleIds] as const,
  favoriteStatus: (userId: Id, saleId: string) => ["favorite-status", userId, saleId] as const,
  searchFavoriteStatus: (userId: Id, saleIds: readonly string[]) =>
    ["search-favorite-status", userId, saleIds] as const,
  /** Prefix of {@link queryKeys.searchFavoriteStatus} for every id list of a user. */
  searchFavoriteStatusForUser: (userId: Id) => ["search-favorite-status", userId] as const,

  // Catalogue search (index 2 is the access scope, see catalogPlaceholder)
  salesSearch: (signature: string, accessScope: string | null) =>
    ["sales-search", signature, accessScope] as const,
  salesSearchCount: (signature: string, accessScope: string | null) =>
    ["sales-search-count", signature, accessScope] as const,
  salesSearchMap: (signature: string, accessScope: string | null) =>
    ["sales-search-map", signature, accessScope] as const,
  salesMapDetail: (accessScope: string | null, saleId: string | null) =>
    ["sales-map-detail", accessScope, saleId] as const,
  salesAiReview: (userKey: Id, saleIds: readonly string[]) =>
    ["sales-ai-review", userKey, saleIds] as const,
  salesStatistics: (signature: string) => ["sales-statistics", signature] as const,
  dpeExplorer: (signature: string) => ["dpe-explorer", signature] as const,
  searchLawyerPlacement: (city: Id, department: Id) =>
    ["search-lawyer-placement", city, department] as const,

  // Sale detail
  saleDetail: (saleId: string, sessionKey: Id, mode: "discovery" | "analysis") =>
    ["sale-detail", saleId, sessionKey, mode] as const,
  saleAiReview: (saleId: string, userKey: Id) => ["sale-ai-review", saleId, userKey] as const,
  saleFactReliability: (saleId: string, userKey: Id) =>
    ["sale-fact-reliability", saleId, userKey] as const,
  saleUrbanismeCadastre: (saleId: string, sourceUrl: string | null | undefined) =>
    ["sale-urbanisme-cadastre", saleId, sourceUrl] as const,
  saleWeather: (saleId: string) => ["sale-weather", saleId] as const,
  saleRisks: (saleId: string) => ["sale-risks", saleId] as const,
  saleWorkspace: (saleId: string) => ["sale-workspace", saleId] as const,
  precomputedMarketEstimate: (saleId: string) => ["precomputed-market-estimate", saleId] as const,
  outcomeGraph: (saleId: string) => ["outcome-graph", saleId] as const,
  listingStatistics: (saleId: string, historyMonths: number, mode: "demo" | "live") =>
    ["listing-statistics", saleId, historyMonths, mode] as const,
  listingStatisticsPrices: (saleId: string) => ["listing-statistics-prices", saleId] as const,
  propertyReports: (userKey: Id, saleId: string) => ["property-reports", userKey, saleId] as const,
  professionalPilotWorkspace: (userId: Id, saleId: string) =>
    ["professional-pilot-workspace", userId, saleId] as const,
  lawyerReferrals: (userKey: Id, saleId: string) => ["lawyer-referrals", userKey, saleId] as const,
  lawyerDirectory: (
    saleId: string | undefined,
    bar: string | undefined,
    city: string | undefined,
    department: string | undefined,
  ) => ["lawyer-directory", saleId, bar, city, department] as const,

  // Saved comparisons
  saleAnalysisSets: (userId: string) => ["sale-analysis-sets", userId] as const,

  // Tribunal and adjudication statistics
  tribunalJudicialActivityPlan: (userId: Id) =>
    ["tribunal-judicial-activity-plan", userId] as const,
  tribunalJudicialActivityDirectory: (historyMonths: number) =>
    ["tribunal-judicial-activity-directory", historyMonths] as const,
  adjudicationStatisticsPlan: (userId: Id) => ["adjudication-statistics-plan", userId] as const,
  adjudicationPriceStatisticsDirectory: (userId: Id) =>
    ["adjudication-price-statistics-directory", userId] as const,

  // Publication requests
  publicationRequests: (userId: Id) => ["publication-requests", userId] as const,
  /** Prefix of every publication-requests key (all users and workspaces). */
  publicationRequestsAll: () => ["publication-requests"] as const,
  publicationRequestsWorkspace: (userId: Id) =>
    ["publication-requests", "workspace", userId] as const,
  publicationRequest: (requestId: string | null | undefined) =>
    ["publication-request", requestId] as const,

  // Admin quality dashboards
  adminQualityReport: () => ["admin-quality-report"] as const,
  adminValuationOverview: () => ["admin-valuation-overview"] as const,
};
