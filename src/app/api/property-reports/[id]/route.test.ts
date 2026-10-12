import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getPropertyReport: vi.fn(),
  deletePropertyReport: vi.fn(),
  updatePropertyReport: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "fixture-token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({
  getPropertyReport: mocks.getPropertyReport,
  deletePropertyReport: mocks.deletePropertyReport,
  updatePropertyReport: mocks.updatePropertyReport,
  propertyReportUpdateSchema: { parse: mocks.parse },
}));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "owner-1" });
});

describe("property report detail route", () => {
  it("reads report 51 through the direct owner-scoped detail service", async () => {
    mocks.getPropertyReport.mockResolvedValue({
      report: { id: "report-51", user_id: "owner-1" },
      plan: { plan: "analyse" },
    });

    const response = await GET(new Request("http://localhost/api/property-reports/report-51"), {
      params: Promise.resolve({ id: "report-51" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(mocks.getPropertyReport).toHaveBeenCalledWith({
      auth: { userId: "owner-1" },
      reportId: "report-51",
    });
    await expect(response.json()).resolves.toMatchObject({ report: { id: "report-51" } });
  });
});
