import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));

import {
  adminAuctionFactClaimReviewQuerySchema,
  listAdminAuctionFactClaims,
  reviewAdminAuctionFactClaim,
} from "./admin-auction-fact-claims-review";

const saleId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const adminUserId = "33333333-3333-4333-8333-333333333333";

const adminAuth = {
  userId: adminUserId,
  isAdmin: true,
} as never;

function queryResult(result: { data: unknown[] | null; error: null; count?: number | null }) {
  const query = {
    select: vi.fn(),
    in: vi.fn(),
    eq: vi.fn(),
    not: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    or: vi.fn(),
    then: vi.fn(),
  };
  for (const method of ["select", "in", "eq", "not", "order", "range", "or"]) {
    query[method as keyof typeof query] = vi.fn().mockReturnValue(query) as never;
  }
  query.then.mockImplementation((onFulfilled, onRejected) =>
    Promise.resolve(result).then(onFulfilled, onRejected),
  );
  return query;
}

beforeEach(() => vi.resetAllMocks());

describe("admin auction fact claim review", () => {
  it("lists only sale candidates and keeps provenance in the admin DTO", async () => {
    const claimQuery = queryResult({
      data: [
        {
          claim_id: claimId,
          auction_sale_id: saleId,
          lot_id: null,
          field_key: "sale.starting_price_eur",
          value_jsonb: 92000,
          fact_status: "candidate",
          conflict_group: null,
          evidence_kind: "source_listing",
          source_id: "44444444-4444-4444-8444-444444444444",
          raw_artifact_id: "55555555-5555-4555-8555-555555555555",
          source_record_id: null,
          artifact_extraction_id: null,
          source_url: "https://source.example/sale",
          evidence_locator: { quote: "Mise à prix : 92 000 €" },
          confidence_score: "0.91",
          captured_at: "2026-09-28T10:00:00Z",
          created_at: "2026-09-28T10:01:00Z",
          updated_at: "2026-09-28T10:01:00Z",
          resolution_note: null,
        },
      ],
      error: null,
      count: 1,
    });
    const saleQuery = queryResult({
      data: [
        {
          id: saleId,
          title: "Appartement T3",
          city: "Paris",
          sale_date: "2026-10-10T10:00:00Z",
          starting_price_eur: 92000,
          surface_m2: null,
          habitable_surface_m2: null,
          carrez_surface_m2: null,
          land_surface_m2: null,
          occupancy_status: null,
        },
      ],
      error: null,
    });
    mocks.from.mockReturnValueOnce(claimQuery).mockReturnValueOnce(saleQuery);

    const response = await listAdminAuctionFactClaims({
      auth: adminAuth,
      input: { offset: 0, limit: 20 },
    });

    expect(response).toMatchObject({ total: 1, offset: 0, limit: 20, hasMore: false });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      claimId,
      saleId,
      value: 92000,
      currentCanonicalValue: 92000,
      evidence: {
        sourceUrl: "https://source.example/sale",
        confidence: 0.91,
      },
    });
    expect(claimQuery.not).toHaveBeenCalledWith("auction_sale_id", "is", null);
    expect(claimQuery.in).toHaveBeenCalledWith("fact_status", ["candidate", "conflicted"]);
  });

  it("reads the requested page with offset/limit, the exact total and the status filter", async () => {
    const claimQuery = queryResult({ data: [], error: null, count: 130 });
    mocks.from.mockReturnValue(claimQuery);

    const response = await listAdminAuctionFactClaims({
      auth: adminAuth,
      input: { offset: 50, limit: 50, status: "conflicted" },
    });

    expect(claimQuery.select).toHaveBeenCalledWith(expect.any(String), { count: "exact" });
    expect(claimQuery.eq).toHaveBeenCalledWith("fact_status", "conflicted");
    expect(claimQuery.range).toHaveBeenCalledWith(50, 99);
    expect(response).toMatchObject({ total: 130, offset: 50, limit: 50, hasMore: true });
  });

  it("reports the last page without a next page", async () => {
    mocks.from.mockReturnValue(queryResult({ data: [], error: null, count: 100 }));
    const response = await listAdminAuctionFactClaims({
      auth: adminAuth,
      input: { offset: 50, limit: 50 },
    });
    expect(response.hasMore).toBe(false);
  });

  it("validates offset and limit with the shared admin page schema", () => {
    const parse = (value: Record<string, string>) =>
      adminAuctionFactClaimReviewQuerySchema.safeParse(value);
    expect(parse({}).data).toMatchObject({ offset: 0, limit: 50 });
    expect(parse({ offset: "100", limit: "25" }).data).toMatchObject({ offset: 100, limit: 25 });
    expect(parse({ limit: "101" }).success).toBe(false);
    expect(parse({ limit: "0" }).success).toBe(false);
    expect(parse({ offset: "-1" }).success).toBe(false);
    expect(parse({ offset: "1.5" }).success).toBe(false);
    expect(parse({ status: "accepted" }).success).toBe(false);
  });

  it("refuses list and decision operations for a non-admin", async () => {
    const nonAdmin = { userId: "66666666-6666-4666-8666-666666666666", isAdmin: false } as never;

    await expect(
      listAdminAuctionFactClaims({ auth: nonAdmin, input: { offset: 0, limit: 10 } }),
    ).rejects.toThrow("Forbidden");
    await expect(
      reviewAdminAuctionFactClaim({
        auth: nonAdmin,
        input: { claimId, decision: "accepted", resolutionNote: null },
      }),
    ).rejects.toThrow("Forbidden");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes the admin decision to the atomic database guard", async () => {
    mocks.rpc.mockResolvedValue({
      data: { claim_id: claimId, claim_status: "rejected" },
      error: null,
    });

    const response = await reviewAdminAuctionFactClaim({
      auth: adminAuth,
      input: {
        claimId,
        decision: "rejected",
        resolutionNote: "La source affiche une autre mise à prix.",
      },
    });

    expect(response).toEqual({
      ok: true,
      result: { claim_id: claimId, claim_status: "rejected" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("review_auction_fact_claim", {
      p_reviewer_id: adminUserId,
      p_claim_id: claimId,
      p_decision: "rejected",
      p_resolution_note: "La source affiche une autre mise à prix.",
    });
  });
});
