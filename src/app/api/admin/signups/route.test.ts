import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  listUsers: vi.fn(),
  getUserById: vi.fn(),
  launchOffer: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { admin: { listUsers: mocks.listUsers, getUserById: mocks.getUserById } },
  },
}));
vi.mock("@/lib/launch-offer.server", () => ({ readLaunchOfferState: mocks.launchOffer }));

import { POST as search } from "./search/route";
import { POST, maxDuration } from "./route";

const url = "https://example.test/api/admin/signups";
const searchUrl = "https://example.test/api/admin/signups/search";
const ADMIN = { authorization: "Bearer admin-token" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const post = (target: string, body: unknown, headers: Record<string, string> = ADMIN) =>
  new Request(target, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Base factice : aucun profil, aucun abonnement, un seul compte confirmé. */
function database({ writeError = null as { message: string } | null } = {}) {
  const writes = {
    insert: vi.fn(async () => ({ error: writeError })),
    update: vi.fn(),
  };
  mocks.from.mockImplementation(() => ({
    select: () => ({
      order: () => ({ range: async () => ({ data: [], error: null }) }),
      in: async () => ({ data: [], error: null }),
    }),
    insert: writes.insert,
    update: writes.update,
  }));
  mocks.getUserById.mockImplementation(async (userId: string) => ({
    data: {
      user: {
        id: userId,
        email: "compte@exemple.fr",
        created_at: "2026-10-01T00:00:00.000Z",
        email_confirmed_at: "2026-10-01T00:00:00.000Z",
      },
    },
    error: null,
  }));
  mocks.rpc.mockImplementation(async (name: string) => {
    // Migration 20261108190000 pas encore appliquée : la prolongation prend l'ancien chemin.
    if (name === "extend_trial_with_note") {
      return { data: null, error: { code: "PGRST202", message: "absent" } };
    }
    return name === "record_trial_extension"
      ? { data: "note-1", error: null }
      : { data: [{ ends_at: "2026-10-08T00:00:00.000Z", gate_open: true }], error: null };
  });
  return writes;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: id(900) });
  mocks.launchOffer.mockResolvedValue({ active: true, degraded: false });
  mocks.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
});

