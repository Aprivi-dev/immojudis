import { describe, expect, it, vi } from "vitest";
import {
  buildPreviewSearchArgs,
  mapPreviewRows,
  previewSearchRequestKey,
  runPreviewSearch,
} from "./preview-search";
import { salesSearchSignature, validateSalesSearch } from "./search-url-state";

const row = {
  id: "sale-1",
  starting_price_eur: 90_000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  total_count: 57,
  city: "Bordeaux",
  department: "33",
  property_type: "apartment",
  sale_date: "2026-10-20T07:00:00Z",
  app_surface_m2: 60,
  app_surface_kind: "habitable",
  rooms_count: 3,
  bedrooms_count: 2,
  bathrooms_count: 1,
  latitude: 44.84,
  longitude: -0.58,
  thumbnail_url: "https://media.immobilier.notaires.fr/inotr/media/a.jpg",
  completeness_tier: 1,
};

describe("public preview search", () => {
  it("builds the same arguments for the first page of an empty search", () => {
    expect(buildPreviewSearchArgs({})).toMatchObject({
      p_limit: 24,
      p_offset: 0,
      p_statuses: ["upcoming", "unknown", "postponed"],
      p_occupancy_status: null,
      p_min_score: null,
      p_north: null,
    });
  });

  it("falls back to relevance for the bedroom sort, which the public RPC does not know", () => {
    expect(buildPreviewSearchArgs({ sort: "beds_desc" })).toMatchObject({
      p_sort: "completeness_desc",
    });
    expect(buildPreviewSearchArgs({ sort: "price_asc" })).toMatchObject({ p_sort: "price_asc" });
  });

  it("classe par complétude par défaut, et jamais par score d'investissement", () => {
    expect(buildPreviewSearchArgs({})).toMatchObject({ p_sort: "completeness_desc" });
    expect(buildPreviewSearchArgs({ sort: "relevance" })).toMatchObject({
      p_sort: "completeness_desc",
    });
    expect(buildPreviewSearchArgs({ sort: "distance" })).toMatchObject({
      p_sort: "completeness_desc",
    });
    // Le score d'investissement est réservé à Analyse : un visiteur qui arrive avec cette valeur
    // dans l'URL retombe sur le tri par défaut.
    expect(buildPreviewSearchArgs({ sort: "score_desc" })).toMatchObject({
      p_sort: "completeness_desc",
    });
    expect(buildPreviewSearchArgs({ sort: "sale_date_asc" })).toMatchObject({
      p_sort: "date_asc",
    });
  });

  it("paginates with the requested page and size", () => {
    expect(buildPreviewSearchArgs({ page: 3, limit: 10 })).toMatchObject({
      p_limit: 10,
      p_offset: 20,
    });
  });

  it("uses the dated RPC only when a sale date is requested", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [row], error: null });
    await runPreviewSearch({ rpc }, {});
    expect(rpc.mock.calls[0][0]).toBe("search_auction_sales_preview_v3");
    await runPreviewSearch({ rpc }, { minSaleDate: "2026-10-01" });
    expect(rpc.mock.calls[1][0]).toBe("search_auction_sales_preview_v4");
    expect(rpc.mock.calls[1][1]).toMatchObject({
      p_min_sale_date: "2026-10-01",
      p_max_sale_date: null,
    });
  });

  it("returns the cards and the total count", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [row], error: null });
    const { items, count } = await runPreviewSearch({ rpc }, {});
    expect(count).toBe(57);
    expect(items[0]).toMatchObject({
      id: "sale-1",
      city: "Bordeaux",
      media: [{ type: "image", url: row.thumbnail_url }],
    });
  });

  it("transmet le palier de complétude de chaque carte (badge « bien renseignée »)", () => {
    const [high, low] = mapPreviewRows([row, { ...row, id: "sale-2", completeness_tier: 0 }]);
    expect(high.completeness_tier).toBe(1);
    expect(low.completeness_tier).toBe(0);
  });

  it("ignores a thumbnail that is not a property photo", () => {
    expect(mapPreviewRows([{ ...row, thumbnail_url: "javascript:alert(1)" }])[0].media).toEqual([]);
    expect(mapPreviewRows([{ ...row, thumbnail_url: null }])[0].media).toEqual([]);
  });

  it("rejects instead of hiding a database error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error("timeout") });
    await expect(runPreviewSearch({ rpc }, {})).rejects.toThrow("timeout");
  });

  it("derives one request key per distinct search", () => {
    expect(previewSearchRequestKey({})).toBe(previewSearchRequestKey({ sort: "relevance" }));
    expect(previewSearchRequestKey({})).not.toBe(previewSearchRequestKey({ city: "Pau" }));
  });
});

describe("search signature shared by server and browser", () => {
  it("is identical whatever the order of the URL parameters", () => {
    const a = validateSalesSearch({ city: "Pau", maxPrice: "100000" });
    const b = validateSalesSearch({ maxPrice: "100000", city: "Pau" });
    expect(salesSearchSignature(a)).toBe(salesSearchSignature(b));
  });

  it("is the empty list for the unfiltered catalogue", () => {
    expect(salesSearchSignature({})).toBe("[]");
    expect(salesSearchSignature(validateSalesSearch({ page: "1", sort: "relevance" }))).toBe("[]");
  });
});
