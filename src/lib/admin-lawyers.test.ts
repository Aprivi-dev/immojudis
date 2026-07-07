import { describe, expect, it } from "vitest";
import {
  adminReferencedLawyerInputSchema,
  referencedLawyerCoverageRows,
  referencedLawyerPayload,
} from "@/lib/admin-lawyers";

describe("admin referenced lawyers", () => {
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
