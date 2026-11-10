import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  mode: vi.fn(),
  latest: vi.fn(),
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
  it("mode arrêt : rien n'est lu ni affiché", async () => {
    expect(await loadAutoPublicationReviewAnnotations(["fact-1"])).toEqual({ mode: "off" });
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("simulation : décision et raisons en clair", async () => {
    mocks.mode.mockResolvedValue("simulation");
    mocks.latest.mockResolvedValue(
      new Map([
        [
          "fact-1",
          {
            outcome: "would_publish",
            reasons: [],
            decidedAt: "x",
            policyVersion: "auto_publication_v1",
          },
        ],
        [
          "fact-2",
          {
            outcome: "review",
            reasons: ["daily_cap_reached", "attachment_source"],
            decidedAt: "x",
            policyVersion: "auto_publication_v1",
          },
        ],
      ]),
    );
    expect(await loadAutoPublicationReviewAnnotations(["fact-1", "fact-2"])).toEqual({
      mode: "simulation",
      decisions: {
        "fact-1": { outcome: "would_publish", label: "Aurait été publié", reasons: [] },
        "fact-2": {
          outcome: "review",
          label: "Relecture",
          reasons: [
            "plafond atteint : 10 informations par jour",
            "information tirée d’une pièce jointe, pas du corps du message",
          ],
        },
      },
    });
  });

  it("une lecture impossible est signalée, la liste des réponses reste affichée", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.mode.mockRejectedValue(Object.assign(new Error("boom"), { code: "PGRST000" }));
    expect(await loadAutoPublicationReviewAnnotations(["fact-1"])).toEqual({ mode: "unavailable" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("PGRST000"));
    error.mockRestore();
  });
});
