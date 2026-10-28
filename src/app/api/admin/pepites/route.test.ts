import { beforeEach, describe, expect, it, vi } from "vitest";
import { unavailablePepites } from "@/lib/admin-pepites";

const mocks = vi.hoisted(() => ({ get: vi.fn(), suspend: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-pepites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-pepites")>()),
  getAdminPepites: mocks.get,
  suspendAdminPepites: mocks.suspend,
}));

import { GET, POST, maxDuration } from "./route";

const url = "https://example.test/api/admin/pepites";

describe("GET /api/admin/pepites", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rend les pépites sans cache, avec le jeton de l'administrateur", async () => {
    mocks.get.mockResolvedValue({ ...unavailablePepites(), migrated: true, mode: "shadow" });

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // La réponse est la page déjà mise en forme (sections), pas les données brutes.
    const body = await response.json();
    expect(body.sections.map((section: { id: string }) => section.id)).toEqual([
      "mode",
      "counters",
      "rate",
      "flood",
      "fees",
      "list",
      "independence",
    ]);
    expect(JSON.stringify(body)).toContain("Mode : shadow");
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

  it("répond par une erreur neutre à une panne, sans détail de la base", async () => {
    mocks.get.mockRejectedValue(new Error("relation auction_sale_pepites does not exist"));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("auction_sale_pepites");
  });

  describe("POST : arrêt d'urgence", () => {
    const post = (
      body: unknown,
      headers: Record<string, string> = { authorization: "Bearer admin-token" },
    ) => POST(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));

    it("passe en shadow par défaut, avec le jeton de l'administrateur", async () => {
      mocks.suspend.mockResolvedValue({ mode: "shadow" });

      const response = await post({});

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ mode: "shadow" });
      expect(mocks.suspend).toHaveBeenCalledWith("admin-token", { mode: "shadow" });
    });

    it("accepte « off » et refuse tout autre mode, « on » compris", async () => {
      mocks.suspend.mockResolvedValue({ mode: "off" });
      expect((await post({ mode: "off" })).status).toBe(200);
      for (const body of [{ mode: "on" }, { mode: "autre" }, { mode: "shadow", extra: 1 }]) {
        mocks.suspend.mockClear();
        expect((await post(body)).status).toBe(400);
        expect(mocks.suspend).not.toHaveBeenCalled();
      }
    });

    it("répond 401 sans jeton avant même de valider le corps, et ne lit rien", async () => {
      for (const body of [{}, { mode: "on" }, { mode: "autre" }]) {
        expect((await post(body, {})).status).toBe(401);
      }
      expect((await POST(new Request(url, { method: "POST", body: "pas du JSON" }))).status).toBe(
        401,
      );
      expect(mocks.suspend).not.toHaveBeenCalled();
    });

    it("refuse sans jeton et un compte non administrateur", async () => {
      expect((await post({}, {})).status).toBe(401);
      mocks.suspend.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));
      expect((await post({})).status).toBe(403);
    });
  });

  it("laisse trente secondes à la route", () => {
    expect(maxDuration).toBe(30);
  });
});
