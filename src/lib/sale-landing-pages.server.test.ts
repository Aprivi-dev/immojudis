import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));

vi.mock("next/cache", () => ({
  // Pas de cache de données hors de Next.js : chaque appel atteint la base simulée.
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.client,
}));

import {
  loadIndexableSaleLandingPaths,
  loadSaleLandingForPage,
  readSaleLanding,
  tryLoadSaleLanding,
} from "./sale-landing-pages.server";
import type { PreviewRpcClient } from "@/lib/search/preview-search";

function row(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    starting_price_eur: 50_000 + index,
    total_count: 0,
    sale_venue_type: "tribunal",
    sale_verification_status: null,
    city: "Bordeaux",
    department: "33",
    property_type: "house",
    sale_date: "2026-11-20T13:00:00Z",
    app_surface_m2: 90,
    app_surface_kind: null,
    rooms_count: null,
    bedrooms_count: null,
    bathrooms_count: null,
    latitude: null,
    longitude: null,
    thumbnail_url: null,
    completeness_tier: 0,
    ...overrides,
  };
}

const isPostponedCall = (args: Record<string, unknown>) =>
  Array.isArray(args.p_statuses) &&
  args.p_statuses.length === 1 &&
  args.p_statuses[0] === "postponed";

/**
 * Une base simulée : `count` ventes à venir pour chaque filtre (par type de bien ou de vente), dont
 * celles de `postponed` sont reportées. Comme la fonction publique, `total_count` est porté par
 * chaque ligne et `p_limit` borne la page.
 */
function serve(
  counts: Partial<Record<string, number>>,
  postponed: readonly number[] = [],
  overrides: (index: number) => Record<string, unknown> = () => ({}),
) {
  mocks.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    const filter =
      (args.p_property_types as string[] | null)?.[0] ?? (args.p_sale_venue_type as string);
    const total = counts[filter] ?? 0;
    const matching = Array.from({ length: total }, (_, index) => index).filter(
      (index) => !isPostponedCall(args) || postponed.includes(index),
    );
    const rows = matching
      .slice(0, args.p_limit as number)
      .map((index) => row(index, { total_count: matching.length, ...overrides(index) }));
    return { data: rows, error: null };
  });
}

const client = (): PreviewRpcClient => ({ rpc: mocks.rpc });

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.client.mockReset();
  mocks.client.mockReturnValue({ rpc: mocks.rpc });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("readSaleLanding", () => {
  it("lit les prochaines ventes du filtre de la page, par date, avec le total de la recherche", async () => {
    serve({ house: 45 });
    const data = await readSaleLanding(client(), { homeTypes: ["house"] }, new Date("2026-11-14"));
    expect(data.upcomingCount).toBe(45);
    expect(data.sales).toHaveLength(30);
    expect(data.generatedAt).toBe("2026-11-14T00:00:00.000Z");
    // La fonction publique de `/sales`, avec le filtre de la page, triée par date, 30 lignes.
    const [name, args] = mocks.rpc.mock.calls.find(([, call]) => !isPostponedCall(call))!;
    expect(name).toBe("search_auction_sales_preview_v3");
    expect(args).toMatchObject({
      p_property_types: ["house"],
      p_sale_venue_type: null,
      p_sort: "date_asc",
      p_limit: 30,
      p_offset: 0,
      // Les statuts ouverts de la recherche publique (reportées comprises).
      p_statuses: ["upcoming", "unknown", "postponed"],
    });
  });

  it("filtre par type de vente pour les notaires et l'État", async () => {
    serve({ notary: 4, state: 5 });
    expect((await readSaleLanding(client(), { saleType: "notary" })).upcomingCount).toBe(4);
    expect((await readSaleLanding(client(), { saleType: "state" })).upcomingCount).toBe(5);
    const venueTypes = mocks.rpc.mock.calls.map(([, args]) => args.p_sale_venue_type);
    expect(new Set(venueTypes)).toEqual(new Set(["notary", "state"]));
  });

  it("marque les ventes reportées par un second appel, même filtre et même ordre", async () => {
    serve({ apartment: 5 }, [1, 3]);
    const data = await readSaleLanding(client(), { homeTypes: ["apartment"] });
    expect(data.sales.map((sale) => sale.status)).toEqual([
      "scheduled",
      "postponed",
      "scheduled",
      "postponed",
      "scheduled",
    ]);
    const postponedCall = mocks.rpc.mock.calls.find(([, args]) => isPostponedCall(args))!;
    expect(postponedCall[1]).toMatchObject({
      p_property_types: ["apartment"],
      p_sort: "date_asc",
      p_limit: 30,
    });
  });

  it("garde ce que la ligne affiche, département compris, et une seule écriture par arrondissement", async () => {
    serve({ apartment: 2 }, [], (index) =>
      index === 0
        ? { city: "Paris 13ème", department: "75", sale_venue_type: "notary" }
        : { city: null, department: "974", starting_price_eur: null },
    );
    const data = await readSaleLanding(client(), { homeTypes: ["apartment"] });
    expect(data.sales[0]).toMatchObject({
      city: "Paris 13e",
      department: "75",
      venueType: "notary",
      propertyType: "house",
      surfaceM2: 90,
    });
    expect(data.sales[1]).toMatchObject({ city: null, department: "974", startingPriceEur: null });
  });

  it("écarte l'annonce de démonstration de la liste", async () => {
    mocks.rpc.mockImplementation(async () => ({
      data: [row(0, { id: "example-immojudis-1", total_count: 2 }), row(1, { total_count: 2 })],
      error: null,
    }));
    const data = await readSaleLanding(client(), { homeTypes: ["house"] });
    expect(data.sales.map((sale) => sale.id)).toEqual([row(1).id]);
  });

  it("lève une erreur de la base, y compris sur l'appel des ventes reportées", async () => {
    mocks.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) =>
      isPostponedCall(args)
        ? { data: null, error: { message: "timeout", code: "57014" } }
        : { data: [row(0, { total_count: 1 })], error: null },
    );
    await expect(readSaleLanding(client(), { homeTypes: ["house"] })).rejects.toMatchObject({
      code: "57014",
    });
  });
});

describe("lectures des pages et du sitemap", () => {
  it("rend `error` sans lever quand la base est illisible", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await tryLoadSaleLanding("house")).toEqual({ status: "error" });
    mocks.client.mockReturnValue(null);
    expect(await tryLoadSaleLanding("house")).toEqual({ status: "error" });
  });

  it("donne `null` à la page hors production (build), et lève en production", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await loadSaleLandingForPage("notary")).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    await expect(loadSaleLandingForPage("notary")).rejects.toThrow("indisponibles");
    // Pendant `next build`, la page est produite sans sa liste.
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(await loadSaleLandingForPage("notary")).toBeNull();
  });

  it("liste au sitemap les seules pages qui ont au moins 3 ventes à venir", async () => {
    serve({ house: 40, apartment: 3, notary: 2, state: 0 });
    expect(await loadIndexableSaleLandingPaths()).toEqual([
      "/maison-aux-encheres",
      "/appartement-aux-encheres",
    ]);
  });

  it("n'ajoute pas une page dont la lecture échoue, sans priver les autres", async () => {
    serve({ house: 40, apartment: 3, notary: 10, state: 10 });
    const healthy = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
      args.p_sale_venue_type === "state"
        ? { data: null, error: { message: "down" } }
        : healthy(name, args),
    );
    expect(await loadIndexableSaleLandingPaths()).toEqual([
      "/maison-aux-encheres",
      "/appartement-aux-encheres",
      "/encheres-notariales",
    ]);
  });
});
