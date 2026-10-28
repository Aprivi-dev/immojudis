import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; filters: Array<[string, unknown]>; select: string };

const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; filters: Array<[string, unknown]>; select: string }>,
  anilRows: [] as Array<Record<string, unknown>>,
  saleRows: [] as Array<Record<string, unknown>>,
  communeRows: [] as Array<Record<string, unknown>>,
  singleRow: null as Record<string, unknown> | null,
  failTable: null as string | null,
  failCode: undefined as string | undefined,
  configured: true,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcRows: {} as Record<string, unknown[]>,
  rpcError: null as { code?: string } | null,
  /** Lectures en cours en même temps (preuve du parallélisme des lots). */
  running: 0,
  maxRunning: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    supabase: state.configured
      ? { adminUrl: "https://db.test", serviceRoleKey: "service" }
      : { adminUrl: null, serviceRoleKey: null },
  }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: state.rpcRows[name] ?? [], error: null };
    },
    from: (table: string) => {
      const call: Call = { table, filters: [], select: "" };
      state.calls.push(call);
      const result = () => {
        if (state.failTable === table)
          return { data: null, error: Object.assign(new Error("boom"), { code: state.failCode }) };
        if (table === "anil_rents") {
          // Comme PostgREST : seulement les lignes des communes et des segments demandés.
          const codes = (call.filters.find(([column]) => column === "commune_code")?.[1] ??
            []) as string[];
          const segments = (call.filters.find(([column]) => column === "segment")?.[1] ??
            []) as string[];
          return {
            data: state.anilRows.filter(
              (row) =>
                codes.includes(String(row.commune_code)) && segments.includes(String(row.segment)),
            ),
            error: null,
          };
        }
        if (table === "auction_sale_communes") return { data: state.communeRows, error: null };
        return { data: state.saleRows, error: null };
      };
      const query: Record<string, unknown> = {
        select: (columns: string) => {
          call.select = columns;
          return query;
        },
        in: (column: string, values: unknown) => {
          call.filters.push([column, values]);
          return query;
        },
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return query;
        },
        maybeSingle: async () =>
          state.failTable === table
            ? { data: null, error: new Error("boom") }
            : { data: state.singleRow, error: null },
        then: (resolve: (value: unknown) => unknown) => {
          state.running += 1;
          state.maxRunning = Math.max(state.maxRunning, state.running);
          return new Promise((done) => setTimeout(done, 1))
            .then(() => {
              state.running -= 1;
              return result();
            })
            .then(resolve);
        },
      };
      return query;
    },
  },
}));

import {
  createRentLookupSession,
  loadRentLookup,
  loadSaleRentReference,
  rentBasisOf,
  resetRentReferenceCachesForTests,
} from "./rent-reference.server";

const anil = (code: string, segment: string, overrides: Record<string, unknown> = {}) => ({
  commune_code: code,
  segment,
  rent_per_m2: 16,
  rent_low_per_m2: 12,
  rent_high_per_m2: 20,
  prediction_type: "commune",
  observations_commune: 500,
  r2_adj: 0.8,
  vintage: 2025,
  source_updated_on: "2025-12-11",
  ...overrides,
});

const withGeocode = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
  id,
  department: "33",
  property_type: "apartment",
  rooms_count: 2,
  raw_payload: { geocode: { accepted: true, citycode: code } },
  ...extra,
});

const salesTableCalls = () => state.calls.filter((call) => call.table === "auction_sales");
const anilCalls = () => state.calls.filter((call) => call.table === "anil_rents");

beforeEach(() => {
  state.calls = [];
  state.anilRows = [];
  state.saleRows = [];
  state.communeRows = [];
  state.failCode = undefined;
  state.singleRow = null;
  state.failTable = null;
  state.configured = true;
  state.rpcCalls = [];
  state.rpcRows = {};
  state.rpcError = null;
  state.running = 0;
  state.maxRunning = 0;
  resetRentReferenceCachesForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(console.error).mockClear();
});

