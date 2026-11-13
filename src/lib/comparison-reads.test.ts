import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sale-publication-guard", () => ({ assertSalePublicationVisible: vi.fn() }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { getMarketAnalytics, marketAnalyticsQuerySchema } from "@/lib/market-analytics";
import { getSaleHistory, saleHistoryQuerySchema } from "@/lib/sale-history";

const SALE_ID = "6f0f8d0e-6b1e-4b5e-9a39-0d7a4c1a1b11";
const REFERENCE = {
  id: SALE_ID,
  city: "Bordeaux",
  department: "33",
  tribunal_code: "tj-bordeaux",
  property_type: "apartment",
};

/**
 * Session d'administrateur (droits complets) dont la vue rend la vente de référence, puis, pour
 * chaque lecture de périmètre, `rowsPerRead` lignes ; chaque lecture garde ses filtres.
 */
function fakeAuth(rowsPerRead: number[], reference: Record<string, unknown> = REFERENCE) {
  const reads: string[][] = [];
  const from = vi.fn(() => {
    const filters: string[] = [];
    const builder: Record<string, unknown> = {};
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        filters.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(",")})`);
        return builder;
      };
    for (const name of ["select", "not", "gte", "lte", "order", "limit", "eq", "neq"]) {
      builder[name] = chain(name);
    }
    builder.maybeSingle = async () => ({ data: reference, error: null });
    builder.then = (resolve: (value: unknown) => void) => {
      const count = rowsPerRead[reads.length] ?? 0;
      reads.push(filters);
      resolve({
        data: Array.from({ length: count }, (_, index) => ({ id: `row-${index}` })),
        error: null,
      });
    };
    return builder;
  });
  return { auth: { userId: "admin-1", isAdmin: true, supabase: { from } } as never, reads };
}

beforeEach(() => vi.clearAllMocks());

describe("analyse de marché d'une vente", () => {
  it("écarte la vente de référence de l'échantillon, à chaque périmètre essayé", async () => {
    const { auth, reads } = fakeAuth([2, 6]);

    const response = await getMarketAnalytics({
      auth,
      input: marketAnalyticsQuerySchema.parse({ saleId: SALE_ID }),
      now: new Date("2026-05-31T10:00:00.000Z"),
    });

    expect(reads).toHaveLength(2);
    for (const filters of reads) expect(filters).toContain(`neq("id","${SALE_ID}")`);
    expect(response.scope.label).toBe("Même tribunal et même type de bien");
  });

  it("compte les mois au calendrier : 3 mois avant ou après le 31 mai tombent les 28 février et 31 août", async () => {
    const { auth } = fakeAuth([5]);

    const response = await getMarketAnalytics({
      auth,
      input: marketAnalyticsQuerySchema.parse({ city: "Lyon", months: "3", futureMonths: "3" }),
      now: new Date("2026-05-31T10:00:00.000Z"),
    });

    expect(response.scope).toMatchObject({
      label: "Même ville",
      fromDate: "2026-02-28T10:00:00.000Z",
      toDate: "2026-08-31T10:00:00.000Z",
    });
  });
});

describe("ventes passées autour d'une vente", () => {
  it("nomme le périmètre du tribunal par ses deux critères, tribunal et type de bien", async () => {
    const { auth, reads } = fakeAuth([0, 3]);

    const response = await getSaleHistory({
      auth,
      input: saleHistoryQuerySchema.parse({ saleId: SALE_ID }),
      now: new Date("2026-05-31T10:00:00.000Z"),
    });

    expect(response.scope.label).toBe("Même tribunal et même type de bien");
    expect(reads[1]).toEqual(
      expect.arrayContaining([
        `neq("id","${SALE_ID}")`,
        `eq("tribunal_code","tj-bordeaux")`,
        `eq("property_type","apartment")`,
      ]),
    );
  });

  it("élargit en dernier à la ville, tous types de biens confondus", async () => {
    const { auth, reads } = fakeAuth([0, 0, 0, 0, 1]);

    const response = await getSaleHistory({
      auth,
      input: saleHistoryQuerySchema.parse({ saleId: SALE_ID }),
      now: new Date("2026-05-31T10:00:00.000Z"),
    });

    expect(response.scope).toMatchObject({ label: "Même ville", propertyType: null });
    expect(reads.at(-1)).not.toContain(`eq("property_type","apartment")`);
  });

  it("compte les mois au calendrier : 3 mois avant le 31 mai, c'est le 28 février", async () => {
    const { auth } = fakeAuth([1]);

    const response = await getSaleHistory({
      auth,
      input: saleHistoryQuerySchema.parse({ department: "33", months: "3" }),
      now: new Date("2026-05-31T10:00:00.000Z"),
    });

    expect(response.scope.fromDate).toBe("2026-02-28T10:00:00.000Z");
  });
});

// Avant le lot 12, `selectedScope.label` levait une TypeError (500) faute de périmètre.
describe("vente de référence sans rien de comparable", () => {
  const NOTHING = {
    id: SALE_ID,
    city: null,
    department: null,
    tribunal_code: null,
    property_type: "unknown",
  };
  const message =
    "La vente de référence n'a ni ville, ni département, ni tribunal, ni type de bien : aucun périmètre de comparaison.";

  it("refuse l'analyse de marché (400) sans lire les ventes", async () => {
    const { auth, reads } = fakeAuth([], NOTHING);

    await expect(
      getMarketAnalytics({ auth, input: marketAnalyticsQuerySchema.parse({ saleId: SALE_ID }) }),
    ).rejects.toMatchObject({ name: "PublicApiError", status: 400, message });
    expect(reads).toHaveLength(0);
  });

  it("refuse les ventes passées (400) sans lire les ventes", async () => {
    const { auth, reads } = fakeAuth([], { ...NOTHING, property_type: null });

    await expect(
      getSaleHistory({ auth, input: saleHistoryQuerySchema.parse({ saleId: SALE_ID }) }),
    ).rejects.toMatchObject({ name: "PublicApiError", status: 400, message });
    expect(reads).toHaveLength(0);
  });
});
