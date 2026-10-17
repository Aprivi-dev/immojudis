import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `supabase-js` (63 Ko transférés) ne doit pas entrer dans le premier chargement de `/sales` d'un
 * visiteur anonyme : les requêtes du catalogue chargent le client à l'appel, pas à l'import.
 */
const mocks = vi.hoisted(() => ({
  clientEvaluated: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
  mocks.clientEvaluated();
  return { isSupabaseConfigured: true, supabase: { from: mocks.from } };
});

describe("requêtes du catalogue : client Supabase chargé à la demande", () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.clientEvaluated.mockClear();
    mocks.from.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "ci-publishable-key");
    const { resetSupabaseLazyForTests } = await import("@/integrations/supabase/lazy");
    resetSupabaseLazyForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("importer les requêtes et le service de recherche n'évalue pas le client Supabase", async () => {
    await import("./queries");
    await import("./search/search-service");
    await import("@/components/search/SearchResults");

    expect(mocks.clientEvaluated).not.toHaveBeenCalled();
  });

  it("une requête sans client fourni charge le client, une seule fois", async () => {
    const select = vi.fn(() => ({ eq: vi.fn(), not: vi.fn() }));
    mocks.from.mockReturnValue({ select });
    const { getSalesCount } = await import("./queries");

    // Le constructeur de requête simulé n'est pas thenable : on ne regarde que le chargement.
    await getSalesCount({}).catch(() => undefined);
    await getSalesCount({}).catch(() => undefined);

    expect(mocks.clientEvaluated).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it("une lecture avec un client fourni (rendu serveur, export) ne charge pas le client navigateur", async () => {
    const builder = {
      select: () => builder,
      order: () => builder,
      range: () => builder,
      in: () => builder,
      eq: () => builder,
      then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
    };
    const { getSales } = await import("./queries");

    await getSales({}, 12, "price_asc", 0, { client: { from: () => builder } as never });

    expect(mocks.clientEvaluated).not.toHaveBeenCalled();
  });
});
