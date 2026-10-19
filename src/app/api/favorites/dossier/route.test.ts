import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/favorite-dossier", () => ({
  getFavoriteDossier: mocks.get,
  saveFavoriteDossier: mocks.save,
}));

import { GET, PUT } from "./route";
import { PublicApiError } from "@/lib/api-errors";

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const AUTH = { userId: "user-1" };

function put(body: unknown) {
  return new Request("https://immojudis.test/api/favorites/dossier", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue(AUTH);
});

describe("/api/favorites/dossier", () => {
  it("lit le dossier d'une vente, jamais mis en cache", async () => {
    mocks.get.mockResolvedValue({ dossier: { saleId: SALE_ID, followed: false } });
    const response = await GET(
      new Request(`https://immojudis.test/api/favorites/dossier?saleId=${SALE_ID}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.get).toHaveBeenCalledWith({ auth: AUTH, saleId: SALE_ID });
  });

  it("refuse un identifiant de vente invalide", async () => {
    const response = await GET(
      new Request("https://immojudis.test/api/favorites/dossier?saleId=nope"),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("exige un compte connecté", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: No token provided"));
    const response = await GET(
      new Request(`https://immojudis.test/api/favorites/dossier?saleId=${SALE_ID}`),
    );
    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("enregistre le statut et le plafond avec les valeurs validées et arrondies", async () => {
    mocks.save.mockResolvedValue({ dossier: { saleId: SALE_ID, followed: true } });
    const response = await PUT(
      put({ saleId: SALE_ID, personalStatus: "bidding", bidCeilingEur: 184_999.6 }),
    );

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({
      auth: AUTH,
      input: { saleId: SALE_ID, personalStatus: "bidding", bidCeilingEur: 185_000 },
    });
  });

  it("refuse une demande vide ou un statut inconnu avant toute écriture", async () => {
    for (const body of [
      { saleId: SALE_ID },
      { saleId: SALE_ID, personalStatus: "bogus" },
      { saleId: SALE_ID, bidCeilingEur: -5 },
    ]) {
      const response = await PUT(put(body));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("répond 404 quand la vente n'est pas suivie par le compte", async () => {
    mocks.save.mockRejectedValue(new PublicApiError("Suivez d’abord cette vente.", 404));
    const response = await PUT(put({ saleId: SALE_ID, personalStatus: "won" }));
    expect(response.status).toBe(404);
  });
});
