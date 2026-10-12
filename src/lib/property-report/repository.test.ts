import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@/lib/property-reports";
import type { SavedReportRow } from "@/lib/property-reports";

const mocks = vi.hoisted(() => ({
  assertSalePublicationVisible: vi.fn(),
}));

vi.mock("@/lib/sale-publication-guard", () => ({
  assertSalePublicationVisible: mocks.assertSalePublicationVisible,
  getPublicationVisibleSaleIds: vi.fn(),
}));

import { getReport } from "./repository";

afterEach(() => vi.resetAllMocks());

describe("property report repository", () => {
  it("loads the 51st report directly while retaining owner filtering", async () => {
    const report = {
      id: "report-51",
      user_id: "owner-1",
      sale_id: "sale-51",
    } as SavedReportRow;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({ data: report, error: null }),
    };
    const supabase = { from: vi.fn(() => query) } as unknown as SupabaseClient;

    await expect(getReport(supabase, "owner-1", "report-51")).resolves.toBe(report);

    expect(supabase.from).toHaveBeenCalledWith("saved_property_reports");
    expect(query.eq).toHaveBeenNthCalledWith(1, "id", "report-51");
    expect(query.eq).toHaveBeenNthCalledWith(2, "user_id", "owner-1");
    expect(mocks.assertSalePublicationVisible).toHaveBeenCalledWith("sale-51");
  });
});
