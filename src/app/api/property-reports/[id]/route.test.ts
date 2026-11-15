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

import { DELETE, GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "owner-1" });
});

describe("property report detail route", () => {
  it("reads report 51 through the direct owner-scoped detail service", async () => {
    mocks.getPropertyReport.mockResolvedValue({
      report: { id: "51515151-5151-4515-8515-515151515151", user_id: "owner-1" },
      plan: { plan: "analyse" },
    });

    const response = await GET(
      new Request("http://localhost/api/property-reports/51515151-5151-4515-8515-515151515151"),
      {
        params: Promise.resolve({ id: "51515151-5151-4515-8515-515151515151" }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(mocks.getPropertyReport).toHaveBeenCalledWith({
      auth: { userId: "owner-1" },
      reportId: "51515151-5151-4515-8515-515151515151",
    });
    await expect(response.json()).resolves.toMatchObject({
      report: { id: "51515151-5151-4515-8515-515151515151" },
    });
  });

  it("answers 400 to a malformed report identifier, before any read", async () => {
    for (const handler of [GET, DELETE]) {
      const response = await handler(new Request("http://localhost/api/property-reports/x"), {
        params: Promise.resolve({ id: "pas-un-uuid" }),
      });
      expect(response.status).toBe(400);
    }
    expect(mocks.getPropertyReport).not.toHaveBeenCalled();
    expect(mocks.deletePropertyReport).not.toHaveBeenCalled();
  });
});
