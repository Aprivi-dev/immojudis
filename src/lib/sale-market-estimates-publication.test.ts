import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

vi.mock("@/lib/market.functions", () => ({
  getMarketEstimate: vi.fn(),
}));

import { getStoredSaleMarketContext } from "@/lib/sale-market-estimates";

function hiddenSaleQuery() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({
    data: {
      id: "11111111-1111-4111-8111-111111111111",
      status: "quarantined",
      raw_payload: {},
    },
    error: null,
  });
  return query;
}

describe("sale market estimates publication guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not read or expose a cached estimate for a quarantined sale", async () => {
    const query = hiddenSaleQuery();
    mocks.from.mockReturnValue(query);

    await expect(
      getStoredSaleMarketContext("11111111-1111-4111-8111-111111111111"),
    ).rejects.toThrow("Vente introuvable ou inaccessible.");
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(query.maybeSingle).toHaveBeenCalledOnce();
  });
});
