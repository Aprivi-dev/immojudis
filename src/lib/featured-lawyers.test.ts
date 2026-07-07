import { describe, expect, it } from "vitest";
import {
  buildFeaturedLawyerSectorCriteria,
  selectActivePaidPlacement,
} from "@/lib/featured-lawyers";

type LawyerRow = Parameters<typeof selectActivePaidPlacement>[0][number];

describe("featured lawyers", () => {
  it("prioritizes precise local paid-placement coverage before department coverage", () => {
    const criteria = buildFeaturedLawyerSectorCriteria({
      id: "sale-1",
      tribunal: "Tribunal judiciaire de Bordeaux",
      tribunal_code: "tj-bordeaux",
      postal_code: "33000",
      city: "Bordeaux",
      department: "33",
    });

    expect(criteria.map((criterion) => `${criterion.column}:${criterion.value}`)).toEqual([
      "tribunal_code:tj-bordeaux",
      "postal_code_prefix:33000",
      "postal_code_prefix:3300",
      "postal_code_prefix:330",
      "city:Bordeaux",
      "department:33",
    ]);
  });

  it("keeps only active paid placement windows for the sticky sale card", () => {
    const now = new Date("2026-07-07T10:00:00.000Z");

    const selected = selectActivePaidPlacement(
      [
        lawyerRow({
          id: "future",
          display_name: "Me Future",
          paid_placement_starts_at: "2026-07-08T10:00:00.000Z",
        }),
        lawyerRow({
          id: "expired",
          display_name: "Me Expired",
          paid_placement_ends_at: "2026-07-06T10:00:00.000Z",
        }),
        lawyerRow({
          id: "active",
          display_name: "Me Dupont",
          paid_placement_starts_at: "2026-07-01T10:00:00.000Z",
          paid_placement_ends_at: "2026-07-31T10:00:00.000Z",
        }),
      ],
      now,
    );

    expect(selected?.id).toBe("active");
  });
});

function lawyerRow(overrides: Partial<LawyerRow>): LawyerRow {
  return {
    id: "lawyer",
    display_name: "Me Référencé",
    firm_name: "Cabinet ImmoJudis",
    bar_association: "Paris",
    city: "Paris",
    department: "75",
    profile_summary: "Accompagnement en adjudication.",
    practice_tags: ["adjudication"],
    priority_weight: 100,
    paid_placement_starts_at: null,
    paid_placement_ends_at: null,
    ...overrides,
  };
}
