import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  apiKeyAuth: vi.fn(),
  exportCsv: vi.fn(),
  exportFeed: vi.fn(),
  webhook: vi.fn(),
  listRefresh: vi.fn(),
  requestRefresh: vi.fn(),
  parseRefreshList: vi.fn((value) => value),
  parseRefreshRequest: vi.fn((value) => value),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => null),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/api-keys", () => ({ apiKeyAuthContextFromRequest: mocks.apiKeyAuth }));
vi.mock("@/lib/sale-exports", () => ({
  exportSalesCsv: mocks.exportCsv,
  exportSalesApiFeed: mocks.exportFeed,
}));
vi.mock("@/lib/billing", () => ({ handleStripeWebhook: mocks.webhook }));
vi.mock("@/lib/data-refresh", () => ({
  dataRefreshListQuerySchema: { parse: mocks.parseRefreshList },
  dataRefreshRequestSchema: { parse: mocks.parseRefreshRequest },
  listDataRefreshRequests: mocks.listRefresh,
  requestDataRefresh: mocks.requestRefresh,
}));

import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { GET as exportCsv } from "@/app/api/sales/export/route";
import { GET as exportFeed } from "@/app/api/sales/feed/route";
import { POST as requestRefresh } from "@/app/api/data-refresh/route";

describe("critical API route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("returns a stable authentication error on CSV exports", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await exportCsv(
      new Request("https://example.test/api/sales/export", {
        headers: { "x-request-id": "client-12345678" },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("client-12345678");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "AUTH_REQUIRED",
      requestId: "client-12345678",
    });
  });

  it("preserves export metadata and request tracing on success", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.exportCsv.mockResolvedValue({
      content: "id,title\n1,Vente",
      filename: "ventes.csv",
      rowCount: 1,
    });

    const response = await exportCsv(new Request("https://example.test/api/sales/export"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-immojudis-export-row-count")).toBe("1");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.text()).toContain("id,title");
  });

  it("accepts a scoped API key for the bounded sales feed", async () => {
    const auth = { userId: "api-user" };
    mocks.apiKeyAuth.mockResolvedValue(auth);
    mocks.exportFeed.mockResolvedValue({
      ok: true,
      data: [],
      meta: { rowCount: 0 },
    });

    const response = await exportFeed(new Request("https://example.test/api/sales/feed"));

    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.exportFeed).toHaveBeenCalledWith(expect.objectContaining({ auth }));
    expect(response.headers.get("x-immojudis-export-row-count")).toBe("0");
  });

  it("does not expose Stripe configuration details", async () => {
    mocks.webhook.mockRejectedValue(new Error("STRIPE_WEBHOOK_SECRET configuration missing"));

    const response = await stripeWebhook(
      new Request("https://example.test/api/stripe/webhook", { method: "POST", body: "{}" }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(JSON.stringify(body)).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("maps plan rights failures to a stable forbidden response", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.requestRefresh.mockRejectedValue(new Error("Le refresh est réservé aux plans Analyse."));

    const response = await requestRefresh(
      new Request("https://example.test/api/data-refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ saleId: "sale-1" }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });
});
