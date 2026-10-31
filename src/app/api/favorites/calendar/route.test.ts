import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforce: vi.fn(),
  record: vi.fn(),
  rpc: vi.fn(),
  client: vi.fn(),
  followed: vi.fn(),
  inFilter: vi.fn(),
  visits: vi.fn(),
  snapshot: vi.fn(),
  assertFavorites: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));
vi.mock("@/lib/favorites", () => ({ assertSaleFavoritesAvailable: mocks.assertFavorites }));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.client,
}));

import { POST } from "./route";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const post = (body: unknown) =>
  POST(
    new Request("https://example.test/api/favorites/calendar", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    exportable: true,
    sale_date: "2026-11-10T13:00:00Z",
    date_only: false,
    property_type: "apartment",
    city: "Bobigny",
    tribunal_name: "TJ Bobigny",
    tribunal_city: "Bobigny",
    updated_at: "2026-10-01T08:00:00Z",
    ...overrides,
  };
}

/** Client du compte : `user_favorites` rend les ventes suivies (`followed`). */
function accountClient() {
  const query = {
    select: () => query,
    eq: () => query,
    in: (_column: string, ids: string[]) => {
      mocks.inFilter(ids);
      return Promise.resolve({
        data: ids.filter((id) => mocks.followed().includes(id)).map((sale_id) => ({ sale_id })),
        error: null,
      });
    },
  };
  /** Vue du compte : les créneaux de visite (`visit_dates`) des ventes demandées. */
  const visitsQuery = {
    select: () => visitsQuery,
    in: (_column: string, ids: string[]) => {
      const result = mocks.visits(ids) as { data: unknown; error: unknown };
      return Promise.resolve(result);
    },
  };
  /** Instantané du compte (échéancier d'une vente passée remportée). */
  const snapshotQuery = {
    select: () => snapshotQuery,
    eq: () => snapshotQuery,
    gt: () => snapshotQuery,
    maybeSingle: () => Promise.resolve(mocks.snapshot() as { data: unknown; error: unknown }),
  };
  return {
    userId: "user-1",
    supabase: {
      from: (table: string) =>
        table === "user_favorites"
          ? query
          : table === "user_followed_sale_snapshots"
            ? snapshotQuery
            : visitsQuery,
    },
  };
}

