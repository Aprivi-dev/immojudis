import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  range: vi.fn(),
  rpc: vi.fn(),
  lawyerRows: vi.fn(),
  calls: [] as string[][],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "not", "order"]) {
    chain[method] = (...args: unknown[]) => {
      mocks.calls.push([method, ...args.map(String)]);
      return chain;
    };
  }
  chain.range = mocks.range;
  // Lecture des avocats référencés (sans pagination) : la chaîne se résout d'elle-même.
  chain.then = (resolve: (value: unknown) => unknown) => resolve(mocks.lawyerRows());
  return { supabaseAdmin: { from: () => chain, rpc: mocks.rpc } };
});

import {
  clearUpcomingProsecutionCache,
  loadProsecutedSalesForLawyerIds,
  loadUpcomingProsecutedSales,
  parseLawyerIdsParam,
} from "./lawyer-prosecuted-sales.server";

const NOW = new Date("2026-11-20T10:00:00Z");
const durand = {
  id: "lawyer-durand",
  displayName: "Maître Claire Durand",
  barAssociation: "Bordeaux",
};
const lefevre = { id: "lawyer-lefevre", displayName: "Marc Lefèvre", barAssociation: "Bordeaux" };

function candidate(id: string, lawyerName: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    lawyer_name: lawyerName,
    tribunal: "Tribunal judiciaire de Bordeaux",
    sale_date: "2026-12-01T09:00:00Z",
    status: "upcoming",
    catalogue_quarantined: false,
    publication_quarantine: null,
    publication_identity_conflict: null,
    source_identity_mismatch: null,
    ...extra,
  };
}

function publicSummary(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    city: "Mérignac",
    property_type: "apartment",
    sale_date: "2026-12-01T09:00:00Z",
    starting_price_eur: 85_000,
    sale_venue_type: "tribunal",
    tribunal_name: "Tribunal judiciaire de Bordeaux",
    ...extra,
  };
}

