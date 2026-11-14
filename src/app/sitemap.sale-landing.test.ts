import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Du sitemap jusqu'à la fonction publique de recherche : seul le client de la base est simulé, pour
// vérifier que le sitemap suit le seuil de la balise robots des pages par type de bien ou de vente.
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), counts: {} as Record<string, number> }));

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/lib/department-pages.server", async () => ({
  ...(await vi.importActual<typeof import("@/lib/department-pages.server")>(
    "@/lib/department-pages.server",
  )),
  tryLoadDepartmentCatalogue: async () => ({ status: "error" }),
}));
vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: async () => ({ status: "ok", items: [{ code: "pau" }] }),
}));
vi.mock("@/lib/sitemap-tribunal-hearing-pages.server", () => ({
  loadTribunalAndHearingPaths: async () => [],
}));

import sitemap from "./sitemap";

/** `counts` : ventes à venir par filtre (`house`, `apartment`, `notary`, `state`) ; absent = panne. */
function serve(counts: Record<string, number>) {
  mocks.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    const filter =
      (args.p_property_types as string[] | null)?.[0] ?? (args.p_sale_venue_type as string);
    if (!(filter in counts)) return { data: null, error: { message: "down" } };
    const total =
      Array.isArray(args.p_statuses) && args.p_statuses.length === 1 ? 0 : counts[filter];
    const rows = Array.from({ length: Math.min(total, args.p_limit as number) }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      total_count: total,
      sale_venue_type: "tribunal",
      department: "33",
      city: "Bordeaux",
      property_type: "house",
      sale_date: "2026-11-20T13:00:00Z",
      starting_price_eur: 80_000,
      thumbnail_url: null,
    }));
    return { data: rows, error: null };
  });
}

async function paths() {
  return (await sitemap()).map((entry) => new URL(entry.url).pathname);
}

describe("sitemap.xml et les pages par type de bien ou de vente", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", "https://immojudis.com");
    mocks.rpc.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("liste une page à partir de 3 ventes à venir, pas en dessous", async () => {
    serve({ house: 3, apartment: 2, notary: 120, state: 0 });
    const listed = await paths();
    expect(listed).toContain("/maison-aux-encheres");
    expect(listed).toContain("/encheres-notariales");
    expect(listed).not.toContain("/appartement-aux-encheres");
    expect(listed).not.toContain("/ventes-immobilieres-etat");
  });

  it("n'ajoute pas une page dont la lecture échoue, et garde le reste du sitemap", async () => {
    serve({ house: 10, apartment: 10, notary: 10 });
    const listed = await paths();
    expect(listed).not.toContain("/ventes-immobilieres-etat");
    expect(listed).toContain("/appartement-aux-encheres");
    expect(listed).toContain("/sales");
  });
});
