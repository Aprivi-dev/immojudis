import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: mocks.maybeSingle };
      return query;
    },
  },
}));

import { loadVisibleSaleLocation } from "./sale-location.server";

const row = {
  latitude: 48.85,
  longitude: 2.38,
  city: "Paris",
  postal_code: "75011",
  department: "75",
  status: "unknown",
  catalogue_quarantined: false,
  publication_quarantine: null,
};

beforeEach(() => vi.resetAllMocks());

describe("loadVisibleSaleLocation", () => {
  it("returns the location of a visible sale, whatever its catalogue status", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: row, error: null });

    await expect(loadVisibleSaleLocation("sale")).resolves.toEqual({
      latitude: 48.85,
      longitude: 2.38,
      city: "Paris",
      postalCode: "75011",
      department: "75",
    });
  });

  it.each([
    ["missing", null],
    ["catalogue quarantine", { ...row, catalogue_quarantined: true }],
    ["publication quarantine marker", { ...row, publication_quarantine: "conflict" }],
    ["quarantined status", { ...row, status: "quarantined" }],
  ])("refuses a %s sale", async (_, data) => {
    mocks.maybeSingle.mockResolvedValue({ data, error: null });

    await expect(loadVisibleSaleLocation("sale")).resolves.toBeNull();
  });

  it("propagates database errors instead of hiding the sale", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: new Error("down") });

    await expect(loadVisibleSaleLocation("sale")).rejects.toThrow("down");
  });
});
