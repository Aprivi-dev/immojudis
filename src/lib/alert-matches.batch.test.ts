import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  userAlerts: [] as Row[],
  getSalesCalls: [] as Array<{ filters: Record<string, unknown>; limit: number; offset: number }>,
  salesPool: [] as Row[],
  /** Ventes que la lecture incrémentale ne rend pas (non modifiées) mais que la lecture par identifiant rend. */
  untouchedPool: [] as Row[],
  /** Colonnes lourdes relues par identifiant (blocs des sources, pièces). */
  salesDetails: {} as Record<string, Row>,
  detailCalls: [] as string[][],
  updates: [] as Row[],
  upserts: [] as Row[][],
  /** Alertes dont l'écriture des correspondances échoue (erreur PostgREST, pas une Error). */
  failingAlerts: new Set<string>(),
  /** Liste publique des pépites (`list_public_pepite_sale_ids`) et les lectures faites par le client de service. */
  pepiteIds: [] as string[],
  pepiteError: null as unknown,
  rpcCalls: [] as string[],
  tablesRead: [] as string[],
}));

function fakeClient() {
  return {
    async rpc(fn: string) {
      state.rpcCalls.push(fn);
      return state.pepiteError
        ? { data: null, error: state.pepiteError }
        : { data: state.pepiteIds, error: null };
    },
    from(table: string) {
      state.tablesRead.push(table);
      const filters: Record<string, unknown> = {};
      let range: [number, number] | null = null;
      let op: "select" | "update" | "upsert" = "select";
      let patch: Row | null = null;
      let upserted: Row[] = [];
      let columns = "*";
      const chain: Record<string, unknown> = {
        select(value?: string) {
          if (value) columns = value;
          return chain;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return chain;
        },
        order: () => chain,
        in: () => chain,
        range(from: number, to: number) {
          range = [from, to];
          return chain;
        },
        update(value: Row) {
          op = "update";
          patch = value;
          return chain;
        },
        upsert: (rows: Row[]) => {
          op = "upsert";
          upserted = rows;
          return chain;
        },
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (op === "upsert") {
            state.upserts.push(upserted);
            if (state.failingAlerts.has(String(upserted[0]?.alert_id))) {
              return resolve({
                data: null,
                error: { message: "canceling statement due to statement timeout", code: "57014" },
              });
            }
            // Les lignes enregistrées reviennent avec leur identifiant, comme PostgREST.
            return resolve({
              data: upserted.map((row) => ({
                ...row,
                id: `match-${String(row.sale_id)}`,
                read_at: null,
                dismissed_at: null,
              })),
              error: null,
            });
          }
          if (table === "user_alerts" && op === "update") {
            state.updates.push({ ...patch, id: filters.id });
            return resolve({ data: null, error: null });
          }
          if (table === "user_alerts") {
            let rows = state.userAlerts.filter((row) => row.is_active === true);
            if (filters.user_id) rows = rows.filter((row) => row.user_id === filters.user_id);
            if (columns === "user_id") rows = rows.map((row) => ({ user_id: row.user_id }));
            if (range) rows = rows.slice(range[0], range[1] + 1);
            return resolve({ data: rows, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeClient() }));
vi.mock("@/lib/system-auth", () => ({
  systemAuthForUser: async (userId: string) => ({
    supabase: fakeClient(),
    userId,
    claims: {},
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
  }),
}));
vi.mock("@/lib/property-reports", () => ({
  resolvePlanEntitlements: async () => ({ plan: "analyse", hasAnalysisAccess: true }),
}));
vi.mock("@/lib/queries", () => ({
  getSalesForAlertEvaluation: async (
    filters: Record<string, unknown>,
    limit: number,
    offset: number,
  ) => {
    state.getSalesCalls.push({ filters, limit, offset });
    const ids = filters.ids as string[] | undefined;
    const pool = ids
      ? [...state.salesPool, ...state.untouchedPool].filter((sale) => ids.includes(String(sale.id)))
      : state.salesPool;
    // Copies : l'évaluation ajoute les colonnes relues aux ventes, comme aux lignes réelles.
    return pool.slice(offset, offset + limit).map((sale) => ({ ...sale }));
  },
  getSaleAlertDetails: async (ids: string[]) => {
    state.detailCalls.push(ids);
    return ids.map((id) => ({ id, ...state.salesDetails[id] }));
  },
}));
vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: async () => null }));
const rents = vi.hoisted(() => ({
  calls: [] as string[][],
  sessions: 0,
  references: {} as Record<string, unknown>,
  /** « ANIL indisponible » : la lecture de la carte des loyers a échoué. */
  unavailable: false,
}));
vi.mock("@/lib/rent-reference.server", () => ({
  createRentLookupSession: () => {
    rents.sessions += 1;
    return {
      load: async (sales: Array<{ id: string }>) => {
        rents.calls.push(sales.map((sale) => sale.id));
        return (sale: { id: string }) => rents.references[sale.id] ?? null;
      },
      unavailable: () => rents.unavailable,
    };
  },
}));
const notified = vi.hoisted(() => ({ saleIds: [] as string[], suppressedSaleIds: [] as string[] }));
vi.mock("@/lib/alert-notifications", () => ({
  createAlertNotificationsForMatches: async ({
    matches,
  }: {
    matches: Array<{ saleId: string }>;
  }) => {
    notified.saleIds.push(...matches.map((match) => match.saleId));
    return { notificationCount: matches.length };
  },
  suppressAlertNotificationsForMatches: async ({
    matches,
  }: {
    matches: Array<{ saleId: string }>;
  }) => {
    notified.suppressedSaleIds.push(...matches.map((match) => match.saleId));
    return { suppressedCount: matches.length };
  },
}));

import {
  RENT_BASIS_SILENT_WINDOW_MS,
  assertSmartAlertBatchComplete,
  isRentBasisSilentPass,
  resetPepiteSaleIdsForAlertsCache,
  runSmartAlertEvaluationBatch,
} from "./alert-matches";

function alertRow(index: number, overrides: Row = {}): Row {
  return {
    id: `alert-${index}`,
    user_id: `user-${index}`,
    name: `Alerte ${index}`,
    is_active: true,
    alert_frequency: "daily",
    last_evaluated_at: null,
    dpe_classes: [],
    advanced_criteria: {},
    ...overrides,
  };
}

describe("smart alert batch", () => {
  beforeEach(() => {
    state.userAlerts = [];
    state.salesPool = [];
    state.untouchedPool = [];
    state.salesDetails = {};
    state.detailCalls = [];
    state.getSalesCalls = [];
    state.updates = [];
    state.upserts = [];
    state.failingAlerts = new Set();
    state.pepiteIds = [];
    state.pepiteError = null;
    state.rpcCalls = [];
    state.tablesRead = [];
    rents.calls = [];
    rents.sessions = 0;
    rents.references = {};
    notified.saleIds = [];
    notified.suppressedSaleIds = [];
    rents.unavailable = false;
    delete process.env.ALERT_RENT_BASIS_SWITCH_AT;
    resetPepiteSaleIdsForAlertsCache();
  });

  it("évalue les 100 alertes de test en une exécution, sans plafond d'utilisateurs", async () => {
    state.userAlerts = Array.from({ length: 100 }, (_, index) => alertRow(index));

    const result = await runSmartAlertEvaluationBatch();

    expect(result.candidateUserCount).toBe(100);
    expect(result.evaluatedUserCount).toBe(100);
    expect(result.failedUserCount).toBe(0);
    expect(result.deferredUserCount).toBe(0);
    expect(state.updates).toHaveLength(100);
    expect(state.updates.every((update) => update.last_evaluated_at)).toBe(true);
  });

  it("lit toutes les pages de ventes d'une alerte jamais évaluée", async () => {
    state.userAlerts = [alertRow(1)];
    state.salesPool = Array.from({ length: 950 }, (_, index) => ({ id: `sale-${index}` }));

    await runSmartAlertEvaluationBatch();

    expect(state.getSalesCalls.map((call) => call.offset)).toEqual([0, 400, 800]);
    expect(state.getSalesCalls[0].filters.updated_since).toBeUndefined();
    expect(state.getSalesCalls[0].filters.status_in).toEqual(["active", "upcoming"]);
  });

  it("ne relit que les ventes modifiées depuis la dernière évaluation", async () => {
    state.userAlerts = [alertRow(1, { last_evaluated_at: "2026-10-08T06:15:00.000Z" })];

    await runSmartAlertEvaluationBatch();

    const since = String(state.getSalesCalls[0].filters.updated_since);
    // One hour of overlap before the previous evaluation.
    expect(since).toBe("2026-10-08T05:15:00.000Z");
  });

  it("reporte les utilisateurs restants quand le budget de temps est épuisé", async () => {
    state.userAlerts = Array.from({ length: 6 }, (_, index) => alertRow(index));

    const result = await runSmartAlertEvaluationBatch({ timeBudgetMs: -1 });

    expect(result.deferredUserCount).toBe(6);
    expect(result.evaluatedUserCount).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it("n'applique à une alerte « 26 » que les ventes de la Drôme", async () => {
    state.userAlerts = [
      alertRow(1, { advanced_criteria: { source: "sales_search", query: "26" } }),
    ];
    state.salesPool = [
      { id: "sale-26", department: "26" },
      { id: "sale-33", department: "33" },
      { id: "sale-07", department: "07" },
    ];

    await runSmartAlertEvaluationBatch();

    expect(state.upserts.flat().map((row) => row.sale_id)).toEqual(["sale-26"]);
  });

  it("« 66, 65, 05 » : seules les ventes de ces trois départements", async () => {
    state.userAlerts = [
      alertRow(1, { advanced_criteria: { source: "sales_search", query: "66, 65, 05" } }),
    ];
    state.salesPool = [
      { id: "sale-66", department: "66" },
      { id: "sale-33", department: "33" },
      { id: "sale-05", department: "05" },
      { id: "sale-65", department: "65" },
    ];

    await runSmartAlertEvaluationBatch();

    expect(state.upserts.flat().map((row) => row.sale_id)).toEqual([
      "sale-66",
      "sale-05",
      "sale-65",
    ]);
  });

  it("ne relit les blocs et les pièces que des ventes retenues sur les autres critères", async () => {
    state.userAlerts = [
      alertRow(1, { advanced_criteria: { source: "sales_search", query: "26" } }),
    ];
    state.salesPool = [
      { id: "sale-26", department: "26" },
      { id: "sale-33", department: "33" },
    ];
    state.salesDetails = { "sale-26": { documents_rich: [{ url: "https://x/cahier.pdf" }] } };

    await runSmartAlertEvaluationBatch();

    expect(state.detailCalls).toEqual([["sale-26"]]);
    const snapshot = state.upserts.flat()[0]?.match_snapshot as { sale: Row };
    expect(snapshot.sale.documentCount).toBe(1);
  });

  it("lit la classe DPE dans les blocs relus pour un critère DPE", async () => {
    state.userAlerts = [alertRow(1, { department: "26", dpe_classes: ["D"] })];
    state.salesPool = [
      { id: "sale-d", department: "26" },
      { id: "sale-f", department: "26" },
      { id: "sale-33", department: "33" },
    ];
    state.salesDetails = {
      "sale-d": { source_blocks: { dpe: "D" } },
      "sale-f": { source_blocks: { dpe: "F" } },
    };

    await runSmartAlertEvaluationBatch();

    expect(state.detailCalls).toEqual([["sale-d", "sale-f"]]);
    const rows = state.upserts.flat();
    expect(rows.map((row) => row.sale_id)).toEqual(["sale-d"]);
    expect((rows[0].match_snapshot as { sale: Row }).sale.dpe).toBe("D");
  });

  it("aucune relecture quand aucune vente n'est retenue", async () => {
    state.userAlerts = [alertRow(1, { department: "26" })];
    state.salesPool = [{ id: "sale-33", department: "33" }];

    await runSmartAlertEvaluationBatch();

    expect(state.detailCalls).toEqual([]);
  });

  describe("loyers de la carte ANIL", () => {
    const home = (id: string, department = "23") => ({
      id,
      department,
      property_type: "apartment",
      starting_price_eur: 100_000,
      app_surface_m2: 50,
      app_surface_kind: "habitable",
    });
    const reference = (rentPerM2: number) => ({
      rentPerM2,
      source: "anil_commune",
      reliability: "reliable",
      segment: "apt_all",
      communeCode: "23096",
      lowPerM2: null,
      highPerM2: null,
      observations: 100,
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });

    it("évalue le rendement minimal avec le loyer de la commune, lu pour les seules ventes candidates", async () => {
      state.userAlerts = [alertRow(1, { department: "23", min_yield_pct: 6 })];
      state.salesPool = [home("sale-a"), home("sale-b"), home("sale-33", "33")];
      rents.references = { "sale-a": reference(12), "sale-b": reference(6) };

      await runSmartAlertEvaluationBatch();

      // Department 23 has no department rent: only the commune rent can make a sale match.
      expect(state.upserts.flat().map((row) => row.sale_id)).toEqual(["sale-a"]);
      // The department filter leaves two candidates; sale-33 is never read.
      expect(rents.calls).toEqual([["sale-a", "sale-b"]]);
      const snapshot = state.upserts.flat()[0].match_snapshot as { sale: Row };
      expect(snapshot.sale.grossYieldPct).toBeCloseTo(6.2, 1);
    });

    it("une alerte sans critère de rendement ne lit les loyers que des ventes retenues, pour son résumé", async () => {
      state.userAlerts = [alertRow(1, { department: "23" })];
      state.salesPool = [home("sale-a"), home("sale-33", "33")];
      rents.references = { "sale-a": reference(12) };

      await runSmartAlertEvaluationBatch();

      expect(rents.calls).toEqual([["sale-a"]]);
      const snapshot = state.upserts.flat()[0].match_snapshot as { sale: Row };
      expect(snapshot.sale.grossYieldPct).toBeCloseTo(6.2, 1);
    });
  });

  describe("un seul chargement des loyers par exécution", () => {
    it("partage la session entre tous les comptes et toutes les alertes", async () => {
      const home = (id: string) => ({
        id,
        department: "23",
        property_type: "apartment",
        starting_price_eur: 100_000,
        app_surface_m2: 50,
        app_surface_kind: "habitable",
      });
      state.userAlerts = [
        alertRow(1, { department: "23", min_yield_pct: 6 }),
        alertRow(2, { department: "23", min_yield_pct: 6 }),
      ];
      state.salesPool = [home("sale-a")];

      await runSmartAlertEvaluationBatch();

      expect(rents.sessions).toBe(1);
    });
  });

  describe("base silencieuse du changement de loyers de référence", () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const home = (id: string, department: string) => ({
      id,
      department,
      property_type: "apartment",
      starting_price_eur: 100_000,
      app_surface_m2: 50,
      app_surface_kind: "habitable",
    });
    const reference = (rentPerM2: number) => ({
      rentPerM2,
      source: "anil_commune",
      reliability: "reliable",
      segment: "apt_all",
      communeCode: "23096",
      lowPerM2: null,
      highPerM2: null,
      observations: 100,
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    // Le département 23 n'a aucun repère départemental : une vente n'y correspond que grâce à l'ANIL.
    // Le 33 a un repère (14 EUR/m², environ 7,5 %) : sa vente correspondait déjà.
    const arrange = (alert: Row) => {
      state.userAlerts = [alert];
      state.salesPool = [home("sale-new", "23"), home("sale-old", "33")];
      rents.references = { "sale-new": reference(12), "sale-old": reference(12) };
    };

    it("enregistre sans notifier les correspondances dues au seul changement de loyers, la première fois", async () => {
      process.env.ALERT_RENT_BASIS_SWITCH_AT = hoursAgo(1);
      arrange(alertRow(1, { min_yield_pct: 6, last_evaluated_at: hoursAgo(5) }));

      await runSmartAlertEvaluationBatch();

      expect(
        state.upserts
          .flat()
          .map((row) => row.sale_id)
          .sort(),
      ).toEqual(["sale-new", "sale-old"]);
      // Celle qui existait avec le loyer départemental reste notifiée, comme avant.
      expect(notified.saleIds).toEqual(["sale-old"]);
      // La tue est consignée (notification « cancelled ») pour bloquer toute notification ultérieure.
      expect(notified.suppressedSaleIds).toEqual(["sale-new"]);
    });

    it("lecture de l'ANIL en échec : l'alerte à critère de rendement n'avance pas et ne consomme pas la fenêtre", async () => {
      process.env.ALERT_RENT_BASIS_SWITCH_AT = hoursAgo(1);
      arrange(alertRow(1, { min_yield_pct: 6, last_evaluated_at: hoursAgo(5) }));
      rents.unavailable = true;

      const result = await runSmartAlertEvaluationBatch();

      expect(result.failedUserCount).toBe(1);
      expect(state.updates).toEqual([]);
      expect(state.upserts).toEqual([]);
      expect(notified.saleIds).toEqual([]);
      expect(notified.suppressedSaleIds).toEqual([]);

      // Une fois l'ANIL revenue, l'alerte est toujours dans la fenêtre silencieuse (sa date n'a pas bougé).
      rents.unavailable = false;
      await runSmartAlertEvaluationBatch();
      expect(notified.suppressedSaleIds).toEqual(["sale-new"]);
      expect(notified.saleIds).toEqual(["sale-old"]);
    });

    it("une alerte sans critère de rendement ne dépend pas de la lecture de l'ANIL", async () => {
      arrange(alertRow(1, { last_evaluated_at: hoursAgo(5) }));
      rents.unavailable = true;
      const result = await runSmartAlertEvaluationBatch();
      expect(result.failedUserCount).toBe(0);
      expect(state.updates).toHaveLength(1);
    });

    it("ne tait rien sans le marqueur, hors des 48 heures, ni pour une alerte déjà évaluée depuis", async () => {
      const cases: Array<[string, () => void]> = [
        [
          "sans marqueur",
          () => arrange(alertRow(1, { min_yield_pct: 6, last_evaluated_at: hoursAgo(5) })),
        ],
        [
          "après 48 heures",
          () => {
            process.env.ALERT_RENT_BASIS_SWITCH_AT = hoursAgo(60);
            arrange(alertRow(1, { min_yield_pct: 6, last_evaluated_at: hoursAgo(70) }));
          },
        ],
        [
          "alerte évaluée après le changement",
          () => {
            process.env.ALERT_RENT_BASIS_SWITCH_AT = hoursAgo(2);
            arrange(alertRow(1, { min_yield_pct: 6, last_evaluated_at: hoursAgo(1) }));
          },
        ],
        [
          "alerte jamais évaluée (créée ou modifiée)",
          () => {
            process.env.ALERT_RENT_BASIS_SWITCH_AT = hoursAgo(1);
            arrange(alertRow(1, { min_yield_pct: 6, last_evaluated_at: null }));
          },
        ],
        [
          "alerte sans critère de rendement",
          () => {
            process.env.ALERT_RENT_BASIS_SWITCH_AT = hoursAgo(1);
            arrange(alertRow(1, { last_evaluated_at: hoursAgo(5) }));
          },
        ],
      ];
      for (const [label, setUp] of cases) {
        delete process.env.ALERT_RENT_BASIS_SWITCH_AT;
        notified.saleIds = [];
        state.upserts = [];
        setUp();

        await runSmartAlertEvaluationBatch();

        // Aucune n'est tue : les deux correspondances sont notifiées.
        expect([...notified.saleIds].sort(), label).toEqual(["sale-new", "sale-old"]);
      }
    });
  });

  it("écrit les correspondances par lots de 200", async () => {
    state.userAlerts = [alertRow(1)];
    state.salesPool = Array.from({ length: 450 }, (_, index) => ({ id: `sale-${index}` }));

    const result = await runSmartAlertEvaluationBatch();

    expect(state.upserts.map((rows) => rows.length)).toEqual([200, 200, 50]);
    expect(result.totalMatchCount).toBe(450);
  });
});

describe("alertes en échec isolées", () => {
  beforeEach(() => {
    state.userAlerts = [];
    state.salesPool = [{ id: "sale-1" }];
    state.getSalesCalls = [];
    state.updates = [];
    state.upserts = [];
    state.failingAlerts = new Set();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const sameUser = (alerts: string[]) =>
    alerts.map((id) => alertRow(1, { id, user_id: "user-1", name: `Alerte ${id}` }));

  it("une alerte en échec ne fait pas échouer le compte ni les autres alertes", async () => {
    state.userAlerts = sameUser(["a", "b", "c"]);
    state.failingAlerts = new Set(["b"]);

    const result = await runSmartAlertEvaluationBatch();

    expect(result.failedUserCount).toBe(0);
    expect(result.evaluatedUserCount).toBe(1);
    expect(result.failedAlertCount).toBe(1);
    expect(result.alertFailures).toEqual([
      {
        userId: "user-1",
        alertId: "b",
        error: "canceling statement due to statement timeout (57014)",
      },
    ]);
    // L'alerte en échec garde son ancienne date d'évaluation : le passage suivant la reprend.
    expect(state.updates.map((update) => update.id).sort()).toEqual(["a", "c"]);
    expect(() => assertSmartAlertBatchComplete(result)).not.toThrow();
  });

  it("journalise le message et le code d'une erreur qui n'est pas une Error", async () => {
    state.userAlerts = sameUser(["a", "b"]);
    state.failingAlerts = new Set(["a"]);

    await runSmartAlertEvaluationBatch();

    const logged = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(
      expect.objectContaining({
        outcome: "alert_failed",
        alertId: "a",
        code: "57014",
        message: "canceling statement due to statement timeout",
      }),
    );
  });

  it("le compte échoue, avec le vrai motif, quand toutes ses alertes échouent", async () => {
    state.userAlerts = sameUser(["a", "b"]);
    state.failingAlerts = new Set(["a", "b"]);

    const result = await runSmartAlertEvaluationBatch();

    expect(result.failedUserCount).toBe(1);
    expect(result.failedAlertCount).toBe(2);
    expect(result.results[0].error).toBe(
      "2 alerte(s) en échec : canceling statement due to statement timeout (57014)",
    );
    expect(() => assertSmartAlertBatchComplete(result)).toThrow(/57014/);
    expect(state.updates).toHaveLength(0);
  });
});

describe("passage des alertes intelligentes : échecs partiels", () => {
  const result = (analysed: number, failed: number, error: string | null = "boom") => ({
    analysedUserCount: analysed,
    failedUserCount: failed,
    results: Array.from({ length: failed }, (_, index) => ({
      userId: `user-${index}`,
      ok: false,
      alertCount: 0,
      saleCount: 0,
      matchCount: 0,
      notificationCount: 0,
      failedAlertCount: 0,
      error,
    })),
  });

  it("réussit quand aucun compte n'a échoué ou qu'aucun n'a été analysé", () => {
    expect(() => assertSmartAlertBatchComplete(result(50, 0))).not.toThrow();
    expect(() => assertSmartAlertBatchComplete(result(0, 0))).not.toThrow();
  });

  it("réussit sous 20 % de comptes en échec", () => {
    expect(() => assertSmartAlertBatchComplete(result(10, 1))).not.toThrow();
    expect(() => assertSmartAlertBatchComplete(result(100, 19))).not.toThrow();
  });

  it("échoue à 20 % de comptes en échec ou plus, avec la première erreur", () => {
    expect(() => assertSmartAlertBatchComplete(result(10, 2))).toThrow(
      "Alertes intelligentes : 2 compte(s) en échec sur 10 analysé(s) (seuil 20 %) ; première erreur : boom.",
    );
    expect(() => assertSmartAlertBatchComplete(result(100, 20, null))).toThrow(
      "Alertes intelligentes : 20 compte(s) en échec sur 100 analysé(s) (seuil 20 %).",
    );
  });

  it("accepte un vrai passage sans échec", async () => {
    state.userAlerts = Array.from({ length: 5 }, (_, index) => alertRow(index));
    const run = await runSmartAlertEvaluationBatch();
    expect(run.failedUserCount).toBe(0);
    expect(() => assertSmartAlertBatchComplete(run)).not.toThrow();
  });
});

describe("alertes « Seulement les pépites »", () => {
  beforeEach(() => {
    state.userAlerts = [];
    state.salesPool = [];
    state.untouchedPool = [];
    state.salesDetails = {};
    state.detailCalls = [];
    state.getSalesCalls = [];
    state.updates = [];
    state.upserts = [];
    state.failingAlerts = new Set();
    state.pepiteIds = [];
    state.pepiteError = null;
    state.rpcCalls = [];
    state.tablesRead = [];
    resetPepiteSaleIdsForAlertsCache();
  });

  const pepiteAlert = (index: number, overrides: Row = {}) =>
    alertRow(index, {
      advanced_criteria: { source: "sales_search", pepite_only: true },
      ...overrides,
    });

  it("ne retient que les ventes de la liste publique des pépites, avec la mention en texte", async () => {
    state.userAlerts = [pepiteAlert(1)];
    state.pepiteIds = ["sale-b"];
    state.salesPool = [{ id: "sale-a" }, { id: "SALE-B" }, { id: "sale-c" }];

    await runSmartAlertEvaluationBatch();

    const rows = state.upserts.flat();
    expect(rows.map((row) => row.sale_id)).toEqual(["SALE-B"]);
    expect(rows[0].match_reasons).toContain("pépite");
    // Aucun montant dans le résumé enregistré.
    expect(JSON.stringify(rows[0])).not.toMatch(/plafond|ceiling|probable|referenceCeiling/i);
  });

  it("lit la liste PUBLIQUE (vide hors mode « on »), jamais la table privée, une seule fois pour tous les comptes", async () => {
    state.userAlerts = [pepiteAlert(1), pepiteAlert(2), alertRow(3)];
    state.pepiteIds = ["sale-b"];
    state.salesPool = [{ id: "sale-b" }];

    await runSmartAlertEvaluationBatch();

    expect(state.rpcCalls.filter((fn) => fn === "list_public_pepite_sale_ids")).toHaveLength(1);
    expect(state.tablesRead).not.toContain("auction_sale_pepites");
  });

  it("en mode shadow (liste vide) : aucune correspondance, et la lecture suit l'évaluation précédente", async () => {
    state.userAlerts = [pepiteAlert(1, { last_evaluated_at: "2026-10-08T06:15:00.000Z" })];
    state.pepiteIds = [];
    state.salesPool = [{ id: "sale-a" }];

    await runSmartAlertEvaluationBatch();

    expect(state.upserts.flat()).toEqual([]);
    expect(state.getSalesCalls[0].filters.updated_since).toBe("2026-10-08T05:15:00.000Z");
  });

  it("garde la fenêtre incrémentale et ajoute les pépites par identifiant : une vente le devient sans que sa ligne change", async () => {
    state.userAlerts = [pepiteAlert(1, { last_evaluated_at: "2026-10-08T06:15:00.000Z" })];
    state.pepiteIds = ["sale-b"];
    state.untouchedPool = [{ id: "sale-b" }, { id: "sale-c" }];

    await runSmartAlertEvaluationBatch();

    // Pas de relecture complète : la première lecture reste incrémentale.
    expect(state.getSalesCalls[0].filters.updated_since).toBe("2026-10-08T05:15:00.000Z");
    expect(state.getSalesCalls[0].filters.ids).toBeUndefined();
    expect(state.getSalesCalls[1].filters).toMatchObject({ ids: ["sale-b"] });
    expect(state.getSalesCalls).toHaveLength(2);
    expect(state.upserts.flat().map((row) => row.sale_id)).toEqual(["sale-b"]);
  });

  it("une alerte d'un autre critère du même compte ne relit rien de plus et n'évalue pas ces ventes", async () => {
    state.userAlerts = [
      pepiteAlert(1, { user_id: "user-1", last_evaluated_at: "2026-10-08T06:15:00.000Z" }),
      alertRow(2, { user_id: "user-1", last_evaluated_at: "2026-10-08T06:15:00.000Z" }),
    ];
    state.pepiteIds = ["sale-b"];
    state.untouchedPool = [{ id: "sale-b" }];
    state.salesPool = [{ id: "sale-new" }];

    await runSmartAlertEvaluationBatch();

    // Une seule lecture complète n'a eu lieu : la fenêtre incrémentale, puis les pépites par identifiant.
    expect(state.getSalesCalls.filter((call) => !call.filters.ids)).toHaveLength(1);
    expect(state.getSalesCalls[0].filters.updated_since).toBe("2026-10-08T05:15:00.000Z");
    const bySale = new Map<string, string[]>();
    for (const row of state.upserts.flat()) {
      bySale.set(String(row.sale_id), [
        ...(bySale.get(String(row.sale_id)) ?? []),
        String(row.alert_id),
      ]);
    }
    // sale-b (pépite, non modifiée) : seulement l'alerte « pépites » ; sale-new : seulement l'alerte plain.
    expect(bySale.get("sale-b")).toEqual(["alert-1"]);
    expect(bySale.get("sale-new")).toEqual(["alert-2"]);
  });

  it("sans pépite hors de la fenêtre, aucune lecture par identifiant", async () => {
    state.userAlerts = [pepiteAlert(1, { last_evaluated_at: "2026-10-08T06:15:00.000Z" })];
    state.pepiteIds = ["sale-b"];
    state.salesPool = [{ id: "sale-b" }];

    await runSmartAlertEvaluationBatch();

    expect(state.getSalesCalls).toHaveLength(1);
    expect(state.upserts.flat().map((row) => row.sale_id)).toEqual(["sale-b"]);
  });

  it("n'appelle pas la liste pour des alertes qui ne la demandent pas", async () => {
    state.userAlerts = [alertRow(1, { last_evaluated_at: "2026-10-08T06:15:00.000Z" })];

    await runSmartAlertEvaluationBatch();

    expect(state.rpcCalls).toEqual([]);
    expect(state.getSalesCalls[0].filters.updated_since).toBe("2026-10-08T05:15:00.000Z");
  });

  it("une liste illisible fait échouer l'alerte, qui garde sa date d'évaluation (reprise au passage suivant)", async () => {
    state.userAlerts = [pepiteAlert(1)];
    state.pepiteError = { code: "57014", message: "timeout" };
    state.salesPool = [{ id: "sale-b" }];
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runSmartAlertEvaluationBatch();

    expect(result.failedAlertCount).toBe(1);
    expect(state.updates).toEqual([]);
    expect(state.upserts.flat()).toEqual([]);
  });

  it("une fonction absente (migration pas appliquée) vaut aucune pépite, sans échec", async () => {
    state.userAlerts = [pepiteAlert(1)];
    state.pepiteError = { code: "PGRST202", message: "absente" };
    state.salesPool = [{ id: "sale-b" }];

    const result = await runSmartAlertEvaluationBatch();

    expect(result.failedAlertCount).toBe(0);
    expect(state.upserts.flat()).toEqual([]);
    expect(state.updates).toHaveLength(1);
  });
});

describe("isRentBasisSilentPass", () => {
  const switchAt = "2026-11-10T08:00:00.000Z";
  const env = { ALERT_RENT_BASIS_SWITCH_AT: switchAt };
  const yieldAlert = { min_yield_pct: 6, last_evaluated_at: "2026-11-10T06:00:00.000Z" };

  it("ne vaut que pour la première évaluation d'une alerte à rendement, dans les 48 heures", () => {
    expect(isRentBasisSilentPass(yieldAlert, "2026-11-10T09:00:00.000Z", env)).toBe(true);
    expect(isRentBasisSilentPass(yieldAlert, "2026-11-12T07:59:00.000Z", env)).toBe(true);
    // Hors fenêtre, avant le changement, sans marqueur ou avec un marqueur illisible.
    expect(
      isRentBasisSilentPass(
        yieldAlert,
        new Date(Date.parse(switchAt) + RENT_BASIS_SILENT_WINDOW_MS).toISOString(),
        env,
      ),
    ).toBe(false);
    expect(isRentBasisSilentPass(yieldAlert, "2026-11-10T07:00:00.000Z", env)).toBe(false);
    expect(isRentBasisSilentPass(yieldAlert, "2026-11-10T09:00:00.000Z", {})).toBe(false);
    expect(
      isRentBasisSilentPass(yieldAlert, "2026-11-10T09:00:00.000Z", {
        ALERT_RENT_BASIS_SWITCH_AT: "bientôt",
      }),
    ).toBe(false);
  });

  it("exclut une alerte sans rendement, jamais évaluée, ou déjà évaluée après le changement", () => {
    const now = "2026-11-10T09:00:00.000Z";
    expect(isRentBasisSilentPass({ ...yieldAlert, min_yield_pct: null }, now, env)).toBe(false);
    expect(isRentBasisSilentPass({ ...yieldAlert, last_evaluated_at: null }, now, env)).toBe(false);
    expect(
      isRentBasisSilentPass(
        { ...yieldAlert, last_evaluated_at: "2026-11-10T08:30:00.000Z" },
        now,
        env,
      ),
    ).toBe(false);
  });
});
