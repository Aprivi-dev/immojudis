import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), enforce: vi.fn(), record: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => null),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));

import { POST } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const context = (id = saleId) => ({ params: Promise.resolve({ id }) });
const post = (id = saleId) =>
  POST(
    new Request(`https://example.test/api/sales/${id}/calendar/exported`, { method: "POST" }),
    context(id),
  );

describe("POST /api/sales/[id]/calendar/exported", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.enforce.mockResolvedValue(1);
    mocks.record.mockResolvedValue(true);
  });

  it("records the export for the signed-in account and answers privately", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ recorded: true });
    expect(mocks.record).toHaveBeenCalledWith("user-1", { type: "calendar_exported", saleId });
  });

  it("refuses a request without account and records nothing", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await post();

    expect(response.status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("rejects an identifier that is not a UUID before any authentication or write", async () => {
    const response = await post("not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers that nothing was recorded when the event of the day already exists", async () => {
    mocks.record.mockResolvedValue(false);

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: false });
  });
});
