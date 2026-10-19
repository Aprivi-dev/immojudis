import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));

vi.mock("next/cache", () => ({
  // Pas de cache de données hors Next.js : chaque appel atteint la base simulée.
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.client,
}));

import {
  TRIBUNAL_SALES_REVALIDATE_SECONDS,
  mapTribunalSaleRows,
  tryLoadTribunalSales,
} from "./tribunal-pages.server";
import { TRIBUNAL_PAGE_LISTED_SALES } from "./tribunal-pages";

const ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  city: "Bobigny",
  department: "93",
  property_type: "apartment",
  sale_date: "2026-11-10T13:00:00Z",
  starting_price_eur: "40500",
  surface_m2: 52.5,
  status: "upcoming",
};

describe("mapTribunalSaleRows", () => {
  it("rend des ventes au tribunal, avec les nombres lus même quand PostgREST les envoie en chaîne", () => {
    expect(mapTribunalSaleRows([ROW])).toEqual([
      {
        id: ROW.id,
        city: "Bobigny",
        propertyType: "apartment",
        saleDate: "2026-11-10T13:00:00Z",
        startingPriceEur: 40_500,
        surfaceM2: 52.5,
        venueType: "tribunal",
        status: "scheduled",
      },
    ]);
  });

  it("marque les ventes reportées et celles au statut inconnu, sans les présenter comme à venir", () => {
    const sales = mapTribunalSaleRows([
      { ...ROW, status: "postponed" },
      { ...ROW, status: "unknown" },
      { ...ROW, status: null },
      { ...ROW, status: "" },
      { ...ROW, status: "upcoming" },
    ]);
    expect(sales.map((sale) => sale.status)).toEqual([
      "postponed",
      "unknown",
      "unknown",
      "unknown",
      "scheduled",
    ]);
  });

  it("laisse vide ce que la base ne renseigne pas, sans inventer de zéro", () => {
    const [sale] = mapTribunalSaleRows([
      { ...ROW, starting_price_eur: null, surface_m2: "", sale_date: null, city: null },
    ]);
    expect(sale).toMatchObject({
      startingPriceEur: null,
      surfaceM2: null,
      saleDate: null,
      city: null,
    });
  });

  it("ne laisse sortir aucun champ privé", () => {
    const [sale] = mapTribunalSaleRows([
      { ...ROW, address: "1 rue Privée", latitude: 48.9, longitude: 2.4 } as typeof ROW,
    ]);
    expect(Object.keys(sale).sort()).toEqual([
      "city",
      "id",
      "propertyType",
      "saleDate",
      "startingPriceEur",
      "status",
      "surfaceM2",
      "venueType",
    ]);
  });
});

describe("tryLoadTribunalSales", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.client.mockReset();
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lit les ventes du tribunal par son code, avec la limite de la page", async () => {
    mocks.rpc.mockResolvedValue({ data: [ROW], error: null });

    const result = await tryLoadTribunalSales("justice_tj_1_113");

    expect(mocks.rpc).toHaveBeenCalledWith("get_public_tribunal_sales", {
      p_tribunal_code: "justice_tj_1_113",
      p_limit: TRIBUNAL_PAGE_LISTED_SALES,
    });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" ? result.sales : []).toHaveLength(1);
  });

  it("distingue un tribunal sans vente d'une lecture en échec", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await tryLoadTribunalSales("vide")).toEqual({ status: "ok", sales: [] });

    mocks.rpc.mockResolvedValue({ data: null, error: new Error("function does not exist") });
    expect(await tryLoadTribunalSales("vide")).toEqual({ status: "error" });
  });

  it("ne lève pas quand Supabase n'est pas configuré", async () => {
    mocks.client.mockReturnValue(null);
    expect(await tryLoadTribunalSales("x")).toEqual({ status: "error" });
  });

  it("se rafraîchit toutes les heures, comme l'activité des tribunaux", async () => {
    const { PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS } =
      await import("./public-tribunal-activity.server");
    expect(TRIBUNAL_SALES_REVALIDATE_SECONDS).toBe(3_600);
    expect(TRIBUNAL_SALES_REVALIDATE_SECONDS).toBe(PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS);
  });
});
