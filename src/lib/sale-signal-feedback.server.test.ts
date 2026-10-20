import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { recordSaleSignalFeedback } from "./sale-signal-feedback.server";

const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const saleId = "A1B2C3D4-0000-4000-8000-000000000001";

describe("recordSaleSignalFeedback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValue({ data: true, error: null });
  });

  it("sends the account, the sale and the closed values, and nothing else", async () => {
    await expect(
      recordSaleSignalFeedback(userId, saleId, { signal: "market_gap_band", value: "useful" }),
    ).resolves.toBe(true);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("record_sale_signal_feedback", {
      p_user_id: userId,
      p_sale_id: "a1b2c3d4-0000-4000-8000-000000000001",
      p_signal: "market_gap_band",
      p_value: "useful",
    });
  });

  it("sends the reason when there is one", async () => {
    await recordSaleSignalFeedback(userId, saleId, {
      signal: "points_to_verify",
      value: "not_relevant",
      reason: "point_missing",
    });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_sale_signal_feedback",
      expect.objectContaining({ p_reason: "point_missing" }),
    );
  });

  it("records nothing without an account or with an invalid identifier", async () => {
    const input = { signal: "market_gap_band", value: "useful" } as const;

    await expect(recordSaleSignalFeedback(null, saleId, input)).resolves.toBe(false);
    await expect(recordSaleSignalFeedback("not-a-uuid", saleId, input)).resolves.toBe(false);
    await expect(recordSaleSignalFeedback(userId, "not-a-uuid", input)).resolves.toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns false when the database refuses the feedback", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    await expect(
      recordSaleSignalFeedback(userId, saleId, { signal: "market_gap_band", value: "useful" }),
    ).resolves.toBe(false);
  });

  it("throws on a failure, logging the signal but no identifier", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "XX000" } });

    await expect(
      recordSaleSignalFeedback(userId, saleId, { signal: "market_gap_band", value: "useful" }),
    ).rejects.toMatchObject({ code: "XX000" });
    const logged = String(vi.mocked(console.warn).mock.calls[0]?.[0]);
    expect(logged).toContain("market_gap_band");
    expect(logged).not.toContain(userId);
    expect(logged).not.toContain(saleId.toLowerCase());
  });
});
