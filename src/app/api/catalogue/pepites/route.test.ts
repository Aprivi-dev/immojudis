import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), enforceIp: vi.fn() }));

vi.mock("next/cache", () => ({
  // Le cache de données de Next est remplacé par un passe-plat dans les tests unitaires.
  unstable_cache: (load: (...args: unknown[]) => unknown) => load,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));

import { GET } from "./route";

const call = () => GET(new Request("https://example.test/api/catalogue/pepites"));

describe("GET /api/catalogue/pepites", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.enforceIp.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("rend les identifiants des pépites, en minuscules, gardés par le CDN, sans autre champ", async () => {
    mocks.rpc.mockResolvedValue({
      data: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 42],
      error: null,
    });
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });
    expect(response.headers.get("cache-control")).toMatch(/^public, s-maxage=60,/);
    // Une seule lecture de la base par réponse : jamais un appel par carte.
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("list_public_pepite_sale_ids");
  });

  it("rend une liste vide en mode shadow (la base ne rend rien)", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await (await call()).json()).toEqual({ ids: [] });
  });

  it.each(["PGRST202", "42883"])(
    "fonction absente (%s, migration pas appliquée) : aucune pépite, sans erreur",
    async (code) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "absente" } });
      const response = await call();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ids: [] });
    },
  );

  it("une panne de la base répond 503, jamais gardée : le navigateur ne la prend pas pour « aucune pépite »", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).ids).toBeUndefined();
  });

  it("répond 429 au-delà du quota par adresse", async () => {
    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 30));
    const response = await call();
    expect(response.status).toBe(429);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
