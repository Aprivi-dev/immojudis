import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforceUser: vi.fn(),
  enforceIp: vi.fn(),
  assertEntitlement: vi.fn(),
  isPublished: vi.fn(),
  readStored: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: mocks.enforceUser,
  enforceIpRateLimit: mocks.enforceIp,
}));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlementVia: mocks.assertEntitlement }));
vi.mock("@/lib/supabase-public.server", () => ({ createPublicSupabaseClient: () => ({}) }));
vi.mock("@/lib/sale-pepite.server", () => ({
  isPublishedPepite: mocks.isPublished,
  readStoredPepite: mocks.readStored,
}));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";

const STORED = {
  reasonCodes: [
    "pass:regime_open",
    "pass:sale_upcoming",
    "pass:test_b_chance",
    "pass:test_c_cost",
    "stab:entered",
  ],
  details: {
    regime: "tribunal",
    referenceCeilingEur: 118_000,
    probablePriceEur: 90_000,
    rangeLowEur: 75_000,
    rangeHighEur: 110_000,
    costRatio: 0.68,
    holdMissed: [],
    scenarios: { reliability: "good", courtSample: 40, nationalSample: 800 },
  },
  evaluatedAt: "2026-11-05T09:00:00.000Z",
};

function call(query = "", token: string | null = null) {
  return GET(
    new Request(`https://example.test/api/sales/${saleId}/pepite${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    { params: Promise.resolve({ id: saleId }) },
  );
}

describe("GET /api/sales/[id]/pepite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({ userId: "user-1" });
    mocks.enforceUser.mockResolvedValue(1);
    mocks.enforceIp.mockResolvedValue(1);
    mocks.assertEntitlement.mockResolvedValue({ plan: { plan: "analyse" }, door: "plan" });
    mocks.isPublished.mockResolvedValue(true);
    mocks.readStored.mockResolvedValue(STORED);
    mocks.record.mockResolvedValue(true);
  });

  it("refuse un identifiant qui n'est pas une vente (400), sans rien lire", async () => {
    const response = await GET(new Request("https://example.test/api/sales/x/pepite"), {
      params: Promise.resolve({ id: "pas-un-uuid" }),
    });
    expect(response.status).toBe(400);
    expect(mocks.isPublished).not.toHaveBeenCalled();
  });

  describe("niveau « criteria » (ouvert à tous, visiteurs compris)", () => {
    it("rend les noms des critères, sans aucun montant ni valeur, à un visiteur", async () => {
      const response = await call();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.access).toBe("criteria");
      // Deux critères remplis, puis les vérifications de fiabilité à part.
      expect(body.count).toBe(2);
      expect(body.tests.map((criterion: { id: string }) => criterion.id)).toEqual([
        "test_b_chance",
        "test_c_cost",
      ]);
      expect(body.checks.map((criterion: { id: string }) => criterion.id)).toEqual([
        "regime_open",
        "sale_upcoming",
      ]);
      expect(body.checksPassed).toBe(2);
      expect(body).not.toHaveProperty("detail");
      const serialized = JSON.stringify(body);
      for (const secret of ["118000", "90000", "75000", "110000", "0.68", "referenceCeiling"]) {
        expect(serialized).not.toContain(secret);
      }
      // Aucun jeton, aucun droit demandé : le droit n'est pas en jeu à ce niveau.
      expect(mocks.auth).not.toHaveBeenCalled();
      expect(mocks.assertEntitlement).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toMatch(/^public, s-maxage=60\b/);
    });

    it("ne donne jamais le détail, même à un compte Analyse, tant que le niveau n'est pas demandé", async () => {
      const response = await call("", "token");
      const body = await response.json();
      expect(body.access).toBe("criteria");
      expect(JSON.stringify(body)).not.toContain("118");
    });

    it("limite le débit par adresse pour un visiteur", async () => {
      await call();
      expect(mocks.enforceIp).toHaveBeenCalledWith(
        expect.objectContaining({ bucketKey: "sale-pepite" }),
      );
    });

    it("répond 404 quand la vente n'est pas une pépite publiable (mode shadow, off, avant la migration)", async () => {
      mocks.isPublished.mockResolvedValue(false);
      const response = await call();
      expect(response.status).toBe(404);
      expect(mocks.readStored).not.toHaveBeenCalled();
    });

    it("répond 404 sans ligne stockée, sans rien inventer", async () => {
      mocks.readStored.mockResolvedValue(null);
      expect((await call()).status).toBe(404);
    });

    it("reste ouvert avec un jeton invalide : le niveau « criteria » ne lit pas le compte", async () => {
      mocks.auth.mockRejectedValue(new Error("Unauthorized: invalid token"));
      const response = await call("", "jeton-invalide");
      expect(response.status).toBe(200);
      expect((await response.json()).access).toBe("criteria");
      expect(mocks.auth).not.toHaveBeenCalled();
    });

    it.each(["?view=Detail", "?view=", "?view=criteria", "?view=autre", "?foo=detail"])(
      "traite %s comme le niveau « criteria » (seul « detail », en minuscules, ouvre le détail)",
      async (query) => {
        const response = await call(query);
        expect(response.status).toBe(200);
        expect((await response.json()).access).toBe("criteria");
        expect(mocks.auth).not.toHaveBeenCalled();
        expect(mocks.assertEntitlement).not.toHaveBeenCalled();
      },
    );

    it("lit le premier paramètre view quand il est répété : « detail » d'abord exige un compte", async () => {
      const detailFirst = await call("?view=detail&view=criteria");
      expect(detailFirst.status).toBe(401);
      mocks.auth.mockResolvedValue({ userId: "user-1" });
      const criteriaFirst = await call("?view=criteria&view=detail");
      expect(criteriaFirst.status).toBe(200);
      expect((await criteriaFirst.json()).access).toBe("criteria");
    });

    it("cherche la vente en minuscules quand l'identifiant est en majuscules", async () => {
      const response = await GET(new Request("https://example.test/api/sales/x/pepite"), {
        params: Promise.resolve({ id: saleId.toUpperCase() }),
      });
      expect(response.status).toBe(200);
      expect(mocks.isPublished).toHaveBeenCalledWith(expect.anything(), saleId);
      expect(mocks.readStored).toHaveBeenCalledWith(saleId);
    });

    it("répond 404 (pas 500) pour un identifiant non conforme à la RFC 4122 qui n'est pas une pépite", async () => {
      mocks.isPublished.mockResolvedValue(false);
      const response = await GET(new Request("https://example.test/api/sales/x/pepite"), {
        params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }),
      });
      expect(response.status).toBe(404);
    });
  });

  describe("niveau « detail » (droit au plafond)", () => {
    it("répond 401 sans compte, avant toute lecture", async () => {
      const response = await call("?view=detail");
      expect(response.status).toBe(401);
      expect(mocks.assertEntitlement).not.toHaveBeenCalled();
      expect(mocks.readStored).not.toHaveBeenCalled();
    });

    it("répond 401 avec un jeton invalide", async () => {
      mocks.auth.mockRejectedValue(new Error("Unauthorized: Invalid token"));
      const response = await call("?view=detail", "mauvais");
      expect(response.status).toBe(401);
      expect(mocks.readStored).not.toHaveBeenCalled();
    });

    it("répond 403 à un compte Découverte qui n'a pas débloqué la vente, sans le moindre montant", async () => {
      mocks.assertEntitlement.mockRejectedValue(
        new Error("Le détail de la pépite est réservé à l’offre Analyse ou à une vente débloquée."),
      );
      const response = await call("?view=detail", "token");
      expect(response.status).toBe(403);
      // L'identifiant de requête est un UUID aléatoire : il peut contenir « 118 » par hasard.
      const { requestId: _requestId, ...body } = await response.json();
      expect(JSON.stringify(body)).not.toMatch(/118|90000|75000|110000/);
      // Le droit est vérifié avant la lecture de la table privée.
      expect(mocks.readStored).not.toHaveBeenCalled();
      expect(mocks.isPublished).not.toHaveBeenCalled();
    });

    it("demande le droit au plafond POUR CETTE VENTE : un déblocage n'ouvre que celle-là", async () => {
      await call("?view=detail", "token");
      expect(mocks.assertEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        "property.bidCeiling",
        expect.any(String),
        { saleId },
      );
    });

    it("rend le détail (montants, condition, réserve) à un compte qui a le droit, sans cache partagé", async () => {
      const response = await call("?view=detail", "token");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.access).toBe("detail");
      expect(body.count).toBe(2);
      expect(body.detail.referenceCeilingEur).toBe(118_000);
      expect(body.detail.priceLine).toMatch(/Prix de référence : environ 90\s000/u);
      expect(body.detail.priceNote).toContain("Ce n'est pas une prévision");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("authorization");
    });

    it("enregistre pour le compte que le détail a été servi, et seulement à ce niveau", async () => {
      await call("", "token");
      expect(mocks.record).not.toHaveBeenCalled();
      await call("?view=detail", "token");
      expect(mocks.record).toHaveBeenCalledWith("user-1", { type: "pepite_detail_served", saleId });
    });

    it("n'enregistre rien quand le droit est refusé", async () => {
      mocks.assertEntitlement.mockRejectedValue(new Error("refusé"));
      await call("?view=detail", "token");
      expect(mocks.record).not.toHaveBeenCalled();
    });

    it("garde le 404 d'une vente qui n'est pas (ou plus) une pépite, même avec le droit", async () => {
      mocks.isPublished.mockResolvedValue(false);
      expect((await call("?view=detail", "token")).status).toBe(404);
    });

    it("limite le débit par compte", async () => {
      await call("?view=detail", "token");
      expect(mocks.enforceUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", bucketKey: "sale-pepite" }),
      );
    });
  });
});
