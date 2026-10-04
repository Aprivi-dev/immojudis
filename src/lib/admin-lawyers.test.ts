import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

import {
  adminReferencedLawyerInputSchema,
  referencedLawyerCoverageRows,
  referencedLawyerPayload,
  saveAdminReferencedLawyer,
} from "@/lib/admin-lawyers";

afterEach(() => vi.resetAllMocks());

describe("admin referenced lawyers", () => {
  it("rejects invalid contact URLs and inverted placement windows", () => {
    expect(() =>
      adminReferencedLawyerInputSchema.parse({
        displayName: "Me Test",
        email: "not-an-email",
        websiteUrl: "javascript:alert(1)",
      }),
    ).toThrow("adresse email");

    expect(() =>
      adminReferencedLawyerInputSchema.parse({
        displayName: "Me Test",
        paidPlacementStartsAt: "2026-08-01T00:00:00.000Z",
        paidPlacementEndsAt: "2026-07-01T00:00:00.000Z",
      }),
    ).toThrow("postérieure au début");

    expect(() =>
      adminReferencedLawyerInputSchema.parse({
        displayName: "Me Test",
        coverage: [{}],
      }),
    ).toThrow("Chaque zone");
  });

  it("persists the lawyer and coverage through one transaction RPC", async () => {
    const lawyerId = "7c6f2b2a-7a59-4f09-a7b7-cb49f8488bd4";
    const adminId = "3f1a1d80-8163-46b8-84de-fcfef5875652";
    const savedLawyer = referencedLawyerRow({ id: lawyerId, created_by: adminId });
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: adminId });
    mocks.rpc.mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: savedLawyer, error: null }),
    });
    mocks.from.mockImplementation((table: string) => {
      if (table === "referenced_lawyer_coverage") {
        return queryBuilder({ data: [], error: null });
      }
      if (table === "lawyer_placement_events" || table === "lawyer_referral_requests") {
        return queryBuilder({ data: [], error: null });
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const input = adminReferencedLawyerInputSchema.parse({
      id: lawyerId,
      status: "active",
      paidPlacementStatus: "active",
      displayName: "Maître Transaction",
      coverage: [{ department: "33" }],
    });

    const result = await saveAdminReferencedLawyer({ authToken: "admin-token", input });

    expect(result.lawyer.id).toBe(lawyerId);
    expect(mocks.rpc).toHaveBeenCalledWith("save_referenced_lawyer_with_coverage", {
      p_lawyer_id: lawyerId,
      p_lawyer: expect.objectContaining({
        display_name: "Maître Transaction",
        status: "active",
      }),
      p_coverage: [
        {
          tribunal_code: null,
          tribunal_name: null,
          city: null,
          department: "33",
          postal_code_prefix: null,
        },
      ],
    });
    expect(mocks.from).not.toHaveBeenCalledWith("referenced_lawyers");
  });

  it("does not issue follow-up reads when the transaction RPC fails", async () => {
    const lawyerId = "7c6f2b2a-7a59-4f09-a7b7-cb49f8488bd4";
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin-id" });
    mocks.rpc.mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: null,
        error: new Error("coverage insert rolled back"),
      }),
    });

    const input = adminReferencedLawyerInputSchema.parse({
      id: lawyerId,
      displayName: "Maître Échec",
      coverage: [{ department: "33" }],
    });

    await expect(saveAdminReferencedLawyer({ authToken: "admin-token", input })).rejects.toThrow(
      "coverage insert rolled back",
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("normalizes paid lawyer payloads for the dedicated referenced lawyer tables", () => {
    const input = adminReferencedLawyerInputSchema.parse({
      status: "active",
      paidPlacementStatus: "active",
      displayName: "  Maître Dupont  ",
      firmName: " Cabinet Dupont ",
      city: " Bordeaux ",
      department: "33",
      address: " 12 rue du Palais ",
      practiceTags: ["Adjudication", "adjudication", "Immobilier"],
      priorityWeight: 20,
      paidPlacementStartsAt: "2026-07-01T08:00:00.000Z",
      paidPlacementEndsAt: "2026-07-31T18:00:00.000Z",
      coverage: [{ department: "33" }],
    });

    expect(referencedLawyerPayload(input)).toMatchObject({
      status: "active",
      paid_placement_status: "active",
      display_name: "Maître Dupont",
      firm_name: "Cabinet Dupont",
      city: "Bordeaux",
      department: "33",
      address: "12 rue du Palais",
      practice_tags: ["adjudication", "immobilier"],
      priority_weight: 20,
      paid_placement_starts_at: "2026-07-01T08:00:00.000Z",
      paid_placement_ends_at: "2026-07-31T18:00:00.000Z",
      accepts_judicial_auctions: true,
      accepts_remote_contact: true,
    });
  });

  it("maps coverage rows without coupling to source listing contacts", () => {
    const input = adminReferencedLawyerInputSchema.parse({
      displayName: "Maître Martin",
      coverage: [
        {
          tribunalCode: "TJ-BDX",
          tribunalName: "Tribunal judiciaire de Bordeaux",
          city: "Bordeaux",
          department: "33",
          postalCodePrefix: "33",
        },
      ],
    });

    expect(referencedLawyerCoverageRows("lawyer-1", input.coverage)).toEqual([
      {
        lawyer_id: "lawyer-1",
        tribunal_code: "TJ-BDX",
        tribunal_name: "Tribunal judiciaire de Bordeaux",
        city: "Bordeaux",
        department: "33",
        postal_code_prefix: "33",
      },
    ]);
  });
});

function referencedLawyerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "7c6f2b2a-7a59-4f09-a7b7-cb49f8488bd4",
    status: "active",
    paid_placement_status: "active",
    display_name: "Maître Transaction",
    firm_name: null,
    email: null,
    phone: null,
    website_url: null,
    bar_association: null,
    bar_number: null,
    city: null,
    department: "33",
    address: null,
    profile_summary: null,
    practice_tags: ["adjudication"],
    accepts_judicial_auctions: true,
    accepts_remote_contact: true,
    priority_weight: 0,
    paid_placement_starts_at: null,
    paid_placement_ends_at: null,
    created_by: null,
    created_at: "2026-10-04T00:00:00.000Z",
    updated_at: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function queryBuilder(result: unknown) {
  const query = {
    select: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    gte: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return query;
}
