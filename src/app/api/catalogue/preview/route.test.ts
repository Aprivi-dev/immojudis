import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  enforceIp: vi.fn(),
}));

vi.mock("next/cache", () => ({
  // Le cache de données de Next est remplacé par un passe-plat dans les tests unitaires.
  unstable_cache: (load: (...args: unknown[]) => unknown) => load,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));

import { previewSearchApiUrl } from "@/lib/search/preview-search-request";
import { GET } from "./route";

const PHOTO = "https://www.licitor.com/photos/maison.jpg";
const PHOTO_B = "https://www.vench.fr/vignettes/v1.jpg";
const mirrorRow = {
  source_url: PHOTO,
  path_640: "s/abc-640.webp",
  path_1600: "s/abc-1600.webp",
  width: 1600,
  height: 1200,
};

/** Champs réservés que la fonction SQL ne renvoie pas mais qu'une fuite pourrait ajouter. */
const searchRows = [
  {
    id: "a",
    total_count: 2276,
    city: "Bordeaux",
    department: "33",
    starting_price_eur: 90000,
    thumbnail_url: PHOTO,
    completeness_tier: 3,
    lawyer_contact: "ne doit pas fuiter",
    investment_score: 82,
  },
  { id: "b", total_count: 2276, city: "Pau", thumbnail_url: PHOTO_B },
];

function request(path: string) {
  return new Request(`https://example.test${path}`);
}

function rpcCalls(name: string) {
  return mocks.rpc.mock.calls.filter(([fn]) => fn === name);
}

describe("GET /api/catalogue/preview", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.enforceIp.mockReset().mockResolvedValue(undefined);
    mocks.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === "sale_photo_mirrors"
          ? { data: [mirrorRow], error: null }
          : { data: searchRows, error: null },
      ),
    );
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renvoie la liste, le total et les copies de photos en une seule réponse", async () => {
    const response = await GET(request("/api/catalogue/preview"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(2276);
    expect(body.items.map((sale: { id: string }) => sale.id)).toEqual(["a", "b"]);
    expect(body.items[0]).toMatchObject({
      city: "Bordeaux",
      media: [{ type: "image", url: PHOTO }],
    });
    expect(body.mirrors).toEqual([
      [
        PHOTO,
        { path640: "s/abc-640.webp", path1600: "s/abc-1600.webp", width: 1600, height: 1200 },
      ],
    ]);
    // Une seule recherche et une seule lecture des copies, pour toute la page.
    expect(rpcCalls("search_auction_sales_preview_v3")).toHaveLength(1);
    expect(rpcCalls("sale_photo_mirrors")).toHaveLength(1);
    expect(rpcCalls("sale_photo_mirrors")[0]![1]).toEqual({ p_source_urls: [PHOTO, PHOTO_B] });
  });

  it("n'expose aucun champ réservé de la ligne SQL", async () => {
    const body = await (await GET(request("/api/catalogue/preview"))).json();
    const serialized = JSON.stringify(body);

    for (const secret of [
      "lawyer_contact",
      "ne doit pas fuiter",
      "investment_score",
      "thumbnail_url",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("appelle la fonction publique avec les arguments de la page (mêmes filtres, même tri)", async () => {
    await GET(
      request(
        "/api/catalogue/preview?department=33&minPrice=50000&maxPrice=200000&sort=price_asc&page=2&limit=12&homeTypes=house,apartment",
      ),
    );

    expect(rpcCalls("search_auction_sales_preview_v3")[0]![1]).toMatchObject({
      p_departments: expect.arrayContaining(["33"]),
      p_min_price: 50000,
      p_max_price: 200000,
      p_property_types: ["house", "apartment"],
      p_sort: "price_asc",
      p_limit: 12,
      p_offset: 12,
      // Les critères réservés ne sont jamais transmis à la fonction publique.
      p_occupancy_status: null,
      p_min_score: null,
      p_north: null,
    });
  });

  it("n'affiche pas les ventes d'exemple de l'accueil et envoie les départements d'une région", async () => {
    mocks.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === "sale_photo_mirrors"
          ? { data: [], error: null }
          : {
              data: [
                { id: "example-immojudis-bordeaux-t2", total_count: 2 },
                { id: "49deebe5-bbba-4c8a-9f4e-237a2edbae94", total_count: 2 },
              ],
              error: null,
            },
      ),
    );

    const body = await (
      await GET(request("/api/catalogue/preview?query=Nouvelle-Aquitaine"))
    ).json();

    expect(body.items.map((sale: { id: string }) => sale.id)).toEqual([
      "49deebe5-bbba-4c8a-9f4e-237a2edbae94",
    ]);
    expect(rpcCalls("search_auction_sales_preview_v3")[0]![1]).toMatchObject({
      p_departments: expect.arrayContaining(["33", "Gironde", "64", "Pyrénées-Atlantiques"]),
      p_keywords: null,
    });
  });

  it("utilise la fonction à plage de dates quand une date est demandée", async () => {
    await GET(request("/api/catalogue/preview?minSaleDate=2026-11-01&maxSaleDate=2026-11-30"));

    expect(rpcCalls("search_auction_sales_preview_v4")[0]![1]).toMatchObject({
      p_min_sale_date: "2026-11-01",
      p_max_sale_date: "2026-11-30",
    });
    expect(rpcCalls("search_auction_sales_preview_v3")).toHaveLength(0);
  });

  it("ne renvoie aucune copie quand l'interrupteur est éteint, sans appeler la fonction des copies", async () => {
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "off");

    const body = await (await GET(request("/api/catalogue/preview"))).json();

    expect(body.mirrors).toEqual([]);
    expect(body.items).toHaveLength(2);
    expect(rpcCalls("sale_photo_mirrors")).toHaveLength(0);
  });

  it("se met en cache publiquement, aussi longtemps que la première page du catalogue", async () => {
    const response = await GET(request("/api/catalogue/preview"));

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=60",
    );
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("limite les appels par adresse IP, comme les autres routes publiques", async () => {
    await GET(request("/api/catalogue/preview"));

    expect(mocks.enforceIp).toHaveBeenCalledWith(
      expect.objectContaining({ bucketKey: "catalogue.preview", limit: 60, windowSeconds: 60 }),
    );
  });

  it("répond 429 avec Retry-After, sans cache et sans lire la base, au-delà du quota", async () => {
    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 9));

    const response = await GET(request("/api/catalogue/preview"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  describe("paramètres invalides", () => {
    it.each([
      ["une page nulle", "page=0"],
      ["une page illisible", "page=abc"],
      ["une page au-delà de la limite de la fonction (10 000 lignes)", "page=500&limit=24"],
      ["une taille de page supérieure à 100", "limit=101"],
      ["une taille de page négative", "limit=-5"],
      ["un prix illisible", "minPrice=beaucoup"],
      ["un prix négatif", "maxPrice=-1"],
      ["un tri inconnu", "sort=drop_table"],
      ["un type de vente inconnu", "saleType=casino"],
      ["une date impossible", "minSaleDate=2026-02-31"],
      ["une période inversée", "minSaleDate=2026-12-01&maxSaleDate=2026-11-01"],
      ["une ville trop longue", `city=${"v".repeat(121)}`],
      ["un tribunal trop long", `tribunal=${"t".repeat(161)}`],
      ["plus de 8 types de bien", "homeTypes=a,b,c,d,e,f,g,h,i"],
      ["un type de bien trop long", `homeTypes=${"x".repeat(81)}`],
    ])("refuse %s avec un 400 sans lire la base ni consommer le quota", async (_label, query) => {
      const response = await GET(request(`/api/catalogue/preview?${query}`));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.enforceIp).not.toHaveBeenCalled();
    });

    it("ignore les critères réservés ou inconnus sans les transmettre", async () => {
      const response = await GET(
        request(
          "/api/catalogue/preview?occupancy=libre&minScore=80&bbox=-1,43,1,45&viewport=45:44:2:1&evil=1",
        ),
      );

      expect(response.status).toBe(200);
      expect(rpcCalls("search_auction_sales_preview_v3")[0]![1]).toMatchObject({
        p_occupancy_status: null,
        p_min_score: null,
        p_north: null,
        p_south: null,
        p_east: null,
        p_west: null,
      });
    });
  });

  it("accepte les adresses construites par le navigateur", async () => {
    const response = await GET(
      new Request(
        `https://example.test${previewSearchApiUrl({
          city: "Bordeaux",
          homeTypes: ["house"],
          sort: "price_desc",
          page: 3,
          minSaleDate: "2026-11-01",
        })}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(rpcCalls("search_auction_sales_preview_v4")[0]![1]).toMatchObject({
      p_city: "Bordeaux",
      p_property_types: ["house"],
      p_sort: "price_desc",
      p_offset: 48,
    });
  });

  it("répond 503 sans cache ni détail technique quand la base est indisponible", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "connection to db refused" } });

    const response = await GET(request("/api/catalogue/preview"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain("refused");
    expect(body).toMatchObject({ ok: false, error: "Catalogue indisponible." });
  });

  it("garde la liste quand seules les copies de photos échouent", async () => {
    mocks.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === "sale_photo_mirrors"
          ? { data: null, error: { message: "boom" } }
          : { data: searchRows, error: null },
      ),
    );

    const response = await GET(request("/api/catalogue/preview"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.mirrors).toEqual([]);
  });
});
