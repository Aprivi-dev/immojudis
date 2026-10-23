import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), cacheOptions: vi.fn(), cacheKey: vi.fn() }));

vi.mock("next/cache", () => ({
  unstable_cache: (
    load: (...args: unknown[]) => unknown,
    keyParts: string[],
    options: { revalidate: number; tags: string[] },
  ) => {
    mocks.cacheKey(keyParts);
    mocks.cacheOptions(options);
    return load;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { getAuctionScenarios } from "./auction-scenarios.server";

const OK_SET = {
  status: "ok",
  band: 2,
  court_sample: 40,
  national_sample: 120,
  basis: "court",
  reliability: "good",
  price_scope: "court",
  scenarios: [
    { key: "near_start", low_ratio: 0, high_ratio: 1.1, probability: 0.2 },
    { key: "above_3", low_ratio: 3, high_ratio: null, probability: 0.8 },
  ],
  ratio_quartiles: { q25: 1.5, q50: 2.5, q75: 3.5 },
};

const sale = {
  tribunal_code: "justice_tj_1_210",
  tribunal: "TJ Bobigny",
  starting_price_eur: 45_000,
  property_type: "apartment",
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({
    data: {
      scenarios: OK_SET,
      history: { licitor: { sample: 442 }, dvf: null },
      data_as_of: "2026-10-22T14:03:00+00:00",
    },
    error: null,
  });
});

describe("getAuctionScenarios", () => {
  it("passe au SQL le tribunal, une mise à prix de la tranche et le groupe de nature du bien", async () => {
    const response = await getAuctionScenarios(sale);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("get_court_auction_scenarios", {
      p_court_code: "justice_tj_1_210",
      // Le SQL ne lit que la tranche : le cache est donc par (tribunal, tranche, groupe).
      p_starting_price: 20_000,
      p_property_group: "housing",
    });
    expect(response.scenarios).toMatchObject({ status: "ok", reliability: "good" });
    expect(response.unavailable).toBeNull();
    expect(response.dataAsOf).toBe("2026-10-22T14:03:00+00:00");
    expect(response.history.licitor?.sample).toBe(442);
  });

  it("ne renvoie plus de surface (référence DVF masquée)", async () => {
    const response = await getAuctionScenarios({
      ...sale,
      habitable_surface_m2: 52,
      app_surface_m2: 50,
    } as typeof sale);
    expect(response).not.toHaveProperty("surfaceM2");
  });

  it("n'envoie pas de groupe pour un bien de nature inconnue ou mixte", async () => {
    await getAuctionScenarios({ ...sale, property_type: "building" });
    expect(mocks.rpc).toHaveBeenCalledWith("get_court_auction_scenarios", {
      p_court_code: "justice_tj_1_210",
      p_starting_price: 20_000,
    });
  });

  it("met le cache sous le contrôle d'une durée et d'une étiquette", () => {
    expect(mocks.cacheOptions).toHaveBeenCalledWith({
      revalidate: 3_600,
      tags: ["auction-scenarios"],
    });
  });

  it("ne lit rien sans code de tribunal, et le dit", async () => {
    const response = await getAuctionScenarios({ ...sale, tribunal_code: null });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(response).toMatchObject({ scenarios: null, unavailable: "no_court_code" });
  });

  it("dit pourquoi sans mise à prix, mais garde l'historique du tribunal", async () => {
    mocks.rpc.mockResolvedValue({
      data: { scenarios: null, history: { licitor: { sample: 442 }, dvf: null } },
      error: null,
    });
    const response = await getAuctionScenarios({ ...sale, starting_price_eur: null });
    expect(mocks.rpc).toHaveBeenCalledWith("get_court_auction_scenarios", {
      p_court_code: "justice_tj_1_210",
      p_starting_price: 0,
      p_property_group: "housing",
    });
    expect(response.unavailable).toBe("no_starting_price");
    expect(response.scenarios).toBeNull();
    expect(response.history.licitor?.sample).toBe(442);
  });

  it("n'établit aucun scénario sous 1 000 € de mise à prix", async () => {
    mocks.rpc.mockResolvedValue({
      data: { scenarios: OK_SET, history: {} },
      error: null,
    });
    const response = await getAuctionScenarios({ ...sale, starting_price_eur: 999 });
    expect(response.unavailable).toBe("starting_price_too_low");
    expect(response.scenarios).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "get_court_auction_scenarios",
      expect.objectContaining({ p_starting_price: 0 }),
    );
  });

  it("renvoie l'état « données insuffisantes » avec ses effectifs", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        scenarios: { status: "insufficient", band: 2, court_sample: 3, national_sample: 18 },
        history: {},
      },
      error: null,
    });
    const response = await getAuctionScenarios(sale);
    expect(response.unavailable).toBe("insufficient_data");
    expect(response.scenarios).toMatchObject({
      status: "insufficient",
      courtSample: 3,
      nationalSample: 18,
    });
  });

  it("laisse remonter une erreur de la base (rien n'est mis en cache)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("statement timeout") });
    await expect(getAuctionScenarios(sale)).rejects.toThrow("statement timeout");
  });
});
