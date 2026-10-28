import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { RateLimitError } from "@/lib/api-errors";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { validateSalesSearch } from "@/lib/search/search-url-state";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  userLimit: vi.fn(),
  daily: vi.fn(),
  getSales: vi.fn(),
  exported: vi.fn(),
  inserted: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        limit: async () => mocks.exported(),
        insert: async (row: unknown) => {
          mocks.inserted(row);
          return { error: null };
        },
      };
      return query;
    },
  },
}));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  enforceUserRateLimit: mocks.userLimit,
  enforceDailyOperationLimits: mocks.daily,
}));
vi.mock("@/lib/queries", () => ({ getSales: mocks.getSales }));
vi.mock("@/lib/geo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geo")>()),
  geocodeAddress: vi.fn(),
}));
vi.mock("@/lib/sale-publication-guard", () => ({
  getPublicationVisibleSaleIds: async (ids: string[]) => new Set(ids),
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));

import { exportSalesApiFeed, exportSalesCsv } from "@/lib/sale-exports";
import { SALES_API_FEED_DAILY_ROWS, SALES_CSV_EXPORT_DAILY_ROWS } from "@/lib/rate-limit-policies";

const request = new Request("https://immojudis.com/api/sales/export");
const auth = { userId: "user-1", claims: {}, supabase: {} } as unknown as SupabaseAuthContext;
const search = validateSalesSearch({});
const analyse = { plan: "analyse" };

const catalogue = Array.from({ length: 700 }, (_, index) => ({
  ...EXAMPLE_SALE,
  id: `sale-${index}`,
}));

/** Lignes déjà exportées aujourd'hui, telles que `sale_data_exports` les renvoie. */
const alreadyExported = (...rowCounts: number[]) =>
  mocks.exported.mockResolvedValue({
    data: rowCounts.map((row_count) => ({ row_count })),
    error: null,
  });

describe("plafonds journaliers de l'export CSV et du flux API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.plan.mockResolvedValue(analyse);
    mocks.userLimit.mockResolvedValue(1);
    mocks.daily.mockResolvedValue(undefined);
    mocks.getSales.mockResolvedValue(catalogue);
    alreadyExported();
  });

  it("n'use aucun compteur pour un compte sans droit (CSV et flux)", async () => {
    mocks.plan.mockResolvedValue({ plan: "decouverte" });
    await expect(exportSalesCsv({ auth, search, request })).rejects.toThrow("Export CSV réservé");
    await expect(exportSalesApiFeed({ auth, search, request })).rejects.toThrow("API ventes");
    expect(mocks.daily).not.toHaveBeenCalled();
    expect(mocks.getSales).not.toHaveBeenCalled();
  });

  it("applique le plafond du CSV après le droit, avec la part de l'offre de lancement", async () => {
    await exportSalesCsv({ auth, search, request });
    expect(mocks.daily).toHaveBeenLastCalledWith({
      request,
      userId: "user-1",
      operation: "salesCsvExport",
      launchOffer: false,
    });
    mocks.plan.mockResolvedValue({ ...analyse, launchOffer: true });
    await exportSalesCsv({ auth, search, request });
    expect(mocks.daily).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "salesCsvExport", launchOffer: true }),
    );
  });

  it("applique le plafond du flux après le droit, avec la part de l'offre de lancement", async () => {
    mocks.plan.mockResolvedValue({ ...analyse, launchOffer: true });
    await exportSalesApiFeed({ auth, search, request });
    expect(mocks.daily).toHaveBeenCalledWith({
      request,
      userId: "user-1",
      operation: "salesApiFeed",
      launchOffer: true,
    });
  });

  it("refuse sans rien lire ni exporter quand le plafond journalier est atteint", async () => {
    mocks.daily.mockRejectedValue(
      new RateLimitError(undefined, 3600, "Limite quotidienne atteinte, réessayez demain."),
    );
    await expect(exportSalesCsv({ auth, search, request })).rejects.toBeInstanceOf(RateLimitError);
    await expect(exportSalesApiFeed({ auth, search, request })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(mocks.getSales).not.toHaveBeenCalled();
    expect(mocks.inserted).not.toHaveBeenCalled();
  });

  it("exporte 500 lignes au plus par fichier quand le budget du jour est entier", async () => {
    const result = await exportSalesCsv({ auth, search, request });
    expect(result.rowCount).toBe(500);
    expect(mocks.inserted).toHaveBeenCalledWith(
      expect.objectContaining({ export_kind: "sales_csv", row_count: 500 }),
    );
  });

  it("réduit le CSV aux lignes qui restent du plafond de 2 000 lignes par compte et par jour", async () => {
    expect(SALES_CSV_EXPORT_DAILY_ROWS).toBe(2_000);
    alreadyExported(500, 500, 500, 300);
    const result = await exportSalesCsv({ auth, search, request });
    expect(result.rowCount).toBe(200);
    expect(result.content.split("\n")).toHaveLength(201);
  });

  it("refuse le CSV quand les 2 000 lignes du jour sont exportées, avec le message quotidien", async () => {
    alreadyExported(500, 500, 500, 500);
    const failure = await exportSalesCsv({ auth, search, request }).catch((error) => error);
    expect(failure).toBeInstanceOf(RateLimitError);
    expect(failure.publicMessage).toBe("Limite quotidienne atteinte, réessayez demain.");
    expect(failure.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(mocks.getSales).not.toHaveBeenCalled();
    expect(mocks.inserted).not.toHaveBeenCalled();
  });

  it("borne aussi le flux API, par un plafond de lignes distinct de celui du CSV", async () => {
    alreadyExported(SALES_API_FEED_DAILY_ROWS - 40);
    const result = await exportSalesApiFeed({ auth, search, request });
    expect(result.meta.rowCount).toBe(40);
    expect(result.meta.limit).toBe(40);
    // Sans loyer ANIL lu (base de service non configurée ici), les rendements sont départementaux.
    expect(result.meta.rentBasis).toBe("department");
    expect(result.meta.rentAttribution).toContain("Estimations ANIL");
    // Le sens des rendements a changé : la version du schéma a monté, et la note de changement l'explique.
    expect(result.meta.schemaVersion).toBe("2026-10-judicial-sales-v1");
    expect(result.meta.changes.join(" ")).toMatch(/loyers de la carte ANIL/);
    expect(result.meta.changes.join(" ")).toMatch(/frais du type de vente/);

    alreadyExported(SALES_API_FEED_DAILY_ROWS);
    await expect(exportSalesApiFeed({ auth, search, request })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("échoue fermé si le décompte des lignes est illisible", async () => {
    mocks.exported.mockResolvedValue({ data: null, error: new Error("base indisponible") });
    await expect(exportSalesCsv({ auth, search, request })).rejects.toThrow("base indisponible");
    expect(mocks.getSales).not.toHaveBeenCalled();
  });
});
