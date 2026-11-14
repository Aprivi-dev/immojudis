import { AdminRequiredError, PublicApiError } from "@/lib/api-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  settings: vi.fn(),
  stats: vi.fn(),
  events: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: vi.fn() },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/information-agent/autopilot-settings", () => ({
  loadAutopilotSettings: mocks.settings,
  loadAutopilotStats: mocks.stats,
  loadRecentAutopilotEvents: mocks.events,
}));
vi.mock("@/lib/information-agent/autopilot-readiness", () => ({
  currentPrivacyVersion: () => "2026-11-01.1",
  evaluateAutopilotReadiness: mocks.readiness,
  isActiveAdmin: async () => true,
  loadRoundtripVerifiedAt: async () => null,
  loadVerifiedResendDomains: async () => null,
}));

import {
  adminAutopilotActionSchema,
  getAdminAutopilotView,
  runAdminAutopilotAction,
} from "./admin-information-agent-autopilot";
import { parseAutopilotStats } from "@/lib/information-agent/autopilot-rules";

const settings = {
  mode: "simulation",
  actingAdminId: "admin-1",
  capTotalOverride: null,
  allowLicitorDecoded: false,
  art14RuleEnabled: true,
  art14MaxAgeDays: 30,
  aipdAttestedAt: null,
  aipdVersion: null,
  simulationStartedAt: null,
  pausedUntil: null,
  autoStoppedAt: null,
  autoStopReason: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1", supabase: { rpc: mocks.rpc } });
  mocks.settings.mockResolvedValue(settings);
  mocks.stats.mockResolvedValue(parseAutopilotStats({}));
  mocks.events.mockResolvedValue([]);
  mocks.readiness.mockReturnValue({
    ready: false,
    checks: [{ key: "aipd", label: "AIPD attestée", ok: false, detail: "" }],
  });
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "in"]) query[name] = () => query;
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  mocks.from.mockReturnValue(query);
});

describe("schéma des actions du pilote", () => {
  it("exige un motif de 8 caractères pour un changement de mode, de réglage ou l'AIPD", () => {
    expect(
      adminAutopilotActionSchema.safeParse({
        action: "set_mode",
        mode: "simulation",
        reason: "court",
      }).success,
    ).toBe(false);
    expect(
      adminAutopilotActionSchema.safeParse({
        action: "set_mode",
        mode: "turbo",
        reason: "Motif suffisant",
      }).success,
    ).toBe(false);
    expect(
      adminAutopilotActionSchema.safeParse({
        action: "set_mode",
        mode: "off",
        reason: "Motif suffisant",
      }).success,
    ).toBe(true);
    expect(
      adminAutopilotActionSchema.safeParse({ action: "attest_aipd", version: "v1", reason: "x" })
        .success,
    ).toBe(false);
  });

  it.each(["set_mode", "attest_aipd", "update_settings"])(
    "%s : un motif contenant une adresse (« @ ») est refusé",
    (action) => {
      const base: Record<string, unknown> = {
        action,
        reason: "Motif avec avocat@cabinet.test",
        ...(action === "set_mode" ? { mode: "simulation" } : {}),
        ...(action === "attest_aipd" ? { version: "v1" } : {}),
        ...(action === "update_settings" ? { changes: { art14MaxAgeDays: 45 } } : {}),
      };
      expect(adminAutopilotActionSchema.safeParse(base).success).toBe(false);
      expect(
        adminAutopilotActionSchema.safeParse({ ...base, reason: "Motif sans adresse" }).success,
      ).toBe(true);
    },
  );

  it("l'arrêt d'urgence n'exige aucun motif", () => {
    expect(adminAutopilotActionSchema.safeParse({ action: "emergency_stop" }).success).toBe(true);
  });

  it("refuse un réglage inconnu ou hors bornes (60 par jour au plus)", () => {
    const base = { action: "update_settings", reason: "Motif suffisant" };
    expect(
      adminAutopilotActionSchema.safeParse({ ...base, changes: { mode: "live" } }).success,
    ).toBe(false);
    expect(
      adminAutopilotActionSchema.safeParse({ ...base, changes: { capTotalOverride: 100 } }).success,
    ).toBe(false);
    expect(adminAutopilotActionSchema.safeParse({ ...base, changes: {} }).success).toBe(false);
    expect(
      adminAutopilotActionSchema.safeParse({
        ...base,
        changes: { capTotalOverride: 12, art14MaxAgeDays: 45 },
      }).success,
    ).toBe(true);
  });
});

