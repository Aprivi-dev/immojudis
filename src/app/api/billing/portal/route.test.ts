import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  portal: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/billing", () => ({ createBillingPortalSession: mocks.portal }));

import { POST } from "./route";

function post(body?: string) {
  return POST(
    new Request("https://immojudis.test/api/billing/portal", {
      method: "POST",
      ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }),
    }),
  );
}

describe("POST /api/billing/portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.portal.mockResolvedValue({ url: "https://billing.stripe.test/s" });
  });

  it("requires an authenticated user", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await post(JSON.stringify({ intent: "cancel" }));

    expect(response.status).toBe(401);
    expect(mocks.portal).not.toHaveBeenCalled();
  });

  it("opens the generic portal when the request has no body", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://billing.stripe.test/s" });
    expect(mocks.portal).toHaveBeenCalledWith({
      auth: { userId: "user-1" },
      origin: "https://immojudis.test",
      intent: "manage",
    });
  });

  it("forwards the cancel intent", async () => {
    const response = await post(JSON.stringify({ intent: "cancel" }));

    expect(response.status).toBe(200);
    expect(mocks.portal).toHaveBeenCalledWith(expect.objectContaining({ intent: "cancel" }));
  });

  it("ignores a subscription id sent by the client", async () => {
    await post(JSON.stringify({ intent: "cancel", subscription: "sub_of_someone_else" }));

    expect(mocks.portal).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.portal.mock.calls[0])).not.toContain("sub_of_someone_else");
  });

  it.each([
    ["an unknown intent", JSON.stringify({ intent: "delete" })],
    ["a malformed body", "{not json"],
  ])("rejects %s with a 4xx and never calls Stripe", async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.portal).not.toHaveBeenCalled();
  });
});
