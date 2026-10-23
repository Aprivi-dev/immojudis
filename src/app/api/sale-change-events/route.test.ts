import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/sale-change-monitor", () => ({
  listSaleChangeEvents: mocks.list,
  monitorUserSaleChanges: vi.fn(),
  saleChangeEventActionSchema: { parse: vi.fn() },
  updateSaleChangeEventState: vi.fn(),
}));

import { GET } from "./route";

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const AUTH = { userId: "user-1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue(AUTH);
  mocks.list.mockResolvedValue({ events: [] });
});

describe("GET /api/sale-change-events", () => {
  it("rend les changements de toutes les ventes suivies sans filtre", async () => {
    const response = await GET(new Request("https://immojudis.test/api/sale-change-events"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith({
      auth: AUTH,
      limit: 80,
      includeDismissed: false,
      saleId: undefined,
    });
  });

  it("limite la lecture à une vente (fiche : plafond à vérifier), écartés compris", async () => {
    await GET(
      new Request(
        `https://immojudis.test/api/sale-change-events?saleId=${SALE_ID}&includeDismissed=true&limit=50`,
      ),
    );

    expect(mocks.list).toHaveBeenCalledWith({
      auth: AUTH,
      limit: 50,
      includeDismissed: true,
      saleId: SALE_ID,
    });
  });

  it("refuse un identifiant de vente invalide sans lire la base", async () => {
    const response = await GET(
      new Request("https://immojudis.test/api/sale-change-events?saleId=nope"),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
