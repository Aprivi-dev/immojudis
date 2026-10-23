import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforce: vi.fn(),
  door: vi.fn(),
  claims: vi.fn(),
  visible: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/property-reports", () => ({ saleFeatureDoor: mocks.door }));
vi.mock("@/lib/auction-fact-claims", () => ({ readSaleFactClaims: mocks.claims }));
vi.mock("@/lib/sale-publication-guard", () => ({ assertSalePublicationVisible: mocks.visible }));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";

const SALE = {
  id: saleId,
  title: "Appartement T3 à Bordeaux",
  property_type: "apartment",
  city: "Bordeaux",
  tribunal: "Tribunal judiciaire de Bordeaux",
  sale_venue_type: "tribunal",
  sale_date: "2026-12-14T09:00:00.000Z",
  starting_price_eur: 85_000,
  documents: null,
  occupancy_status: null,
};

function accountSeeing(visible: boolean) {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: visible ? SALE : null, error: null });
  const from = vi.fn().mockReturnValue(query);
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from } });
  return { from, query };
}

const call = (id = saleId) =>
  GET(new Request(`https://example.test/api/sales/${id}/lawyer-questions`), {
    params: Promise.resolve({ id }),
  });

describe("GET /api/sales/[id]/lawyer-questions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.enforce.mockResolvedValue(1);
    mocks.door.mockResolvedValue("plan");
    mocks.claims.mockResolvedValue({ claims: [], claimsBacked: true });
    mocks.visible.mockResolvedValue(undefined);
  });

  it("calcule les questions côté serveur pour l'offre Analyse, sans cache", async () => {
    const { from } = accountSeeing(true);

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { questions: Array<{ key: string; question: string }> };
    expect(body.questions.length).toBeGreaterThan(0);
    expect(body.questions.map((entry) => entry.key)).toContain("documents");
    expect(JSON.stringify(body)).not.toMatch(/\bnous\b/);
    expect(from).toHaveBeenCalledWith("v_auction_sales_app");
    expect(mocks.door).toHaveBeenCalledWith(expect.anything(), "property.documentReading", saleId);
    expect(mocks.visible).toHaveBeenCalledWith(saleId);
  });

  it("lit la vue débloquée, pour cette vente seulement, avec un déblocage", async () => {
    mocks.door.mockResolvedValue("unlock");
    const { from } = accountSeeing(true);

    const response = await call();

    expect(response.status).toBe(200);
    expect(from).toHaveBeenCalledWith("v_auction_sales_unlocked");
    expect(from).not.toHaveBeenCalledWith("v_auction_sales_app");
    expect(mocks.claims).not.toHaveBeenCalled();
  });

  it("refuse un compte qui n'a ni l'offre ni cette vente débloquée, sans lire la vente", async () => {
    mocks.door.mockResolvedValue(null);
    const { from } = accountSeeing(true);

    const response = await call();

    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("répond 404 pour une vente que la session ne voit pas, et 4xx pour un identifiant invalide", async () => {
    accountSeeing(false);
    expect((await call()).status).toBe(404);
    expect((await call("pas-un-uuid")).status).toBeGreaterThanOrEqual(400);
    expect(mocks.claims).not.toHaveBeenCalled();
  });

  it("limite le débit par compte", async () => {
    accountSeeing(true);
    await call();
    expect(mocks.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", bucketKey: "lawyer-questions" }),
    );
  });
});
