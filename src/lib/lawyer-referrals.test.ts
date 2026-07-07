import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  buildLawyerReferralSectorCriteria,
  createLawyerReferralRequest,
  listLawyerReferralRequests,
} from "@/lib/lawyer-referrals";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { recordFeatureUsageEvent } from "@/lib/usage";

vi.mock("@/lib/property-reports", () => ({
  resolvePlanEntitlements: vi.fn(),
}));

vi.mock("@/lib/usage", () => ({
  recordFeatureUsageEvent: vi.fn(async () => undefined),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SALE_ID = "22222222-2222-4222-8222-222222222222";
const LAWYER_ID = "33333333-3333-4333-8333-333333333333";

describe("lawyer referrals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks referral requests for Decouverte users", async () => {
    vi.mocked(resolvePlanEntitlements).mockResolvedValue(planEntitlements("decouverte"));
    const auth = {
      userId: USER_ID,
      claims: { sub: USER_ID, email: "buyer@example.test" },
      supabase: {
        from() {
          throw new Error("No database query should run for a locked feature.");
        },
      },
    } as unknown as SupabaseAuthContext;

    await expect(
      createLawyerReferralRequest({
        auth,
        input: {
          saleId: SALE_ID,
          preferredContactMethod: "email",
        },
      }),
    ).rejects.toThrow("Mise en relation avocat réservée au plan Analyse ou Investisseur.");

    expect(recordFeatureUsageEvent).not.toHaveBeenCalled();
  });

  it("matches only ImmoJudis referenced lawyers, not source-site lawyer contacts", async () => {
    vi.mocked(resolvePlanEntitlements).mockResolvedValue(planEntitlements("analyse"));
    const auth = fakeReferralAuth();

    const response = await createLawyerReferralRequest({
      auth,
      input: {
        saleId: SALE_ID,
        preferredContactMethod: "either",
        message: "Je souhaite préparer l'audience.",
        financingReady: true,
        maxBidEur: 126_000,
      },
    });

    expect(response).toMatchObject({
      status: "new",
      matchingStatus: "matched",
      matchedLawyer: {
        id: LAWYER_ID,
        displayName: "Me Référencé",
        firmName: "Cabinet ImmoJudis",
      },
      reusedExisting: false,
    });

    expect(auth.calls.map((call) => call.table)).toEqual([
      "auction_sales",
      "lawyer_referral_requests",
      "referenced_lawyer_coverage",
      "referenced_lawyers",
      "lawyer_referral_requests",
    ]);
    expect(auth.calls[0]?.selected).not.toContain("lawyer_name");
    expect(auth.calls[0]?.selected).not.toContain("lawyer_contact");
    expect(auth.calls[3]).toMatchObject({
      table: "referenced_lawyers",
      filters: {
        status: "active",
        paid_placement_status: ["trial", "active"],
        accepts_judicial_auctions: true,
      },
    });
    expect(auth.inserts).toHaveLength(1);
    expect(auth.inserts[0]).toMatchObject({
      requester_id: USER_ID,
      requester_email: "buyer@example.test",
      sale_id: SALE_ID,
      requested_lawyer_id: LAWYER_ID,
      matching_status: "matched",
      preferred_contact_method: "either",
      metadata: {
        source: "sale_detail",
        matching_basis: "referenced_lawyer_coverage",
      },
    });
    expect(auth.inserts[0]?.sale_snapshot).not.toHaveProperty("lawyer_name");
    expect(auth.inserts[0]?.sale_snapshot).not.toHaveProperty("lawyer_contact");
    expect(recordFeatureUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        auth,
        eventKey: "lawyer.referral_requested",
        subjectType: "lawyer_referral_request",
      }),
    );
  });

  it("does not match expired paid lawyer placements", async () => {
    vi.mocked(resolvePlanEntitlements).mockResolvedValue(planEntitlements("analyse"));
    const auth = fakeReferralAuth({
      referencedLawyerRows: [
        referencedLawyerRow({
          paid_placement_starts_at: "2025-01-01T00:00:00.000Z",
          paid_placement_ends_at: "2025-12-31T23:59:59.999Z",
        }),
      ],
    });

    const response = await createLawyerReferralRequest({
      auth,
      input: {
        saleId: SALE_ID,
        preferredContactMethod: "email",
      },
    });

    expect(response).toMatchObject({
      status: "manual_review",
      matchingStatus: "manual_review",
      matchedLawyer: null,
      reusedExisting: false,
    });
    expect(auth.inserts[0]).toMatchObject({
      requested_lawyer_id: null,
      matching_status: "manual_review",
      metadata: {
        source: "sale_detail",
        matching_basis: "manual_review",
      },
    });
  });

  it("prioritizes precise referral coverage before department coverage", () => {
    const criteria = buildLawyerReferralSectorCriteria({
      tribunal_code: null,
      postal_code: "33000",
      city: "Bordeaux",
      department: "33",
    });

    expect(criteria.map((criterion) => `${criterion.column}:${criterion.value}`)).toEqual([
      "postal_code_prefix:33000",
      "postal_code_prefix:3300",
      "postal_code_prefix:330",
      "city:Bordeaux",
      "department:33",
    ]);
  });

  it("matches city referral coverage without case sensitivity", async () => {
    vi.mocked(resolvePlanEntitlements).mockResolvedValue(planEntitlements("analyse"));
    const auth = fakeReferralAuth({
      saleRow: {
        tribunal_code: null,
        postal_code: null,
        city: "BORDEAUX",
        department: null,
      },
    });

    const response = await createLawyerReferralRequest({
      auth,
      input: {
        saleId: SALE_ID,
        preferredContactMethod: "email",
      },
    });

    expect(response.matchingStatus).toBe("matched");
    expect(auth.calls.find((call) => call.table === "referenced_lawyer_coverage")).toMatchObject({
      filters: {
        "ilike:city": "BORDEAUX",
      },
    });
  });

  it("lists buyer referral status without exposing source-site lawyer contacts", async () => {
    const auth = fakeReferralListAuth();

    const response = await listLawyerReferralRequests({
      auth,
      query: { saleId: SALE_ID, limit: 1 },
    });

    expect(response.requests).toHaveLength(1);
    expect(response.requests[0]).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
      status: "sent_to_lawyer",
      statusLabel: "Transmise à l'avocat référencé",
      requestedLawyerId: LAWYER_ID,
      matchedLawyer: {
        id: LAWYER_ID,
        displayName: "Me Référencé",
        firmName: "Cabinet ImmoJudis",
      },
      sale: {
        id: SALE_ID,
        title: "Appartement judiciaire",
        tribunal: "Tribunal judiciaire de Bordeaux",
      },
    });
    expect(JSON.stringify(response)).not.toContain("source@example.test");
    expect(JSON.stringify(response)).not.toContain("Me Source");
    expect(auth.calls.map((call) => call.table)).toEqual([
      "lawyer_referral_requests",
      "referenced_lawyers",
    ]);
    expect(auth.calls[0]).toMatchObject({
      filters: {
        requester_id: USER_ID,
        sale_id: SALE_ID,
      },
    });
  });
});

