import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforce: vi.fn(),
  record: vi.fn(),
  rpc: vi.fn(),
  client: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => null),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.client,
}));

import { POST } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const context = (id = saleId) => ({ params: Promise.resolve({ id }) });
const post = (id = saleId) =>
  POST(
    new Request(`https://example.test/api/sales/${id}/calendar/exported`, { method: "POST" }),
    context(id),
  );
const calendarRow = (overrides: Record<string, unknown> = {}) => ({
  id: saleId,
  exportable: true,
  sale_date: "2026-11-10T13:00:00Z",
  ...overrides,
});

describe("POST /api/sales/[id]/calendar/exported", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.enforce.mockResolvedValue(1);
    mocks.record.mockResolvedValue(true);
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({ data: [calendarRow()], error: null });
  });

  it("records the export for the signed-in account and answers privately", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ recorded: true });
    expect(mocks.rpc).toHaveBeenCalledWith("get_public_sale_calendar_event", {
      p_sale_id: saleId,
    });
    expect(mocks.record).toHaveBeenCalledWith("user-1", { type: "calendar_exported", saleId });
  });

  it("looks the sale up with the anonymous client and a lowercase identifier", async () => {
    await post(saleId.toUpperCase());

    expect(mocks.rpc).toHaveBeenCalledWith("get_public_sale_calendar_event", {
      p_sale_id: saleId,
    });
  });

  it("records nothing for a sale that is not publicly visible (no row)", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const response = await post();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ recorded: false });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records nothing when the function answers null for an unknown sale", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    expect(await (await post()).json()).toEqual({ recorded: false });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records nothing for a visible sale whose hearing is not exportable", async () => {
    mocks.rpc.mockResolvedValue({
      data: [calendarRow({ exportable: false, sale_date: null })],
      error: null,
    });

    expect(await (await post()).json()).toEqual({ recorded: false });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("accepts the single-object shape of the function answer", async () => {
    mocks.rpc.mockResolvedValue({ data: calendarRow(), error: null });

    expect(await (await post()).json()).toEqual({ recorded: true });
  });

  it("fails without recording when the visibility read fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "XX000" } });

    const response = await post();

    expect(response.status).toBe(500);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("fails without recording when Supabase is not configured", async () => {
    mocks.client.mockReturnValue(null);

    const response = await post();

    expect(response.status).toBe(503);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("is rate limited per account before any database read", async () => {
    mocks.enforce.mockRejectedValue(new Error("Rate limited"));

    await post();

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a request without account and records nothing", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await post();

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("rejects an identifier that is not a UUID before any authentication or write", async () => {
    const response = await post("not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers that nothing was recorded when the event of the day already exists or the daily cap is reached", async () => {
    mocks.record.mockResolvedValue(false);

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: false });
  });
});
