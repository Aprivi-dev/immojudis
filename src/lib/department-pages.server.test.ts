import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));

vi.mock("next/cache", () => ({
  // No data cache outside Next.js: every call reaches the mocked database.
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.client,
}));

function row(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    starting_price_eur: 50_000 + index,
    total_count: 0,
    sale_venue_type: "tribunal",
    sale_verification_status: null,
    city: "Bordeaux",
    department: "33",
    property_type: "apartment",
    sale_date: "2026-11-10T13:00:00Z",
    app_surface_m2: 40,
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

/** L'appel qui ne demande que les ventes reportées (le catalogue complet demande les trois statuts). */
const isPostponedCall = (args: Record<string, unknown>) => {
  const statuses = args.p_statuses;
  return Array.isArray(statuses) && statuses.length === 1 && statuses[0] === "postponed";
};

/** Une base de `total` ventes servie par pages, comme la fonction publique de recherche. */
function serve(
  total: number,
  overrides: (index: number) => Record<string, unknown> = () => ({}),
  postponed: (index: number) => boolean = () => false,
) {
  mocks.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    // Comme la fonction publique : `p_statuses` filtre sur le statut, que la ligne ne renvoie pas.
    const onlyPostponed = isPostponedCall(args);
    const matching = Array.from({ length: total }, (_, index) => index).filter(
      (index) => !onlyPostponed || postponed(index),
    );
    const offset = args.p_offset as number;
    const limit = args.p_limit as number;
    const rows = matching
      .slice(offset, offset + limit)
      .map((index) => row(index, { total_count: matching.length, ...overrides(index) }));
    return { data: rows, error: null };
  });
}

/** Les appels de lecture du catalogue complet (les ventes reportées se lisent à part). */
const catalogueCalls = () =>
  mocks.rpc.mock.calls.filter(([, args]) => !isPostponedCall(args as Record<string, unknown>));