describe("POST /api/favorites/calendar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(accountClient());
    mocks.enforce.mockResolvedValue(1);
    mocks.record.mockResolvedValue(true);
    mocks.followed.mockReturnValue([A, B]);
    mocks.client.mockReturnValue({ rpc: mocks.rpc });
    mocks.visits.mockReturnValue({ data: [], error: null });
    mocks.assertFavorites.mockResolvedValue({ plan: "decouverte" });
    mocks.rpc.mockImplementation(async (_name: string, { p_sale_id }: { p_sale_id: string }) => ({
      data: [row(p_sale_id, p_sale_id === B ? { sale_date: "2026-10-30T13:00:00Z" } : {})],
      error: null,
    }));
  });

  it("ajoute au fichier les créneaux de visite datés, sans adresse ni texte brut", async () => {
    mocks.visits.mockReturnValue({
      data: [
        { id: A, visit_dates: ["2099-10-02 à 14:00", "sur rendez-vous", "mardi 20 octobre"] },
        { id: B, visit_dates: null },
      ],
      error: null,
    });
    const response = await post({ saleIds: [A, B] });

    expect(response.status).toBe(200);
    // Les mesures et les compteurs restent ceux des audiences, pas des visites.
    expect(response.headers.get("x-exported-count")).toBe("2");
    expect(mocks.record).toHaveBeenCalledTimes(2);
    const body = (await response.text()).replace(/\r\n /g, "");
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(body).toContain("SUMMARY:Visite – Appartement à Bobigny");
    // 14 h à Paris en octobre (UTC+2) : 12 h UTC.
    expect(body).toContain("DTSTART:20991002T120000Z");
    expect(body).not.toContain("sur rendez-vous");
    expect(body).not.toContain("LOCATION:Visite");
    expect(mocks.visits).toHaveBeenCalledWith([A, B]);
  });

  it("exporte quand même les audiences quand la lecture des visites échoue", async () => {
    mocks.visits.mockReturnValue({ data: null, error: { message: "boom" } });
    const response = await post({ saleIds: [A] });

    expect(response.status).toBe(200);
    expect((await response.text()).match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("rend un seul fichier .ics des audiences suivies, jamais mis en cache", async () => {
    const response = await post({ saleIds: [A, B] });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="immojudis-audiences-suivies.ics"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-exported-count")).toBe("2");
    expect(response.headers.get("x-skipped-count")).toBe("0");
    const body = await response.text();
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    // Dans l'ordre des dates : B (30 octobre) avant A (10 novembre).
    expect(body.indexOf(B)).toBeLessThan(body.indexOf(A));
    // Les mêmes garde-fous que l'export d'une audience : la fonction publique, par vente.
    expect(mocks.rpc).toHaveBeenCalledWith("get_public_sale_calendar_event", { p_sale_id: A });
    expect(mocks.rpc).toHaveBeenCalledWith("get_public_sale_calendar_event", { p_sale_id: B });
  });

  it("enregistre calendar_exported pour chaque vente du fichier", async () => {
    await post({ saleIds: [A, B] });

    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith("user-1", { type: "calendar_exported", saleId: A });
    expect(mocks.record).toHaveBeenCalledWith("user-1", { type: "calendar_exported", saleId: B });
  });

  it("ne lit ni n'exporte une vente que le compte ne suit pas", async () => {
    const response = await post({ saleIds: [A, C] });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-exported-count")).toBe("1");
    expect(mocks.rpc).not.toHaveBeenCalledWith("get_public_sale_calendar_event", {
      p_sale_id: C,
    });
    expect(mocks.record).not.toHaveBeenCalledWith("user-1", {
      type: "calendar_exported",
      saleId: C,
    });
  });

  it("laisse de côté une audience non exportable et le dit", async () => {
    mocks.rpc.mockImplementation(async (_name: string, { p_sale_id }: { p_sale_id: string }) => ({
      data: [p_sale_id === B ? row(B, { exportable: false, sale_date: null }) : row(A)],
      error: null,
    }));
    const response = await post({ saleIds: [A, B] });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-exported-count")).toBe("1");
    expect(response.headers.get("x-skipped-count")).toBe("1");
    expect(await response.text()).not.toMatch(/à confirmer/i);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("répond 409 sans fichier ni mesure quand aucune audience n'est exportable", async () => {
    mocks.rpc.mockResolvedValue({
      data: [row(A, { exportable: false, sale_date: null })],
      error: null,
    });
    const response = await post({ saleIds: [A] });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).not.toContain("text/calendar");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("répond 409 quand aucune des ventes n'est suivie", async () => {
    mocks.followed.mockReturnValue([]);
    const response = await post({ saleIds: [A] });

    expect(response.status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("exige un compte connecté", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: No token provided"));
    const response = await post({ saleIds: [A] });

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("applique la limite par compte", async () => {
    mocks.enforce.mockRejectedValue(
      Object.assign(new Error("Trop de demandes."), { status: 429, name: "RateLimitError" }),
    );
    await post({ saleIds: [A] });

    expect(mocks.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", bucketKey: "favorites-calendar" }),
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("plafonne à 50 ventes et refuse un corps invalide", async () => {
    const tooMany = Array.from(
      { length: 51 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    for (const body of [{ saleIds: tooMany }, { saleIds: [] }, { saleIds: ["nope"] }, {}]) {
      const response = await post(body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  describe("échéancier d'une vente passée remportée", () => {
    const SNAPSHOT = "44444444-4444-4444-8444-444444444444";
    const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
      sale_id: A,
      sale_date: "2026-10-14T12:00:00Z",
      sale_venue_type: "tribunal",
      sale_legal_framework: "judicial_seizure",
      property_type: "house",
      city: "Bordeaux",
      personal_status: "won",
      ...overrides,
    });

    it("rend un .ics de deux dates à confirmer, sans mesure d'audience exportée", async () => {
      mocks.snapshot.mockReturnValue({ data: snapshotRow(), error: null });
      const response = await post({ deadlinesSnapshotId: SNAPSHOT });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/calendar");
      expect(response.headers.get("content-disposition")).toContain("immojudis-echeancier-");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = (await response.text()).replace(/\r\n /g, "");
      expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(2);
      expect(body).toContain("DTSTART;VALUE=DATE:20261024");
      expect(body).toContain("À confirmer avec votre avocat.");
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it("répond 409 pour une vente non marquée « Remporté »", async () => {
      mocks.snapshot.mockReturnValue({
        data: snapshotRow({ personal_status: "lost" }),
        error: null,
      });
      const response = await post({ deadlinesSnapshotId: SNAPSHOT });
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).not.toContain("text/calendar");
    });

    it("répond 409 hors saisie immobilière : d'autres délais s'appliquent", async () => {
      mocks.snapshot.mockReturnValue({
        data: snapshotRow({ sale_legal_framework: "insolvency" }),
        error: null,
      });
      const response = await post({ deadlinesSnapshotId: SNAPSHOT });
      expect(response.status).toBe(409);
    });

    it("répond 404 pour un instantané qui n'est pas au compte ou qui est échu", async () => {
      mocks.snapshot.mockReturnValue({ data: null, error: null });
      const response = await post({ deadlinesSnapshotId: SNAPSHOT });
      expect(response.status).toBe(404);
    });

    it("refuse un identifiant invalide", async () => {
      const response = await post({ deadlinesSnapshotId: "nope" });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(mocks.snapshot).not.toHaveBeenCalled();
    });
  });
});
