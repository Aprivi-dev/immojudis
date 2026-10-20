import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result = {
  data: Record<string, string | null> | Array<Record<string, string | null>> | null;
  error: { message: string } | null;
};

const mocks = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  from: vi.fn(),
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  // Une chaîne de requête qui rend le résultat de la table à la fin (`maybeSingle`).
  const chain = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "not", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        mocks.calls.push({ table, method, args });
        return builder;
      };
    }
    const settle = async () => {
      const result = mocks.results[table];
      if (result instanceof Error) throw result;
      return result;
    };
    builder.maybeSingle = settle;
    // Une requête sans `maybeSingle` (liste de lignes) se termine par un `await`.
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      settle().then(resolve, reject);
    return builder;
  };
  return {
    supabaseAdmin: {
      from: (table: string) => {
        mocks.from(table);
        return chain(table);
      },
    },
  };
});

import { GET } from "./route";

const NOW = new Date("2026-10-20T12:00:00.000Z");

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString();
}

/** `collections` : la dernière publication complète de chaque source ACTIVÉE (`null` : jamais). */
function answer({
  healthAt,
  collections,
}: {
  healthAt: string | null;
  collections: Array<string | null>;
}) {
  mocks.results.operational_job_runs = {
    data: healthAt ? { finished_at: healthAt } : null,
    error: null,
  } satisfies Result;
  mocks.results.auction_source_state = {
    data: collections.map((at) => ({ last_publication_complete_at: at })),
    error: null,
  } satisfies Result;
}

describe("/api/health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.results = {};
    mocks.from.mockReset();
    mocks.calls = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const call = () => GET(new Request("https://example.test/api/health"));

  it("répond ok (200) quand les âges sont dans les seuils, avec une garde de 30 s du CDN", async () => {
    answer({ healthAt: ago(7 * 60_000), collections: [ago(5 * 3_600_000), ago(2 * 3_600_000)] });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
    // Une réponse gardée serait servie à d'autres appelants : l'identifiant de requête n'y figure pas.
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(await response.json()).toEqual({
      status: "ok",
      checkedAt: NOW.toISOString(),
      operationalHealth: { ageMinutes: 7, maxMinutes: 45, ok: true },
      collection: { ageHours: 5, maxHours: 36, ok: true, enabledSources: 2, lateSources: 0 },
    });
  });

  it("lit les deux sources attendues, et seulement les sources activées", async () => {
    answer({ healthAt: ago(60_000), collections: [ago(3_600_000)] });
    await call();
    expect(mocks.from.mock.calls.map(([table]) => table).sort()).toEqual([
      "auction_source_state",
      "operational_job_runs",
    ]);
    expect(
      mocks.calls.filter((call) => call.table === "auction_source_state" && call.method === "eq"),
    ).toEqual([{ table: "auction_source_state", method: "eq", args: ["enabled", true] }]);
  });

  it("est dégradée (503) au-delà de 45 minutes sans succès de operational-health", async () => {
    answer({ healthAt: ago(46 * 60_000), collections: [ago(3_600_000)] });
    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.operationalHealth).toMatchObject({ ageMinutes: 46, ok: false });
    expect(body.collection.ok).toBe(true);
  });

  it("tolère exactement 45 minutes", async () => {
    answer({ healthAt: ago(45 * 60_000), collections: [ago(3_600_000)] });
    expect((await call()).status).toBe(200);
  });

  it("tolère une collecte de 20 heures (au-delà de l'alerte de 18 h, sous le seuil de 36 h)", async () => {
    answer({ healthAt: ago(60_000), collections: [ago(20 * 3_600_000)] });
    expect((await call()).status).toBe(200);
  });

  it("est dégradée dès qu'UNE source activée n'a pas de publication complète depuis plus de 36 heures", async () => {
    // Les autres sources sont fraîches : l'ancien calcul (la plus récente) disait « ok ».
    answer({
      healthAt: ago(60_000),
      collections: [ago(3_600_000), ago(36 * 3_600_000 + 60_000), ago(2 * 3_600_000)],
    });
    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.collection).toMatchObject({
      ok: false,
      maxHours: 36,
      ageHours: 36,
      enabledSources: 3,
      lateSources: 1,
    });
    expect(body.operationalHealth.ok).toBe(true);
  });

  it("est dégradée quand une source activée n'a jamais de publication complète", async () => {
    answer({ healthAt: ago(60_000), collections: [ago(3_600_000), null] });
    const response = await call();
    expect(response.status).toBe(503);
    expect((await response.json()).collection).toMatchObject({
      ok: false,
      ageHours: 1,
      enabledSources: 2,
      lateSources: 1,
    });
  });

  it("est dégradée quand aucune source n'est activée", async () => {
    answer({ healthAt: ago(60_000), collections: [] });
    const response = await call();
    expect(response.status).toBe(503);
    expect((await response.json()).collection).toMatchObject({
      ok: false,
      ageHours: null,
      enabledSources: 0,
    });
  });

  it("est dégradée quand aucun succès n'existe", async () => {
    answer({ healthAt: null, collections: [null] });
    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.operationalHealth).toMatchObject({ ageMinutes: null, ok: false });
    expect(body.collection).toMatchObject({ ageHours: null, ok: false });
  });

  it("est dégradée sans rien révéler quand la lecture des sources répond une erreur", async () => {
    mocks.results.operational_job_runs = { data: { finished_at: ago(60_000) }, error: null };
    mocks.results.auction_source_state = {
      data: null,
      error: { message: "relation secret_table missing" },
    };
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("secret_table");
  });

  it("est dégradée sans rien révéler quand la base répond une erreur", async () => {
    mocks.results.operational_job_runs = {
      data: null,
      error: { message: "connection to 10.0.0.12 refused" },
    };
    mocks.results.auction_source_state = { data: [], error: null };
    const response = await call();
    expect(response.status).toBe(503);
    // Une erreur n'est jamais gardée par le CDN.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await response.json());
    expect(text).toContain("degraded");
    expect(text).not.toContain("10.0.0.12");
    expect(text).not.toContain("refused");
  });

  it("est dégradée quand la lecture lève une exception", async () => {
    mocks.results.operational_job_runs = new Error("boom secret");
    mocks.results.auction_source_state = { data: [], error: null };
    const response = await call();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("ne rend que des âges et des seuils : aucun champ sensible", async () => {
    answer({ healthAt: ago(60_000), collections: [ago(3_600_000)] });
    const body = await (await call()).json();
    expect(Object.keys(body).sort()).toEqual([
      "checkedAt",
      "collection",
      "operationalHealth",
      "status",
    ]);
    expect(Object.keys(body.operationalHealth).sort()).toEqual(["ageMinutes", "maxMinutes", "ok"]);
    expect(Object.keys(body.collection).sort()).toEqual([
      "ageHours",
      "enabledSources",
      "lateSources",
      "maxHours",
      "ok",
    ]);
    // Aucun nom de source.
    expect(JSON.stringify(body)).not.toMatch(/licitor|vench|notaires|source_name/i);
  });
});
