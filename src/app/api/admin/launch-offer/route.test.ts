import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-launch-offer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-launch-offer")>()),
  getAdminLaunchOffer: mocks.get,
  setAdminLaunchOffer: mocks.set,
}));

import { GET, POST } from "./route";

const url = "https://example.test/api/admin/launch-offer";
const headers = { authorization: "Bearer admin-token" };

describe("/api/admin/launch-offer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("lit l'état sans cache", async () => {
    mocks.get.mockResolvedValue({ active: true });
    const response = await GET(new Request(url, { headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.get).toHaveBeenCalledWith("admin-token");
  });

  it("change l'état avec le jeton de l'administrateur", async () => {
    mocks.set.mockResolvedValue({ active: false });
    const response = await POST(
      new Request(url, { method: "POST", headers, body: JSON.stringify({ active: false }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
    expect(mocks.set).toHaveBeenCalledWith({
      authToken: "admin-token",
      input: { active: false },
    });
  });

  it("refuse sans jeton, sans rien changer", async () => {
    const response = await POST(
      new Request(url, { method: "POST", body: JSON.stringify({ active: false }) }),
    );
    expect(response.status).toBe(401);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("lit le jeton avant de valider le corps : sans jeton, un corps invalide est refusé en 401", async () => {
    const response = await POST(
      new Request(url, { method: "POST", body: JSON.stringify({ active: "oui" }) }),
    );
    expect(response.status).toBe(401);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.set.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));
    const response = await POST(
      new Request(url, { method: "POST", headers, body: JSON.stringify({ active: false }) }),
    );
    expect(response.status).toBe(403);
  });

  it("refuse un corps invalide avant toute écriture", async () => {
    const response = await POST(
      new Request(url, { method: "POST", headers, body: JSON.stringify({ active: "oui" }) }),
    );
    expect(response.status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