describe("loadRentLookup", () => {
  it("reads the segment of the commune that the payload names, with the ANIL row's own metadata", async () => {
    state.anilRows = [anil("33063", "apt_1_2", { observations_commune: 12 })];

    const lookup = await loadRentLookup([withGeocode("sale-a", "33063")]);

    expect(lookup({ id: "sale-a" })).toMatchObject({
      source: "anil_commune",
      rentPerM2: 16,
      segment: "apt_1_2",
      communeCode: "33063",
      reliability: "indicative", // 12 observations
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    // The code was in memory: no read of the sales table. The T1-T2 row and the "all apartments" fallback
    // row are read together.
    expect(salesTableCalls()).toEqual([]);
    expect(anilCalls()[0].filters).toEqual([
      ["commune_code", ["33063"]],
      ["segment", ["apt_1_2", "apt_all"]],
    ]);
  });

  it("falls back to the department rent when the commune has no ANIL row", async () => {
    const lookup = await loadRentLookup([withGeocode("sale-a", "33063")]);

    expect(lookup({ id: "sale-a" })).toMatchObject({
      source: "department_estimate",
      rentPerM2: 14,
    });
  });

  it("falls back from a missing apartment segment to all apartments of the same commune, never to houses", async () => {
    state.anilRows = [
      anil("33063", "apt_all", { rent_per_m2: 15 }),
      anil("33063", "house", { rent_per_m2: 9 }),
    ];

    const lookup = await loadRentLookup([
      withGeocode("t3", "33063", { rooms_count: 4 }),
      withGeocode("t2", "33063", { rooms_count: 1 }),
      withGeocode("maison", "33063", { property_type: "house", rooms_count: 5 }),
    ]);

    expect(lookup({ id: "t3" })).toMatchObject({ segment: "apt_all", rentPerM2: 15 });
    expect(lookup({ id: "t2" })).toMatchObject({ segment: "apt_all", rentPerM2: 15 });
    expect(lookup({ id: "maison" })).toMatchObject({ segment: "house", rentPerM2: 9 });

    // A house without a house row is not given an apartment rent: the department rent applies.
    state.anilRows = [anil("33063", "apt_all", { rent_per_m2: 15 })];
    resetRentReferenceCachesForTests();
    const noHouse = await loadRentLookup([
      withGeocode("maison", "33063", { property_type: "house", rooms_count: 5 }),
    ]);
    expect(noHouse({ id: "maison" })?.source).toBe("department_estimate");
  });

  it("prefers the exact segment over the fallback when both exist", async () => {
    state.anilRows = [
      anil("33063", "apt_3p", { rent_per_m2: 12 }),
      anil("33063", "apt_all", { rent_per_m2: 15 }),
    ];

    const lookup = await loadRentLookup([withGeocode("t3", "33063", { rooms_count: 3 })]);

    expect(lookup({ id: "t3" })).toMatchObject({ segment: "apt_3p", rentPerM2: 12 });
  });

  it("gives no reference at all to a property that is not a dwelling, and reads nothing for it", async () => {
    const lookup = await loadRentLookup([
      withGeocode("terrain", "33063", { property_type: "land" }),
      withGeocode("parking", "33063", { property_type: "parking" }),
      withGeocode("immeuble", "33063", { property_type: "building" }),
    ]);

    for (const id of ["terrain", "parking", "immeuble"]) expect(lookup({ id })).toBeNull();
    expect(state.calls).toEqual([]);
  });

  it("reads only the commune fields of the sales loaded without their payload, never the whole object", async () => {
    state.saleRows = [
      { id: "sale-b", postal_code: "69003", citycode: "69123", accepted: "true", commune: null },
    ];
    state.anilRows = [anil("69383", "house")];

    const lookup = await loadRentLookup([
      { id: "SALE-B", department: "69", property_type: "house", rooms_count: 5 },
    ]);

    // Lyon is read as an arrondissement, deduced from the postal code of the sale.
    expect(lookup({ id: "sale-b" })?.communeCode).toBe("69383");
    const select = salesTableCalls()[0].select;
    expect(select).toBe(
      "id,postal_code,citycode:raw_payload->geocode->>citycode,accepted:raw_payload->geocode->>accepted,commune:raw_payload->commune",
    );
    expect(select).not.toMatch(/raw_payload(,|$)/);

    // The code is cached: a second call does not read the sales table again.
    state.calls = [];
    await loadRentLookup([{ id: "sale-b", department: "69", property_type: "house" }]);
    expect(salesTableCalls()).toEqual([]);
  });

  it("uses the arrondissement that the commune lot writes, before the geocode", async () => {
    state.anilRows = [anil("75108", "apt_all")];

    const lookup = await loadRentLookup([
      {
        id: "paris",
        department: "75",
        property_type: "apartment",
        postal_code: "75008",
        raw_payload: {
          commune: { insee: "75056", arrondissement_insee: "75108" },
          geocode: { accepted: true, citycode: "75056" },
        },
      },
    ]);

    expect(lookup({ id: "paris" })?.communeCode).toBe("75108");
  });

  it("prefers the stored commune table to the raw payload, and derives the arrondissement from the postal code", async () => {
    state.anilRows = [anil("33063", "apt_all"), anil("75108", "apt_all")];
    state.saleRows = [
      { id: "stored", postal_code: null, citycode: "33281", accepted: "true", commune: null },
      { id: "paris-centre", postal_code: "75008", citycode: null, accepted: null, commune: null },
      { id: "raw-only", postal_code: null, citycode: "33063", accepted: "true", commune: null },
    ];
    state.communeRows = [
      { sale_id: "stored", commune_insee: "33063", arrondissement_insee: null },
      { sale_id: "paris-centre", commune_insee: "75056", arrondissement_insee: null },
    ];

    const lookup = await loadRentLookup([
      { id: "stored", department: "33", property_type: "apartment" },
      { id: "paris-centre", department: "75", property_type: "apartment" },
      { id: "raw-only", department: "33", property_type: "apartment" },
    ]);

    expect(lookup({ id: "stored" })?.communeCode).toBe("33063");
    expect(lookup({ id: "paris-centre" })?.communeCode).toBe("75108");
    expect(lookup({ id: "raw-only" })?.communeCode).toBe("33063");
  });

  it("keeps reading the raw payload when the commune table does not exist yet", async () => {
    state.anilRows = [anil("33063", "apt_all")];
    state.saleRows = [
      { id: "sale-d", postal_code: null, citycode: "33063", accepted: "true", commune: null },
    ];
    state.failTable = "auction_sale_communes";
    state.failCode = "PGRST205";

    const lookup = await loadRentLookup([
      { id: "sale-d", department: "33", property_type: "apartment" },
    ]);

    expect(lookup({ id: "sale-d" })?.communeCode).toBe("33063");
  });

  it("serves the department rent to a sale whose geocode is rejected or missing", async () => {
    state.saleRows = [
      { id: "sale-c", postal_code: null, citycode: "33063", accepted: "false", commune: null },
    ];

    const lookup = await loadRentLookup([
      { id: "sale-c", department: "33", property_type: "apartment", rooms_count: 3 },
    ]);

    expect(lookup({ id: "sale-c" })?.source).toBe("department_estimate");
    expect(anilCalls()).toEqual([]);
  });

  it("never throws: an unreadable table leaves every sale on the caller's department fallback", async () => {
    state.failTable = "anil_rents";

    const lookup = await loadRentLookup([withGeocode("sale-a", "33063")]);

    expect(lookup({ id: "sale-a" })).toBeNull();
  });

  it("does not remember a failure: the next call tries again", async () => {
    state.failTable = "anil_rents";
    const session = createRentLookupSession();
    await session.load([withGeocode("sale-a", "33063")]);
    state.failTable = null;
    state.anilRows = [anil("33063", "apt_1_2")];

    const lookup = await session.load([withGeocode("sale-a", "33063")]);

    expect(lookup({ id: "sale-a" })?.source).toBe("anil_commune");
  });

  it("reads nothing when the service role is not configured or there is no sale", async () => {
    state.configured = false;
    const unconfigured = await loadRentLookup([withGeocode("sale-a", "33063")]);
    expect(unconfigured({ id: "sale-a" })).toBeNull();
    state.configured = true;
    await loadRentLookup([]);
    expect(state.calls).toEqual([]);
  });

  it("asks for each commune once, however many sales share it", async () => {
    state.anilRows = [anil("33063", "apt_all")];

    await loadRentLookup([
      withGeocode("a", "33063", { rooms_count: null }),
      withGeocode("b", "33063", { rooms_count: null }),
    ]);

    expect(anilCalls()).toHaveLength(1);
    expect(anilCalls()[0].filters[0]).toEqual(["commune_code", ["33063"]]);
  });

  it("keeps the ANIL rows for six hours, including the absence of a row", async () => {
    state.anilRows = [anil("33063", "apt_all")];
    await loadRentLookup([withGeocode("a", "33063", { rooms_count: null })]);
    await loadRentLookup([
      withGeocode("b", "33063", { rooms_count: null }),
      withGeocode("c", "17300", { rooms_count: null }),
    ]);
    // 17300 had no row: asked once, then remembered as absent.
    await loadRentLookup([withGeocode("d", "17300", { rooms_count: null })]);

    expect(anilCalls().map((call) => call.filters[0])).toEqual([
      ["commune_code", ["33063"]],
      ["commune_code", ["17300"]],
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 3_600_000 + 1_000);
    try {
      await loadRentLookup([withGeocode("e", "33063", { rooms_count: null })]);
    } finally {
      vi.useRealTimers();
    }
    expect(anilCalls()).toHaveLength(3);
  });

  it("reads the batches in parallel", async () => {
    const sales = Array.from({ length: 450 }, (_, index) =>
      withGeocode(`sale-${index}`, `${10000 + index}`, { rooms_count: null }),
    );

    await loadRentLookup(sales);

    // 450 communes = 3 batches of 150, read together.
    expect(anilCalls()).toHaveLength(3);
    expect(state.maxRunning).toBeGreaterThan(1);
  });
});

describe("fallbacks before the hard-coded department table", () => {
  const sale = (id: string, code: string, extra: Record<string, unknown> = {}) =>
    withGeocode(id, code, { rooms_count: 3, ...extra });

  it("tries the successor code of a merged commune, as an indicative reference", async () => {
    state.rpcRows.commune_code_aliases = [
      { code: "02077", alias: "02564", direction: "new", depth: 1 },
    ];
    state.anilRows = [anil("02564", "apt_3p", { rent_per_m2: 9.5 })];

    const lookup = await loadRentLookup([sale("sale-a", "02077", { department: "02" })]);

    expect(lookup({ id: "sale-a" })).toMatchObject({
      source: "anil_commune",
      communeCode: "02564",
      rentPerM2: 9.5,
      reliability: "indicative", // 500 observations and a good R², but not the commune the sale names
    });
    expect(state.rpcCalls[0]).toEqual({
      name: "commune_code_aliases",
      args: { p_codes: ["02077"] },
    });
  });

  it("tries the old code when the sale already carries the new one, new codes first", async () => {
    state.rpcRows.commune_code_aliases = [
      { code: "02564", alias: "02077", direction: "old", depth: 1 },
      { code: "02564", alias: "02999", direction: "new", depth: 1 },
    ];
    state.anilRows = [
      anil("02077", "apt_3p", { rent_per_m2: 8 }),
      anil("02999", "apt_3p", { rent_per_m2: 12 }),
    ];

    const lookup = await loadRentLookup([sale("sale-a", "02564", { department: "02" })]);
    expect(lookup({ id: "sale-a" })?.rentPerM2).toBe(12);

    resetRentReferenceCachesForTests();
    state.anilRows = [anil("02077", "apt_3p", { rent_per_m2: 8 })];
    const older = await loadRentLookup([sale("sale-b", "02564", { department: "02" })]);
    expect(older({ id: "sale-b" })).toMatchObject({ communeCode: "02077", rentPerM2: 8 });
  });

  it("does not look for an alias when the commune has its own ANIL row", async () => {
    state.anilRows = [anil("33063", "apt_3p")];

    await loadRentLookup([sale("sale-a", "33063")]);

    expect(state.rpcCalls.map((call) => call.name)).toEqual([]);
  });

  it("gives Paris, Lyon and Marseille without arrondissement the median of their arrondissements", async () => {
    state.anilRows = [
      anil("75101", "apt_3p", { rent_per_m2: 30, vintage: 2025 }),
      anil("75102", "apt_3p", { rent_per_m2: 34 }),
      anil("75103", "apt_3p", { rent_per_m2: 40 }),
      anil("75104", "apt_3p", { rent_per_m2: 36 }),
    ];

    const lookup = await loadRentLookup([sale("sale-a", "75056", { department: "75" })]);

    expect(lookup({ id: "sale-a" })).toMatchObject({
      source: "anil_arrondissements_median",
      rentPerM2: 35,
      reliability: "indicative",
      segment: "apt_3p",
      communeCode: "75056",
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    const read = anilCalls().at(-1);
    expect(read?.filters[0]).toEqual([
      "commune_code",
      Array.from({ length: 20 }, (_, index) => `751${String(index + 1).padStart(2, "0")}`),
    ]);
  });

  it("falls back from the segment to all apartments when computing the median of the arrondissements", async () => {
    state.anilRows = [
      anil("13201", "apt_all", { rent_per_m2: 14 }),
      anil("13202", "apt_all", { rent_per_m2: 16 }),
    ];

    const lookup = await loadRentLookup([sale("sale-a", "13055", { department: "13" })]);

    expect(lookup({ id: "sale-a" })).toMatchObject({ rentPerM2: 15, segment: "apt_all" });
  });

  it("computes the department median on the map before the hard-coded table, Corsica included", async () => {
    state.rpcRows.anil_department_medians = [
      {
        department_code: "2A",
        segment: "apt_3p",
        rent_per_m2: 13.5,
        communes: 120,
        vintage: 2025,
        source_updated_on: "2025-12-11",
      },
    ];

    const lookup = await loadRentLookup([
      {
        id: "sale-a",
        department: "2A",
        property_type: "apartment",
        rooms_count: 3,
        raw_payload: {},
      },
    ]);

    expect(lookup({ id: "sale-a" })).toMatchObject({
      source: "anil_department_median",
      rentPerM2: 13.5,
      reliability: "indicative",
      segment: "apt_3p",
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    expect(state.rpcCalls).toContainEqual({
      name: "anil_department_medians",
      args: { p_departments: ["2A"] },
    });
  });

  it("keeps the hard-coded table when the map has no median, and nothing for Mayotte", async () => {
    const lookup = await loadRentLookup([
      {
        id: "sale-a",
        department: "33",
        property_type: "apartment",
        rooms_count: 3,
        raw_payload: {},
      },
      {
        id: "sale-b",
        department: "976",
        property_type: "apartment",
        rooms_count: 3,
        raw_payload: {},
      },
      {
        id: "sale-c",
        department: "23",
        property_type: "apartment",
        rooms_count: 3,
        raw_payload: {},
      },
    ]);

    expect(lookup({ id: "sale-a" })).toMatchObject({
      source: "department_estimate",
      rentPerM2: 14,
    });
    // Mayotte is excluded from the ANIL map and absent from the table: no rent, assumed.
    expect(lookup({ id: "sale-b" })).toBeNull();
    expect(lookup({ id: "sale-c" })).toBeNull();
  });

  it("reads the medians of each department once, whatever the number of sales", async () => {
    state.rpcRows.anil_department_medians = [
      {
        department_code: "23",
        segment: "apt_all",
        rent_per_m2: 7,
        communes: 4,
        vintage: 2025,
        source_updated_on: null,
      },
    ];
    const facts = (id: string) => ({
      id,
      department: "23",
      property_type: "apartment",
      rooms_count: null,
      raw_payload: {},
    });

    await loadRentLookup([facts("sale-a"), facts("sale-b"), facts("sale-c")]);
    await loadRentLookup([facts("sale-d")]);

    expect(state.rpcCalls.filter((call) => call.name === "anil_department_medians")).toHaveLength(
      1,
    );
  });

  it("treats a function that is not migrated yet as no fallback, silently", async () => {
    state.rpcError = { code: "PGRST202" };

    const lookup = await loadRentLookup([
      sale("sale-a", "33063"),
      {
        id: "sale-b",
        department: "23",
        property_type: "apartment",
        rooms_count: 3,
        raw_payload: {},
      },
    ]);

    expect(lookup({ id: "sale-a" })).toMatchObject({ source: "department_estimate" });
    expect(lookup({ id: "sale-b" })).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps the communes it found when an optional fallback fails", async () => {
    state.rpcError = { code: "XX000" };
    state.anilRows = [anil("33063", "apt_3p")];

    const lookup = await loadRentLookup([
      sale("sale-a", "33063"),
      sale("sale-b", "02077", { department: "02" }),
    ]);

    expect(lookup({ id: "sale-a" })?.source).toBe("anil_commune");
    expect(lookup({ id: "sale-b" })).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("rent lookup session", () => {
  it("loads each sale once, even when two callers ask at the same time", async () => {
    state.anilRows = [anil("33063", "apt_all")];
    const session = createRentLookupSession();
    const sale = withGeocode("sale-a", "33063", { rooms_count: null });

    const [first, second] = await Promise.all([session.load([sale]), session.load([sale])]);
    await session.load([sale]);

    expect(anilCalls()).toHaveLength(1);
    expect(first({ id: "sale-a" })).toEqual(second({ id: "sale-a" }));
  });

  it("covers the sales loaded earlier in the session with the same lookup", async () => {
    state.anilRows = [anil("33063", "apt_all"), anil("69383", "apt_all")];
    const session = createRentLookupSession();
    await session.load([withGeocode("a", "33063", { rooms_count: null })]);

    const lookup = await session.load([withGeocode("b", "69383", { rooms_count: null })]);

    expect(lookup({ id: "a" })?.communeCode).toBe("33063");
    expect(lookup({ id: "b" })?.communeCode).toBe("69383");
  });
});

describe("loadSaleRentReference", () => {
  it("resolves the reference of the sale it is given, reading only the commune code", async () => {
    state.saleRows = [
      { id: "sale-a", postal_code: "33000", citycode: "33063", accepted: "true", commune: null },
    ];
    state.anilRows = [anil("33063", "apt_3p")];

    await expect(
      loadSaleRentReference({
        id: "sale-a",
        department: "33",
        property_type: "apartment",
        rooms_count: 4,
      }),
    ).resolves.toMatchObject({ source: "anil_commune", segment: "apt_3p" });
    // The facts came from the sale: the row is not read for them (only the commune code is).
    expect(salesTableCalls()).toHaveLength(1);
    expect(salesTableCalls()[0].select).toContain("citycode:raw_payload->geocode->>citycode");
  });

  it("does not read the sale again for the report that follows the page", async () => {
    state.saleRows = [
      { id: "sale-a", postal_code: "33000", citycode: "33063", accepted: "true", commune: null },
    ];
    state.anilRows = [anil("33063", "apt_3p")];
    const sale = { id: "sale-a", department: "33", property_type: "apartment", rooms_count: 4 };

    const page = await loadSaleRentReference(sale);
    state.calls = [];
    const report = await loadSaleRentReference(sale);

    expect(report).toEqual(page);
    expect(salesTableCalls()).toEqual([]);
  });

  it("reads the facts of an identifier given alone", async () => {
    state.singleRow = {
      id: "sale-a",
      department: "33",
      property_type: "apartment",
      rooms_count: 4,
      postal_code: "33000",
    };
    state.saleRows = [
      { id: "sale-a", postal_code: "33000", citycode: "33063", accepted: "true", commune: null },
    ];
    state.anilRows = [anil("33063", "apt_3p")];

    await expect(loadSaleRentReference("sale-a")).resolves.toMatchObject({ segment: "apt_3p" });
  });

  it("returns null for an unknown sale, an unreadable base or a missing configuration", async () => {
    await expect(loadSaleRentReference("missing")).resolves.toBeNull();
    state.failTable = "auction_sales";
    await expect(loadSaleRentReference("sale-a")).resolves.toBeNull();
    state.configured = false;
    await expect(loadSaleRentReference("sale-a")).resolves.toBeNull();
  });
});

describe("rentBasisOf", () => {
  const reference = (source: string) => ({ rentPerM2: 12, source, reliability: "reliable" });
  const sale = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    department: "33",
    property_type: "apartment",
    ...extra,
  });
  const lookupOf = (table: Record<string, unknown>) => (item: { id: string }) =>
    (table[item.id] ?? null) as never;

  it("says whether the yields come from the ANIL, the department table, or both", () => {
    const rents = lookupOf({ a: reference("anil_commune"), b: reference("anil_epci") });
    expect(rentBasisOf([sale("a"), sale("b")], rents)).toBe("anil");

    const mixed = lookupOf({ a: reference("anil_commune"), b: reference("department_estimate") });
    expect(rentBasisOf([sale("a"), sale("b")], mixed)).toBe("mixed");
    // A sale with no reference in the lookup still has the department rent when its department has one.
    expect(rentBasisOf([sale("a"), sale("c")], lookupOf({ a: reference("anil_commune") }))).toBe(
      "mixed",
    );

    expect(rentBasisOf([sale("a")], undefined)).toBe("department");
    expect(rentBasisOf([], undefined)).toBe("department");
  });

  it("does not count a property without a rent reference", () => {
    const rents = lookupOf({ a: reference("anil_commune") });
    const sales = [
      sale("a"),
      sale("land", { property_type: "land" }),
      // Department 23 has no department rent: no yield, so no vote.
      sale("creuse", { department: "23" }),
    ];

    expect(rentBasisOf(sales, rents)).toBe("anil");
  });
});
