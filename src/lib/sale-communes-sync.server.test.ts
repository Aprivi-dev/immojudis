import { beforeEach, describe, expect, it, vi } from "vitest";

type DbError = { code?: string; message: string } | null;

const db = vi.hoisted(() => ({
  /** Réponse de `sync_sale_communes()` : une ligne de trois compteurs. */
  counts: { n_with_code: 0, n_changed: 0, n_written: 0 },
  /** Erreur de la fonction (`PGRST202` : migration en retard). */
  rpcError: null as DbError,
  /** Erreur de la lecture de contrôle de la table (fonction absente seulement). */
  probeError: null as DbError,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  tables: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: unknown) => {
      db.rpcCalls.push({ name, args });
      if (db.rpcError) return { data: null, error: db.rpcError };
      return { data: [db.counts], error: null };
    },
    from: (table: string) => ({
      select: () => ({
        limit: async () => {
          db.tables.push(table);
          return db.probeError ? { data: null, error: db.probeError } : { data: [], error: null };
        },
      }),
    }),
  },
}));

import { pipelineCommuneOf, syncSaleCommunes } from "./sale-communes-sync.server";

const NOW = new Date("2026-11-10T12:00:00.000Z");

beforeEach(() => {
  db.counts = { n_with_code: 0, n_changed: 0, n_written: 0 };
  db.rpcError = null;
  db.probeError = null;
  db.rpcCalls = [];
  db.tables = [];
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

describe("syncSaleCommunes : recopie faite dans la base", () => {
  it("une seule instruction SQL, sans relire raw_payload ni écrire ligne à ligne", async () => {
    db.counts = { n_with_code: 1800, n_changed: 12, n_written: 12 };

    const result = await syncSaleCommunes(NOW);

    expect(result).toEqual({
      withCode: 1800,
      written: 12,
      deferred: 0,
      rejected: 0,
      busy: false,
      notMigrated: false,
    });
    expect(db.rpcCalls).toEqual([{ name: "sync_sale_communes", args: undefined }]);
    expect(db.tables).toEqual([]);
  });

  it("les lignes à écrire que la base a sautées (vente verrouillée) sont comptées « différées »", async () => {
    db.counts = { n_with_code: 10, n_changed: 5, n_written: 3 };
    expect(await syncSaleCommunes(NOW)).toMatchObject({ written: 3, deferred: 2, busy: false });
  });

  it("rien à écrire : aucune ligne écrite", async () => {
    db.counts = { n_with_code: 1800, n_changed: 0, n_written: 0 };
    expect(await syncSaleCommunes(NOW)).toMatchObject({ withCode: 1800, written: 0, deferred: 0 });
  });

  it.each(["57014", "55P03", "40P01"])(
    "verrou ou délai (%s) : la recopie est reportée à la passe suivante, la passe n'échoue pas",
    async (code) => {
      db.rpcError = { code, message: "canceling statement due to statement timeout" };
      expect(await syncSaleCommunes(NOW)).toMatchObject({
        busy: true,
        written: 0,
        notMigrated: false,
      });
    },
  );

  it("une autre erreur de la base fait échouer la passe, avec son code seul", async () => {
    db.rpcError = { code: "42501", message: "permission denied for table auction_sales" };
    const failure = await syncSaleCommunes(NOW).catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Synchronisation des communes refusée (code 42501)");
  });

  it("fonction absente (migration en retard) mais table présente : recopie sautée, la passe continue", async () => {
    db.rpcError = { code: "PGRST202", message: "Could not find the function" };
    expect(await syncSaleCommunes(NOW)).toMatchObject({ notMigrated: false, written: 0 });
    expect(db.tables).toEqual(["auction_sale_communes"]);
  });

  it("fonction et table absentes : migration en retard", async () => {
    db.rpcError = { code: "PGRST202", message: "Could not find the function" };
    db.probeError = { code: "PGRST205", message: "Could not find the table" };
    expect(await syncSaleCommunes(NOW)).toMatchObject({ notMigrated: true, written: 0 });
  });
});
