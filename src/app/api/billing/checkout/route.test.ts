import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError, RateLimitError } from "@/lib/api-errors";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforceUser: vi.fn(),
  checkout: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    if (!request.headers.get("authorization")) {
      throw new AuthRequiredError("Unauthorized: No authorization header provided");
    }
    return "token";
  },
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforceUser }));
vi.mock("@/lib/billing", () => ({
  createPlanCheckoutSession: mocks.checkout,
  resolveCheckoutPlanCode: (value: unknown) => {
    if (value !== "analysis") throw new Error("Offre inconnue.");
    return value;
  },
}));

import { POST } from "./route";

const consent = {
  termsAccepted: true,
  termsVersion: LEGAL_DOCUMENTS.terms.version,
  privacyVersion: LEGAL_DOCUMENTS.privacy.version,
  paymentObligationAcknowledged: true,
  immediatePerformanceRequested: true,
  withdrawalInformationAcknowledged: true,
};

function post(body: unknown, withToken = true) {
  return POST(
    new Request("https://immojudis.test/api/billing/checkout", {
      method: "POST",
      headers: withToken ? { authorization: "Bearer token" } : undefined,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/billing/checkout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.enforceUser.mockResolvedValue(1);
    mocks.checkout.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
  });

  it("answers 401 without a token, before the rate limit and the body", async () => {
    const response = await post("{bad json", false);

    expect(response.status).toBe(401);
    expect(mocks.enforceUser).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("answers 401 when the token is rejected", async () => {
    mocks.requireAuth.mockRejectedValue(new AuthRequiredError("Unauthorized: Invalid token"));

    expect((await post({ plan: "analysis", consent })).status).toBe(401);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("answers 403 when the account cannot open a checkout", async () => {
    mocks.checkout.mockRejectedValue(new ForbiddenError("Paiement réservé aux comptes confirmés."));

    expect((await post({ plan: "analysis", consent })).status).toBe(403);
  });

  it("answers 400 for a missing or incomplete consent, an unknown plan and a malformed body", async () => {
    expect((await post({ plan: "analysis" })).status).toBe(400);
    expect(
      (await post({ plan: "analysis", consent: { ...consent, termsAccepted: false } })).status,
    ).toBe(400);
    expect((await post({ plan: "inconnue", consent })).status).toBe(400);
    expect((await post("{bad json")).status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("limits the checkout to 10 per hour and per account, and answers 429 with Retry-After", async () => {
    mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 1800));

    const response = await post({ plan: "analysis", consent });

    expect(mocks.enforceUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        bucketKey: "billing.checkout",
        limit: 10,
        windowSeconds: 3600,
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1800");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("opens the checkout session when everything is in order", async () => {
    const response = await post({ plan: "analysis", consent });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/s" });
    expect(mocks.checkout).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "analysis", origin: "https://immojudis.test" }),
    );
  });
});
