import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  mode: vi.fn(),
  latest: vi.fn(),
  arbiter: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: vi.fn() },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/information-agent/auto-publication-store", () => ({
  loadAutoPublicationMode: mocks.mode,
  loadLatestAutoPublicationDecisions: mocks.latest,
  loadLatestArbiterReasons: mocks.arbiter,
}));

import {
  adminAutoPublicationActionSchema,
  getAdminAutoPublicationView,
  listRecentAutoPublications,
  loadAutoPublicationReviewAnnotations,
  runAdminAutoPublicationAction,
} from "./admin-information-agent-auto-publication";

let changes: unknown[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  changes = [];
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1", supabase: { rpc: mocks.rpc } });
  mocks.mode.mockResolvedValue("off");
  mocks.arbiter.mockResolvedValue(new Map());
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "in"]) query[name] = () => query;
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: changes, error: null }).then(resolve);
  mocks.from.mockReturnValue(query);
});

describe("réglage de la publication automatique", () => {
  it("étape 6 : le mode automatique passe par la RPC d'administration, avec le jeton de l'administrateur", async () => {
    mocks.mode.mockResolvedValue("auto");
    const view = await runAdminAutoPublicationAction({
      authToken: "token",
      input: { action: "set_mode", mode: "auto" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("set_information_agent_auto_publication_mode", {
      p_mode: "auto",
    });
    expect(view).toMatchObject({ mode: "auto", modeLabel: "Automatique" });
  });

  it("réservé à un administrateur", async () => {
    mocks.auth.mockResolvedValue({
      isAdmin: false,
      userId: "user-1",
      supabase: { rpc: mocks.rpc },
    });
    await expect(
      runAdminAutoPublicationAction({
        authToken: "token",
        input: { action: "set_mode", mode: "simulation" },
      }),
    ).rejects.toThrow(/administrateur/);
    await expect(getAdminAutoPublicationView("token")).rejects.toThrow(/administrateur/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passe en simulation par la RPC d'administration, avec le jeton de l'administrateur", async () => {
    mocks.mode.mockResolvedValue("simulation");
    const view = await runAdminAutoPublicationAction({
      authToken: "token",
      input: { action: "set_mode", mode: "simulation" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("set_information_agent_auto_publication_mode", {
      p_mode: "simulation",
    });
    expect(view).toMatchObject({ mode: "simulation", modeLabel: "Simulation" });
    expect(view).not.toHaveProperty("lockReasons");
  });

  it("l'arrêt d'urgence est un seul appel, sans condition", async () => {
    await runAdminAutoPublicationAction({
      authToken: "token",
      input: { action: "emergency_stop" },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("stop_information_agent_auto_publication");
  });

  it("le schéma n'accepte que les trois modes et l'arrêt d'urgence", () => {
    expect(
      adminAutoPublicationActionSchema.safeParse({ action: "set_mode", mode: "live" }).success,
    ).toBe(false);
    expect(adminAutoPublicationActionSchema.safeParse({ action: "emergency_stop" }).success).toBe(
      true,
    );
  });

  it("la vue donne la trace des changements (qui, quand, ancien et nouveau mode)", async () => {
    changes = [
      {
        changed_at: "2026-11-15T10:00:00.000Z",
        actor_id: "12345678-aaaa-4bbb-8ccc-000000000001",
        previous_mode: "simulation",
        new_mode: "off",
        emergency_stop: true,
      },
    ];
    const view = await getAdminAutoPublicationView("token");
    expect(view.changes).toEqual([
      {
        at: "2026-11-15T10:00:00.000Z",
        label: "Simulation → Arrêt (arrêt d’urgence), par l’administrateur 12345678",
      },
    ]);
    expect(view.eligibleFields).toEqual(["surface", "surface du terrain", "nombre de pièces"]);
    expect(view.caps).toEqual({ daily: 10, perCase: 2 });
  });
});

describe("annotations de l'onglet Réponses", () => {
  const pending = (id: string, fact_key = "surface_m2") => ({ id, fact_key, status: "pending" });

  it("mode arrêt : rien n'est lu ni affiché", async () => {
    expect(await loadAutoPublicationReviewAnnotations([pending("fact-1")])).toEqual({
      mode: "off",
      decisions: {},
    });
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("table absente : « indisponible », jamais « arrêt » à tort", async () => {
    mocks.mode.mockRejectedValue(Object.assign(new Error("missing"), { code: "PGRST205" }));
    expect(await loadAutoPublicationReviewAnnotations([pending("fact-1")])).toEqual({
      mode: "unavailable",
    });
  });

  it("simulation : décision du journal datée, même pour un fait déjà traité ; sinon relecture sans journal", async () => {
    mocks.mode.mockResolvedValue("simulation");
    const row = (outcome: string, reasons: string[]) => ({
      outcome,
      reasons,
      decidedAt: "2026-11-20T09:00:00.000Z",
      policyVersion: "auto_publication_v2",
    });
    mocks.latest.mockResolvedValue(
      new Map([
        ["fact-1", row("would_publish", [])],
        ["fact-2", row("review", ["daily_cap_reached", "attachment_source"])],
        ["fact-5", row("would_publish", [])],
      ]),
    );
    const annotations = await loadAutoPublicationReviewAnnotations([
      pending("fact-1"),
      pending("fact-2"),
      pending("fact-3", "occupancy_status"),
      { id: "fact-4", fact_key: "rooms_count", status: "conflict" },
      { id: "fact-5", fact_key: "surface_m2", status: "accepted" },
    ]);
    expect(mocks.latest).toHaveBeenCalledWith(["fact-1", "fact-2", "fact-4", "fact-5"]);
    expect(annotations).toEqual({
      mode: "simulation",
      decisions: {
        "fact-1": {
          outcome: "would_publish",
          label: "Aurait été publié",
          reasons: [],
          arbiterReason: null,
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
        },
        "fact-2": {
          outcome: "review",
          label: "À relire",
          reasons: [
            "plafond atteint : 10 informations par jour",
            "information tirée d’une pièce jointe, pas du corps du message",
          ],
          arbiterReason: null,
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
        },
        "fact-3": {
          outcome: "review",
          label: "À relire (hors liste)",
          reasons: ["champ hors de la liste fermée (surface, terrain, nombre de pièces)"],
          arbiterReason: null,
          recorded: false,
          decidedAt: null,
        },
        "fact-4": {
          outcome: "review",
          label: "À relire",
          reasons: ["information en conflit avec la fiche ou déjà traitée"],
          arbiterReason: null,
          recorded: false,
          decidedAt: null,
        },
        // Déjà acceptée par un administrateur : la décision du journal reste affichée.
        "fact-5": {
          outcome: "would_publish",
          label: "Aurait été publié",
          reasons: [],
          arbiterReason: null,
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
        },
      },
    });
  });

  it("automatique : « Publié automatiquement » et « À relire », avec le motif de l'IA quand elle refuse", async () => {
    mocks.mode.mockResolvedValue("auto");
    mocks.latest.mockResolvedValue(
      new Map([
        [
          "fact-1",
          {
            outcome: "published",
            reasons: [],
            decidedAt: "2026-11-27T09:00:00.000Z",
            policyVersion: "auto_publication_v2",
          },
        ],
        [
          "fact-2",
          {
            outcome: "review",
            reasons: ["arbiter_declined"],
            decidedAt: "2026-11-27T09:00:00.000Z",
            policyVersion: "auto_publication_v2",
          },
        ],
      ]),
    );
    mocks.arbiter.mockResolvedValue(new Map([["fact-2", "other_lot_or_property"]]));
    const annotations = await loadAutoPublicationReviewAnnotations([
      pending("fact-1"),
      pending("fact-2"),
    ]);
    expect(annotations).toMatchObject({
      mode: "auto",
      decisions: {
        "fact-1": { outcome: "published", label: "Publié automatiquement", arbiterReason: null },
        "fact-2": {
          outcome: "review",
          label: "À relire",
          reasons: ["l’IA (Claude Haiku) ne confirme pas la publication"],
          arbiterReason: "valeur d’un autre lot ou d’un autre bien",
        },
      },
    });
  });

  it("une lecture impossible ou tronquée est signalée, la liste des réponses reste affichée", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.mode.mockResolvedValue("simulation");
    mocks.latest.mockRejectedValue(Object.assign(new Error("tronqué"), { code: "PGRST000" }));
    expect(await loadAutoPublicationReviewAnnotations([pending("fact-1")])).toEqual({
      mode: "unavailable",
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("PGRST000"));
    error.mockRestore();
  });
});

describe("publications automatiques récentes (onglet Réponses)", () => {
  it("liste les publications des 30 derniers jours, avec la valeur du fait quand elle est encore là", async () => {
    const filters: string[] = [];
    mocks.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      for (const name of ["select", "order", "limit"]) query[name] = () => query;
      query.eq = (column: string, value: unknown) => {
        filters.push(`${table}:${column}=${String(value)}`);
        return query;
      };
      query.gte = (column: string, value: unknown) => {
        filters.push(`${table}:${column}>=${String(value)}`);
        return query;
      };
      query.in = () => query;
      const data =
        table === "information_agent_auto_publication_decisions"
          ? [
              {
                fact_id: "fact-1",
                fact_key: "surface_m2",
                sale_id: "sale-1",
                decided_at: "2026-11-27T09:00:00.000Z",
              },
              {
                fact_id: "fact-2",
                fact_key: "rooms_count",
                sale_id: "sale-2",
                decided_at: "2026-11-26T09:00:00.000Z",
              },
            ]
          : [{ id: "fact-1", display_value: "54 m²" }];
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve);
      return query;
    });
    const list = await listRecentAutoPublications(new Date("2026-11-27T12:00:00.000Z"));
    expect(filters).toContain("information_agent_auto_publication_decisions:outcome=published");
    expect(filters).toContain(
      "information_agent_auto_publication_decisions:decided_at>=2026-10-28T12:00:00.000Z",
    );
    expect(list).toEqual([
      {
        factId: "fact-1",
        factKey: "surface_m2",
        displayValue: "54 m²",
        saleId: "sale-1",
        publishedAt: "2026-11-27T09:00:00.000Z",
      },
      {
        factId: "fact-2",
        factKey: "rooms_count",
        displayValue: null,
        saleId: "sale-2",
        publishedAt: "2026-11-26T09:00:00.000Z",
      },
    ]);
  });
});