describe("loadUpcomingProsecutedSales", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.calls.length = 0;
    clearUpcomingProsecutionCache();
    mocks.rpc.mockImplementation(async (_name: string, args: { p_sale_id: string }) => ({
      data: [publicSummary(args.p_sale_id)],
      error: null,
    }));
  });

  it("reads only upcoming sales that name a lawyer, and returns public facts only", async () => {
    mocks.range.mockResolvedValue({
      data: [candidate("sale-1", "Me Claire DURAND"), candidate("sale-2", "Me Pierre Martin")],
      error: null,
    });

    const result = await loadUpcomingProsecutedSales([durand], new Set([durand.id]), NOW);

    expect(mocks.calls).toContainEqual(["eq", "status", "upcoming"]);
    expect(mocks.calls).toContainEqual(["gte", "sale_date", NOW.toISOString()]);
    expect(mocks.calls).toContainEqual(["not", "lawyer_name", "is", "null"]);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("get_public_sale_summary", { p_sale_id: "sale-1" });
    expect(result.get(durand.id)).toEqual({
      total: 1,
      sales: [
        {
          id: "sale-1",
          city: "Mérignac",
          propertyType: "apartment",
          saleDate: "2026-12-01T09:00:00Z",
          startingPriceEur: 85_000,
          tribunalName: "Tribunal judiciaire de Bordeaux",
        },
      ],
    });
    // The prosecuting lawyer's name never leaves the server.
    expect(JSON.stringify([...result])).not.toContain("DURAND");
  });

  it("skips quarantined sales and sales that the public catalogue does not return", async () => {
    mocks.range.mockResolvedValue({
      data: [
        candidate("quarantined", "Claire Durand", { catalogue_quarantined: true }),
        candidate("marked", "Claire Durand", { publication_quarantine: "identity" }),
        candidate("hidden", "Claire Durand"),
        candidate("notary", "Claire Durand"),
        candidate("visible", "Claire Durand"),
      ],
      error: null,
    });
    mocks.rpc.mockImplementation(async (_name: string, args: { p_sale_id: string }) => ({
      data:
        args.p_sale_id === "hidden"
          ? []
          : [
              publicSummary(args.p_sale_id, {
                sale_venue_type: args.p_sale_id === "notary" ? "notary" : "tribunal",
              }),
            ],
      error: null,
    }));

    const result = await loadUpcomingProsecutedSales([durand], new Set([durand.id]), NOW);

    expect(result.get(durand.id)?.sales.map((sale) => sale.id)).toEqual(["visible"]);
    expect(mocks.rpc).not.toHaveBeenCalledWith("get_public_sale_summary", {
      p_sale_id: "quarantined",
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith("get_public_sale_summary", { p_sale_id: "marked" });
  });

  it("shows at most five sales and counts the others", async () => {
    mocks.range.mockResolvedValue({
      data: Array.from({ length: 7 }, (_, index) =>
        candidate(`sale-${index}`, "Claire Durand", {
          sale_date: `2026-12-0${index + 1}T09:00:00Z`,
        }),
      ),
      error: null,
    });

    const result = await loadUpcomingProsecutedSales([durand], new Set([durand.id]), NOW);

    expect(result.get(durand.id)?.sales).toHaveLength(5);
    expect(result.get(durand.id)?.total).toBe(7);
  });

  it("returns nothing for a lawyer without a reliable match, and no entry for lawyers not shown", async () => {
    mocks.range.mockResolvedValue({
      data: [candidate("sale-1", "Claire Durand"), candidate("sale-2", "Marc Lefèvre")],
      error: null,
    });

    const result = await loadUpcomingProsecutedSales([durand, lefevre], new Set([lefevre.id]), NOW);

    expect([...result.keys()]).toEqual([lefevre.id]);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("knows homonyms that are not on the page", async () => {
    const twin = { ...durand, id: "lawyer-twin", displayName: "Claire DURAND" };
    mocks.range.mockResolvedValue({ data: [candidate("sale-1", "Claire Durand")], error: null });

    const result = await loadUpcomingProsecutedSales([durand, twin], new Set([durand.id]), NOW);

    expect(result.size).toBe(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps the upcoming sales for five minutes instead of reading them again", async () => {
    mocks.range.mockResolvedValue({ data: [candidate("sale-1", "Claire Durand")], error: null });

    await loadUpcomingProsecutedSales([durand], new Set([durand.id]), NOW);
    await loadUpcomingProsecutedSales(
      [durand],
      new Set([durand.id]),
      new Date(NOW.getTime() + 4 * 60_000),
    );
    expect(mocks.range).toHaveBeenCalledTimes(1);

    await loadUpcomingProsecutedSales(
      [durand],
      new Set([durand.id]),
      new Date(NOW.getTime() + 6 * 60_000),
    );
    expect(mocks.range).toHaveBeenCalledTimes(2);
  });

  it("does not read anything without a lawyer to show", async () => {
    const result = await loadUpcomingProsecutedSales([durand], new Set(), NOW);

    expect(result.size).toBe(0);
    expect(mocks.range).not.toHaveBeenCalled();
  });

  it("lets a database error through, for the caller to answer with a generic error", async () => {
    mocks.range.mockResolvedValue({ data: null, error: new Error("boom") });

    await expect(loadUpcomingProsecutedSales([durand], new Set([durand.id]), NOW)).rejects.toThrow(
      "boom",
    );
  });
});

describe("loadProsecutedSalesForLawyerIds", () => {
  const rows = [
    { id: durand.id, display_name: durand.displayName, bar_association: durand.barAssociation },
    { id: lefevre.id, display_name: lefevre.displayName, bar_association: lefevre.barAssociation },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.calls.length = 0;
    clearUpcomingProsecutionCache();
    mocks.lawyerRows.mockReturnValue({ data: rows, error: null });
    mocks.rpc.mockImplementation(async (_name: string, args: { p_sale_id: string }) => ({
      data: [publicSummary(args.p_sale_id)],
      error: null,
    }));
  });

  it("rend les ventes par identifiant d'avocat demandé, depuis les avocats référencés actifs", async () => {
    mocks.range.mockResolvedValue({
      data: [candidate("sale-1", "Claire Durand"), candidate("sale-2", "Marc Lefèvre")],
      error: null,
    });

    const result = await loadProsecutedSalesForLawyerIds([durand.id], NOW);

    expect(mocks.calls).toContainEqual(["eq", "status", "active"]);
    expect(mocks.calls).toContainEqual(["eq", "accepts_judicial_auctions", "true"]);
    expect(Object.keys(result.lawyers)).toEqual([durand.id]);
    expect(result.lawyers[durand.id].sales.map((sale) => sale.id)).toEqual(["sale-1"]);
  });

  it("ignore un identifiant qui n'est pas un avocat référencé actif", async () => {
    mocks.range.mockResolvedValue({ data: [candidate("sale-1", "Claire Durand")], error: null });

    const result = await loadProsecutedSalesForLawyerIds(["lawyer-inconnu"], NOW);

    expect(result).toEqual({ lawyers: {} });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("laisse passer une erreur de lecture des avocats", async () => {
    mocks.lawyerRows.mockReturnValue({ data: null, error: new Error("boom") });

    await expect(loadProsecutedSalesForLawyerIds([durand.id], NOW)).rejects.toThrow("boom");
  });
});

describe("parseLawyerIdsParam", () => {
  const first = "10000000-0000-4000-8000-000000000001";
  const second = "10000000-0000-4000-8000-000000000002";

  it("lit une liste d'identifiants séparés par des virgules, sans doublon", () => {
    expect(parseLawyerIdsParam(`${first}, ${second},${first}`)).toEqual([first, second]);
  });

  it("refuse une liste absente, vide, mal formée ou plus longue qu'une page de l'annuaire", () => {
    expect(() => parseLawyerIdsParam(null)).toThrow("Requête invalide");
    expect(() => parseLawyerIdsParam(" , ")).toThrow("Requête invalide");
    expect(() => parseLawyerIdsParam(`${first},cnb:123`)).toThrow("Requête invalide");
    const tooMany = Array.from(
      { length: 51 },
      (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(() => parseLawyerIdsParam(tooMany.join(","))).toThrow("Requête invalide");
    expect(parseLawyerIdsParam(tooMany.slice(0, 50).join(","))).toHaveLength(50);
  });
});
