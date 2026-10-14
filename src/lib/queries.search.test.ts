import { describe, expect, it } from "vitest";
import { getSaleMapPoints, getSales, getSalesForSearch } from "./queries";

describe("Supabase sale search query", () => {
  it.each([false, true])(
    "filters sale types before pagination, including preview=%s",
    async (preview) => {
      const builder = new QueryRecorder();
      await getSales({ sale_venue_type: "notary" }, 12, "price_asc", 24, {
        preview,
        discovery: true,
        client: { from: () => builder } as never,
      });
      expect(builder.calls).toContainEqual(["eq", "sale_venue_type", "notary"]);
      expect(builder.calls).toContainEqual(["range", 24, 35]);
      if (!preview)
        expect(builder.calls).toContainEqual(["order", "coordinates_rank", { ascending: true }]);
      const columns = String(builder.calls.find((call) => call[0] === "select")?.[1]);
      expect(columns).toContain("sale_venue_type");
      expect(columns).toContain("sale_verification_status");
      if (preview) {
        expect(columns).not.toContain("lawyer_contact");
        expect(columns).not.toContain("sale_procedure");
      } else {
        expect(columns).toContain("sale_procedure");
      }
    },
  );

  it("sorts by bedroom count on the server, empty values last", async () => {
    const builder = new QueryRecorder();
    await getSales({}, 24, "beds_desc", 0, { client: { from: () => builder } as never });
    expect(builder.calls).toContainEqual([
      "order",
      "bedrooms_count",
      { ascending: false, nullsFirst: false },
    ]);
  });

  const orderCalls = (builder: QueryRecorder) =>
    builder.calls.filter((call) => call[0] === "order").map((call) => call.slice(1));

  it("classe par défaut: localisées d'abord, palier de complétude, date de vente, puis id", async () => {
    const builder = new QueryRecorder();
    await getSales({}, 24, "completeness_desc", 0, { client: { from: () => builder } as never });
    expect(orderCalls(builder)).toEqual([
      ["coordinates_rank", { ascending: true }],
      ["completeness_tier", { ascending: false, nullsFirst: false }],
      ["sale_date", { ascending: true, nullsFirst: false }],
      ["id", { ascending: true }],
    ]);
  });

  it.each([
    ["date_asc", ["sale_date", { ascending: true, nullsFirst: false }]],
    ["date_desc", ["sale_date", { ascending: false, nullsFirst: false }]],
    ["price_asc", ["starting_price_eur", { ascending: true, nullsFirst: false }]],
    ["price_desc", ["starting_price_eur", { ascending: false, nullsFirst: false }]],
    ["surface_desc", ["app_surface_m2", { ascending: false, nullsFirst: false }]],
    ["beds_desc", ["bedrooms_count", { ascending: false, nullsFirst: false }]],
    ["score_desc", ["investment_score", { ascending: false, nullsFirst: false }]],
  ] as const)(
    "départage toujours par id, y compris pour le tri %s (pagination stable)",
    async (sort, expected) => {
      const builder = new QueryRecorder();
      await getSales({}, 24, sort, 0, { client: { from: () => builder } as never });
      expect(orderCalls(builder)).toEqual([
        ["coordinates_rank", { ascending: true }],
        expected,
        ["id", { ascending: true }],
      ]);
    },
  );

  it("applique le même ordre à la sélection des identifiants (Analyse)", async () => {
    const client = new QueryClient([[{ id: "a" }], [{ id: "a" }]]);
    await getSalesForSearch({}, 24, "completeness_desc", 0, { client: client as never });
    expect(orderCalls(client.builders[0])).toEqual([
      ["coordinates_rank", { ascending: true }],
      ["completeness_tier", { ascending: false, nullsFirst: false }],
      ["sale_date", { ascending: true, nullsFirst: false }],
      ["id", { ascending: true }],
    ]);
    expect(String(client.builders[1].calls.find((call) => call[0] === "select")?.[1])).toContain(
      "completeness_tier",
    );
  });

  it("applique le même ordre, déterministe, à l'offre Découverte", async () => {
    const client = new QueryClient([[{ id: "d" }]]);
    await getSalesForSearch({}, 24, "completeness_desc", 0, {
      discovery: true,
      client: client as never,
    });
    expect(orderCalls(client.builders[0])).toEqual([
      ["coordinates_rank", { ascending: true }],
      ["completeness_tier", { ascending: false, nullsFirst: false }],
      ["sale_date", { ascending: true, nullsFirst: false }],
      ["id", { ascending: true }],
    ]);
  });

  it("ne lit le palier d'une recherche complète que si la carte l'affiche", async () => {
    const withTier = new QueryRecorder();
    await getSales({}, 24, "date_asc", 0, {
      client: { from: () => withTier } as never,
      completenessTier: true,
    });
    const without = new QueryRecorder();
    await getSales({}, 24, "date_asc", 0, { client: { from: () => without } as never });
    const selected = (builder: QueryRecorder) =>
      String(builder.calls.find((call) => call[0] === "select")?.[1]);
    expect(selected(withTier).split(",")).toContain("completeness_tier");
    expect(selected(without).split(",")).not.toContain("completeness_tier");
  });

  it("matches canonical vacant occupancy before pagination", async () => {
    const builder = new QueryRecorder();
    await getSales({ occupancy_status: "free" }, 24, "price_asc", 24, {
      client: { from: () => builder } as never,
    });
    expect(builder.calls).toContainEqual([
      "or",
      "occupancy_status.ilike.%libre%,occupancy_status.ilike.vacant,occupancy_status.ilike.free",
    ]);
    expect(builder.calls).toContainEqual(["range", 24, 47]);
  });

  it("does not treat legacy online entries as an organizer family", async () => {
    const builder = new QueryRecorder();
    await getSales({ sale_venue_type: "unknown" }, 24, "price_asc", 0, {
      client: { from: () => builder } as never,
    });
    expect(builder.calls).toContainEqual(["in", "sale_venue_type", ["unknown", "online"]]);
  });

  it("applies department names, postal codes and accent-tolerant multi-term text filters", async () => {
    const builder = new QueryRecorder();
    const client = { from: () => builder };

    await getSales(
      {
        departments: ["33"],
        postal_code: "33000",
        keywords: "Nimes centre",
      },
      24,
      "score_desc",
      0,
      { client: client as never },
    );

    expect(builder.calls).toContainEqual(["in", "department", ["33", "Gironde"]]);
    expect(builder.calls).toContainEqual(["eq", "postal_code", "33000"]);

    const orFilters = builder.calls
      .filter((call) => call[0] === "or")
      .map((call) => String(call[1]));
    expect(orFilters).toHaveLength(2);
    expect(orFilters[0]).toContain("city.ilike.%nimes%");
    expect(orFilters[0]).toContain("city.ilike.%n_mes%");
    expect(orFilters[1]).toContain("postal_code.ilike.%centre%");
  });

  it("hydrates premium cards from the selected IDs and preserves the first-phase order", async () => {
    const client = new QueryClient([
      [{ id: "first" }, { id: "second" }, { id: "removed" }],
      [{ id: "second" }, { id: "extra" }, { id: "first" }],
    ]);

    const rows = await getSalesForSearch({}, 3, "date_asc", 0, {
      client: client as never,
    });

    expect(rows.map((row) => row.id)).toEqual(["first", "second"]);
    expect(client.builders).toHaveLength(2);
    expect(client.builders[0].calls).toContainEqual(["select", "id"]);
    expect(client.builders[0].calls).toContainEqual(["range", 0, 2]);
    expect(client.builders[1].calls).toContainEqual(["in", "id", ["first", "second", "removed"]]);
    expect(client.builders[1].calls.some((call) => call[0] === "range")).toBe(false);
  });

  it("charge tous les points de la carte, par pages de 1 000, avec des colonnes minimales", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `p-${start + index}` }));
    const client = new QueryClient([page(0, 1000), page(1000, 1000), page(2000, 250)]);

    const rows = await getSaleMapPoints({ city: "Bordeaux" }, { client: client as never });

    expect(rows).toHaveLength(2250);
    expect(client.builders).toHaveLength(3);
    expect(client.builders[1].calls).toContainEqual(["range", 1000, 1999]);
    const calls = client.builders[0].calls;
    expect(calls).toContainEqual(["not", "latitude", "is", null]);
    expect(calls).toContainEqual(["order", "id", { ascending: true }]);
    const columns = String(calls.find((call) => call[0] === "select")?.[1]).split(",");
    expect(columns).toEqual(
      expect.arrayContaining(["id", "latitude", "longitude", "starting_price_eur"]),
    );
    expect(columns.length).toBeLessThanOrEqual(10);
    expect(columns).not.toContain("title");
  });

  it("keeps discovery on one request because its security barrier makes two phases slower", async () => {
    const client = new QueryClient([[{ id: "discovery" }]]);

    await getSalesForSearch({}, 1, "date_asc", 0, {
      discovery: true,
      client: client as never,
    });

    expect(client.builders).toHaveLength(1);
    expect(client.builders[0].calls.some((call) => call[0] === "range")).toBe(true);
    expect(client.builders[0].calls.find((call) => call[0] === "select")?.[1]).not.toBe("id");
  });
});

