import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  row: null as unknown,
  visible: new Set<string>(),
  error: null as unknown,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: mocks.row, error: mocks.error }),
  };
  return { supabaseAdmin: { from: () => query } };
});
vi.mock("@/lib/sale-publication-guard", () => ({
  getPublicationVisibleSaleIds: async () => mocks.visible,
  publicationVisibleRows: vi.fn(),
}));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: vi.fn() }));

import { getSharedSaleComparison } from "@/lib/sale-analysis-sets";

const TOKEN = "abcDEF123_-abcDEF123_-abcDEF123_";
const IDS = [
  "7d335032-e935-4550-9347-ed22b0f63449",
  "8e446143-fa46-4661-a458-fe33c1074a5a",
  "9f557254-0b57-4772-b569-0f44d2185b6b",
];

function snapshot(ids: string[]) {
  return {
    version: 1,
    items: ids.map((id) => ({ id, city: "Bordeaux", startingPriceEur: 100_000 })),
  };
}

function shared(ids: string[], overrides: Record<string, unknown> = {}) {
  return {
    name: "Ma sélection",
    analysis_kind: "comparison",
    shared_snapshot: snapshot(ids),
    shared_at: "2026-10-01T10:00:00.000Z",
    share_expires_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("getSharedSaleComparison", () => {
  beforeEach(() => {
    mocks.row = shared(IDS);
    mocks.visible = new Set(IDS);
    mocks.error = null;
  });

  it("returns every sale when all of them are still in the catalogue", async () => {
    const comparison = await getSharedSaleComparison(TOKEN);

    expect(comparison.items.map((item) => item.id)).toEqual(IDS);
    expect(comparison.withdrawnCount).toBe(0);
  });

  it("drops a withdrawn sale instead of failing the whole link, and counts it", async () => {
    mocks.visible = new Set([IDS[0], IDS[2]]);

    const comparison = await getSharedSaleComparison(TOKEN);

    expect(comparison.items.map((item) => item.id)).toEqual([IDS[0], IDS[2]]);
    expect(comparison.withdrawnCount).toBe(1);
    expect(comparison.name).toBe("Ma sélection");
  });

  it("keeps the link while at least one sale remains", async () => {
    mocks.visible = new Set([IDS[1]]);

    const comparison = await getSharedSaleComparison(TOKEN);

    expect(comparison.items).toHaveLength(1);
    expect(comparison.withdrawnCount).toBe(2);
  });

  it("fails only when no sale is left", async () => {
    mocks.visible = new Set();

    await expect(getSharedSaleComparison(TOKEN)).rejects.toThrow("introuvable ou expirée");
  });

  it("still fails for an unknown, expired or empty link", async () => {
    mocks.row = null;
    await expect(getSharedSaleComparison(TOKEN)).rejects.toThrow("introuvable ou expirée");

    mocks.row = shared(IDS, { share_expires_at: "2020-01-01T00:00:00.000Z" });
    await expect(getSharedSaleComparison(TOKEN)).rejects.toThrow("introuvable ou expirée");

    mocks.row = shared([]);
    await expect(getSharedSaleComparison(TOKEN)).rejects.toThrow("introuvable ou expirée");
  });

  it("looks the link up by digest and propagates a database failure", async () => {
    expect(createHash("sha256").update(TOKEN).digest("hex")).toHaveLength(64);
    mocks.error = new Error("connection reset");

    await expect(getSharedSaleComparison(TOKEN)).rejects.toThrow("connection reset");
  });
});
