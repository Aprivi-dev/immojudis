import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: Record<string, string> | null; error: { message: string } | null };

const mocks = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  // Une chaîne de requête qui rend le résultat de la table à la fin (`maybeSingle`).
  const chain = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "not", "order", "limit"]) {
      builder[method] = () => builder;
    }
    builder.maybeSingle = async () => {
      const result = mocks.results[table];
      if (result instanceof Error) throw result;
      return result;
    };
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

function answer({
  healthAt,
  collectionAt,
}: {
  healthAt: string | null;
  collectionAt: string | null;
}) {
  mocks.results.operational_job_runs = {
    data: healthAt ? { finished_at: healthAt } : null,
    error: null,
  } satisfies Result;
  mocks.results.auction_source_state = {
    data: collectionAt ? { last_publication_complete_at: collectionAt } : null,
    error: null,
  } satisfies Result;
}

describe("/api/health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.results = {};
    mocks.from.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const call = () => GET(new Request("https://example.test/api/health"));

  it("répond ok (200) quand les deux âges sont dans les seuils, sans cache", async () => {
    answer({ healthAt: ago(7 * 60_000), collectionAt: ago(5 * 3_600_000) });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      checkedAt: NOW.toISOString(),
      operationalHealth: { ageMinutes: 7, maxMinutes: 45, ok: true },
      collection: { ageHours: 5, maxHours: 18, ok: true },
    });
  });

  it("lit les deux sources attendues", async () => {
    answer({ healthAt: ago(60_000), collectionAt: ago(3_600_000) });
    await call();
    expect(mocks.from.mock.calls.map(([table]) => table).sort()).toEqual([
      "auction_source_state",
      "operational_job_runs",
    ]);
  });

  it("est dégradée (503) au-delà de 45 minutes sans succès de operational-health", async () => {
    answer({ healthAt: ago(46 * 60_000), collectionAt: ago(3_600_000) });
    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.operationalHealth).toMatchObject({ ageMinutes: 46, ok: false });
    expect(body.collection.ok).toBe(true);
  });

  it("tolère exactement 45 minutes", async () => {
    answer({ healthAt: ago(45 * 60_000), collectionAt: ago(3_600_000) });
    expect((await call()).status).toBe(200);
  });

  it("est dégradée au-delà de 18 heures sans collecte réussie", async () => {
    answer({ healthAt: ago(60_000), collectionAt: ago(18 * 3_600_000 + 60_000) });
    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.collection).toMatchObject({ ok: false, maxHours: 18 });
    expect(body.operationalHealth.ok).toBe(true);
  });

  it("est dégradée quand aucun succès ni aucune collecte n'existent", async () => {
    answer({ healthAt: null, collectionAt: null });
    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.operationalHealth).toMatchObject({ ageMinutes: null, ok: false });
    expect(body.collection).toMatchObject({ ageHours: null, ok: false });
  });

  it("est dégradée sans rien révéler quand la base répond une erreur", async () => {
    mocks.results.operational_job_runs = {
      data: null,
      error: { message: "connection to 10.0.0.12 refused" },
    };
    mocks.results.auction_source_state = { data: null, error: null };
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await response.json());
    expect(text).toContain("degraded");
    expect(text).not.toContain("10.0.0.12");
    expect(text).not.toContain("refused");
  });

  it("est dégradée quand la lecture lève une exception", async () => {
    mocks.results.operational_job_runs = new Error("boom secret");
    mocks.results.auction_source_state = { data: null, error: null };
    const response = await call();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("ne rend que des âges et des seuils : aucun champ sensible", async () => {
    answer({ healthAt: ago(60_000), collectionAt: ago(3_600_000) });
    const body = await (await call()).json();
    expect(Object.keys(body).sort()).toEqual([
      "checkedAt",
      "collection",
      "operationalHealth",
      "status",
    ]);
    expect(Object.keys(body.operationalHealth).sort()).toEqual(["ageMinutes", "maxMinutes", "ok"]);
    expect(Object.keys(body.collection).sort()).toEqual(["ageHours", "maxHours", "ok"]);
  });
});
