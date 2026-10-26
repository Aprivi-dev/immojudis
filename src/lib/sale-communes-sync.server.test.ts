import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  /** Lignes de `auction_sales` (id + raw_payload->commune). */
  sales: [] as Array<{ id: string; commune: unknown }>,
  /** Lignes déjà présentes de `auction_sale_communes`. */
  stored: [] as Row[],
  /** Identifiants de vente que la base refuse (contrainte), y compris dans un paquet. */
  rejectedSaleIds: new Set<string>(),
  /** Si défini : tout upsert échoue avec cette erreur. */
  upsertError: null as { code?: string; message: string } | null,
  /** Lignes écrites avec succès. */
  written: [] as Row[],
  /** Taille de chaque upsert tenté. */
  upsertSizes: [] as number[],
  throwOnChunk: false,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => {
        const query = {
          eq: () => query,
          order: () => query,
          range: (from: number, to: number) =>
            Promise.resolve({
              data:
                table === "auction_sales"
                  ? db.sales.slice(from, to + 1)
                  : db.stored.slice(from, to + 1),
              error: null,
            }),
        };
        return query;
      },
      upsert: async (rows: Row | Row[]) => {
        const list = Array.isArray(rows) ? rows : [rows];
        db.upsertSizes.push(list.length);
        if (db.upsertError) return { data: null, error: db.upsertError };
        if (db.throwOnChunk && list.length > 1) throw new Error("réseau coupé");
        if (list.some((row) => db.rejectedSaleIds.has(String(row.sale_id)))) {
          return { data: null, error: { code: "23514", message: "violates check constraint" } };
        }
        db.written.push(...list);
        return { data: null, error: null };
      },
    }),
  },
}));

import { pipelineCommuneOf, syncSaleCommunes } from "./sale-communes-sync.server";

const NOW = new Date("2026-11-10T12:00:00.000Z");

beforeEach(() => {
  db.sales = [];
  db.stored = [];
  db.rejectedSaleIds = new Set();
  db.upsertError = null;
  db.written = [];
  db.upsertSizes = [];
  db.throwOnChunk = false;
});

describe("pipelineCommuneOf : paire commune et arrondissement", () => {
  const commune = (insee: string, arrondissement: string | null) =>
    pipelineCommuneOf({ insee, arrondissement_insee: arrondissement, source: "geocode" });

  it("une commune ordinaire n'a pas d'arrondissement, même si le pipeline en envoie un identique", () => {
    expect(commune("33063", "33063")).toEqual({
      insee: "33063",
      arrondissementInsee: null,
      source: "geocode",
    });
    expect(commune("33063", "75108")?.arrondissementInsee).toBeNull();
  });

  it.each([
    ["75056", "75101"],
    ["75056", "75120"],
    ["13055", "13201"],
    ["13055", "13216"],
    ["69123", "69381"],
    ["69123", "69389"],
  ])("garde l'arrondissement valide de sa commune (%s, %s)", (insee, arrondissement) => {
    expect(commune(insee, arrondissement)?.arrondissementInsee).toBe(arrondissement);
  });

  it.each([
    ["75056", "75121"], // hors Paris
    ["75056", "75100"],
    ["75056", "13201"], // arrondissement d'une autre commune
    ["13055", "13217"],
    ["13055", "75108"],
    ["69123", "69380"],
    ["69123", "69390"],
    ["69123", "75108"],
  ])("écarte l'arrondissement incohérent (%s, %s) : arrondissementInsee = null", (insee, arr) => {
    expect(commune(insee, arr)).toEqual({ insee, arrondissementInsee: null, source: "geocode" });
  });

  it("refuse un code commune ou une source invalides", () => {
    expect(commune("3306", null)).toBeNull();
    expect(commune("ZZ063", null)).toBeNull();
    expect(pipelineCommuneOf({ insee: "33063", source: "autre" })).toBeNull();
    expect(pipelineCommuneOf(null)).toBeNull();
    expect(pipelineCommuneOf([])).toBeNull();
  });

  it("accepte la Corse (2A, 2B) et normalise la casse", () => {
    expect(commune(" 2a004 ", null)?.insee).toBe("2A004");
  });
});

describe("syncSaleCommunes", () => {
  it("n'écrit jamais l'arrondissement d'une paire invalide (33063 / 33063)", async () => {
    db.sales = [
      { id: "a", commune: { insee: "33063", arrondissement_insee: "33063", source: "geocode" } },
    ];

    const result = await syncSaleCommunes(NOW);

    expect(result).toMatchObject({ withCode: 1, written: 1, rejected: 0, notMigrated: false });
    expect(db.written[0]).toMatchObject({
      sale_id: "a",
      commune_insee: "33063",
      arrondissement_insee: null,
    });
  });

  it("une ligne refusée par la base est ignorée : le reste du paquet est écrit, la passe continue", async () => {
    db.sales = ["a", "b", "c"].map((id) => ({
      id,
      commune: { insee: "33063", arrondissement_insee: null, source: "reference_communes" },
    }));
    db.rejectedSaleIds = new Set(["b"]);

    const result = await syncSaleCommunes(NOW);

    expect(result).toMatchObject({ withCode: 3, written: 2, rejected: 1 });
    expect(db.written.map((row) => row.sale_id)).toEqual(["a", "c"]);
    // Le paquet de trois a échoué, puis chaque ligne a été retentée seule.
    expect(db.upsertSizes).toEqual([3, 1, 1, 1]);
  });

  it("une exception sur un paquet (réseau) n'annule pas la passe : lignes retentées une à une", async () => {
    db.sales = ["a", "b"].map((id) => ({
      id,
      commune: { insee: "75056", arrondissement_insee: "75108", source: "geocode" },
    }));
    db.throwOnChunk = true;

    const result = await syncSaleCommunes(NOW);

    expect(result).toMatchObject({ written: 2, rejected: 0 });
  });

  it("table absente : migration en retard, rien n'est tenté", async () => {
    db.sales = [{ id: "a", commune: { insee: "33063", source: "geocode" } }];
    db.upsertError = { code: "PGRST205", message: "absente" };
    expect(await syncSaleCommunes(NOW)).toMatchObject({ notMigrated: true, written: 0 });
  });

  it("n'écrit pas ce qui est déjà à jour", async () => {
    db.sales = [
      { id: "a", commune: { insee: "75056", arrondissement_insee: "75108", source: "geocode" } },
    ];
    db.stored = [{ sale_id: "a", commune_insee: "75056", arrondissement_insee: "75108" }];
    const result = await syncSaleCommunes(NOW);
    expect(result).toMatchObject({ withCode: 1, written: 0 });
    expect(db.upsertSizes).toEqual([]);
  });
});
