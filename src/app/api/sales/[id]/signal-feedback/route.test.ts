import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforce: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/sale-signal-feedback.server", () => ({
  recordSaleSignalFeedback: mocks.record,
}));

import { POST } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const post = (body: unknown, id = saleId, raw = false) =>
  POST(
    new Request(`https://example.test/api/sales/${id}/signal-feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/sales/[id]/signal-feedback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.enforce.mockResolvedValue(1);
    mocks.record.mockResolvedValue(true);
  });

  it("records a « useful » for the signed-in account and answers privately", async () => {
    const response = await post({ signal: "market_gap_band", value: "useful" });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ recorded: true });
    expect(mocks.record).toHaveBeenCalledWith("user-1", saleId, {
      signal: "market_gap_band",
      value: "useful",
    });
  });

  it("records a « not relevant » with a reason of the signal", async () => {
    await post({ signal: "points_to_verify", value: "not_relevant", reason: "point_wrong" });

    expect(mocks.record).toHaveBeenCalledWith("user-1", saleId, {
      signal: "points_to_verify",
      value: "not_relevant",
      reason: "point_wrong",
    });
  });

  it("records the feedback of the Pépite signal with one of its reasons", async () => {
    await post({ signal: "pepite", value: "not_relevant", reason: "amount_too_high" });

    expect(mocks.record).toHaveBeenCalledWith("user-1", saleId, {
      signal: "pepite",
      value: "not_relevant",
      reason: "amount_too_high",
    });
  });

  it("refuses a reason of another signal for the Pépite signal", async () => {
    const response = await post({
      signal: "pepite",
      value: "not_relevant",
      reason: "estimate_too_high",
    });

    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers recorded: false when the database refuses (sale out of the catalogue, daily cap)", async () => {
    mocks.record.mockResolvedValue(false);

    const response = await post({ signal: "market_gap_band", value: "useful" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: false });
  });

  it("has no anonymous measure: without a valid session nothing is recorded", async () => {
    mocks.requireAuth.mockRejectedValue(
      new Error("Unauthorized: No authorization header provided"),
    );

    const response = await post({ signal: "market_gap_band", value: "useful" });

    expect(response.status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown signal", { signal: "page_viewed", value: "useful" }],
    ["a value outside the list", { signal: "market_gap_band", value: "great" }],
    [
      "a reason of the other signal",
      { signal: "market_gap_band", value: "not_relevant", reason: "point_wrong" },
    ],
    [
      "a free-text reason",
      { signal: "points_to_verify", value: "not_relevant", reason: "il manque la cave" },
    ],
    [
      "a reason on a « useful »",
      { signal: "points_to_verify", value: "useful", reason: "point_wrong" },
    ],
    ["a free field", { signal: "market_gap_band", value: "useful", comment: "texte libre" }],
    ["an empty body", {}],
  ])("refuses %s with 400 and records nothing", async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON with 400", async () => {
    const response = await post("not json", saleId, true);

    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a sale identifier that is not a UUID", async () => {
    const response = await post({ signal: "market_gap_band", value: "useful" }, "not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("limits the calls of an account", async () => {
    const limited = Object.assign(new Error("Trop de demandes."), { name: "RateLimitError" });
    mocks.enforce.mockRejectedValue(limited);

    const response = await post({ signal: "market_gap_band", value: "useful" });

    expect(response.status).not.toBe(200);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("fails without leaking the database error when the write fails", async () => {
    mocks.record.mockRejectedValue(new Error("duplicate key value violates constraint x"));

    const response = await post({ signal: "market_gap_band", value: "useful" });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("constraint");
  });
});