describe("POST /api/admin/signups : prolongation d'essai", () => {
  const valid = () => ({ userIds: [id(1)], endsAt: future(14), note: "Demande reçue par email" });

  it("répond 401 sans jeton, avant de valider le corps, et ne lit rien", async () => {
    for (const body of [valid(), {}, "pas du JSON", null]) {
      expect((await POST(post(url, body, {}))).status).toBe(401);
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false, userId: id(9) });
    const response = await POST(post(url, valid()));
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["corps vide", ""],
    ["JSON tronqué", "{"],
    ["null", "null"],
    ["tableau", "[]"],
    ["sans identifiants", { endsAt: future(14), note: "Motif" }],
    ["identifiants vides", { userIds: [], endsAt: future(14), note: "Motif" }],
    [
      "26 comptes",
      {
        userIds: Array.from({ length: 26 }, (_, n) => id(n + 1)),
        endsAt: future(14),
        note: "Motif",
      },
    ],
    ["identifiant invalide", { userIds: ["abc"], endsAt: future(14), note: "Motif" }],
    ["fin vide", { userIds: [id(1)], endsAt: "", note: "Motif" }],
    ["fin illisible", { userIds: [id(1)], endsAt: "abc", note: "Motif" }],
    ["fin numérique", { userIds: [id(1)], endsAt: 1234, note: "Motif" }],
    ["fin nulle", { userIds: [id(1)], endsAt: null, note: "Motif" }],
    ["sans motif", { userIds: [id(1)], endsAt: future(14) }],
    ["motif vide", { userIds: [id(1)], endsAt: future(14), note: "   " }],
    ["motif de 2 caractères", { userIds: [id(1)], endsAt: future(14), note: "ab" }],
    ["motif de 501 caractères", { userIds: [id(1)], endsAt: future(14), note: "x".repeat(501) }],
  ])("répond 400 pour un corps invalide : %s", async (_label, body) => {
    const response = await POST(post(url, body));
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("répond 400 avec un message français pour une fin passée ou au-delà de 90 jours", async () => {
    const past = await POST(post(url, { ...valid(), endsAt: future(-1) }));
    expect(past.status).toBe(400);
    expect((await past.json()).error).toMatch(/futur/);
    const far = await POST(post(url, { ...valid(), endsAt: future(120) }));
    expect(far.status).toBe(400);
    expect((await far.json()).error).toMatch(/90 jours/);
  });

  it("prolonge, sans cache, et enregistre le motif hors de la ligne", async () => {
    const writes = database();
    const response = await POST(post(url, valid()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.results).toEqual([
      { userId: id(1), email: "compte@exemple.fr", outcome: "extended", reason: null },
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_trial_extension",
      expect.objectContaining({ p_user_id: id(1), p_note: "Demande reçue par email" }),
    );
    expect(JSON.stringify(writes.insert.mock.calls)).not.toContain("Demande reçue par email");
  });

  it("rejouer une prolongation déjà écrite donne « déjà ouvert au-delà » (double clic)", async () => {
    const endsAt = future(14);
    mocks.from.mockImplementation((table: string) => {
      const rows =
        table === "user_subscriptions"
          ? [
              {
                user_id: id(1),
                plan_code: "analyse",
                status: "trialing",
                current_period_end: endsAt,
                stripe_subscription_id: null,
                updated_at: "2026-10-27T11:00:00.000Z",
                metadata: {},
              },
            ]
          : [];
      return { select: () => ({ in: async () => ({ data: rows, error: null }) }) };
    });
    mocks.getUserById.mockResolvedValue({
      data: {
        user: {
          id: id(1),
          email: "compte@exemple.fr",
          created_at: "2026-10-01T00:00:00.000Z",
          email_confirmed_at: "2026-10-01T00:00:00.000Z",
        },
      },
      error: null,
    });
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const response = await POST(post(url, { ...valid(), endsAt }));

    expect(response.status).toBe(200);
    expect((await response.json()).results[0]).toMatchObject({
      outcome: "skipped",
      reason: expect.stringMatching(/au-delà/),
    });
  });

  it("répond 200 avec le refus de la ligne quand la base refuse l'écriture : le client lit `results`", async () => {
    database({ writeError: { message: "permission denied for table user_subscriptions" } });
    const response = await POST(post(url, valid()));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[0]).toMatchObject({ outcome: "skipped", reason: "Écriture impossible." });
    expect(JSON.stringify(body)).not.toContain("permission denied");
  });

  it("n'accepte plus la lecture de la liste en GET : la recherche ne passe plus dans l'URL", async () => {
    const route = (await import("./route")) as Record<string, unknown>;
    expect(route.GET).toBeUndefined();
  });

  it("laisse trente secondes à la route", () => {
    expect(maxDuration).toBe(30);
  });
});

describe("POST /api/admin/signups/search : liste et recherche", () => {
  it("répond 401 sans jeton, avant de valider le corps, et ne lit rien", async () => {
    for (const body of [{}, { offset: -1 }, "pas du JSON"]) {
      expect((await search(post(searchUrl, body, {}))).status).toBe(401);
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false, userId: id(9) });
    expect((await search(post(searchUrl, {}))).status).toBe(403);
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it.each([
    ["décalage négatif", { offset: -1 }],
    ["décalage décimal", { offset: 1.5 }],
    ["décalage hors borne", { offset: 100_001 }],
    ["limite nulle", { limit: 0 }],
    ["limite de 101", { limit: 101 }],
    ["limite illisible", { limit: "abc" }],
    ["accès inconnu", { access: "foo" }],
    ["recherche de 321 caractères", { q: "x".repeat(321) }],
    ["JSON tronqué", "{"],
  ])("répond 400 : %s", async (_label, body) => {
    const response = await search(post(searchUrl, body));
    expect(response.status).toBe(400);
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it("rend la liste sans cache, avec la recherche lue dans le corps", async () => {
    database();
    mocks.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: id(1),
            email: "compte1@exemple.fr",
            created_at: "2026-10-01T00:00:00.000Z",
            email_confirmed_at: "2026-10-01T00:00:00.000Z",
          },
          {
            id: id(2),
            email: "autre@exemple.fr",
            created_at: "2026-10-02T00:00:00.000Z",
            email_confirmed_at: null,
          },
        ],
      },
      error: null,
    });

    const response = await search(post(searchUrl, { q: "compte1", limit: 10, access: "all" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.accounts.map((account: { userId: string }) => account.userId)).toEqual([id(1)]);
    expect(body.summary.total).toBe(2);
  });

  it("accepte un corps vide d'options : valeurs par défaut", async () => {
    database();
    const response = await search(post(searchUrl, {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ offset: 0, limit: 50 });
  });
});