describe("panneau du pilote (serveur)", () => {
  it("rend un modèle de vue déjà mis en forme", async () => {
    const view = await getAdminAutopilotView("token", {
      env: {},
      now: new Date("2026-11-03T09:30:00Z"),
    });
    expect(view.modeLabel).toBe("Simulation (aucun envoi)");
    expect(view.counters[0]).toEqual({
      label: "Envois aujourd’hui (manuels inclus)",
      value: "0 sur 5",
    });
    // Repris tel quel par le bandeau de synthèse de l'écran : même chiffre que le premier compteur.
    expect(view.sentToday).toBe("0 sur 5");
    expect(view.readiness.ready).toBe(false);
  });

  it("un passage en erreur se lit dans le journal du panneau", async () => {
    mocks.events.mockResolvedValue([
      {
        id: "e1",
        at: "2026-11-03T09:30:00Z",
        kind: "run",
        action: "run",
        reason: null,
        details: { examined: 5, prepared: 2, would_send: 1, sent: 0, error_draft_error: 2 },
      },
      {
        id: "e2",
        at: "2026-11-03T09:20:00Z",
        kind: "run",
        action: "run",
        reason: null,
        details: { examined: 3, prepared: 1, would_send: 1, sent: 0 },
      },
    ]);
    const view = await getAdminAutopilotView("token", {
      env: {},
      now: new Date("2026-11-03T09:30:00Z"),
    });
    expect(view.events.map((event) => event.detail)).toEqual([
      "5 examinées, 2 préparées, 1 simulées, 0 envoyées, 2 en erreur",
      "3 examinées, 1 préparées, 1 simulées, 0 envoyées",
    ]);
  });

  it("compte par structure incomplet : l'écran le dit au lieu d'échouer", async () => {
    const at = { env: {}, now: new Date("2026-11-03T09:30:00Z") };
    mocks.stats.mockResolvedValue({
      ...parseAutopilotStats({}),
      sharedStructureCountsComplete: false,
    });
    const degraded = await getAdminAutopilotView("token", at);
    expect(degraded.notice).toEqual({
      tone: "warn",
      text: expect.stringContaining("Compte des envois par office ou service incomplet"),
    });
    // Les autres compteurs restent affichés.
    expect(degraded.sentToday).toBe("0 sur 5");

    mocks.stats.mockResolvedValue({
      ...parseAutopilotStats({}),
      sharedStructureCountsComplete: true,
    });
    expect((await getAdminAutopilotView("token", at)).notice).toBeNull();
  });

  it("refuse un compte qui n'est pas administrateur", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "u" });
    await expect(getAdminAutopilotView("token")).rejects.toThrow(AdminRequiredError);
    await expect(
      runAdminAutopilotAction({ authToken: "token", input: { action: "emergency_stop" } }),
    ).rejects.toThrow(AdminRequiredError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuse le mode réel tant que le contrôle de préparation n'est pas satisfait, sans appeler la base", async () => {
    await expect(
      runAdminAutopilotAction({
        authToken: "token",
        input: { action: "set_mode", mode: "live", reason: "Passage en réel autorisé" },
        env: {},
      }),
    ).rejects.toThrow(/contrôle de préparation non satisfait : AIPD attestée/);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "set_information_agent_autopilot_mode",
      expect.anything(),
    );
  });

  it("transmet le mode et le motif à la fonction de la base (journal en ajout seul)", async () => {
    await runAdminAutopilotAction({
      authToken: "token",
      input: { action: "set_mode", mode: "simulation", reason: "Début de la simulation" },
      env: {},
    });
    expect(mocks.rpc).toHaveBeenCalledWith("set_information_agent_autopilot_mode", {
      p_mode: "simulation",
      p_reason: "Début de la simulation",
    });
  });

  it("l'arrêt d'urgence passe toujours, même si le contrôle de préparation échoue", async () => {
    await runAdminAutopilotAction({
      authToken: "token",
      input: { action: "emergency_stop" },
      env: {},
    });
    expect(mocks.rpc).toHaveBeenCalledWith("stop_information_agent_autopilot", {
      p_reason: undefined,
    });
    expect(mocks.readiness).toHaveBeenCalledTimes(1); // seulement pour recomposer la vue
  });

  it("traduit les réglages en colonnes et les journalise avec leur motif", async () => {
    await runAdminAutopilotAction({
      authToken: "token",
      input: {
        action: "update_settings",
        changes: { allowLicitorDecoded: true, art14MaxAgeDays: 45 },
        reason: "Accord écrit de Licitor reçu",
      },
      env: {},
    });
    expect(mocks.rpc).toHaveBeenCalledWith("update_information_agent_autopilot_settings", {
      p_changes: { allow_licitor_decoded: true, art14_max_age_days: 45 },
      p_reason: "Accord écrit de Licitor reçu",
    });
  });

  it("une erreur interne de la base (contrainte) donne un message générique, jamais le texte brut", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "23514",
        message: 'violates check constraint "no_address_check" Failing row (avocat@cabinet.test)',
      },
    });
    const failure = runAdminAutopilotAction({
      authToken: "token",
      input: { action: "emergency_stop", reason: "Arrêt demandé" },
      env: {},
    });
    // Message interne neutre : la route le remplace par son message générique, sans le texte brut.
    await expect(failure).rejects.toThrow("Database call failed");
    await expect(failure).rejects.not.toBeInstanceOf(PublicApiError);
    await expect(failure).rejects.not.toThrow(/avocat@|constraint/);
  });

  it("remonte le refus métier de la base (le mode réel est aussi refusé par la fonction SQL)", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "55000", message: "Attestation d'AIPD manquante" },
    });
    await expect(
      runAdminAutopilotAction({
        authToken: "token",
        input: { action: "attest_aipd", version: "v1", reason: "AIPD signée le 02/11" },
        env: {},
      }),
    ).rejects.toMatchObject({ message: "Attestation d'AIPD manquante", status: 409 });
  });
});
