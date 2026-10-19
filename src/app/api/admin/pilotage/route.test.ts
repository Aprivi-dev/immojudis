import { beforeEach, describe, expect, it, vi } from "vitest";
import { unavailablePilotage } from "@/lib/admin-pilotage";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
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
    mocks.get.mockResolvedValue(unavailablePilotage());

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(unavailablePilotage());
    expect(mocks.get).toHaveBeenCalledWith("admin-token");
  });

  it("refuse sans jeton, sans rien lire", async () => {
    const response = await GET(new Request(url));

    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.get.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer user-token" } }),
    );

    expect(response.status).toBe(403);
  });
});
