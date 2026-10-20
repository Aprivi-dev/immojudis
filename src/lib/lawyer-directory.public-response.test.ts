import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  loadUpcoming: vi.fn(),
  tables: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/lawyer-prosecuted-sales.server", () => ({
  loadUpcomingProsecutedSales: mocks.loadUpcoming,
  loadProsecutedSalesForLawyerIds: mocks.loadUpcoming,
}));

import { listLawyerDirectory, lawyerDirectoryQuerySchema } from "@/lib/lawyer-directory";

const LAWYER = {
  id: "10000000-0000-4000-8000-000000000001",
  display_name: "Claire Durand",
  firm_name: null,
  email: null,
  phone: null,
  website_url: null,
  bar_association: "Bordeaux",
  bar_number: null,
  city: "Bordeaux",
  department: "33",
  address: null,
  profile_summary: null,
  practice_tags: [],
  accepts_remote_contact: false,
  priority_weight: 0,
  paid_placement_status: "not_started",
  paid_placement_starts_at: null,
  paid_placement_ends_at: null,
};

/** Chaîne de requête Supabase qui se résout avec les lignes de la table lue. */
function queryFor(table: string) {
  mocks.tables.push(table);
  const rows = table === "referenced_lawyers" ? [LAWYER] : [];
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
  };
  for (const method of ["select", "eq", "in", "order", "limit"]) chain[method] = () => chain;
  return chain;
}

describe("réponse publique de l'annuaire des avocats", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.tables.length = 0;
    mocks.from.mockImplementation(queryFor);
  });

  it("ne porte aucune vente liée à un avocat et ne lit jamais ces ventes", async () => {
    // Même si une lecture des ventes aurait un résultat, la réponse mise en cache ne doit pas le dire.
    mocks.loadUpcoming.mockResolvedValue({
      lawyers: {
        [LAWYER.id]: { total: 1, sales: [{ id: "0b1f7f3e-9a2c-4c55-8d5e-111111111111" }] },
      },
    });

    const directory = await listLawyerDirectory(
      lawyerDirectoryQuerySchema.parse({ bar: "Bordeaux" }),
      new Date("2026-11-20T10:00:00Z"),
    );

    expect(directory.lawyers.map((lawyer) => lawyer.id)).toEqual([LAWYER.id]);
    const serialized = JSON.stringify(directory);
    expect(serialized).not.toContain("upcomingProsecutedSales");
    expect(serialized).not.toContain("0b1f7f3e");
    expect(mocks.loadUpcoming).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.tables).not.toContain("auction_sales");
  });
});
