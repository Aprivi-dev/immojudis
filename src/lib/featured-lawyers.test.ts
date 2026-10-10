import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFeaturedReferencedLawyerForSale,
  selectActivePaidPlacement,
} from "@/lib/featured-lawyers";

const { serverFrom } = vi.hoisted(() => ({ serverFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom },
}));

type LawyerRow = Parameters<typeof selectActivePaidPlacement>[0][number];

describe("featured lawyer of a sale (bar of the tribunal only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockTables(saleRow: Record<string, unknown>, lawyers: LawyerRow[]) {
    serverFrom.mockImplementation((table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: table === "auction_sales" ? saleRow : null,
          error: null,
        }),
        then: (resolve: (value: { data: unknown; error: null }) => void) =>
          resolve({ data: table === "referenced_lawyers" ? lawyers : [], error: null }),
      };
      return builder;
    });
  }

  const sale = {
    id: "sale-1",
    tribunal: "Tribunal judiciaire de Bordeaux",
    tribunal_code: "tj-bordeaux",
    lawyer_name: "Maître Pierre Poursuivant",
    status: "published",
    raw_payload: {},
  };

  it("keeps the lawyers of the tribunal's bar, ignoring the sale's own city", async () => {
    mockTables({ ...sale, city: "Paris" }, [
      lawyerRow({ id: "paris", display_name: "Me Parisien", bar_association: "Paris" }),
      lawyerRow({ id: "bordeaux", display_name: "Me Bordelais", bar_association: "Bordeaux" }),
    ]);

    const { lawyer } = await getFeaturedReferencedLawyerForSale({ saleId: "sale-1" });

    expect(lawyer?.id).toBe("bordeaux");
    expect(lawyer?.sectorLabel).toBe("Barreau de Bordeaux");
  });

  it("never features the prosecuting lawyer", async () => {
    mockTables(sale, [
      lawyerRow({
        id: "prosecuting",
        display_name: "Me Pierre Poursuivant",
        bar_association: "Bordeaux",
      }),
    ]);

    const { lawyer } = await getFeaturedReferencedLawyerForSale({ saleId: "sale-1" });

    expect(lawyer).toBeNull();
  });

  it("features nobody when the tribunal does not name a bar", async () => {
    mockTables({ ...sale, tribunal: "Cour d'appel", tribunal_code: null }, [
      lawyerRow({ id: "bordeaux", bar_association: "Bordeaux" }),
    ]);

    const { lawyer } = await getFeaturedReferencedLawyerForSale({ saleId: "sale-1" });

    expect(lawyer).toBeNull();
  });
});

describe("featured lawyers", () => {
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
