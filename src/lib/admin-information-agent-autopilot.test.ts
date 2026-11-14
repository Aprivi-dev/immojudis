import { AdminRequiredError, PublicApiError, RateLimitError } from "@/lib/api-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotDeps } from "@/lib/information-agent-autopilot";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  settings: vi.fn(),
  stats: vi.fn(),
  events: vi.fn(),
  readiness: vi.fn(),
  provider: vi.fn(),
  onDemand: vi.fn(),
  pilotDeps: null as null | (() => Partial<AutopilotDeps>),
  realPilot: null as null | typeof import("@/lib/information-agent-autopilot"),
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
  // Dépendances par défaut du passage, toutes remplacées par celles en mémoire (`pilot()`).
  hasOnDemandAutopilotRunSince: vi.fn(),
  recordAutopilotEvent: vi.fn(),
  recordAutopilotAutoStop: vi.fn(),
  syncAutopilotWarning: vi.fn(),
}));
vi.mock("@/lib/send-tracked-email", () => ({ sendTrackedEmail: mocks.provider }));
vi.mock("@/lib/email-alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-alerts")>()),
  sendResendEmail: mocks.provider,
}));
// Le VRAI passage du pilote, avec des dépendances en mémoire (aucune base, aucun fournisseur).
vi.mock("@/lib/information-agent-autopilot", async (importOriginal) => {
  mocks.realPilot = await importOriginal<typeof import("@/lib/information-agent-autopilot")>();
  return { runInformationAgentAutopilotOnDemand: mocks.onDemand };
});
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
  mocks.pilotDeps = null;
  mocks.onDemand.mockImplementation((request) =>
    mocks.realPilot!.runInformationAgentAutopilotOnDemand(request, mocks.pilotDeps?.() ?? {}),
  );
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

  it("rend chaque brouillon prêt à valider avec sa mission et sa vente, pour l'ouvrir", async () => {
    const rows: Record<string, unknown[]> = {
      information_agent_missions: [
        {
          id: "m-2",
          sale_id: "s-1",
          metadata: { trigger: "autopilot", autopilot_simulated: true },
        },
        {
          id: "m-1",
          sale_id: "s-2",
          metadata: { trigger: "autopilot", autopilot_simulated: true },
        },
      ],
      auction_sales: [
        { id: "s-1", title: "Appartement Bordeaux", city: "Bordeaux" },
        { id: "s-2", title: null, city: "Lyon" },
      ],
    };
    mocks.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      for (const name of ["select", "eq", "order", "limit", "in"]) query[name] = () => query;
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
      return query;
    });
    const view = await getAdminAutopilotView("token", {
      env: {},
      now: new Date("2026-11-03T09:30:00Z"),
    });
    expect(view.ready).toEqual({
      count: 2,
      items: [
        { missionId: "m-2", saleId: "s-1", label: "Appartement Bordeaux" },
        { missionId: "m-1", saleId: "s-2", label: "Lyon" },
      ],
    });
    expect(JSON.stringify(view.ready)).not.toContain("@");
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

  it("arrêt d'urgence enregistré mais état non relu : le dit, jamais « Arrêt impossible »", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // L'arrêt passe ; la relecture de l'état qui suit échoue (base momentanément indisponible).
    mocks.settings.mockRejectedValue(new Error("lecture impossible"));
    const stop = runAdminAutopilotAction({
      authToken: "token",
      input: { action: "emergency_stop" },
      env: {},
    });
    await expect(stop).rejects.toBeInstanceOf(PublicApiError);
    await expect(stop).rejects.toMatchObject({
      message: expect.stringContaining("Arrêt enregistré, état non relu"),
    });
    expect(mocks.rpc).toHaveBeenCalledWith("stop_information_agent_autopilot", {
      p_reason: undefined,
    });
    logged.mockRestore();
  });

  it("un arrêt d'urgence refusé par la base reste une erreur de l'arrêt", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "panne" } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runAdminAutopilotAction({ authToken: "token", input: { action: "emergency_stop" }, env: {} }),
    ).rejects.not.toMatchObject({ message: expect.stringContaining("Arrêt enregistré") });
    logged.mockRestore();
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

