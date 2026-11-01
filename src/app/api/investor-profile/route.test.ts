import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/investor-profile-store", () => ({
  getInvestorProfile: mocks.get,
  saveInvestorProfile: mocks.save,
  deleteInvestorProfile: mocks.remove,
}));

import { DELETE, GET, PUT } from "./route";

const AUTH = { userId: "user-1" };
const URL_ = "https://immojudis.test/api/investor-profile";
const put = (body: unknown) =>
  PUT(new Request(URL_, { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue(AUTH);
});

describe("/api/investor-profile", () => {
  it("lit le profil du compte, jamais mis en cache", async () => {
    mocks.get.mockResolvedValue({ profile: null });
    const response = await GET(new Request(URL_));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ profile: null });
    expect(mocks.get).toHaveBeenCalledWith({ auth: AUTH });
  });

  it("enregistre le profil du compte avec des montants arrondis", async () => {
    mocks.save.mockResolvedValue({ profile: {} });
    const response = await put({ downPaymentEur: 40_000.4, strategy: "louer" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.save).toHaveBeenCalledWith({
      auth: AUTH,
      input: { downPaymentEur: 40_000, strategy: "louer" },
    });
  });

  it("efface le profil du compte", async () => {
    mocks.remove.mockResolvedValue({ ok: true, removed: true });
    const response = await DELETE(new Request(URL_, { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ auth: AUTH });
  });

  it("exige un compte connecté pour chaque méthode", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: No token provided"));
    expect((await GET(new Request(URL_))).status).toBe(401);
    expect((await put({ strategy: "louer" })).status).toBe(401);
    expect((await DELETE(new Request(URL_, { method: "DELETE" }))).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuse un profil vide, hors bornes ou avec un autre compte, avant toute écriture", async () => {
    for (const body of [
      {},
      { targetMarginPct: 80 },
      { strategy: "habiter" },
      { strategy: "louer", userId: "user-2" },
    ]) {
      const response = await put(body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
