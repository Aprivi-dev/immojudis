import { AdminRequiredError } from "@/lib/api-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));

import {
  buildAdminCatalogueQualityView,
  buildCeilingCoverage,
  buildCrossSourceDuplicates,
  CATALOGUE_QUALITY_ALERT_PREFIX,
  catalogueQualityRows,
  ceilingFailureReason,
  type CatalogueQualityRow,
  type CeilingCoverageSale,
} from "@/lib/admin-catalogue-quality";

const alertKey = (metric: string) => `${CATALOGUE_QUALITY_ALERT_PREFIX}${metric}`;
import { getAdminCatalogueQuality } from "@/lib/admin-catalogue-quality.server";

/** Cliché tel qu'écrit par app_private.evaluate_catalogue_quality_health (valeurs de l'audit du 03/11/2026). */
function snapshotMetrics(overrides: Record<string, unknown> = {}) {
  return {
    evaluated_at: "2026-11-05T00:00:12Z",
    live_sales: 862,
    metrics: {
      bedrooms_ge_rooms: { count: 0, example_sale_ids: [] },
      land_with_rooms: { count: 0, example_sale_ids: [] },
      price_per_m2_implausible: {
        count: 0,
        acknowledged: 1,
        highest_eur_per_m2: null,
        example_sale_ids: [],
      },
      licitor_lot_mismatch: { count: 9, licitor_live: 300, example_sale_ids: ["638fdb03"] },
      missing_postal_code_ratio: { count: 32, population: 862, ratio: 0.0371 },
      dwelling_without_surface_ratio: { count: 137, population: 654, ratio: 0.2095 },
      occupancy_unknown_ratio: { count: 234, population: 862, ratio: 0.2715 },
      documents_incomplete: { count: 64, example_sale_ids: [] },
      ...overrides,
    },
    thresholds: {
      price_per_m2_max_eur: 30000,
      price_per_m2_acknowledged_sale_ids: ["b13dcf59-fa8a-42d5-8c5b-a0de982994cf"],
      missing_postal_code_ratio_max: 0.08,
      ratio_minimum_live_sales: 100,
      documents_incomplete_minimum_age_days: 3,
      documents_incomplete_max_sales: 80,
      example_limit: 5,
    },
  };
}

// Intl.NumberFormat fr-FR sépare les milliers et le signe % par des espaces insécables : ramenés à des espaces
// ordinaires pour garder les attentes lisibles.
const plain = (row: CatalogueQualityRow): CatalogueQualityRow =>
  JSON.parse(JSON.stringify(row).replace(/[\u00a0\u202f]/g, " "));
const byKey = (rows: CatalogueQualityRow[], key: string) =>
  plain(rows.find((row) => row.key === key)!);