describe("passage de simulation lancé à la main", () => {
  const SATURDAY = new Date("2026-11-14T13:00:00Z"); // samedi 14 h à Paris, hors plage d'envoi
  const input = { action: "run_simulation_now", reason: "Premier passage demandé" } as const;

  /** Journal et passages du pilote en mémoire ; `at` avance à la demande. */
  function pilot(at = SATURDAY) {
    const state = {
      now: at,
      journal: [] as Array<{ at: Date; kind: string; details: Record<string, unknown> }>,
      sends: 0,
      runs: 0,
      released: 0,
      /** Durée d'un examen (examens lents : la borne de temps les arrête). */
      examMs: 0,
    };
    mocks.pilotDeps = () => ({
      now: () => state.now,
      env: { VERCEL_ENV: "production" },
      loadSettings: () => mocks.settings(),
      loadStats: async () => parseAutopilotStats({}),
      isAdmin: async () => true,
      claimLease: async () => {
        state.runs += 1;
        return { kind: "held", token: "bail" };
      },
      releaseLease: async () => {
        state.released += 1;
      },
      hasOnDemandRunSince: async (since) =>
        state.journal.some(
          (event) => event.kind === "run" && event.details.manual === true && event.at >= since,
        ),
      findCandidates: async (_settings, _now, _limit, shouldStop) => {
        let examined = 0;
        while (examined < 3 && !shouldStop()) {
          examined += 1;
          state.now = new Date(state.now.getTime() + state.examMs);
        }
        return {
          candidates: [
            {
              saleId: "sale-1",
              tribunalCode: "T1",
              email: "contact@cabinet-fictif.test",
              domain: "cabinet-fictif.test",
              identityKeys: ["lawyer|bordeaux|dupont jean"],
            },
          ],
          skipped: { not_class_a: 2 },
          examined,
        };
      },
      prepareDraft: async () => ({
        missionId: "mission-1",
        recipientEmail: "contact@cabinet-fictif.test",
        recipientName: null,
        subject: "Demande",
        bodyText: "Bonjour",
        alreadySimulated: false,
      }),
      preview: async () => ({ blockers: [], fingerprint: "f".repeat(64) }),
      cancelDraft: async () => undefined,
      markSimulated: async () => undefined,
      send: async () => {
        state.sends += 1;
      },
      record: async (kind, _runId, details) => {
        state.journal.push({ at: state.now, kind, details });
      },
      autoStop: async () => undefined,
      warning: async () => undefined,
    });
    return state;
  }

  it("exige un motif de 8 caractères sans adresse, comme les autres actions", () => {
    const parse = (reason: string) =>
      adminAutopilotActionSchema.safeParse({ action: "run_simulation_now", reason }).success;
    expect(parse("court")).toBe(false);
    expect(parse("Motif avec avocat@cabinet.test")).toBe(false);
    expect(parse("Premier passage demandé")).toBe(true);
  });

  it.each([
    ["off", /Passage refusé : le pilote est éteint/],
    ["live", /Passage refusé : le pilote est en mode réel/],
  ] as const)("mode %s lu en base : refus 409, aucun passage", async (mode, message) => {
    const state = pilot();
    mocks.settings.mockResolvedValue({ ...settings, mode });
    const refusal = runAdminAutopilotAction({ authToken: "token", input, env: {} });
    await expect(refusal).rejects.toBeInstanceOf(PublicApiError);
    await expect(refusal).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(message),
    });
    expect(state.runs).toBe(0);
    expect(state.journal).toEqual([]);
    expect(state.sends).toBe(0);
  });

  it("accepté en simulation un samedi hors plage : résultat rédigé, journal « à la main », aucun envoi", async () => {
    const state = pilot();
    const response = await runAdminAutopilotAction({
      authToken: "token",
      // Une identité envoyée par le client n'est jamais lue : seule la session vérifiée compte.
      input: adminAutopilotActionSchema.parse({ ...input, actorId: "intrus", adminId: "intrus" }),
      startedAt: +state.now,
      env: {},
    });
    expect(response.onDemandRun).toEqual({
      text: "Passage de simulation terminé : 3 examinées, 1 préparées, 1 simulées. Aucun envoi.",
    });
    expect(response.modeLabel).toBe("Simulation (aucun envoi)");
    const run = state.journal.find((event) => event.kind === "run");
    expect(run?.details).toMatchObject({
      manual: true,
      actorId: "admin-1",
      reason: "Premier passage demandé",
      examined: 3,
      prepared: 1,
      would_send: 1,
      sent: 0,
    });
    expect(state.sends).toBe(0);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuse un second passage dans les 10 minutes (429), l'accepte ensuite", async () => {
    const state = pilot();
    await runAdminAutopilotAction({ authToken: "token", input, env: {}, startedAt: +state.now });
    state.now = new Date(SATURDAY.getTime() + 9 * 60_000);
    const second = runAdminAutopilotAction({
      authToken: "token",
      input,
      env: {},
      startedAt: +state.now,
    });
    await expect(second).rejects.toBeInstanceOf(RateLimitError);
    await expect(second).rejects.toMatchObject({
      publicMessage: expect.stringContaining("il y a moins de 10 minutes"),
    });
    expect(state.journal.filter((event) => event.kind === "run")).toHaveLength(1);
    state.now = new Date(SATURDAY.getTime() + 11 * 60_000);
    await runAdminAutopilotAction({ authToken: "token", input, env: {}, startedAt: +state.now });
    expect(state.journal.filter((event) => event.kind === "run")).toHaveLength(2);
    expect(state.sends).toBe(0);
  });

  it("examens lents : arrêté par la borne de 20 s comptée depuis le début de la requête, bail rendu", async () => {
    const state = pilot();
    state.examMs = 7_000;
    const response = await runAdminAutopilotAction({
      authToken: "token",
      input,
      env: {},
      // La requête a commencé 2 s avant le passage : la borne tombe 18 s après son début.
      startedAt: SATURDAY.getTime() - 2_000,
    });
    // Examens entamés à 0 s, 7 s et 14 s ; à 21 s, le candidat trouvé n'est pas entamé.
    expect(response.onDemandRun).toEqual({
      text: "Passage de simulation terminé : 3 examinées, 0 préparées, 0 simulées, arrêté au bout de 20 s. Aucun envoi.",
    });
    expect(state.journal.find((event) => event.kind === "run")?.details).toMatchObject({
      manual: true,
      examined: 3,
      stopped_by_time_budget: true,
    });
    expect(state.released).toBe(1);
    expect(state.sends).toBe(0);
  });

  it("garde administrateur : un compte ordinaire ne lance aucun passage", async () => {
    const state = pilot();
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "u" });
    await expect(runAdminAutopilotAction({ authToken: "token", input, env: {} })).rejects.toThrow(
      AdminRequiredError,
    );
    expect(mocks.onDemand).not.toHaveBeenCalled();
    expect(state.runs).toBe(0);
  });

  it.each([
    ["busy", /déjà en cours/],
    ["paused", /en pause/],
    ["auto_stopped", /arrêté automatiquement/],
    ["not_production", /production/],
  ])("passage non lancé (%s) : refus 409 avec son motif", async (code, message) => {
    mocks.onDemand.mockResolvedValueOnce({
      runId: "r",
      status: "skipped",
      code,
      mode: "simulation",
      examined: 0,
      prepared: 0,
      wouldSend: 0,
      sent: 0,
      skipped: {},
      errors: {},
      warnings: [],
    });
    await expect(
      runAdminAutopilotAction({ authToken: "token", input, env: {} }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(message) });
  });

  it("le passage fait, une relecture de l'état en échec le dit sans le faire passer pour refusé", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = pilot();
    mocks.events.mockRejectedValue(new Error("lecture impossible"));
    const failure = runAdminAutopilotAction({
      authToken: "token",
      input,
      env: {},
      startedAt: +state.now,
    });
    await expect(failure).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("Passage de simulation terminé : 3 examinées"),
    });
    logged.mockRestore();
  });

  it("le journal du panneau distingue un passage lancé à la main", async () => {
    mocks.events.mockResolvedValue([
      {
        id: "e1",
        at: "2026-11-14T13:00:00Z",
        kind: "run",
        action: "run",
        reason: null,
        details: { manual: true, examined: 3, prepared: 1, would_send: 1, sent: 0 },
      },
    ]);
    const view = await getAdminAutopilotView("token", { env: {}, now: SATURDAY });
    expect(view.events[0]).toMatchObject({
      label: "Passage à la demande",
      detail: "3 examinées, 1 préparées, 1 simulées, 0 envoyées",
    });
  });
});
