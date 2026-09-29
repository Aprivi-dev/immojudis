import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import {
  assertPublicationVisiblePayload,
  assertPublicationVisibleSaleRow,
  assertSalePublicationVisible,
  getPublicationVisibleSaleIds,
  isPublicationQuarantined,
  publicationVisibleRows,
  SalePublicationUnavailableError,
} from "@/lib/sale-publication-guard";

function queryResult(result: { data: unknown; error: { message: string } | null }) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    maybeSingle: vi.fn(),
    then: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue(result);
  query.then.mockImplementation((resolve: (value: typeof result) => unknown) => resolve(result));
  return query;
}

describe("sale publication quarantine guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ publication_quarantine: "operator_hold" }],
    [{ publication_quarantine: true }],
    [{ publication_quarantine: 1 }],
  ])("recognizes every non-empty quarantine marker", (payload) => {
    expect(isPublicationQuarantined(payload)).toBe(true);
    expect(() => assertPublicationVisiblePayload(payload)).toThrow(SalePublicationUnavailableError);
  });

  it("blocks a quarantined status even when the marker was lost", () => {
    expect(isPublicationQuarantined({}, "quarantined")).toBe(true);
    expect(() =>
      assertPublicationVisibleSaleRow({ id: "status-hidden", status: "quarantined" }),
    ).toThrow(SalePublicationUnavailableError);
  });

  it("treats an absent or empty marker as visible", () => {
    expect(isPublicationQuarantined(null)).toBe(false);
    expect(isPublicationQuarantined({})).toBe(false);
    expect(isPublicationQuarantined({ publication_quarantine: "  " })).toBe(false);
    expect(() => assertPublicationVisiblePayload({})).not.toThrow();
  });

  it("fails closed for a missing sale and for a quarantined sale", async () => {
    const missing = queryResult({ data: null, error: null });
    mocks.from.mockReturnValueOnce(missing);
    await expect(assertSalePublicationVisible("sale-missing")).rejects.toThrow(
      SalePublicationUnavailableError,
    );

    const quarantined = queryResult({
      data: { id: "sale-hidden", publication_quarantine: "operator_hold" },
      error: null,
    });
    mocks.from.mockReturnValueOnce(quarantined);
    await expect(assertSalePublicationVisible("sale-hidden")).rejects.toThrow(
      SALE_PUBLICATION_UNAVAILABLE_MESSAGE,
    );
  });

  it("propagates a visibility query failure instead of serving the sale", async () => {
    const query = queryResult({ data: null, error: { message: "database unavailable" } });
    mocks.from.mockReturnValue(query);

    await expect(assertSalePublicationVisible("sale-1")).rejects.toThrow("database unavailable");
  });

  it("filters quarantined rows and keeps the public row shape", () => {
    const rows = publicationVisibleRows([
      { id: "visible", raw_payload: {} },
      { id: "hidden", raw_payload: { publication_quarantine: "operator_hold" } },
    ]);

    expect(rows).toEqual([{ id: "visible", raw_payload: {} }]);
  });

  it("returns only visible IDs for shared or aggregate service-role reads", async () => {
    const query = queryResult({
      data: [
        { id: "visible", publication_quarantine: null },
        { id: "hidden", publication_quarantine: "operator_hold" },
        { id: "status-hidden", status: "quarantined", publication_quarantine: null },
      ],
      error: null,
    });
    mocks.from.mockReturnValue(query);

    await expect(
      getPublicationVisibleSaleIds(["visible", "hidden", "status-hidden", "visible"]),
    ).resolves.toEqual(new Set(["visible"]));
    expect(query.in).toHaveBeenCalledWith("id", ["visible", "hidden", "status-hidden"]);
  });

  it("keeps a 1,000-sale export lookup within bounded PostgREST queries", async () => {
    const batches: string[][] = [];
    mocks.from.mockImplementation(() => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => {
          batches.push(ids);
          return {
            data: ids.map((id) => ({ id, status: "upcoming", publication_quarantine: null })),
            error: null,
          };
        },
      }),
    }));

    const ids = Array.from({ length: 205 }, (_, index) => `sale-${index}`);
    await expect(getPublicationVisibleSaleIds(ids)).resolves.toEqual(new Set(ids));
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
  });
});

const SALE_PUBLICATION_UNAVAILABLE_MESSAGE = "Vente introuvable ou inaccessible.";