describe("catalogueQualityRows", () => {
  it("reprend les règles de la sentinelle : invariants dès 1 vente, seuils de part et de pièces", () => {
    const rows = catalogueQualityRows(snapshotMetrics());

    expect(rows.map((row) => row.key)).toEqual([
      "bedrooms_ge_rooms",
      "land_with_rooms",
      "licitor_lot_mismatch",
      "price_per_m2_implausible",
      "missing_postal_code_ratio",
      "documents_incomplete",
      "dwelling_without_surface_ratio",
      "occupancy_unknown_ratio",
    ]);
    expect(byKey(rows, "bedrooms_ge_rooms")).toMatchObject({
      label: "Chambres ≥ pièces (plus d’une pièce)",
      count: "0",
      threshold: "Alerte dès 1 vente",
      state: "ok",
      stateLabel: "Sous le seuil",
    });
    expect(byKey(rows, "licitor_lot_mismatch")).toMatchObject({ count: "9", state: "alert" });
    expect(byKey(rows, "price_per_m2_implausible")).toMatchObject({
      threshold: "Alerte dès 1 vente au-dessus de 30 000 €/m²",
      state: "ok",
      note: "1 vente reconnue légitime, non comptée",
    });
    expect(byKey(rows, "missing_postal_code_ratio")).toMatchObject({
      count: "32 (3,7 %)",
      threshold: "Alerte au-dessus de 8 % (dès 100 ventes en ligne)",
      state: "ok",
      note: null,
    });
    expect(byKey(rows, "documents_incomplete")).toMatchObject({
      count: "64",
      threshold: "Alerte au-delà de 80 ventes",
      state: "ok",
      note: "Pièce « incomplete » connue depuis plus de 3 jours.",
    });
    expect(byKey(rows, "occupancy_unknown_ratio")).toMatchObject({
      count: "234 (27,2 %)",
      threshold: "Suivi sans alerte",
      state: "trend",
    });
  });

  it("passe au rouge au-dessus des seuils, aux mêmes bornes que les alertes", () => {
    const rows = catalogueQualityRows(
      snapshotMetrics({
        price_per_m2_implausible: { count: 2, acknowledged: 1, highest_eur_per_m2: 41250 },
        missing_postal_code_ratio: { count: 70, population: 862, ratio: 0.0812 },
        documents_incomplete: { count: 81 },
      }),
    );
    expect(byKey(rows, "price_per_m2_implausible")).toMatchObject({
      state: "alert",
      stateLabel: "Au-dessus du seuil",
      note: "jusqu’à 41 250 €/m² · 1 vente reconnue légitime, non comptée",
    });
    expect(byKey(rows, "missing_postal_code_ratio").state).toBe("alert");
    expect(byKey(rows, "documents_incomplete").state).toBe("alert");

    // 80 ventes exactement : la sentinelle n'alerte qu'au-delà.
    expect(
      byKey(
        catalogueQualityRows(snapshotMetrics({ documents_incomplete: { count: 80 } })),
        "documents_incomplete",
      ).state,
    ).toBe("ok");
  });

  it("n'alerte pas sur la part sans code postal sous 100 ventes en ligne", () => {
    const payload = {
      ...snapshotMetrics({ missing_postal_code_ratio: { count: 30, population: 60, ratio: 0.5 } }),
      live_sales: 60,
    };
    expect(byKey(catalogueQualityRows(payload), "missing_postal_code_ratio")).toMatchObject({
      state: "ok",
      note: "Moins de 100 ventes en ligne : la part n’alerte pas.",
    });
  });

  it("dit « Non mesuré » pour une mesure absente ou des seuils manquants, sans inventer d'état", () => {
    const rows = catalogueQualityRows({ live_sales: 862, metrics: { bedrooms_ge_rooms: {} } });
    expect(byKey(rows, "bedrooms_ge_rooms")).toMatchObject({ count: "—", state: "unknown" });
    expect(byKey(rows, "missing_postal_code_ratio")).toMatchObject({
      threshold: "Seuil inconnu",
      state: "unknown",
      stateLabel: "Non mesuré",
    });
  });
});

describe("buildAdminCatalogueQualityView", () => {
  const now = new Date("2026-11-05T09:30:00Z");

  it("rend un état vide sans cliché", () => {
    expect(buildAdminCatalogueQualityView(null, [], now)).toEqual({ snapshot: null, alerts: [] });
  });

  it("signale un cliché d'un jour précédent", () => {
    const view = buildAdminCatalogueQualityView(
      { observed_at: "2026-11-04T00:00:12Z", metrics: snapshotMetrics() },
      [],
      now,
    );
    expect(view.snapshot?.isToday).toBe(false);
    expect(view.snapshot?.title).toMatch(
      /^Pas encore de cliché aujourd’hui : dernier cliché du 04 novembre 2026/,
    );
  });

  it("met en forme le cliché du jour et les alertes ouvertes", () => {
    const view = buildAdminCatalogueQualityView(
      { observed_at: "2026-11-05T00:00:12Z", metrics: snapshotMetrics() },
      [
        {
          alert_key: alertKey("licitor_lot_mismatch"),
          first_seen_at: "2026-11-03T14:00:00Z",
          last_seen_at: "2026-11-05T09:00:00Z",
          details: { count: 7, live_sales: 862, maximum_count: 0 },
        },
        {
          alert_key: alertKey("nouvelle_mesure"),
          first_seen_at: "2026-11-05T09:00:00Z",
          last_seen_at: "2026-11-05T09:00:00Z",
          details: null,
        },
      ],
      now,
    );
    expect(view.snapshot).toMatchObject({ isToday: true, liveSales: "862" });
    expect(view.snapshot?.title).toMatch(/^Cliché du 05 novembre 2026/);
    expect(view.alerts).toEqual([
      {
        key: alertKey("licitor_lot_mismatch"),
        label: "Lots Licitor discordants avec leur carte",
        seen: expect.stringMatching(/^Ouverte le 03 novembre 2026 .*, vue le 05 novembre 2026/),
        detail: "7 au dernier passage",
      },
      {
        key: alertKey("nouvelle_mesure"),
        label: "catalogue.quality.nouvelle_mesure",
        seen: expect.any(String),
        detail: "Nombre non précisé",
      },
    ]);
  });
});