function planEntitlements(plan: "decouverte" | "analyse" | "investisseur") {
  return {
    plan,
    label: plan,
    limits: {},
    features: {},
  } as Awaited<ReturnType<typeof resolvePlanEntitlements>>;
}

function fakeReferralAuth(
  options: {
    referencedLawyerRows?: Array<Record<string, unknown>>;
    saleRow?: Record<string, unknown>;
  } = {},
): SupabaseAuthContext & {
  calls: Array<{ table: string; selected: string | null; filters: Record<string, unknown> }>;
  inserts: Array<Record<string, unknown>>;
} {
  const calls: Array<{ table: string; selected: string | null; filters: Record<string, unknown> }> =
    [];
  const inserts: Array<Record<string, unknown>> = [];
  const referencedLawyerRows = options.referencedLawyerRows ?? [referencedLawyerRow()];

  const auth = {
    userId: USER_ID,
    claims: { sub: USER_ID, email: "buyer@example.test" },
    calls,
    inserts,
    supabase: {
      from(table: string) {
        const call = {
          table,
          selected: null as string | null,
          filters: {} as Record<string, unknown>,
        };
        calls.push(call);
        let insertPayload: Record<string, unknown> | null = null;

        const builder = {
          select(columns?: string) {
            call.selected = columns ?? null;
            return builder;
          },
          eq(column: string, value: unknown) {
            call.filters[column] = value;
            return builder;
          },
          ilike(column: string, value: unknown) {
            call.filters[`ilike:${column}`] = value;
            return builder;
          },
          in(column: string, value: unknown) {
            call.filters[column] = value;
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          insert(payload: Record<string, unknown>) {
            insertPayload = payload;
            inserts.push(payload);
            return builder;
          },
          async maybeSingle() {
            if (table === "auction_sales") {
              return {
                data: {
                  id: SALE_ID,
                  title: "Appartement judiciaire",
                  city: "Bordeaux",
                  department: "33",
                  postal_code: "33000",
                  address: "1 rue Test",
                  tribunal: "Tribunal judiciaire de Bordeaux",
                  tribunal_code: "TJ-BDX",
                  sale_date: "2026-07-20",
                  starting_price_eur: 92_000,
                  property_type: "apartment",
                  lawyer_name: "Me Source",
                  lawyer_contact: "source@example.test",
                  ...options.saleRow,
                },
                error: null,
              };
            }

            if (table === "lawyer_referral_requests" && !insertPayload) {
              return { data: null, error: null };
            }

            if (table === "referenced_lawyers") {
              return {
                data: referencedLawyerRows[0] ?? null,
                error: null,
              };
            }

            return { data: null, error: new Error(`Unexpected maybeSingle on ${table}`) };
          },
          async single() {
            if (table === "lawyer_referral_requests" && insertPayload) {
              return {
                data: {
                  id: "44444444-4444-4444-8444-444444444444",
                  status: insertPayload.status,
                  matching_status: insertPayload.matching_status,
                },
                error: null,
              };
            }

            return { data: null, error: new Error(`Unexpected single on ${table}`) };
          },
          then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) {
            if (table === "referenced_lawyer_coverage") {
              resolve({ data: [{ lawyer_id: LAWYER_ID }], error: null });
              return;
            }

            if (table === "referenced_lawyers") {
              resolve({ data: referencedLawyerRows, error: null });
              return;
            }

            resolve({ data: [], error: null });
          },
        };

        return builder;
      },
    },
  };

  return auth as unknown as SupabaseAuthContext & {
    calls: Array<{ table: string; selected: string | null; filters: Record<string, unknown> }>;
    inserts: Array<Record<string, unknown>>;
  };
}

function referencedLawyerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LAWYER_ID,
    display_name: "Me Référencé",
    firm_name: "Cabinet ImmoJudis",
    bar_association: "Bordeaux",
    city: "Bordeaux",
    department: "33",
    priority_weight: 100,
    paid_placement_starts_at: null,
    paid_placement_ends_at: null,
    ...overrides,
  };
}

function fakeReferralListAuth(): SupabaseAuthContext & {
  calls: Array<{ table: string; selected: string | null; filters: Record<string, unknown> }>;
} {
  const calls: Array<{ table: string; selected: string | null; filters: Record<string, unknown> }> =
    [];

  const auth = {
    userId: USER_ID,
    claims: { sub: USER_ID, email: "buyer@example.test" },
    calls,
    supabase: {
      from(table: string) {
        const call = {
          table,
          selected: null as string | null,
          filters: {} as Record<string, unknown>,
        };
        calls.push(call);

        const builder = {
          select(columns?: string) {
            call.selected = columns ?? null;
            return builder;
          },
          eq(column: string, value: unknown) {
            call.filters[column] = value;
            return builder;
          },
          ilike(column: string, value: unknown) {
            call.filters[`ilike:${column}`] = value;
            return builder;
          },
          in(column: string, value: unknown) {
            call.filters[column] = value;
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => void) {
            if (table === "lawyer_referral_requests") {
              resolve({
                data: [
                  {
                    id: "55555555-5555-4555-8555-555555555555",
                    status: "sent_to_lawyer",
                    matching_status: "matched",
                    requested_lawyer_id: LAWYER_ID,
                    sale_id: SALE_ID,
                    sale_snapshot: {
                      id: SALE_ID,
                      title: "Appartement judiciaire",
                      city: "Bordeaux",
                      department: "33",
                      tribunal: "Tribunal judiciaire de Bordeaux",
                      tribunal_code: "TJ-BDX",
                      sale_date: "2026-07-20",
                      starting_price_eur: 92_000,
                      lawyer_name: "Me Source",
                      lawyer_contact: "source@example.test",
                    },
                    preferred_contact_method: "email",
                    financing_ready: true,
                    max_bid_eur: 126_000,
                    assigned_at: "2026-07-06T09:00:00.000Z",
                    sent_at: "2026-07-06T10:00:00.000Z",
                    responded_at: null,
                    created_at: "2026-07-06T08:30:00.000Z",
                    updated_at: "2026-07-06T10:00:00.000Z",
                  },
                ],
                error: null,
              });
              return;
            }

            if (table === "referenced_lawyers") {
              resolve({ data: [referencedLawyerRow()], error: null });
              return;
            }

            resolve({ data: [], error: null });
          },
        };

        return builder;
      },
    },
  };

  return auth as unknown as SupabaseAuthContext & {
    calls: Array<{ table: string; selected: string | null; filters: Record<string, unknown> }>;
  };
}
