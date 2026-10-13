import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforceUser: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforceUser }));
vi.mock("@/lib/lawyer-referrals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lawyer-referrals")>()),
  previewLawyerReferralRecipient: mocks.preview,
}));

import { GET } from "./route";

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const LAWYER_ID = "22222222-2222-4222-8222-222222222222";
const request = (query: string) =>
  new Request(`https://example.test/api/lawyer-referrals/preview?${query}`, {
    headers: { authorization: "Bearer token" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue({ userId: "user-1" });
  mocks.enforceUser.mockResolvedValue(1);
});

describe("GET /api/lawyer-referrals/preview", () => {
  it("returns the recipient without caching, for the signed-in user only", async () => {
    mocks.preview.mockResolvedValue({ recipient: null });

    const response = await GET(request(`saleId=${SALE_ID}&lawyerId=${LAWYER_ID}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ recipient: null });
    expect(mocks.preview).toHaveBeenCalledWith({
      auth: { userId: "user-1" },
      query: { saleId: SALE_ID, lawyerId: LAWYER_ID },
    });
    expect(mocks.enforceUser).toHaveBeenCalledWith({
      userId: "user-1",
      bucketKey: "lawyer-referrals.preview",
      limit: 30,
      windowSeconds: 60,
    });
  });

  it("rejects a missing or malformed sale id without querying anything", async () => {
    const response = await GET(request("saleId=pas-un-uuid"));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("answers 429 when the rate limit is exceeded", async () => {
    mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 12));

    const response = await GET(request(`saleId=${SALE_ID}`));

    expect(response.status).toBe(429);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
