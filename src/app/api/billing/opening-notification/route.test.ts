import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforceUser: vi.fn(),
  setNotification: vi.fn(),
  setSurvey: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforceUser }));
vi.mock("@/lib/offer-opening-notification", () => ({
  getOfferOpeningNotification: vi.fn(),
  offerOpeningNotificationSchema: { parse: (value: unknown) => value },
  offerOpeningSurveySchema: { parse: (value: unknown) => value },
  setOfferOpeningNotification: mocks.setNotification,
  setOfferOpeningSurvey: mocks.setSurvey,
}));

import { PATCH, PUT } from "./route";

function call(handler: typeof PUT, method: "PUT" | "PATCH") {
  return handler(
    new Request("https://immojudis.test/api/billing/opening-notification", {
      method,
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({ requested: true }),
    }),
  );
}

describe("/api/billing/opening-notification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.enforceUser.mockResolvedValue(1);
    mocks.setNotification.mockResolvedValue({ requested: true });
    mocks.setSurvey.mockResolvedValue({ saved: true });
  });

  it.each([
    ["PUT", PUT],
    ["PATCH", PATCH],
  ] as const)("charges %s to the shared form bucket of the account", async (method, handler) => {
    const response = await call(handler, method);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.enforceUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        bucketKey: "billing.opening-notification",
        limit: 10,
        windowSeconds: 3600,
      }),
    );
  });

  it.each([
    ["PUT", PUT],
    ["PATCH", PATCH],
  ] as const)("answers 429 on %s before writing anything", async (method, handler) => {
    mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 120));

    const response = await call(handler, method);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(mocks.setNotification).not.toHaveBeenCalled();
    expect(mocks.setSurvey).not.toHaveBeenCalled();
  });
});
