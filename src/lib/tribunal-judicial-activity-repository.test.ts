import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverFrom } = vi.hoisted(() => ({ serverFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom },
}));

import {
  getTribunalJudicialActivity,
  getTribunalJudicialActivityDirectory,
} from "@/lib/tribunal-judicial-activity-repository";

const AS_OF = new Date("2026-08-20T12:00:00.000Z");

describe("tribunal judicial activity repository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exige un tribunal officiel actif et ne lit que les ventes judiciaires contrôlées", async () => {
    const courtQuery = fakeQuery({
      data: {
        code: "justice_tj_1_59",
        name: "TJ Marseille",
        judicial_region: "Aix-en-Provence",
      },
      error: null,
    });
    const salesQuery = fakeQuery({
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          sale_date: "2026-09-10T09:00:00.000Z",
          status: "upcoming",
          starting_price_eur: 50_000,
          property_type: "apartment",
          visit_dates: ["2026-09-01T09:00:00.000Z"],
          first_seen_at: "2026-08-01T09:00:00.000Z",
        },
      ],
      error: null,
    });
    serverFrom.mockReturnValueOnce(courtQuery.query).mockReturnValueOnce(salesQuery.query);

    const result = await getTribunalJudicialActivity(
      { courtCode: "justice_tj_1_59", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.court).toEqual({
      code: "justice_tj_1_59",
      name: "TJ Marseille",
      judicialRegion: "Aix-en-Provence",
    });
    expect(result.activity.upcomingSales).toBe(1);
    expect(serverFrom).toHaveBeenNthCalledWith(1, "outcome_courts");
    expect(serverFrom).toHaveBeenNthCalledWith(2, "auction_sales");
    expect(courtQuery.state.filters).toEqual(
      expect.arrayContaining([
        ["eq", "code", "justice_tj_1_59"],
        ["eq", "active", true],
      ]),
    );
    expect(salesQuery.state.filters).toEqual(
      expect.arrayContaining([
        ["eq", "tribunal_code", "justice_tj_1_59"],
        ["eq", "sale_venue_type", "tribunal"],
        ["in", "sale_verification_status", ["verified", "cross_checked"]],
        ["in", "status", ["upcoming", "past", "adjudicated"]],
        ["gte", "sale_date", "2023-08-01T00:00:00.000Z"],
        ["lt", "sale_date", "2027-08-20T12:00:00.000Z"],
      ]),
    );
    expect(salesQuery.state.selected).not.toMatch(
      /address|raw|description|lawyer|document|source_url/i,
    );
    expect(salesQuery.state.ranges).toEqual([[0, 999]]);
  });

  it("échoue fermé sans correspondance exacte dans le référentiel Justice", async () => {
    const courtQuery = fakeQuery({ data: null, error: null });
    serverFrom.mockReturnValueOnce(courtQuery.query);

    await expect(
      getTribunalJudicialActivity(
        { courtCode: "tribunal-inconnu", historyMonths: 36 },
        { asOf: AS_OF },
      ),
    ).rejects.toThrow("No active exact official court reference");
    expect(serverFrom).toHaveBeenCalledOnce();
  });

  it("résout le code depuis une annonce judiciaire vérifiée sans exposer la ligne", async () => {
    const saleLookup = fakeQuery({
      data: {
        tribunal_code: "justice_tj_1_59",
        sale_venue_type: "tribunal",
        sale_verification_status: "cross_checked",
      },
      error: null,
    });
    const courtQuery = fakeQuery({
      data: {
        code: "justice_tj_1_59",
        name: "TJ Marseille",
        judicial_region: null,
      },
      error: null,
    });
    const salesQuery = fakeQuery({ data: [], error: null });
    serverFrom
      .mockReturnValueOnce(saleLookup.query)
      .mockReturnValueOnce(courtQuery.query)
      .mockReturnValueOnce(salesQuery.query);

    const result = await getTribunalJudicialActivity(
      { saleId: "11111111-1111-4111-8111-111111111111", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.court.code).toBe("justice_tj_1_59");
    expect(serverFrom).toHaveBeenNthCalledWith(1, "auction_sales");
    expect(saleLookup.state.selected).toBe(
      "tribunal_code,sale_venue_type,sale_verification_status",
    );
    expect(saleLookup.state.selected).not.toMatch(/address|description|lawyer|raw|document/i);
    expect(saleLookup.state.filters).toContainEqual([
      "eq",
      "id",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("refuse une annonce notariale même si elle porte un code tribunal", async () => {
    const saleLookup = fakeQuery({
      data: {
        tribunal_code: "justice_tj_1_59",
        sale_venue_type: "notary",
        sale_verification_status: "verified",
      },
      error: null,
    });
    serverFrom.mockReturnValueOnce(saleLookup.query);

    await expect(
      getTribunalJudicialActivity(
        { saleId: "11111111-1111-4111-8111-111111111111", historyMonths: 36 },
        { asOf: AS_OF },
      ),
    ).rejects.toThrow("no verified exact judicial court assignment");
    expect(serverFrom).toHaveBeenCalledOnce();
  });

  it("ne transforme pas une erreur de lecture en statistique vide", async () => {
    const courtQuery = fakeQuery({
      data: {
        code: "justice_tj_1_59",
        name: "TJ Marseille",
        judicial_region: null,
      },
      error: null,
    });
    const salesQuery = fakeQuery({ data: null, error: { message: "database unavailable" } });
    serverFrom.mockReturnValueOnce(courtQuery.query).mockReturnValueOnce(salesQuery.query);

    await expect(
      getTribunalJudicialActivity(
        { courtCode: "justice_tj_1_59", historyMonths: 36 },
        { asOf: AS_OF },
      ),
    ).rejects.toThrow("Judicial sale activity lookup failed");
  });

  it("charge l’annuaire en deux lectures bornées sans exposer les lignes sources", async () => {
    const courtsQuery = fakeQuery({
      data: [
        {
          code: "justice_tj_1_59",
          name: "TJ Marseille",
          judicial_region: "Aix-en-Provence",
        },
      ],
      error: null,
    });
    const salesQuery = fakeQuery({
      data: [
        {
          tribunal_code: "justice_tj_1_59",
          id: "11111111-1111-4111-8111-111111111111",
          sale_date: "2026-09-10T09:00:00.000Z",
          status: "upcoming",
          starting_price_eur: 50_000,
          property_type: "apartment",
          visit_dates: [],
          first_seen_at: "2026-08-01T09:00:00.000Z",
        },
      ],
      error: null,
    });
    serverFrom.mockReturnValueOnce(courtsQuery.query).mockReturnValueOnce(salesQuery.query);

    const result = await getTribunalJudicialActivityDirectory(
      { historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.totals).toMatchObject({ trackedCourts: 1, upcomingSales: 1 });
    expect(serverFrom).toHaveBeenNthCalledWith(1, "outcome_courts");
    expect(serverFrom).toHaveBeenNthCalledWith(2, "auction_sales");
    expect(salesQuery.state.selected).toContain("tribunal_code");
    expect(salesQuery.state.selected).not.toMatch(/address|description|lawyer|raw|document|url/i);
    expect(salesQuery.state.filters).toContainEqual(["not", "tribunal_code", "is", null]);
    expect(courtsQuery.state.ranges).toEqual([[0, 250]]);
    expect(salesQuery.state.ranges).toEqual([[0, 999]]);
  });
});

function fakeQuery(result: { data: unknown; error: { message: string } | null }) {
  const state: {
    selected: string;
    filters: Array<[string, string, unknown, unknown?]>;
    orders: Array<[string, { ascending?: boolean } | undefined]>;
    ranges: Array<[number, number]>;
  } = { selected: "", filters: [], orders: [], ranges: [] };
  const query: Record<string, unknown> = {};
  query.select = vi.fn((columns: string) => {
    state.selected = columns;
    return query;
  });
  for (const method of ["eq", "in", "gte", "lt"] as const) {
    query[method] = vi.fn((column: string, value: unknown) => {
      state.filters.push([method, column, value]);
      return query;
    });
  }
  query.not = vi.fn((column: string, operator: string, value: unknown) => {
    state.filters.push(["not", column, operator, value]);
    return query;
  });
  query.order = vi.fn((column: string, options?: { ascending?: boolean }) => {
    state.orders.push([column, options]);
    return query;
  });
  query.limit = vi.fn(() => query);
  query.range = vi.fn(async (from: number, to: number) => {
    state.ranges.push([from, to]);
    return result;
  });
  query.maybeSingle = vi.fn(async () => result);
  return { query, state };
}
