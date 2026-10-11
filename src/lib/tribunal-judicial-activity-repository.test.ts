import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverFrom, serverRpc } = vi.hoisted(() => ({ serverFrom: vi.fn(), serverRpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom, rpc: serverRpc },
}));

import {
  getTribunalJudicialActivity,
  getTribunalJudicialActivityDirectory,
} from "@/lib/tribunal-judicial-activity-repository";

const AS_OF = new Date("2026-08-20T12:00:00.000Z");

describe("tribunal judicial activity repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverRpc.mockImplementation(() => fakeRpc({ data: [], error: null }).query);
  });

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
          occupancy_status: "occupied",
          city: "Marseille",
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
      /address|description|lawyer|document|source_url/i,
    );
    expect(salesQuery.state.selected).toContain("occupancy_status");
    expect(salesQuery.state.selected).toContain("city");
    expect(salesQuery.state.ranges).toEqual([[0, 999]]);
    expect(salesQuery.state.selected).toContain(
      "publication_quarantine:raw_payload->>publication_quarantine",
    );
  });

  it("continue après une page pleine même si une vente de cette page est quarantainée", async () => {
    const courtQuery = fakeQuery({
      data: { code: "justice_tj_1_59", name: "TJ Marseille", judicial_region: null },
      error: null,
    });
    const saleRow = (index: number) => ({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      sale_date: "2026-09-10T09:00:00.000Z",
      status: "upcoming",
      // Distinct prices: identical rows would be one lot published twice.
      starting_price_eur: 50_000 + index,
      property_type: "apartment",
      visit_dates: [],
      occupancy_status: null,
      city: "Marseille",
      first_seen_at: "2026-08-01T09:00:00.000Z",
      publication_quarantine: index === 0 ? "operator_hold" : null,
    });
    const firstPage = fakeQuery({
      data: Array.from({ length: 1_000 }, (_, index) => saleRow(index)),
      error: null,
    });
    const secondPage = fakeQuery({ data: [saleRow(1_000)], error: null });
    serverFrom
      .mockReturnValueOnce(courtQuery.query)
      .mockReturnValueOnce(firstPage.query)
      .mockReturnValueOnce(secondPage.query);

    const result = await getTribunalJudicialActivity(
      { courtCode: "justice_tj_1_59", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.activity.upcomingSales).toBe(1_000);
    expect(firstPage.state.ranges).toEqual([[0, 999]]);
    expect(secondPage.state.ranges).toEqual([[1_000, 1_999]]);
  });

  it("conserve occupation et commune sur le chemin d’une annonce précise", async () => {
    const courtQuery = fakeQuery({
      data: { code: "justice_tj_1_59", name: "TJ Marseille", judicial_region: null },
      error: null,
    });
    const salesQuery = fakeQuery({
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          sale_date: "2026-08-10T09:00:00.000Z",
          status: "past",
          starting_price_eur: 50_000,
          property_type: "apartment",
          visit_dates: ["2026-07-01T09:00:00.000Z"],
          occupancy_status: "occupied",
          city: "Marseille",
          first_seen_at: "2026-07-01T09:00:00.000Z",
        },
      ],
      error: null,
    });
    serverFrom.mockReturnValueOnce(courtQuery.query).mockReturnValueOnce(salesQuery.query);

    const result = await getTribunalJudicialActivity(
      { courtCode: "justice_tj_1_59", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.activity.occupation).toEqual({
      knownSales: 1,
      unknownSales: 0,
      distribution: [{ status: "occupied", count: 1, share: 1 }],
    });
    expect(result.activity.communes).toEqual([{ city: "Marseille", count: 1, share: 1 }]);
    expect(result.activity.observedVisitCoverage).toEqual({
      status: "insufficient_data",
      value: null,
      sampleSize: 1,
    });
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
        tribunal: "TJ Marseille",
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
      "tribunal_code,tribunal,sale_venue_type,sale_verification_status,status,publication_quarantine:raw_payload->>publication_quarantine",
    );
    expect(saleLookup.state.selected).not.toMatch(/address|description|lawyer|document/i);
    expect(saleLookup.state.filters).toContainEqual([
      "eq",
      "id",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("récupère le rattachement territorial officiel lorsque le code manque sur l’annonce", async () => {
    const saleLookup = fakeQuery({
      data: {
        tribunal_code: null,
        tribunal: null,
        sale_venue_type: "tribunal",
        sale_verification_status: "pending",
      },
      error: null,
    });
    const assignmentLookup = fakeQuery({
      data: { court_code: "justice_tj_1_59" },
      error: null,
    });
    const courtQuery = fakeQuery({
      data: {
        code: "justice_tj_1_59",
        name: "TJ Marseille",
        judicial_region: "Aix-en-Provence",
      },
      error: null,
    });
    const salesQuery = fakeQuery({ data: [], error: null });
    serverFrom
      .mockReturnValueOnce(saleLookup.query)
      .mockReturnValueOnce(assignmentLookup.query)
      .mockReturnValueOnce(courtQuery.query)
      .mockReturnValueOnce(salesQuery.query);

    const result = await getTribunalJudicialActivity(
      { saleId: "11111111-1111-4111-8111-111111111111", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.court.code).toBe("justice_tj_1_59");
    expect(serverFrom).toHaveBeenNthCalledWith(2, "auction_sale_competent_court_assignments");
    expect(assignmentLookup.state.selected).toBe("court_code");
    expect(assignmentLookup.state.filters).toContainEqual([
      "eq",
      "auction_sale_id",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(assignmentLookup.state.orders).toContainEqual(["created_at", { ascending: false }]);
  });

  it("utilise un libellé canonique strict pour une annonce recoupée sans affectation auditée", async () => {
    const saleLookup = fakeQuery({
      data: {
        tribunal_code: null,
        tribunal: "TJ Marseille",
        sale_venue_type: "tribunal",
        sale_verification_status: "verified",
      },
      error: null,
    });
    const assignmentLookup = fakeQuery({ data: null, error: null });
    const tribunalLookup = fakeQuery({
      data: { code: "justice_tj_1_59", canonical_name: "TJ Marseille" },
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
      .mockReturnValueOnce(assignmentLookup.query)
      .mockReturnValueOnce(tribunalLookup.query)
      .mockReturnValueOnce(courtQuery.query)
      .mockReturnValueOnce(salesQuery.query);

    const result = await getTribunalJudicialActivity(
      { saleId: "11111111-1111-4111-8111-111111111111", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.court.code).toBe("justice_tj_1_59");
    expect(serverFrom).toHaveBeenNthCalledWith(3, "tribunals");
    expect(tribunalLookup.state.filters).toContainEqual(["eq", "canonical_name", "TJ Marseille"]);
  });

  it("tolère uniquement les différences typographiques d’un libellé de tribunal recoupé", async () => {
    const saleLookup = fakeQuery({
      data: {
        tribunal_code: null,
        tribunal: "TJ Beziers",
        sale_venue_type: "tribunal",
        sale_verification_status: "verified",
      },
      error: null,
    });
    const assignmentLookup = fakeQuery({ data: null, error: null });
    const exactTribunalLookup = fakeQuery({ data: null, error: null });
    const boundedTribunalsLookup = fakeQuery({
      data: [
        { code: "beziers", canonical_name: "TJ Béziers" },
        { code: "paris", canonical_name: "TJ Paris" },
      ],
      error: null,
    });
    const courtQuery = fakeQuery({
      data: { code: "beziers", name: "TJ Béziers", judicial_region: null },
      error: null,
    });
    const salesQuery = fakeQuery({ data: [], error: null });
    serverFrom
      .mockReturnValueOnce(saleLookup.query)
      .mockReturnValueOnce(assignmentLookup.query)
      .mockReturnValueOnce(exactTribunalLookup.query)
      .mockReturnValueOnce(boundedTribunalsLookup.query)
      .mockReturnValueOnce(courtQuery.query)
      .mockReturnValueOnce(salesQuery.query);

    const result = await getTribunalJudicialActivity(
      { saleId: "11111111-1111-4111-8111-111111111111", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(result.court.code).toBe("beziers");
    expect(serverFrom).toHaveBeenNthCalledWith(4, "tribunals");
    expect(boundedTribunalsLookup.state.ranges).toEqual([[0, 250]]);
  });

  it("ne déduit pas un tribunal depuis un simple libellé encore non contrôlé", async () => {
    const saleLookup = fakeQuery({
      data: {
        tribunal_code: null,
        tribunal: "TJ Marseille",
        sale_venue_type: "tribunal",
        sale_verification_status: "pending",
      },
      error: null,
    });
    const assignmentLookup = fakeQuery({ data: null, error: null });
    serverFrom.mockReturnValueOnce(saleLookup.query).mockReturnValueOnce(assignmentLookup.query);

    await expect(
      getTribunalJudicialActivity(
        { saleId: "11111111-1111-4111-8111-111111111111", historyMonths: 36 },
        { asOf: AS_OF },
      ),
    ).rejects.toThrow("no verified exact judicial court assignment");
    expect(serverFrom).toHaveBeenCalledTimes(2);
  });

  it("refuse une annonce notariale même si elle porte un code tribunal", async () => {
    const saleLookup = fakeQuery({
      data: {
        tribunal_code: "justice_tj_1_59",
        tribunal: "TJ Marseille",
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
    ).rejects.toThrow("not identified as a judicial tribunal sale");
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
          occupancy_status: "rented",
          city: "Marseille",
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
    expect(salesQuery.state.selected).not.toMatch(/address|description|lawyer|document|url/i);
    expect(salesQuery.state.filters).toContainEqual(["not", "tribunal_code", "is", null]);
    expect(courtsQuery.state.ranges).toEqual([[0, 250]]);
    expect(salesQuery.state.ranges).toEqual([[0, 999]]);
    expect(serverRpc).toHaveBeenCalledWith("tribunal_outcome_graph_past_hearings", {
      p_history_start: "2023-08-01T00:00:00.000Z",
      p_as_of: AS_OF.toISOString(),
    });
  });

  it("reconstruit l’historique depuis l’archive du graphe et compte une seule fois un lot multi-sources", async () => {
    const courtQuery = fakeQuery({
      data: { code: "justice_tj_1_59", name: "TJ Marseille", judicial_region: null },
      error: null,
    });
    const liveSalesQuery = fakeQuery({
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          sale_date: "2026-06-10T12:00:00.000Z",
          status: "past",
          starting_price_eur: 80_000,
          property_type: "apartment",
          visit_dates: ["2026-06-01T09:00:00.000Z"],
          occupancy_status: null,
          city: "Marseille",
          first_seen_at: "2026-05-01T09:00:00.000Z",
        },
      ],
      error: null,
    });
    const archive = fakeRpc({
      data: [
        // Same lot as the live row (other source, midnight UTC hearing time).
        archivedRow(1, {
          scheduled_at: "2026-06-10T00:00:00.000Z",
          initial_starting_price_eur: "80000.00",
          city: "MARSEILLE",
          publication_first_seen_at: "2026-04-20T09:00:00.000Z",
        }),
        // Still in the catalogue: the catalogue row is authoritative.
        archivedRow(2, { auction_sale_id: "22222222-2222-4222-8222-222222222222" }),
        ...[3, 4, 5, 6, 7].map((index) =>
          archivedRow(index, { initial_starting_price_eur: 40_000 + index * 1_000 }),
        ),
        // Copy of index 7 from a second source.
        archivedRow(8, { initial_starting_price_eur: 47_000, source_name: "vench" }),
      ],
      error: null,
    });
    serverFrom.mockReturnValueOnce(courtQuery.query).mockReturnValueOnce(liveSalesQuery.query);
    serverRpc.mockReturnValueOnce(archive.query);

    const result = await getTribunalJudicialActivity(
      { courtCode: "justice_tj_1_59", historyMonths: 36 },
      { asOf: AS_OF },
    );

    expect(serverRpc).toHaveBeenCalledWith("tribunal_outcome_graph_past_hearings", {
      p_history_start: "2023-08-01T00:00:00.000Z",
      p_as_of: AS_OF.toISOString(),
      p_court_code: "justice_tj_1_59",
    });
    expect(archive.state.orders).toEqual(["scheduled_at", "round_id"]);
    expect(archive.state.ranges).toEqual([[0, 999]]);
    // live lot (merged with its archived copy) + five archived lots
    expect(result.activity.observedPastSales).toBe(6);
    expect(result.provenance.archivedPastSales).toBe(5);
    expect(result.provenance.mergedDuplicateAnnouncements).toBe(2);
    expect(result.activity.medianStartingPriceEur).toEqual({
      status: "published",
      value: 45_500,
      sampleSize: 6,
    });
    // Archived rows keep no visit dates: only the live row is a visit observation.
    expect(result.activity.observedVisitCoverage).toEqual({
      status: "insufficient_data",
      value: null,
      sampleSize: 1,
    });
    // The live lot inherits the occupation published by its archived copy.
    expect(result.activity.occupation?.knownSales).toBe(6);
  });

  it("ne publie pas un historique partiel si l’archive est illisible", async () => {
    const courtQuery = fakeQuery({
      data: { code: "justice_tj_1_59", name: "TJ Marseille", judicial_region: null },
      error: null,
    });
    serverFrom
      .mockReturnValueOnce(courtQuery.query)
      .mockReturnValueOnce(fakeQuery({ data: [], error: null }).query);
    serverRpc.mockReturnValueOnce(fakeRpc({ data: null, error: { message: "boom" } }).query);

    await expect(
      getTribunalJudicialActivity(
        { courtCode: "justice_tj_1_59", historyMonths: 36 },
        { asOf: AS_OF },
      ),
    ).rejects.toThrow("Archived hearing lookup failed");
  });
});

function archivedRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    round_id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    court_code: "justice_tj_1_59",
    scheduled_at: "2026-05-12T09:00:00.000Z",
    initial_starting_price_eur: 50_000,
    property_type: "apartment",
    city: "Aubagne",
    publication_first_seen_at: "2026-04-01T09:00:00.000Z",
    occupation_status: "tenant_occupied",
    source_name: "petites_affiches",
    auction_sale_id: null,
    external_id: String(index),
    source_url: `https://example.test/archive/${index}`,
    lot_label: "Appartement",
    lawyer_label: null,
    legacy_status: "upcoming",
    ...overrides,
  };
}

function fakeRpc(result: { data: unknown; error: { message: string } | null }) {
  const state: { orders: string[]; ranges: Array<[number, number]> } = { orders: [], ranges: [] };
  const query: Record<string, unknown> = {};
  query.order = vi.fn((column: string) => {
    state.orders.push(column);
    return query;
  });
  query.range = vi.fn(async (from: number, to: number) => {
    state.ranges.push([from, to]);
    return result;
  });
  return { query, state };
}

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
