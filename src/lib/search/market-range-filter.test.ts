import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/lazy", () => ({
  getSupabase: async () => ({ rpc: mocks.rpc }),
}));

import {
  UNDER_RANGE_FILTER_UNAVAILABLE_MESSAGE,
  fetchUnderRangeSaleIds,
  resetUnderRangeSaleIdsCache,
} from "./market-range-filter";

describe("fetchUnderRangeSaleIds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetUnderRangeSaleIdsCache();
    mocks.rpc.mockResolvedValue({ data: ["AAA", "bbb", null, 3], error: null });
  });

  it("lit la liste de la base, en minuscules, sans valeur étrangère", async () => {
    const ids = await fetchUnderRangeSaleIds(1_000);

    expect(mocks.rpc).toHaveBeenCalledWith("list_public_sale_ids_under_market_range");
    expect([...ids]).toEqual(["aaa", "bbb"]);
  });

  it("garde la liste 5 minutes, puis la relit", async () => {
    await fetchUnderRangeSaleIds(0);
    await fetchUnderRangeSaleIds(4 * 60_000);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    await fetchUnderRangeSaleIds(5 * 60_000 + 1);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("partage un seul appel entre deux demandes simultanées", async () => {
    await Promise.all([fetchUnderRangeSaleIds(0), fetchUnderRangeSaleIds(1)]);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("une base sans réponse valable donne une liste vide, pas une erreur", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    expect((await fetchUnderRangeSaleIds(0)).size).toBe(0);
  });

  it("lève un message lisible quand la fonction n'existe pas encore, sans le garder", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "absent" } });

    await expect(fetchUnderRangeSaleIds(0)).rejects.toThrow(UNDER_RANGE_FILTER_UNAVAILABLE_MESSAGE);
    expect(console.warn).not.toHaveBeenCalled();

    // Une panne n'est jamais gardée : l'appel suivant relit.
    expect([...(await fetchUnderRangeSaleIds(1))]).toEqual(["aaa", "bbb"]);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("lève le même message sur une autre erreur, sans montrer le message de la base", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom interne" } });

    await expect(fetchUnderRangeSaleIds(0)).rejects.toThrow(UNDER_RANGE_FILTER_UNAVAILABLE_MESSAGE);
    expect(console.warn).toHaveBeenCalled();
    expect(String(vi.mocked(console.warn).mock.calls[0])).not.toContain("boom interne");
  });
});
