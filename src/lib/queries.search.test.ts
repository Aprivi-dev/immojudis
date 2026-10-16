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

  describe("base sans la colonne completeness_tier (migration pas encore appliquée)", () => {
    const missingTier = {
      code: "42703",
      message: "column v_auction_sales_discovery_search.completeness_tier does not exist",
    };
    const selected = (builder: QueryRecorder) =>
      String(builder.calls.find((call) => call[0] === "select")?.[1]).split(",");

    it("relance la recherche sans la colonne ni ce tri (offre Découverte)", async () => {
      const client = new QueryClient([[], [{ id: "d" }]], [missingTier]);
      const rows = await getSalesForSearch({}, 24, "completeness_desc", 0, {
        discovery: true,
        client: client as never,
      });
      expect(rows.map((row) => row.id)).toEqual(["d"]);
      expect(client.builders).toHaveLength(2);
      expect(selected(client.builders[0])).toContain("completeness_tier");
      expect(selected(client.builders[1])).not.toContain("completeness_tier");
      expect(orderCalls(client.builders[1])).toEqual([
        ["coordinates_rank", { ascending: true }],
        ["sale_date", { ascending: true, nullsFirst: false }],
        ["id", { ascending: true }],
      ]);
    });

    it("relance les deux phases de l'offre Analyse sans la colonne", async () => {
      const client = new QueryClient(
        [[], [{ id: "a" }], [{ id: "a" }]],
        [{ code: "PGRST204", message: "Could not find the 'completeness_tier' column" }],
      );
      const rows = await getSalesForSearch({}, 24, "completeness_desc", 0, {
        client: client as never,
      });
      expect(rows.map((row) => row.id)).toEqual(["a"]);
      expect(client.builders).toHaveLength(3);
      expect(orderCalls(client.builders[1]).flat().join()).not.toContain("completeness_tier");
      expect(selected(client.builders[2])).not.toContain("completeness_tier");
    });

    it("relance une recherche complète qui lisait le palier", async () => {
      const client = new QueryClient([[], [{ id: "s" }]], [missingTier]);
      await getSales({}, 24, "date_asc", 0, {
        client: client as never,
        completenessTier: true,
      });
      expect(client.builders).toHaveLength(2);
      expect(selected(client.builders[0])).toContain("completeness_tier");
      expect(selected(client.builders[1])).not.toContain("completeness_tier");
    });

    it("ne masque ni une autre colonne absente ni une autre erreur", async () => {
      const otherColumn = { code: "42703", message: "column foo.bar does not exist" };
      for (const failure of [
        otherColumn,
        { code: "57014", message: "completeness_tier timeout" },
      ]) {
        const client = new QueryClient([[]], [failure]);
        await expect(
          getSalesForSearch({}, 24, "completeness_desc", 0, {
            discovery: true,
            client: client as never,
          }),
        ).rejects.toEqual(failure);
        expect(client.builders).toHaveLength(1);
      }
    });
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
    const client = new PointsClient(2250);

    const rows = await getSaleMapPoints({ city: "Bordeaux" }, { client: client as never });

    expect(rows.map((row) => (row as { id: string }).id)).toEqual(
      Array.from({ length: 2250 }, (_, index) => `p-${index}`),
    );
    const pages = client.builders.filter((builder) => !builder.isCount);
    expect(pages).toHaveLength(3);
    expect(pages.map((builder) => builder.calls.find((call) => call[0] === "range"))).toEqual([
      ["range", 0, 999],
      ["range", 1000, 1999],
      ["range", 2000, 2999],
    ]);
    const calls = pages[0].calls;
    expect(calls).toContainEqual(["not", "latitude", "is", null]);
    expect(calls).toContainEqual(["order", "id", { ascending: true }]);
    const columns = String(calls.find((call) => call[0] === "select")?.[1]).split(",");
    expect(columns).toEqual(
      expect.arrayContaining(["id", "latitude", "longitude", "starting_price_eur"]),
    );
    expect(columns.length).toBeLessThanOrEqual(10);
    expect(columns).not.toContain("title");
  });

  it("compte les points avec les mêmes filtres que la lecture, sur la même vue", async () => {
    const client = new PointsClient(1500);

    await getSaleMapPoints({ city: "Bordeaux" }, { client: client as never });

    const [count] = client.builders.filter((builder) => builder.isCount);
    expect(client.builders.filter((builder) => builder.isCount)).toHaveLength(1);
    expect(count.calls).toContainEqual(["select", "id", { count: "exact", head: true }]);
    expect(count.calls).toContainEqual(["not", "latitude", "is", null]);
    expect(count.calls).toContainEqual(["not", "longitude", "is", null]);
    const filters = (builder: QueryRecorder) =>
      builder.calls.filter((call) => call[0] === "ilike" || call[0] === "not");
    const [firstPage] = client.builders.filter((builder) => !builder.isCount);
    expect(filters(count)).toEqual(filters(firstPage));
    expect(new Set(client.views).size).toBe(1);
  });

  it.each([0, 999, 1000, 1001, 5000, 10_000, 10_500])(
    "rend les mêmes points pour %i lignes qu'une lecture en série, avec un total juste, faux ou en échec",
    async (size) => {
      const expected = Array.from({ length: Math.min(size, 10_000) }, (_, index) => `p-${index}`);
      for (const count of [size, Math.max(0, size - 1500), size + 3000, "fails"] as const) {
        const client = new PointsClient(size, count);
        const rows = await getSaleMapPoints({}, { client: client as never });
        expect(
          rows.map((row) => (row as { id: string }).id),
          `${size} / ${count}`,
        ).toEqual(expected);
      }
    },
  );

  it("n'ouvre jamais plus de quatre lectures de pages à la fois", async () => {
    const client = new PointsClient(10_000);

    await getSaleMapPoints({}, { client: client as never });

    expect(client.peak).toBeLessThanOrEqual(4);
    expect(client.peak).toBeGreaterThan(1);
  });

  it("propage l'échec d'une page de la carte", async () => {
    const client = new PointsClient(5000, 5000, { failPageAt: 2000 });

    await expect(getSaleMapPoints({}, { client: client as never })).rejects.toMatchObject({
      message: "page en échec",
    });
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

  /** `failures[i]` : erreur renvoyée par la i-ème requête (aucune par défaut). */
  constructor(
    private readonly responses: unknown[][],
    private readonly failures: unknown[] = [],
  ) {}

  from() {
    const builder = new QueryRecorder(
      this.responses[this.builders.length] ?? [],
      this.failures[this.builders.length] ?? null,
    );
    this.builders.push(builder);
    return builder;
  }
}

/** Une table de `size` points (`p-0`…), lue par pages (`range`) ou comptée (`head`). */
class PointsClient {
  builders: PointsQuery[] = [];
  views: string[] = [];
  peak = 0;
  private inFlight = 0;

  constructor(
    private readonly size: number,
    private readonly count: number | "fails" = size,
    private readonly options: { failPageAt?: number } = {},
  ) {}

  from(view: string) {
    this.views.push(view);
    const builder = new PointsQuery(this.size, this.count, this.options, {
      start: () => {
        this.inFlight += 1;
        this.peak = Math.max(this.peak, this.inFlight);
      },
      end: () => {
        this.inFlight -= 1;
      },
    });
    this.builders.push(builder);
    return builder;
  }
}

class PointsQuery {
  calls: unknown[][] = [];

  constructor(
    private readonly size: number,
    private readonly count: number | "fails",
    private readonly options: { failPageAt?: number },
    private readonly gauge: { start: () => void; end: () => void },
  ) {}

  get isCount() {
    return this.calls.some((call) => call[0] === "select" && (call[2] as { head?: boolean })?.head);
  }

  select(...args: unknown[]) {
    return this.record("select", ...args);
  }
  order(...args: unknown[]) {
    return this.record("order", ...args);
  }
  range(...args: unknown[]) {
    return this.record("range", ...args);
  }
  not(...args: unknown[]) {
    return this.record("not", ...args);
  }
  ilike(...args: unknown[]) {
    return this.record("ilike", ...args);
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.answer().then(onfulfilled, onrejected);
  }

  private async answer() {
    this.gauge.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (this.isCount) {
        return this.count === "fails"
          ? { data: null, count: null, error: new Error("décompte indisponible") }
          : { data: null, count: this.count, error: null };
      }
      const range = this.calls.find((call) => call[0] === "range") as number[];
      if (range[1] === this.options.failPageAt)
        return { data: null, error: new Error("page en échec") };
      const end = Math.min(range[2] + 1, this.size);
      const data = Array.from({ length: Math.max(0, end - range[1]) }, (_, index) => ({
        id: `p-${range[1] + index}`,
      }));
      return { data, error: null };
    } finally {
      this.gauge.end();
    }
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push([method, ...args]);
    return this;
  }
}

class QueryRecorder implements PromiseLike<{ data: unknown[]; error: unknown }> {
  calls: unknown[][] = [];

  constructor(
    private readonly response: unknown[] = [],
    private readonly failure: unknown = null,
  ) {}

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

  then<TResult1 = { data: unknown[]; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown[]; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({
      data: this.failure ? null : this.response,
      error: this.failure,
    } as { data: unknown[]; error: unknown }).then(onfulfilled, onrejected);
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push([method, ...args]);
    return this;
  }
}