describe("buildCeilingCoverage (P7)", () => {
  const now = new Date("2026-11-08T09:00:00Z");
  const evaluation = (
    venueType: string | null,
    codes: string[],
    estimate: { status?: string | null; code?: string | null } = {},
    saleDate = "2026-12-01T09:00:00Z",
  ): CeilingCoverageSale => ({
    reasonCodes: ["pass:regime_open", "pass:sale_upcoming", ...codes],
    venueType,
    saleDate,
    estimateStatus: estimate.status === undefined ? "ready" : estimate.status,
    estimateErrorCode: estimate.code ?? null,
  });

  it("mesure la part calculable par type de vente, avec le motif d'échec principal", () => {
    const view = buildCeilingCoverage(
      [
        evaluation("tribunal", ["pass:estimate_actionable", "pass:ceiling_computed"]),
        evaluation("tribunal", ["pass:estimate_actionable", "pass:ceiling_computed"]),
        evaluation("tribunal", ["fail:estimate_actionable", "fail:ceiling_computed"], {
          status: "insufficient_data",
          code: "MISSING_SURFACE",
        }),
        evaluation("tribunal", ["fail:estimate_actionable", "fail:ceiling_computed"], {
          status: "insufficient_data",
          code: "MISSING_SURFACE",
        }),
        evaluation("tribunal", ["fail:estimate_actionable", "fail:ceiling_computed"], {
          status: "insufficient_data",
          code: "NO_COMPARABLES",
        }),
        evaluation("notary", ["pass:estimate_actionable", "pass:ceiling_computed"]),
        evaluation("notary", ["fail:no_valuation_conflict", "fail:ceiling_computed"]),
        {
          reasonCodes: ["fail:regime_open", "pass:sale_upcoming"],
          venueType: "state",
          saleDate: "2026-12-01T09:00:00Z",
          estimateStatus: null,
          estimateErrorCode: null,
        },
      ],
      now,
    )!;
    const plainText = (value: unknown) => JSON.stringify(value).replace(/\s/g, " ");

    expect(view.rows.map((row) => row.key)).toEqual(["tribunal", "notary", "state"]);
    const [tribunal, notary, state] = view.rows;
    expect(plainText(tribunal)).toContain('"computable":"2 (40 %)"');
    expect(tribunal.ratio).toBeCloseTo(0.4);
    expect(tribunal.mainFailure).toBe("Surface absente : 2 ventes");
    expect(notary.mainFailure).toBe("Conflit de valorisation : 1 vente");
    expect(state.ratio).toBe(0);
    expect(state.mainFailure).toBe("Type de vente non ouvert au calcul : 1 vente");
    expect(view.total.upcoming).toBe("8");
    expect(view.total.ratio).toBeCloseTo(3 / 8);
    expect(view.note).toContain("Une surface saisie par un utilisateur n’y entre pas");
  });

  it("ne compte que les ventes à venir, et rien sans évaluation", () => {
    const past = evaluation("tribunal", ["pass:ceiling_computed"], {}, "2026-11-01T09:00:00Z");
    const notUpcoming: CeilingCoverageSale = {
      ...evaluation("tribunal", ["pass:ceiling_computed"]),
      reasonCodes: ["fail:sale_upcoming"],
    };
    expect(buildCeilingCoverage([past, notUpcoming], now)).toBeNull();
    expect(buildCeilingCoverage([], now)).toBeNull();
  });

  it("explique l'échec par l'état de l'estimation stockée", () => {
    const failing = (estimate: { status?: string | null; code?: string | null }) =>
      ceilingFailureReason(
        evaluation("tribunal", ["fail:estimate_actionable", "fail:ceiling_computed"], estimate),
      );
    expect(failing({ status: null })).toBe("estimate_pending");
    expect(failing({ status: "processing" })).toBe("estimate_pending");
    expect(failing({ status: "ready" })).toBe("estimate_not_actionable");
    expect(failing({ status: "failed", code: "UPSTREAM_UNAVAILABLE" })).toBe("estimate_failed");
    expect(failing({ status: "insufficient_data", code: "MISSING_LOCATION" })).toBe(
      "missing_location",
    );
    expect(failing({ status: "insufficient_data", code: "UNSUPPORTED_SEGMENT" })).toBe(
      "unsupported_segment",
    );
    expect(
      ceilingFailureReason(evaluation("tribunal", ["fail:no_ai_block", "fail:ceiling_computed"])),
    ).toBe("ai_block");
    expect(
      ceilingFailureReason(
        evaluation("notary", ["pass:estimate_actionable", "fail:ceiling_computed"]),
      ),
    ).toBe("other");
  });
});

