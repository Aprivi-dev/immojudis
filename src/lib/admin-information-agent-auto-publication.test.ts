import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  mode: vi.fn(),
  latest: vi.fn(),
  NotInstalled: class NotInstalled extends Error {},
}));
const NotInstalled = mocks.NotInstalled;

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: vi.fn() },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/information-agent/auto-publication-store", () => ({
  AutoPublicationNotInstalledError: mocks.NotInstalled,
  loadAutoPublicationMode: mocks.mode,
  loadLatestAutoPublicationDecisions: mocks.latest,
}));

import {
  AUTO_PUBLICATION_LOCKED_MESSAGE,
  adminAutoPublicationActionSchema,
  getAdminAutoPublicationView,
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
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "in"]) query[name] = () => query;
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: changes, error: null }).then(resolve);
  mocks.from.mockReturnValue(query);
});

describe("réglage de la publication automatique", () => {
  it("le mode automatique est verrouillé : refusé par le serveur avant tout appel à la base", async () => {
    await expect(
      runAdminAutoPublicationAction({
        authToken: "token",
        input: { action: "set_mode", mode: "auto" },
      }),
    ).rejects.toThrow(AUTO_PUBLICATION_LOCKED_MESSAGE);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(AUTO_PUBLICATION_LOCKED_MESSAGE).toContain("textes juridiques");
    expect(AUTO_PUBLICATION_LOCKED_MESSAGE).toContain("AIPD");
    expect(AUTO_PUBLICATION_LOCKED_MESSAGE).toContain("avocat");
    expect(AUTO_PUBLICATION_LOCKED_MESSAGE).toContain("jeu d’évaluation");
    expect(AUTO_PUBLICATION_LOCKED_MESSAGE).toContain("simulation concluante");
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
    expect(view).toMatchObject({ mode: "simulation", modeLabel: "Simulation", autoLocked: true });
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
    });
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("migration absente : rien n'est affiché, sans erreur", async () => {
    mocks.mode.mockRejectedValue(new NotInstalled());
    expect(await loadAutoPublicationReviewAnnotations([pending("fact-1")])).toEqual({
      mode: "off",
    });
  });

  it("simulation : décision du journal datée, même pour un fait déjà traité ; sinon relecture sans journal", async () => {
    mocks.mode.mockResolvedValue("simulation");
    const row = (outcome: string, reasons: string[]) => ({
      outcome,
      reasons,
      decidedAt: "2026-11-20T09:00:00.000Z",
      policyVersion: "auto_publication_v1",
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
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
        },
        "fact-2": {
          outcome: "review",
          label: "Relecture",
          reasons: [
            "plafond atteint : 10 informations par jour",
            "information tirée d’une pièce jointe, pas du corps du message",
          ],
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
        },
        "fact-3": {
          outcome: "review",
          label: "Relecture (hors liste)",
          reasons: ["champ hors de la liste fermée (surface, terrain, nombre de pièces)"],
          recorded: false,
          decidedAt: null,
        },
        "fact-4": {
          outcome: "review",
          label: "Relecture",
          reasons: ["information en conflit avec la fiche ou déjà traitée"],
          recorded: false,
          decidedAt: null,
        },
        // Déjà acceptée par un administrateur : la décision du journal reste affichée.
        "fact-5": {
          outcome: "would_publish",
          label: "Aurait été publié",
          reasons: [],
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
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
