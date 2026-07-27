import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({ update: mocks.update })),
  },
}));
vi.mock("@/lib/market.functions", () => ({ getMarketEstimate: vi.fn() }));

import { publishStoredEstimateForClaim } from "./sale-market-estimates";

describe("sale estimate compare-and-swap publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const chain = {
      eq: mocks.eq,
      select: mocks.select,
      maybeSingle: mocks.maybeSingle,
    };
    mocks.update.mockReturnValue(chain);
    mocks.eq.mockReturnValue(chain);
    mocks.select.mockReturnValue(chain);
  });

  it("publishes only while the claimed fingerprint is still processing", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { auction_sale_id: "sale-1" },
      error: null,
    });

    await expect(
      publishStoredEstimateForClaim("sale-1", "fingerprint-v1", { status: "ready" }),
    ).resolves.toBe(true);

    expect(mocks.eq).toHaveBeenNthCalledWith(1, "auction_sale_id", "sale-1");
    expect(mocks.eq).toHaveBeenNthCalledWith(2, "input_fingerprint", "fingerprint-v1");
    expect(mocks.eq).toHaveBeenNthCalledWith(3, "status", "processing");
  });

  it("does not overwrite a newer worker claim", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(
      publishStoredEstimateForClaim("sale-1", "stale-fingerprint", { status: "failed" }),
    ).resolves.toBe(false);
  });
});
