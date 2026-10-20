import { describe, expect, it } from "vitest";
import { catalogPlaceholder } from "./search/catalog-placeholder";
import { queryKeys } from "./query-keys";

// These literals are the keys the components used before the factory existed.
// Cache invalidation and optimistic updates match on them, so they must not drift.
describe("queryKeys", () => {
  it("keeps the exact tuples used by existing queries", () => {
    expect(queryKeys.featureEntitlementsPlan("u1")).toEqual(["feature-entitlements", "u1", "plan"]);
    expect(queryKeys.savedAlerts("u1")).toEqual(["saved-alerts", "u1"]);
    expect(queryKeys.watchedZones("u1")).toEqual(["watched-zones", "u1"]);
    expect(queryKeys.alertNotifications("u1")).toEqual(["alert-notifications", "u1"]);
    expect(queryKeys.notificationPreferences("u1")).toEqual(["notification-preferences", "u1"]);
    expect(queryKeys.privacyRequests()).toEqual(["privacy-requests"]);
    expect(queryKeys.favorites("u1")).toEqual(["favorites", "u1"]);
    expect(queryKeys.favoritesAiReview("u1", ["a"])).toEqual(["favorites-ai-review", "u1", ["a"]]);
    expect(queryKeys.favoriteStatus(null, "s1")).toEqual(["favorite-status", null, "s1"]);
    // « Mon démarrage » vit sous le préfixe `favorites` : rafraîchi avec la liste des favoris.
    expect(queryKeys.accountStart("u1")).toEqual(["favorites", "u1", "start"]);
    expect(queryKeys.searchFavoriteStatus("u1", ["a", "b"])).toEqual([
      "search-favorite-status",
      "u1",
      ["a", "b"],
    ]);
    expect(queryKeys.saleDetail("s1", "u1", "analysis")).toEqual([
      "sale-detail",
      "s1",
      "u1",
      "analysis",
    ]);
    expect(queryKeys.saleDetail("s1", "u1", "unlocked")).toEqual([
      "sale-detail",
      "s1",
      "u1",
      "unlocked",
    ]);
    expect(queryKeys.saleAiReview("s1", "anonymous")).toEqual([
      "sale-ai-review",
      "s1",
      "anonymous",
    ]);
    expect(queryKeys.listingStatistics("s1", 12, "live")).toEqual([
      "listing-statistics",
      "s1",
      12,
      "live",
    ]);
    expect(queryKeys.professionalPilotWorkspace(null, "s1")).toEqual([
      "professional-pilot-workspace",
      null,
      "s1",
    ]);
    expect(queryKeys.lawyerDirectory("s1", "bar", "city", "dep")).toEqual([
      "lawyer-directory",
      "s1",
      "bar",
      "city",
      "dep",
    ]);
    expect(queryKeys.saleAnalysisSets("u1")).toEqual(["sale-analysis-sets", "u1"]);
    expect(queryKeys.publicationRequestsWorkspace("u1")).toEqual([
      "publication-requests",
      "workspace",
      "u1",
    ]);
  });

  it("keys the data that differs between the free, unlocked and Analyse views by access", () => {
    expect(queryKeys.saleUnlock("s1", "u1")).toEqual(["sale-unlock", "s1", "u1"]);
    expect(queryKeys.saleUnlocksOverview("u1")).toEqual(["sale-unlocks-overview", "u1"]);
    for (const access of ["discovery", "unlocked", "analysis"] as const) {
      expect(queryKeys.documentReading("s1", access, "u1")).toEqual([
        "document-reading",
        "s1",
        access,
        "u1",
      ]);
      expect(queryKeys.salePassages("s1", access, "u1")).toEqual([
        "sale-passages",
        "s1",
        access,
        "u1",
      ]);
      expect(queryKeys.auctionScenarios("s1", access, "u1")).toEqual([
        "auction-scenarios",
        "s1",
        access,
        "u1",
      ]);
    }
    // The teaser of a locked sale and the reading of the same sale once unlocked never share an entry.
    expect(queryKeys.documentReading("s1", "discovery", "u1")).not.toEqual(
      queryKeys.documentReading("s1", "unlocked", "u1"),
    );
    // Nor do two accounts share an entry.
    expect(queryKeys.documentReading("s1", "unlocked", "u1")).not.toEqual(
      queryKeys.documentReading("s1", "unlocked", "u2"),
    );
    expect(queryKeys.precomputedMarketEstimate("s1", "u1")).not.toEqual(
      queryKeys.precomputedMarketEstimate("s1", "u2"),
    );
    // The first two elements stay the historical prefix, so a prefix invalidation still matches.
    expect(queryKeys.documentReading("s1", "unlocked", "u1").slice(0, 2)).toEqual([
      "document-reading",
      "s1",
    ]);
  });

  it("keeps prefix keys that invalidate every matching entry", () => {
    const prefix = queryKeys.searchFavoriteStatusForUser("u1");
    const full = queryKeys.searchFavoriteStatus("u1", ["a"]);
    expect(full.slice(0, prefix.length)).toEqual([...prefix]);

    const allRequests = queryKeys.publicationRequestsAll();
    expect(queryKeys.publicationRequests("u1").slice(0, 1)).toEqual([...allRequests]);
    expect(queryKeys.publicationRequestsWorkspace("u1").slice(0, 1)).toEqual([...allRequests]);
  });

  it("keeps the access scope at index 2 of catalogue keys", () => {
    for (const key of [
      queryKeys.salesSearch("sig", "u1:analysis"),
      queryKeys.salesSearchCount("sig", "u1:analysis"),
      queryKeys.salesSearchMap("sig", "u1:analysis"),
    ]) {
      expect(key[2]).toBe("u1:analysis");
      expect(catalogPlaceholder(["rows"], key, "u1:analysis")).toEqual(["rows"]);
      expect(catalogPlaceholder(["rows"], key, "u2:analysis")).toBeUndefined();
    }
  });
});
