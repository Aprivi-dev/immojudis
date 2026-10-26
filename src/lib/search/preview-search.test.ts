import { describe, expect, it, vi } from "vitest";
import {
  buildPreviewSearchArgs,
  mapPreviewRows,
  previewSearchRequestKey,
  MAX_PEPITE_SCAN_ROWS,
  PEPITE_SCAN_CONCURRENCY,
  runPreviewSearch,
} from "./preview-search";
import { PublicApiError } from "@/lib/api-errors";
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

  describe("« Pépites seulement » (visiteur)", () => {
    /** Une page de la recherche : les ventes d'index [offset, offset + limit) d'un catalogue de 250 ventes. */
    const catalogue = Array.from({ length: 250 }, (_, index) => ({
      ...row,
      id: `SALE-${index}`,
      total_count: 250,
    }));
    function client(pepiteResult: { data: unknown; error: unknown }) {
      return {
        rpc: vi.fn(async (name: string, args: { p_limit?: number; p_offset?: number }) =>
          name === "list_public_pepite_sale_ids"
            ? pepiteResult
            : {
                data: catalogue.slice(args.p_offset, (args.p_offset ?? 0) + (args.p_limit ?? 24)),
                error: null,
              },
        ),
      };
    }
    const searchCalls = (rpc: ReturnType<typeof client>["rpc"]) =>
      rpc.mock.calls.filter(([name]) => name !== "list_public_pepite_sale_ids");

    it("croise la liste des pépites (une lecture) avec les lignes, dans l'ordre de la recherche", async () => {
      const { rpc } = client({ data: ["sale-200", "sale-3", "sale-120", "absente"], error: null });
      const { items, count } = await runPreviewSearch({ rpc }, { pepite: true });
      expect(items.map((item) => item.id)).toEqual(["SALE-3", "SALE-120", "SALE-200"]);
      expect(count).toBe(3);
      expect(
        rpc.mock.calls.filter(([name]) => name === "list_public_pepite_sale_ids"),
      ).toHaveLength(1);
      // 250 ventes : trois pages de 100.
      expect(searchCalls(rpc)).toHaveLength(3);
    });

    it("pagine le résultat filtré, pas le catalogue", async () => {
      const ids = Array.from({ length: 30 }, (_, index) => `sale-${index * 8}`);
      const { rpc } = client({ data: ids, error: null });
      const second = await runPreviewSearch({ rpc }, { pepite: true, page: 2, limit: 24 });
      expect(second.count).toBe(30);
      expect(second.items).toHaveLength(6);
    });

    it("sans pépite (mode shadow, fonction absente, panne), rend aucune vente sans lire le catalogue", async () => {
      for (const result of [
        { data: [], error: null },
        { data: null, error: { code: "PGRST202" } },
        { data: null, error: { code: "57014" } },
      ]) {
        const { rpc } = client(result);
        await expect(runPreviewSearch({ rpc }, { pepite: true })).resolves.toEqual({
          items: [],
          count: 0,
        });
        expect(searchCalls(rpc)).toHaveLength(0);
      }
    });

    it("lit les pages 4 à la fois au plus, jamais en rafale", async () => {
      let inFlight = 0;
      let peak = 0;
      const rpc = vi.fn(async (name: string, args: { p_limit?: number; p_offset?: number }) => {
        if (name === "list_public_pepite_sale_ids") return { data: ["sale-3"], error: null };
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const rows = Array.from({ length: 3_000 }, (_, index) => ({
          ...row,
          id: `SALE-${index}`,
          total_count: 3_000,
        }));
        return {
          data: rows.slice(args.p_offset, (args.p_offset ?? 0) + (args.p_limit ?? 24)),
          error: null,
        };
      });
      const result = await runPreviewSearch({ rpc }, { pepite: true });
      expect(result.items.map((item) => item.id)).toEqual(["SALE-3"]);
      // 3 000 lignes : 30 pages, lues par groupes de 4 au plus (la première seule, puis 4 à la fois).
      expect(
        rpc.mock.calls.filter(([name]) => name !== "list_public_pepite_sale_ids"),
      ).toHaveLength(30);
      expect(peak).toBeLessThanOrEqual(PEPITE_SCAN_CONCURRENCY);
      expect(peak).toBeGreaterThan(1);
    });

    it("refuse une recherche de plus de 3 000 lignes (« trop large ») au lieu de tronquer en silence", async () => {
      const rpc = vi.fn(async (name: string) =>
        name === "list_public_pepite_sale_ids"
          ? { data: ["sale-1"], error: null }
          : {
              data: [{ ...row, id: "SALE-1", total_count: MAX_PEPITE_SCAN_ROWS + 1 }],
              error: null,
            },
      );
      const failure = await runPreviewSearch({ rpc }, { pepite: true }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PublicApiError);
      expect((failure as PublicApiError).status).toBe(400);
      expect((failure as Error).message).toBe(
        "Cette recherche est trop large. Choisissez une région ou un département pour appliquer les filtres avancés.",
      );
      // Une seule page lue : on ne balaie pas ce qu'on va refuser.
      expect(
        rpc.mock.calls.filter(([name]) => name !== "list_public_pepite_sale_ids"),
      ).toHaveLength(1);
    });

    it("distingue la recherche filtrée des pépites de la même recherche sans filtre", () => {
      expect(previewSearchRequestKey({ pepite: true })).not.toBe(previewSearchRequestKey({}));
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

  it("lève une Error lisible (message et code PostgREST) au lieu de l'objet brut", async () => {
    const postgrestError = {
      message: "canceling statement due to statement timeout",
      code: "57014",
      details: null,
      hint: null,
    };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: postgrestError });

    const failure = await runPreviewSearch({ rpc }, {}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Recherche d'aperçu en échec : canceling statement due to statement timeout (code 57014)",
    );
    expect((failure as Error).cause).toBe(postgrestError);
  });

  it("garde une Error telle quelle et nomme une erreur sans message", async () => {
    const original = new Error("timeout");
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: original });
    await expect(runPreviewSearch({ rpc }, {})).rejects.toBe(original);

    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST000" } });
    await expect(runPreviewSearch({ rpc }, {})).rejects.toThrow(
      "Recherche d'aperçu en échec : erreur inconnue (code PGRST000)",
    );
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
