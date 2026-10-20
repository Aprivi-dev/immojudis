import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));

vi.mock("next/cache", () => ({
  // Pas de cache de données hors Next.js : chaque appel atteint la base simulée.
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.client,
}));

import { mapPublicTribunalDirectory } from "./public-tribunal-directory";
import { tryLoadPublicTribunalDirectory } from "./public-tribunal-directory.server";

describe("mapPublicTribunalDirectory", () => {
  it("rend le code, le nom court, le nom enregistré, la ville et le département", () => {
    expect(
      mapPublicTribunalDirectory([
        {
          code: "justice_tj_1_93",
          canonical_name: "TJ Bobigny",
          city: "Bobigny",
          department: "93",
        },
      ]),
    ).toEqual([
      {
        code: "justice_tj_1_93",
        name: "Bobigny",
        searchName: "TJ Bobigny",
        city: "Bobigny",
        department: "93",
      },
    ]);
  });

  it("se rabat sur le code sans nom, et écarte une ligne sans code", () => {
    const entries = mapPublicTribunalDirectory([
      { code: "justice_tj_1_1", canonical_name: null, city: null, department: null },
      { code: "  ", canonical_name: "TJ Fantôme", city: null, department: null },
    ]);
    expect(entries.map((entry) => entry.code)).toEqual(["justice_tj_1_1"]);
    expect(entries[0].searchName).toBe("justice_tj_1_1");
    // Le code reste l'identité du tribunal, jamais son nom affiché.
    expect(entries[0].name).toBe("Tribunal à confirmer");
  });
});

describe("tryLoadPublicTribunalDirectory", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.client.mockReset();
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("lit la fonction publique du référentiel", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ code: "a", canonical_name: "TJ Foix", city: "Foix", department: "09" }],
      error: null,
    });
    const result = await tryLoadPublicTribunalDirectory();
    expect(mocks.rpc).toHaveBeenCalledWith("get_public_tribunal_directory");
    expect(result).toMatchObject({ status: "ok", items: [{ code: "a", name: "Foix" }] });
  });

  it("ne lève pas quand la fonction manque ou que la base est indisponible", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    await expect(tryLoadPublicTribunalDirectory()).resolves.toEqual({ status: "error" });
    mocks.client.mockReturnValue(null);
    await expect(tryLoadPublicTribunalDirectory()).resolves.toEqual({ status: "error" });
  });
});
