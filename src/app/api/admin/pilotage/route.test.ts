import { beforeEach, describe, expect, it, vi } from "vitest";
import { unavailablePilotage, unavailableSaleReminderAccuracy } from "@/lib/admin-pilotage";

const mocks = vi.hoisted(() => ({ get: vi.fn(), accuracy: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-pilotage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-pilotage")>()),
  getAdminPilotage: mocks.get,
  getAdminSaleReminderAccuracy: mocks.accuracy,
}));

import { GET } from "./route";

const url = "https://example.test/api/admin/pilotage";

describe("GET /api/admin/pilotage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rend les agrégats sans cache, avec le jeton de l'administrateur", async () => {
    const saleReminders = {
      ...unavailableSaleReminderAccuracy(new Date("2026-11-03T06:00:00Z")),
      measuredReminders: 120,
      contradictedReminders: 1,
      contradictionRate: 1 / 120,
      verdict: "met" as const,
    };
    mocks.get.mockResolvedValue(unavailablePilotage());
    mocks.accuracy.mockResolvedValue(saleReminders);

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ...unavailablePilotage(), saleReminders });
    expect(mocks.get).toHaveBeenCalledWith("admin-token", expect.any(Date));
    expect(mocks.accuracy).toHaveBeenCalledWith("admin-token", expect.any(Date));
  });

  it("garde le pilotage quand la mesure des rappels échoue : « non mesuré »", async () => {
    mocks.get.mockResolvedValue(unavailablePilotage());
    mocks.accuracy.mockRejectedValue(new Error("lecture impossible"));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.windows).toEqual(unavailablePilotage().windows);
    expect(body.saleReminders).toMatchObject({
      measuredReminders: null,
      contradictionRate: null,
      verdict: "unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("lecture impossible");
  });

  it("refuse sans jeton, sans rien lire", async () => {
    const response = await GET(new Request(url));

    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.get.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));
    mocks.accuracy.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer user-token" } }),
    );

    expect(response.status).toBe(403);
  });
});