describe("readAllPublicSales", () => {
  it("lit chaque page une fois, dans l'ordre, jusqu'au total annoncé", async () => {
    const { readAllPublicSales } = await import("./department-pages.server");
    const pages: number[] = [];
    const rows = await readAllPublicSales(async (page) => {
      pages.push(page);
      const items = Array.from({ length: page < 4 ? 100 : 30 }, (_, index) => ({
        id: `${page}-${index}`,
        department: "33",
        city: null,
        propertyType: null,
        saleDate: null,
        startingPriceEur: null,
        surfaceM2: null,
        venueType: null,
        status: "scheduled" as const,
      }));
      return { items, count: 330 };
    });
    expect(pages.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(rows).toHaveLength(330);
  });

  it("ne lit qu'une page pour un petit catalogue, et aucune de plus s'il est vide", async () => {
    const { readAllPublicSales } = await import("./department-pages.server");
    const read = vi.fn(async () => ({ items: [], count: 0 }));
    expect(await readAllPublicSales(read)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("ne dépasse pas la limite de décalage de la fonction publique", async () => {
    const { readAllPublicSales } = await import("./department-pages.server");
    const pages: number[] = [];
    await readAllPublicSales(async (page) => {
      pages.push(page);
      return { items: [], count: 5_000_000 };
    });
    // Décalage maximal accepté : 10 000 lignes, soit la page 101 ; on s'arrête avant.
    expect(Math.max(...pages)).toBe(100);
    expect(pages).toHaveLength(100);
  });

  it("journalise en JSON le catalogue tronqué quand le total annoncé dépasse ce qui a été lu", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { readAllPublicSales } = await import("./department-pages.server");
    await readAllPublicSales(async () => ({ items: [], count: 10_250, fetched: 100 }));
    expect(warn).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warn.mock.calls[0][0]));
    expect(entry).toEqual({
      scope: "department-pages",
      event: "catalogue_truncated",
      source: "catalogue",
      announcedCount: 10_250,
      readCount: 100 * 100,
      pagesRead: 100,
      maxPages: 100,
      pageSize: 100,
    });
    warn.mockRestore();
  });

  it("ne journalise rien quand tout le total annoncé a été lu", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { readAllPublicSales } = await import("./department-pages.server");
    await readAllPublicSales(async (page) => ({
      items: [],
      count: 230,
      fetched: page < 3 ? 100 : 30,
    }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("propage l'échec d'une page : pas de catalogue partiel", async () => {
    const { readAllPublicSales } = await import("./department-pages.server");
    await expect(
      readAllPublicSales(async (page) => {
        if (page === 2) throw new Error("timeout");
        return { items: [], count: 250 };
      }),
    ).rejects.toThrow("timeout");
  });
});

describe("loadDepartmentCatalogue", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.rpc.mockReset();
    mocks.client.mockReset();
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lit la liste publique triée par date d'audience, avec la même fonction que /sales", async () => {
    serve(230);
    const { loadDepartmentCatalogue } = await import("./department-pages.server");
    const catalogue = await loadDepartmentCatalogue();

    expect(catalogue.departments["33"].upcomingCount).toBe(230);
    expect(catalogueCalls()).toHaveLength(3);
    for (const [name, args] of mocks.rpc.mock.calls) {
      expect(name).toBe("search_auction_sales_preview_v3");
      expect(args).toMatchObject({ p_limit: 100, p_sort: "date_asc", p_departments: null });
    }
    expect(
      catalogueCalls()
        .map(([, args]) => args.p_offset)
        .sort((a, b) => a - b),
    ).toEqual([0, 100, 200]);
  });

  it("répartit les ventes par département et écarte l'annonce de démonstration", async () => {
    serve(6, (index) => ({
      department: index < 4 ? "33" : "75",
      ...(index === 0 ? { id: "example-immojudis-demo" } : {}),
    }));
    const { loadDepartmentCatalogue } = await import("./department-pages.server");
    const catalogue = await loadDepartmentCatalogue();
    expect(catalogue.departments["33"].upcomingCount).toBe(3);
    expect(catalogue.departments["75"].upcomingCount).toBe(2);
  });

  it("garde le type de vente et repère les ventes reportées avec un appel filtré", async () => {
    serve(
      4,
      (index) => ({ sale_venue_type: index === 1 ? "notary" : "tribunal" }),
      (index) => index === 2,
    );
    const { loadDepartmentCatalogue } = await import("./department-pages.server");
    const stats = (await loadDepartmentCatalogue()).departments["33"];
    expect(stats.sales.map((sale) => [sale.venueType, sale.status])).toEqual([
      ["tribunal", "scheduled"],
      ["notary", "scheduled"],
      ["tribunal", "postponed"],
      ["tribunal", "scheduled"],
    ]);
    const postponedCalls = mocks.rpc.mock.calls.filter(([, args]) => isPostponedCall(args));
    expect(postponedCalls).toHaveLength(1);
    // Le comptage du catalogue reste celui de la liste publique : le second appel ne filtre rien.
    expect(stats.upcomingCount).toBe(4);
  });

  it("n'annonce pas une vente reportée comme prochaine audience", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T08:00:00Z"));
    try {
      serve(
        2,
        (index) => ({ sale_date: index === 0 ? "2026-10-20T10:00:00Z" : "2026-12-01T10:00:00Z" }),
        (index) => index === 0,
      );
      const { loadDepartmentCatalogue } = await import("./department-pages.server");
      const stats = (await loadDepartmentCatalogue()).departments["33"];
      expect(stats.nextSaleDate).toBe("2026-12-01T10:00:00Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lève une erreur quand la base répond par une erreur", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("database down") });
    const { loadDepartmentCatalogue, tryLoadDepartmentCatalogue } =
      await import("./department-pages.server");
    await expect(loadDepartmentCatalogue()).rejects.toThrow("database down");
    expect(await tryLoadDepartmentCatalogue()).toEqual({ status: "error" });
  });

  it("signale une base non configurée comme une erreur, pas comme un catalogue vide", async () => {
    mocks.client.mockReturnValue(null);
    const { tryLoadDepartmentCatalogue } = await import("./department-pages.server");
    expect(await tryLoadDepartmentCatalogue()).toEqual({ status: "error" });
  });

  it("distingue un catalogue vide d'une panne", async () => {
    serve(0);
    const { tryLoadDepartmentCatalogue } = await import("./department-pages.server");
    const result = await tryLoadDepartmentCatalogue();
    expect(result.status).toBe("ok");
    expect(result.status === "ok" ? result.catalogue.departments : null).toEqual({});
  });
});

describe("lecture en vol partagée", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.rpc.mockReset();
    mocks.client.mockReset();
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ne lance qu'une lecture quand metadata, page et sitemap arrivent en même temps", async () => {
    serve(230);
    const { loadDepartmentCatalogue, tryLoadDepartmentCatalogue } =
      await import("./department-pages.server");
    const [a, b, c] = await Promise.all([
      loadDepartmentCatalogue(),
      loadDepartmentCatalogue(),
      tryLoadDepartmentCatalogue(),
    ]);
    expect(b).toBe(a);
    expect(c).toEqual({ status: "ok", catalogue: a });
    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(catalogueCalls()).toHaveLength(3);
  });

  it("libère la lecture après un succès : la suivante relit (le cache de données prend le relais)", async () => {
    serve(10);
    const { loadDepartmentCatalogue } = await import("./department-pages.server");
    await loadDepartmentCatalogue();
    await loadDepartmentCatalogue();
    expect(mocks.client).toHaveBeenCalledTimes(2);
  });

  it("libère la lecture après un échec : tous les appels simultanés échouent, le suivant réessaie", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("database down") });
    const { loadDepartmentCatalogue } = await import("./department-pages.server");
    const results = await Promise.allSettled([
      loadDepartmentCatalogue(),
      loadDepartmentCatalogue(),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(mocks.client).toHaveBeenCalledTimes(1);

    serve(5);
    const catalogue = await loadDepartmentCatalogue();
    expect(catalogue.departments["33"].upcomingCount).toBe(5);
    expect(mocks.client).toHaveBeenCalledTimes(2);
  });
});

describe("revalidation", () => {
  it("garde la durée d'une heure alignée sur les pages (littéral exigé par Next.js)", async () => {
    const { DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS } = await import("./department-pages.server");
    expect(DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS).toBe(3_600);
  });
});
