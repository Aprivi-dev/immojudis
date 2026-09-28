import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  review: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/lib/admin-auction-fact-claims-review", () => ({
  adminAuctionFactClaimDecisionSchema: {
    parse: (value: unknown) => value,
  },
  adminAuctionFactClaimReviewQuerySchema: {
    parse: (value: unknown) => {
      const record = value as Record<string, unknown>;
      return { ...record, limit: Number(record.limit ?? 50) };
    },
  },
  listAdminAuctionFactClaims: mocks.list,
  reviewAdminAuctionFactClaim: mocks.review,
}));

import { GET, POST } from "./route";

const claimId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "33333333-3333-4333-8333-333333333333" });
});

describe("admin auction fact claim review route", () => {
  it("returns private paginated review data", async () => {
    mocks.list.mockResolvedValue({ ok: true, items: [], hasMore: false, nextCursor: null });

    const response = await GET(
      new Request("https://example.test/api/admin/fact-claims/review?limit=10&status=conflicted"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith({
      auth: expect.objectContaining({ isAdmin: true }),
      input: { limit: 10, status: "conflicted" },
    });
  });

  it("submits a decision without putting source evidence in the client request", async () => {
    mocks.review.mockResolvedValue({ ok: true, result: { claim_id: claimId } });

    const response = await POST(
      new Request("https://example.test/api/admin/fact-claims/review", {
        method: "POST",
        body: JSON.stringify({
          claimId,
          decision: "accepted",
          resolutionNote: null,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith({
      auth: expect.objectContaining({ isAdmin: true }),
      input: { claimId, decision: "accepted", resolutionNote: null },
    });
  });

  it("maps canonical mismatch to a conflict response", async () => {
    mocks.review.mockRejectedValue({
      code: "55000",
      message: "The candidate no longer matches the current canonical sale field.",
    });

    const response = await POST(
      new Request("https://example.test/api/admin/fact-claims/review", {
        method: "POST",
        body: JSON.stringify({ claimId, decision: "accepted" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The candidate no longer matches the current canonical sale field.",
    });
  });

  it("returns unauthorized when the auth middleware rejects the request", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: Invalid token"));

    const response = await GET(new Request("https://example.test/api/admin/fact-claims/review"));

    expect(response.status).toBe(401);
  });
});