describe("buildCrossSourceDuplicates (D12)", () => {
  const plainText = (value: unknown) => JSON.stringify(value).replace(/\s/g, " ");

  it("reprend les groupes, les lignes, les seuils de la base et les groupes à trois sources", () => {
    const view = buildCrossSourceDuplicates(
      {
        groups: 72,
        lines: 152,
        thresholds: { warning_groups: 100, critical_groups: 200 },
        three_source_groups: 1,
        three_source_examples: [
          {
            sale_day: "2026-12-12",
            starting_price_eur: 95000,
            city_key: "lyon",
            line_count: 3,
            source_count: 3,
          },
        ],
      },
      { kind: "function" },
    )!;
    expect(view.groups).toBe("72");
    expect(view.lines).toBe("152");
    expect(view.threshold).toBe("Alerte à partir de 100 groupes (critique : 200)");
    expect(view.state).toBe("ok");
    expect(view.threeSourceGroups).toBe("1");
    expect(plainText(view.threeSourceExamples)).toBe(
      '["12/12/2026 · lyon · 95 000 € · 3 sources, 3 lignes"]',
    );
    expect(view.note).toContain("La fusion des doublons reste coupée");
  });

  it("passe au rouge au seuil d'avertissement de la base, sans le changer", () => {
    const view = buildCrossSourceDuplicates(
      { groups: 100, lines: 210, warning_groups: 100, critical_groups: 200 },
      { kind: "alert", seenAt: "2026-11-07T10:00:00Z" },
    )!;
    expect(view.state).toBe("alert");
    expect(view.threshold).toBe("Alerte à partir de 100 groupes (critique : 200)");
    expect(view.threeSourceGroups).toBe("—");
    expect(view.note).toContain("attend la migration 20261112100100");
  });

  it("ne rend rien sans mesure", () => {
    expect(buildCrossSourceDuplicates(null, { kind: "function" })).toBeNull();
    expect(
      buildCrossSourceDuplicates({ groups: null, lines: null }, { kind: "function" }),
    ).toBeNull();
  });
});

