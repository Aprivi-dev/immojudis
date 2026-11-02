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
    expect(view.readiness.ready).toBe(false);
  });

  it("refuse un compte qui n'est pas administrateur", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "u" });
    await expect(getAdminAutopilotView("token")).rejects.toThrow("accès administrateur");
    await expect(
      runAdminAutopilotAction({ authToken: "token", input: { action: "emergency_stop" } }),
    ).rejects.toThrow("accès administrateur");
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

  it("remonte l'erreur de la base (le mode réel est aussi refusé par la fonction SQL)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "Attestation d'AIPD manquante" } });
    await expect(
      runAdminAutopilotAction({
        authToken: "token",
        input: { action: "attest_aipd", version: "v1", reason: "AIPD signée le 02/11" },
        env: {},
      }),
    ).rejects.toMatchObject({ message: "Attestation d'AIPD manquante" });
  });
});
