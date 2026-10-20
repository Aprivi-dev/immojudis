import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-lawyer-statement", () => ({ getAdminLawyerStatement: mocks.get }));

import { GET } from "./route";

const url = "https://example.test/api/admin/lawyers/statement";
const statement = {
  month: "2026-11",
  rows: [],
  totals: { impressions: 0, ctaClicks: 0, referralRequestsSent: 0 },
};

describe("GET /api/admin/lawyers/statement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("returns the month without cache, with the administrator's token", async () => {
    mocks.get.mockResolvedValue(statement);

    const response = await GET(
      new Request(`${url}?month=2026-11`, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(statement);
    expect(mocks.get).toHaveBeenCalledWith("admin-token", "2026-11");
  });

  it("refuses a missing or malformed month without reading anything", async () => {
    const headers = { authorization: "Bearer admin-token" };

    expect((await GET(new Request(url, { headers }))).status).toBe(400);
    expect((await GET(new Request(`${url}?month=2026-13`, { headers }))).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("refuses without a token", async () => {
    const response = await GET(new Request(`${url}?month=2026-11`));

    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("refuses an account that is not an administrator", async () => {
    mocks.get.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));

    const response = await GET(
      new Request(`${url}?month=2026-11`, { headers: { authorization: "Bearer user-token" } }),
    );

    expect(response.status).toBe(403);
  });
});