describe("getAdminCatalogueQuality", () => {
  beforeEach(() => vi.resetAllMocks());

  it("ne lit rien pour un compte qui n'est pas administrateur", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false });
    await expect(getAdminCatalogueQuality("token")).rejects.toThrow(AdminRequiredError);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("lit le dernier cliché catalogue-quality et les seules alertes qualité ouvertes", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const calls: Record<string, unknown[][]> = {};
    const chain = (table: string, result: unknown) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "like", "order", "limit"]) {
        builder[method] = (...args: unknown[]) => {
          (calls[table] ??= []).push([method, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
      return builder;
    };
    mocks.from.mockImplementation((table: string) =>
      table === "auction_pipeline_observations"
        ? chain(table, {
            data: [{ observed_at: "2026-11-05T00:00:12Z", metrics: snapshotMetrics() }],
            error: null,
          })
        : chain(table, { data: [], error: null }),
    );

    const view = await getAdminCatalogueQuality("token", new Date("2026-11-05T09:30:00Z"));

    expect(view.snapshot?.rows).toHaveLength(8);
    expect(view.alerts).toEqual([]);
    expect(calls.auction_pipeline_observations).toContainEqual([
      "eq",
      "source_name",
      "catalogue-quality",
    ]);
    expect(calls.auction_pipeline_observations).toContainEqual(["limit", 1]);
    expect(calls.operational_alerts).toContainEqual(["like", "alert_key", "catalogue.quality.%"]);
    expect(calls.operational_alerts).toContainEqual(["eq", "status", "open"]);
  });

  it("remonte une erreur de lecture plutôt qu'un état vide", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const failing = {
      select: () => failing,
      eq: () => failing,
      like: () => failing,
      order: () => failing,
      limit: () => failing,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: null, error: new Error("lecture impossible") }).then(resolve),
    };
    mocks.from.mockReturnValue(failing);
    await expect(getAdminCatalogueQuality("token")).rejects.toThrow("lecture impossible");
  });

  it("ajoute la part des plafonds calculables et les doublons, en lecture seule", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const calls: Record<string, unknown[][]> = {};
    const chain = (table: string, result: unknown) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "like", "order", "limit", "contains", "range"]) {
        builder[method] = (...args: unknown[]) => {
          (calls[table] ??= []).push([method, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
      return builder;
    };
    mocks.from.mockImplementation((table: string) =>
      table === "auction_sale_pepites"
        ? chain(table, {
            data: [
              {
                sale_id: "s1",
                reason_codes: ["pass:sale_upcoming", "pass:ceiling_computed"],
                sale: { sale_venue_type: "tribunal", sale_date: "2099-01-01", estimate: null },
              },
              {
                sale_id: "s2",
                reason_codes: ["pass:sale_upcoming", "fail:ceiling_computed"],
                sale: {
                  sale_venue_type: "tribunal",
                  sale_date: "2099-01-01",
                  estimate: { status: "insufficient_data", last_error_code: "MISSING_SURFACE" },
                },
              },
            ],
            error: null,
          })
        : chain(table, { data: [], error: null }),
    );
    mocks.rpc.mockResolvedValue({
      data: { groups: 3, lines: 7, thresholds: { warning_groups: 100, critical_groups: 200 } },
      error: null,
    });

    const view = await getAdminCatalogueQuality("token", new Date("2026-11-05T09:30:00Z"));

    expect(view.ceilingCoverage?.rows[0]).toMatchObject({
      key: "tribunal",
      ratio: 0.5,
      mainFailure: "Surface absente : 1 vente",
    });
    expect(calls.auction_sale_pepites).toContainEqual([
      "contains",
      "reason_codes",
      ["pass:sale_upcoming"],
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_cross_source_duplicates_summary", {
      p_limit: 10,
    });
    expect(view.crossSourceDuplicates).toMatchObject({ groups: "3", lines: "7", state: "ok" });
    // Aucune écriture : ni insert, ni update, ni delete n'existent sur les requêtes simulées.
    expect(
      Object.values(calls)
        .flat()
        .map((call) => call[0]),
    ).not.toContain("update");
  });

  it("lit le dernier passage de l'alerte tant que la fonction n'est pas déployée", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const builder = (result: unknown) => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "like", "order", "limit", "contains", "range"]) {
        query[method] = () => query;
      }
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return query;
    };
    mocks.from.mockImplementation((table: string) =>
      table === "operational_alerts"
        ? builder({
            data: [
              {
                alert_key: "catalogue.duplicates.cross_source",
                last_seen_at: "2026-11-04T10:00:00Z",
                first_seen_at: "2026-11-04T10:00:00Z",
                details: { groups: 120, lines: 250, warning_groups: 100, critical_groups: 200 },
              },
            ],
            error: null,
          })
        : builder({ data: [], error: null }),
    );
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } });

    const view = await getAdminCatalogueQuality("token", new Date("2026-11-05T09:30:00Z"));

    expect(view.crossSourceDuplicates).toMatchObject({ groups: "120", state: "alert" });
    expect(view.crossSourceDuplicates?.note).toContain("Dernier passage de l’alerte");
    expect(view.ceilingCoverage).toBeNull();
  });
});
