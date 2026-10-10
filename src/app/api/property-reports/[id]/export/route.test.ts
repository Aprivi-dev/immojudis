import { beforeEach, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), exportPdf: vi.fn(), enforceUser: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforceUser }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "fixture-token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({ exportPropertyReportPdf: mocks.exportPdf }));
import { POST } from "./route";
const request = () =>
  new Request("http://localhost/api/property-reports/fixture/export", { method: "POST" });
const params = { params: Promise.resolve({ id: "fixture" }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "user" });
  mocks.enforceUser.mockResolvedValue(1);
});
it("returns 403 and prevents caching when the plan does not include PDF export", async () => {
  mocks.exportPdf.mockRejectedValue(new Error("Export PDF réservé au plan Analyse."));
  const response = await POST(request(), params);
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("authorization");
  expect(await response.json()).toMatchObject({
    ok: false,
    error: "Export PDF réservé au plan Analyse.",
    code: "FORBIDDEN",
  });
});
it("returns 401 without invoking export when authentication fails", async () => {
  mocks.auth.mockRejectedValue(new Error("Unauthorized: Invalid token"));
  expect((await POST(request(), params)).status).toBe(401);
  expect(mocks.exportPdf).not.toHaveBeenCalled();
});
it("preserves PDF bytes for an entitled owner", async () => {
  mocks.exportPdf.mockResolvedValue({
    bytes: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    filename: "rapport.pdf",
  });
  const response = await POST(request(), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
});
it("returns 429 with Retry-After when the PDF export budget is spent", async () => {
  mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 12));
  const response = await POST(request(), params);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("12");
  expect(mocks.exportPdf).not.toHaveBeenCalled();
});