class QueryClient {
  builders: QueryRecorder[] = [];

  constructor(private readonly responses: unknown[][]) {}

  from() {
    const builder = new QueryRecorder(this.responses[this.builders.length] ?? []);
    this.builders.push(builder);
    return builder;
  }
}

class QueryRecorder implements PromiseLike<{ data: unknown[]; error: null }> {
  calls: unknown[][] = [];

  constructor(private readonly response: unknown[] = []) {}

  select(...args: unknown[]) {
    return this.record("select", ...args);
  }

  order(...args: unknown[]) {
    return this.record("order", ...args);
  }

  range(...args: unknown[]) {
    return this.record("range", ...args);
  }

  limit(...args: unknown[]) {
    return this.record("limit", ...args);
  }

  not(...args: unknown[]) {
    return this.record("not", ...args);
  }

  eq(...args: unknown[]) {
    return this.record("eq", ...args);
  }

  gte(...args: unknown[]) {
    return this.record("gte", ...args);
  }

  lte(...args: unknown[]) {
    return this.record("lte", ...args);
  }

  in(...args: unknown[]) {
    return this.record("in", ...args);
  }

  ilike(...args: unknown[]) {
    return this.record("ilike", ...args);
  }

  or(...args: unknown[]) {
    return this.record("or", ...args);
  }

  then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.response, error: null }).then(onfulfilled, onrejected);
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push([method, ...args]);
    return this;
  }
}
