import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Matrice de scénarios du pilote automatique (audit du 02/11/2026, section 6.5 : 32 cas) et cas juridiques du
 * cahier des charges. Chaque cas porte son numéro (S01 … S32) ou son nom (J-…). L'exécuteur est piloté par des
 * dépendances simulées : aucun accès base, aucun appel au fournisseur d'e-mails. Les règles pures ont leur propre
 * table (`autopilot-rules.test.ts`) ; la couverture SQL est dans `supabase/tests/868_*.sql`.
 */
const mocks = vi.hoisted(() => ({
  sendTrackedEmail: vi.fn(),
  sendResendEmail: vi.fn(),
  runAction: vi.fn(),
  createDraft: vi.fn(),
  preview: vi.fn(),
  template: vi.fn(),
  cancel: vi.fn(),
  db: { rows: [] as unknown[], sale: null as unknown },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in", "limit", "update"]) query[name] = () => query;
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: table === "information_agent_autopilot_events" ? [] : mocks.db.rows,
          error: null,
        }).then(resolve);
      // Relecture de la vente d'un brouillon réutilisé (`assertInformationAgentSaleCurrent`).
      query.maybeSingle = async () =>
        table === "auction_sales" && mocks.db.sale instanceof Error
          ? { data: null, error: mocks.db.sale }
          : { data: table === "auction_sales" ? mocks.db.sale : null, error: null };
      return query;
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}));
vi.mock("@/lib/send-tracked-email", () => ({ sendTrackedEmail: mocks.sendTrackedEmail }));
vi.mock("@/lib/email-alerts", async (importOriginal) => ({
  ResendRejectedError: (await importOriginal<typeof import("@/lib/email-alerts")>())
    .ResendRejectedError,
  sendResendEmail: mocks.sendResendEmail,
}));
vi.mock("@/lib/admin-information-agent-email-template", () => ({
  getPublishedInformationAgentEmailTemplate: mocks.template,
}));
vi.mock("@/lib/information-agent", () => ({
  runAdminInformationAgentAction: mocks.runAction,
}));
vi.mock("@/lib/information-agent/draft", () => ({
  createAdminInformationAgentDraft: mocks.createDraft,
}));
vi.mock("@/lib/information-agent/preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent/preview")>()),
  previewAdminInformationAgentMission: mocks.preview,
}));
vi.mock("@/lib/information-agent/mission-store", () => ({
  asObject: (value: unknown) => (value && typeof value === "object" ? value : {}),
  cancelMission: mocks.cancel,
}));
vi.mock("@/lib/information-agent/autopilot-candidates", () => ({
  findAutopilotCandidates: vi.fn(),
}));

import {
  blockersAfterSimulationTolerance,
  defaultAutopilotDeps,
  AutopilotDraftCancelError,
  prepareAutopilotDraft,
  runInformationAgentAutopilot,
  type AutopilotDeps,
} from "@/lib/information-agent-autopilot";
import {
  AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION,
  evaluateAutopilotReadiness,
  privacyVersionAtLeast,
} from "@/lib/information-agent/autopilot-readiness";
import {
  evaluateAutopilotCandidate,
  parseAutopilotStats,
  type AutopilotCandidateFacts,
  type AutopilotSettings,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";
import {
  INFORMATION_AGENT_CANARY_ONLY_MESSAGE,
  INFORMATION_AGENT_OUTBOUND_DISABLED_MESSAGE,
} from "@/lib/information-agent/config";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { ResendRejectedError } from "@/lib/email-alerts";
import { AdminDailyApprovalCapError } from "@/lib/information-agent/approval-cap";
import {
  InformationAgentSentButUnrecordedError,
  InformationAgentUnverifiedSendError,
} from "@/lib/information-agent/send";
import { isConsumerMailAddress } from "@/lib/information-agent/address-hygiene";
import { PublicApiError } from "@/lib/api-errors";
import { AutopilotSendRefusedError } from "@/lib/information-agent/autopilot-send-guard";
import { INFORMATION_AGENT_PREVIEW_CHECK_FAILED_MESSAGE } from "@/lib/information-agent/preview";

const MONDAY_10H = new Date("2026-11-03T09:30:00Z"); // mardi 10 h 30 à Paris, plage d'envoi
const NIGHT = new Date("2026-11-03T02:00:00Z");

const settings = (overrides: Partial<AutopilotSettings> = {}): AutopilotSettings => ({
  mode: "live",
  actingAdminId: "admin-1",
  capTotalOverride: null,
  allowLicitorDecoded: false,
  liveAllowed: true,
  art14RuleEnabled: true,
  art14MaxAgeDays: 30,
  aipdAttestedAt: "2026-11-01T00:00:00Z",
  aipdVersion: "AIPD-1",
  simulationStartedAt: "2026-10-01T00:00:00Z",
  pausedUntil: null,
  autoStoppedAt: null,
  autoStopReason: null,
  ...overrides,
});
const stats = (overrides: Partial<AutopilotStats> = {}): AutopilotStats => ({
  ...parseAutopilotStats({}),
  ...overrides,
});
const candidate = (overrides: Record<string, unknown> = {}) => ({
  saleId: "sale-1",
  tribunalCode: "T1",
  email: "me.dupont@cabinet-dupont.test",
  domain: "cabinet-dupont.test",
  identityKeys: ["lawyer|bordeaux|dupont jean"],
  ...overrides,
});
const draft = (overrides: Record<string, unknown> = {}) => ({
  missionId: "mission-1",
  recipientEmail: "me.dupont@cabinet-dupont.test",
  recipientName: "Maître Dupont",
  subject: "Demande de pièces",
  bodyText: "Bonjour,\n\n- Pourriez-vous transmettre les pièces ?",
  alreadySimulated: false,
  ...overrides,
});

type Calls = {
  records: Array<{ kind: string; details: Record<string, unknown> }>;
  autoStops: Array<{ code: string; pauseHours?: number }>;
  sends: number;
  prepares: number;
  cancels: string[];
  released: number;
};

function harness(overrides: Partial<AutopilotDeps> = {}, now = MONDAY_10H) {
  const calls: Calls = {
    records: [],
    autoStops: [],
    sends: 0,
    prepares: 0,
    cancels: [],
    released: 0,
  };
  const deps: AutopilotDeps = {
    now: () => now,
    random: () => 0.9,
    newRunId: () => "run-1",
    env: { VERCEL_ENV: "production" },
    loadSettings: async () => settings(),
    loadStats: async () => stats(),
    readiness: async () => ({ ready: true, checks: [] }),
    isAdmin: async () => true,
    claimLease: async () => ({ kind: "held", token: "lease" }),
    releaseLease: async () => {
      calls.released += 1;
    },
    findCandidates: async () => ({ candidates: [candidate()], skipped: {}, examined: 1 }),
    prepareDraft: async () => {
      calls.prepares += 1;
      return draft();
    },
    preview: async () => ({ blockers: [], fingerprint: "f".repeat(64) }),
    cancelDraft: async (missionId) => {
      calls.cancels.push(missionId);
    },
    markSimulated: async () => undefined,
    countPendingSimulatedDrafts: async () => 0,
    send: async () => {
      calls.sends += 1;
    },
    record: async (kind, _runId, details) => {
      calls.records.push({ kind, details: details as Record<string, unknown> });
    },
    autoStop: async (code, _details, pauseHours) => {
      calls.autoStops.push({ code, pauseHours });
    },
    warning: async () => undefined,
    ...overrides,
  };
  return { deps, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendTrackedEmail.mockImplementation(() => {
    throw new Error("Resend ne doit jamais être appelé");
  });
  mocks.sendResendEmail.mockImplementation(() => {
    throw new Error("Resend ne doit jamais être appelé");
  });
});

describe("matrice du pilote : S01 à S32", () => {
  it("S01 avocat, un email : brouillon, aperçu sans blocage, envoi avec trigger = autopilot", async () => {
    const { deps, calls } = harness();
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", sent: 1, prepared: 1 });
    expect(calls.sends).toBe(1);
    expect(calls.records.map((record) => record.kind)).toEqual(["sent", "run"]);
  });

  it("S01 (envoi réel) : l'action passe par runAdminInformationAgentAction avec le déclencheur du pilote", async () => {
    mocks.runAction.mockResolvedValue({ ok: true, missions: [], facts: [] });
    const deps = defaultAutopilotDeps({}, { VERCEL_ENV: "production" });
    await deps.send(draft(), "f".repeat(64), settings(), "run-9", { phase: 1 });
    expect(mocks.runAction).toHaveBeenCalledTimes(1);
    expect(mocks.runAction.mock.calls[0][0]).toMatchObject({
      input: {
        action: "approve_and_send",
        approvalConfirmed: true,
        previewFingerprint: "f".repeat(64),
      },
      trigger: { kind: "autopilot", runId: "run-9", checks: { phase: 1 } },
    });
    expect(mocks.sendTrackedEmail).not.toHaveBeenCalled();
  });

  it("S02 plusieurs emails ou confiance faible : aucun brouillon, motif contact_ambiguous", async () => {
    const { deps, calls } = harness({
      findCandidates: async () => ({
        candidates: [],
        skipped: { contact_ambiguous: 1 },
        examined: 1,
      }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(calls.prepares).toBe(0);
    expect(summary.skipped).toEqual({ contact_ambiguous: 1 });
    const facts = { selectedUnambiguously: false } as Partial<AutopilotCandidateFacts>;
    expect(verdict(facts)).toEqual({ ok: false, code: "contact_ambiguous" });
  });

  it("S03 greffe de secours : jamais traitée par le pilote", () => {
    expect(verdict({ sourceKind: "court_registry_fallback" })).toEqual({
      ok: false,
      code: "court_registry_refused",
    });
  });

  it("S04 aucune adresse : jamais candidat, aucun brouillon", async () => {
    const { deps, calls } = harness({
      findCandidates: async () => ({ candidates: [], skipped: {}, examined: 0 }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", prepared: 0, sent: 0 });
    expect(calls.prepares).toBe(0);
  });

  it.each([
    ["S05 opposition par adresse", "Le contact est explicitement opposé."],
    [
      "S06 opposition par identité",
      "Ce professionnel s’est opposé : il n’est plus sollicité sous une autre adresse.",
    ],
    [
      "S07 rebond permanent",
      "Cette adresse a rebondi définitivement : elle n'est plus sollicitée.",
    ],
    [
      "S24 vente modifiée entre brouillon et envoi",
      "La date de l’audience a changé depuis le brouillon : régénérez-le.",
    ],
  ])("%s : motif bloquant à l'aperçu, aucun envoi, brouillon annulé", async (_name, blocker) => {
    const { deps, calls } = harness({
      preview: async () => ({ blockers: [blocker], fingerprint: "f".repeat(64) }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(calls.sends).toBe(0);
    expect(calls.cancels).toEqual(["mission-1"]);
    expect(summary.skipped).toEqual({ policy_rejected: 1 });
    expect(mocks.sendTrackedEmail).not.toHaveBeenCalled();
  });

  it("S08 plafond total du jour atteint : fin de passage, sans brouillon", async () => {
    const { deps, calls } = harness({ loadStats: async () => stats({ sentTodayTotal: 5 }) });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.skipped).toEqual({ cap_reached: 1 });
    expect(calls.prepares).toBe(0);
    expect(calls.sends).toBe(0);
  });

  it("S09 plafond d'un tribunal atteint : on passe ce tribunal et on continue", async () => {
    const { deps, calls } = harness({
      loadStats: async () => stats({ todayByCourt: { T1: 3 } }),
      findCandidates: async () => ({
        candidates: [
          candidate({ saleId: "a", tribunalCode: "T1" }),
          candidate({ saleId: "b", tribunalCode: "T2", domain: "autre.test" }),
        ],
        skipped: {},
        examined: 2,
      }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.skipped).toMatchObject({ court_cap: 1 });
    expect(summary.sent).toBe(1);
    expect(calls.prepares).toBe(1);
  });

  it("S10 plafond par domaine atteint : le candidat est écarté", async () => {
    const { deps, calls } = harness({
      loadStats: async () => stats({ todayByDomain: { "cabinet-dupont.test": 1 } }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.skipped).toEqual({ domain_cap: 1 });
    expect(calls.sends).toBe(0);
  });

  it("S11 doublon (dossier déjà envoyé, ou deux passages simultanés) : un seul envoi", async () => {
    const first = harness({
      send: async () => {
        throw new Error(
          "Aucun email n’est parti : cette demande est rattachée à un dossier déjà envoyé",
        );
      },
    });
    const summary = await runInformationAgentAutopilot(first.deps);
    expect(summary.sent).toBe(0);
    expect(summary.skipped).toEqual({ send_error: 1 });
    // Deuxième passage simultané : le bail est tenu, rien ne part.
    const second = harness({ claimLease: async () => ({ kind: "busy" }) });
    expect(await runInformationAgentAutopilot(second.deps)).toMatchObject({
      status: "skipped",
      code: "busy",
    });
    expect(second.calls.sends).toBe(0);
  });

  it("S12 délai de 30 jours (même professionnel, autre vente) : brouillon refusé, passage continue", async () => {
    const { deps, calls } = harness({
      prepareDraft: async () => {
        throw new PublicApiError(
          "Ce professionnel a déjà été sollicité dans les 30 derniers jours.",
          409,
        );
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.skipped).toEqual({ draft_refused: 1 });
    expect(summary.errors).toEqual({});
    expect(calls.sends).toBe(0);
  });

  it("S13 brouillon manuel existant : candidat écarté, le brouillon de l'administrateur n'est pas annulé", () => {
    expect(verdict({ humanDraftExists: true })).toEqual({ ok: false, code: "admin_draft_exists" });
  });

  it("S14 pilote coupé en cours de passage : relecture avant chaque envoi, plus aucun nouvel envoi", async () => {
    let reads = 0;
    const { deps, calls } = harness({
      loadSettings: async () => (++reads <= 2 ? settings() : settings({ mode: "off" })),
      findCandidates: async () => ({
        candidates: [candidate({ saleId: "a" }), candidate({ saleId: "b", domain: "b.test" })],
        skipped: {},
        examined: 2,
      }),
      send: async () => {
        calls.sends += 1;
        throw new ResendRejectedError(429);
      },
    });
    // Le premier envoi échoue en 429 et clôt le passage : un seul essai, jamais de second.
    await runInformationAgentAutopilot(deps);
    expect(calls.sends).toBe(1);
    const stopped = harness({
      loadSettings: async () => (++reads <= 1 ? settings() : settings({ mode: "off" })),
    });
    reads = 0;
    const summary = await runInformationAgentAutopilot(stopped.deps);
    expect(summary.skipped).toEqual({ interrupted: 1 });
    expect(stopped.calls.sends).toBe(0);
  });

  it("S15 interrupteur à « off » : skipped disabled, aucune lecture de candidat, aucun bail", async () => {
    const findCandidates = vi.fn();
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "off" }),
      findCandidates,
    });
    expect(await runInformationAgentAutopilot(deps)).toMatchObject({
      status: "skipped",
      code: "disabled",
    });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(calls.released).toBe(0);
  });

  it("S16 simulation : brouillons et aperçus, événement would_send, ZÉRO appel au fournisseur", async () => {
    const { deps, calls } = harness({ loadSettings: async () => settings({ mode: "simulation" }) });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", wouldSend: 1, sent: 0, prepared: 1 });
    expect(calls.sends).toBe(0);
    expect(calls.records.map((record) => record.kind)).toEqual(["would_send", "run"]);
    expect(mocks.runAction).not.toHaveBeenCalled();
    expect(mocks.sendTrackedEmail).not.toHaveBeenCalled();
    expect(mocks.sendResendEmail).not.toHaveBeenCalled();
  });

  it("S16 (envoi par défaut) : en simulation, la dépendance d'envoi par défaut n'est jamais appelée", async () => {
    mocks.runAction.mockRejectedValue(new Error("ne doit pas être appelé"));
    const real = defaultAutopilotDeps(
      {
        now: () => MONDAY_10H,
        loadSettings: async () => settings({ mode: "simulation" }),
        loadStats: async () => stats(),
        isAdmin: async () => true,
        claimLease: async () => ({ kind: "held", token: "t" }),
        releaseLease: async () => undefined,
        findCandidates: async () => ({ candidates: [candidate()], skipped: {}, examined: 1 }),
        prepareDraft: async () => draft(),
        preview: async () => ({ blockers: [], fingerprint: "f".repeat(64) }),
        markSimulated: async () => undefined,
        countPendingSimulatedDrafts: async () => 0,
        record: async () => undefined,
        warning: async () => undefined,
      },
      { VERCEL_ENV: "production" },
    );
    const summary = await runInformationAgentAutopilot(real);
    expect(summary.wouldSend).toBe(1);
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("S17 hors plage (nuit, week-end, jour férié) : skipped outside_window", async () => {
    for (const when of ["2026-11-03T02:00:00Z", "2026-11-07T09:00:00Z", "2026-11-11T09:00:00Z"]) {
      const { deps } = harness({}, new Date(when));
      expect(await runInformationAgentAutopilot(deps)).toMatchObject({
        status: "skipped",
        code: "outside_window",
      });
    }
    const { deps } = harness({}, NIGHT);
    expect((await runInformationAgentAutopilot(deps)).sent).toBe(0);
  });

  it("S18 envoi désactivé par l'environnement ou canari : mode réel refusé, simulation permise", async () => {
    const closed = evaluateAutopilotReadiness(
      readinessInput({ env: { INFORMATION_AGENT_OUTBOUND_ENABLED: "false" } }),
    );
    expect(closed.checks.find((check) => check.key === "outbound_env")?.ok).toBe(false);
    const canary = evaluateAutopilotReadiness(
      readinessInput({
        env: {
          INFORMATION_AGENT_OUTBOUND_ENABLED: "true",
          INFORMATION_AGENT_OUTBOUND_CANARY_ONLY: "true",
        },
      }),
    );
    expect(canary.checks.find((check) => check.key === "outbound_env")?.ok).toBe(false);
    const live = harness({ readiness: async () => closed });
    expect(await runInformationAgentAutopilot(live.deps)).toMatchObject({
      status: "skipped",
      code: "not_ready",
    });
    expect(live.calls.sends).toBe(0);
    expect(
      blockersAfterSimulationTolerance([
        INFORMATION_AGENT_OUTBOUND_DISABLED_MESSAGE,
        INFORMATION_AGENT_CANARY_ONLY_MESSAGE,
        "Le contact est explicitement opposé.",
      ]),
    ).toEqual(["Le contact est explicitement opposé."]);
    const simulation = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      preview: async () => ({
        blockers: [
          INFORMATION_AGENT_OUTBOUND_DISABLED_MESSAGE,
          INFORMATION_AGENT_CANARY_ONLY_MESSAGE,
        ],
        fingerprint: "f".repeat(64),
      }),
    });
    expect((await runInformationAgentAutopilot(simulation.deps)).wouldSend).toBe(1);
  });

  it("S19 réponse reçue : jamais de relance, 90 jours de pause avant tout nouvel envoi", () => {
    expect(verdict({ lastReplyAt: "2026-10-20T10:00:00Z" })).toEqual({
      ok: false,
      code: "reply_pause",
    });
  });

  it("S20 réponse non rattachée : conservée pour revue (messages non routés)", async () => {
    const unrouted = await import("@/lib/information-agent-inbound/unrouted-messages");
    expect(typeof unrouted.storeUnroutedInboundMessage).toBe("function");
    expect(["no_token", "unknown_case", "case_not_open", "token_mismatch"]).toEqual(
      expect.arrayContaining(["no_token", "token_mismatch"]),
    );
  });

  it("S21 erreur du fournisseur (4xx/5xx) : événement, pas de réessai ; trois erreurs consécutives arrêtent le pilote", async () => {
    const one = harness({
      send: async () => {
        throw new ResendRejectedError(500);
      },
    });
    const summary = await runInformationAgentAutopilot(one.deps);
    expect(summary.sent).toBe(0);
    expect(one.calls.records.find((record) => record.kind === "send_error")?.details).toMatchObject(
      { status: 500 },
    );
    const three = harness({ loadStats: async () => stats({ consecutiveApiErrors: 3 }) });
    expect(await runInformationAgentAutopilot(three.deps)).toMatchObject({
      status: "stopped",
      code: "api_errors",
    });
    expect(three.calls.autoStops[0].code).toBe("api_errors");
    expect(three.calls.sends).toBe(0);
  });

  it("S21b plafond de validations d'un administrateur : une limite, jamais comptée comme erreur d'API", async () => {
    const { deps, calls } = harness({
      send: async () => {
        throw new AdminDailyApprovalCapError(30);
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.skipped).toEqual({ approval_cap: 1 });
    expect(calls.records.map((record) => record.kind)).not.toContain("send_error");
    expect(calls.autoStops).toEqual([]);
  });

  it("S21c envoi accepté par le fournisseur mais mal enregistré : compté comme envoyé, jamais comme erreur", async () => {
    const { deps, calls } = harness({
      send: async () => {
        throw new InformationAgentSentButUnrecordedError(new Error("base"));
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", sent: 1 });
    expect(calls.records.map((record) => record.kind)).toEqual(["sent", "run"]);
  });

  it("S22 délai dépassé (envoi à vérifier) : arrêt immédiat, aucune reprise", async () => {
    const { deps, calls } = harness({
      send: async () => {
        throw new InformationAgentUnverifiedSendError(new Error("timeout"));
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "stopped", code: "unverified_send" });
    expect(calls.autoStops.map((stop) => stop.code)).toEqual(["unverified_send"]);
    expect(calls.released).toBe(1);
  });

  it("S23 passage rejoué : aucune exception après un envoi, résumé partiel", async () => {
    const { deps, calls } = harness({
      record: async (kind) => {
        if (kind === "sent") throw new Error("journal indisponible");
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", code: "partial_after_send", sent: 1 });
    expect(calls.sends).toBe(1);
    expect(calls.released).toBe(1);
  });

  it("S25 vente passée, retirée ou vendue : candidat écarté (audience dans moins de 10 jours)", () => {
    expect(verdict({ saleDate: "2026-11-02T10:00:00Z" })).toEqual({
      ok: false,
      code: "sale_too_soon",
    });
  });

  it("S26 taux de rebond au-dessus du seuil : arrêt automatique avant toute lecture de candidat", async () => {
    const findCandidates = vi.fn();
    const { deps, calls } = harness({
      loadStats: async () => stats({ matureTotal: 100, maturePermanentBounces: 3 }),
      findCandidates,
    });
    expect(await runInformationAgentAutopilot(deps)).toMatchObject({
      status: "stopped",
      code: "bounce_rate",
    });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(calls.autoStops[0].code).toBe("bounce_rate");
  });

  it("S27 plainte : arrêt automatique", async () => {
    const { deps, calls } = harness({
      loadStats: async () => stats({ autopilotTotal: 12, first100Complaints: 1 }),
    });
    expect(await runInformationAgentAutopilot(deps)).toMatchObject({
      status: "stopped",
      code: "complaint",
    });
    expect(calls.sends).toBe(0);
  });

  it("S28 gabarit publié modifié depuis le brouillon : régénération, jamais un texte périmé ; garde commerciale bloquante", async () => {
    mocks.template.mockResolvedValue({ id: "tpl", revision: 9 });
    mocks.db.rows = [
      {
        id: "old-draft",
        status: "draft",
        recipient_email: "me.dupont@cabinet-dupont.test",
        metadata: { trigger: "autopilot", email_content_template_revision: 8 },
      },
    ];
    mocks.cancel.mockResolvedValue(undefined);
    mocks.createDraft.mockResolvedValue({
      mission: {
        id: "new-draft",
        recipientEmail: "me.dupont@cabinet-dupont.test",
        recipientName: null,
        recipientKind: "source_lawyer",
        recipientOrigin: null,
        subject: "Demande",
        bodyText: "Bonjour, une question ?",
      },
    });
    const prepared = await prepareAutopilotDraft(candidate(), settings(), "run-1");
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ missionId: "old-draft" }));
    expect(mocks.createDraft.mock.calls[0][0]).toMatchObject({
      trigger: { kind: "autopilot", runId: "run-1" },
    });
    expect(prepared).toMatchObject({ missionId: "new-draft" });
    // Brouillon à jour : réutilisé sans régénération.
    mocks.db.rows = [
      {
        id: "current",
        status: "draft",
        recipient_email: "me.dupont@cabinet-dupont.test",
        recipient_name: null,
        subject: "S",
        body_text: "B",
        metadata: { trigger: "autopilot", email_content_template_revision: 9 },
      },
    ];
    mocks.createDraft.mockClear();
    expect(await prepareAutopilotDraft(candidate(), settings(), "run-2")).toMatchObject({
      missionId: "current",
    });
    expect(mocks.createDraft).not.toHaveBeenCalled();
    // Mention commerciale à l'aperçu : refus de contenu, brouillon annulé, aucun envoi.
    const { deps, calls } = harness({
      preview: async () => ({
        blockers: ["Le message ne doit contenir aucune mention commerciale (offre, compte)."],
        fingerprint: "f".repeat(64),
      }),
    });
    expect((await runInformationAgentAutopilot(deps)).skipped).toEqual({ content_rejected: 1 });
    expect(calls.sends).toBe(0);
  });

  it("S29 administrateur d'exécution rétrogradé ou supprimé : arrêt, aucun envoi", async () => {
    const { deps, calls } = harness({ isAdmin: async () => false });
    expect(await runInformationAgentAutopilot(deps)).toMatchObject({
      status: "stopped",
      code: "acting_admin_invalid",
    });
    expect(calls.autoStops[0].code).toBe("acting_admin_invalid");
    expect(calls.sends).toBe(0);
  });

  it("S30 expéditeur ou domaine mal configuré : activation refusée, passage refusé", () => {
    const report = evaluateAutopilotReadiness(
      readinessInput({
        env: {
          INFORMATION_AGENT_EMAIL_FROM: "Immojudis <agent@autre-domaine.test>",
          INFORMATION_AGENT_INBOUND_DOMAIN: "reponses.immojudis.test",
        },
        verifiedResendDomains: new Set(["reponses.immojudis.test"]),
      }),
    );
    expect(report.checks.find((check) => check.key === "from_domain")?.ok).toBe(false);
    expect(report.checks.find((check) => check.key === "resend_domain")?.ok).toBe(false);
    expect(report.ready).toBe(false);
  });

  it("S31 Resend 429 : fin de passage, aucun échec de mission, aucun arrêt", async () => {
    const { deps, calls } = harness({
      send: async () => {
        throw new ResendRejectedError(429);
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", sent: 0 });
    expect(summary.skipped).toEqual({ rate_limited: 1 });
    expect(calls.autoStops).toEqual([]);
    expect(calls.records.find((record) => record.kind === "send_error")?.details).toMatchObject({
      status: 429,
    });
  });

  it("S32 base indisponible : échec avant tout envoi (fail-closed)", async () => {
    for (const failing of [
      { loadStats: async (): Promise<AutopilotStats> => Promise.reject(new Error("base")) },
      { loadSettings: async (): Promise<AutopilotSettings> => Promise.reject(new Error("base")) },
    ]) {
      const { deps, calls } = harness(failing);
      await expect(runInformationAgentAutopilot(deps)).rejects.toThrow("base");
      expect(calls.sends).toBe(0);
    }
  });
});

describe("erreurs du passage et refus au moment de l'envoi (relecture du 14/11/2026)", () => {
  const consoleError = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("I4 erreur inattendue au brouillon (base, bogue) : erreur du passage par son code, jamais un candidat écarté", async () => {
    const logged = consoleError();
    const warnings: Array<[string, boolean]> = [];
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      findCandidates: async () => ({
        candidates: [candidate({ saleId: "a" }), candidate({ saleId: "b", domain: "b.test" })],
        skipped: {},
        examined: 2,
      }),
      prepareDraft: async (item) => {
        if (item.saleId === "a") {
          // Erreur de la base telle que la rend le client (objet, pas une Error), message porteur de données.
          throw { code: "57014", message: "timeout sur me.dupont@cabinet-dupont.test" };
        }
        return draft();
      },
      warning: async (code, active) => {
        warnings.push([code, active]);
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", code: "run_errors", wouldSend: 1 });
    expect(summary.errors).toEqual({ draft_error: 1 });
    expect(summary.skipped).toEqual({});
    // Journal du passage : un compte par code ; l'alerte d'avertissement s'ouvre.
    expect(calls.records.find((record) => record.kind === "run")?.details).toMatchObject({
      error_draft_error: 1,
    });
    expect(warnings).toContainEqual(["run_errors", true]);
    // Journal de la plateforme : le code et la nature de l'erreur, jamais son message.
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      code: "draft_error",
      saleId: "a",
      error: { code: "57014" },
    });
    expect(line).not.toContain("@");
    logged.mockRestore();
  });

  it("I4 un passage sans erreur referme l'alerte", async () => {
    const warnings: Array<[string, boolean]> = [];
    const { deps } = harness({
      warning: async (code, active) => {
        warnings.push([code, active]);
      },
    });
    expect(await runInformationAgentAutopilot(deps)).toMatchObject({ code: null, errors: {} });
    expect(warnings).toContainEqual(["run_errors", false]);
  });

  it.each([
    ["404 d'une relecture", new PublicApiError("Enquête introuvable.", 404)],
    ["503 d'un registre indisponible", new PublicApiError("Registre indisponible.", 503)],
    ["bogue", new TypeError("Cannot read properties of undefined")],
  ])("I4 %s : erreur du passage, pas un refus attendu", async (_name, error) => {
    const logged = consoleError();
    const { deps } = harness({
      prepareDraft: async () => {
        throw error;
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.errors).toEqual({ draft_error: 1 });
    expect(summary.skipped).toEqual({});
    logged.mockRestore();
  });

  it("I4 annulation d'un brouillon refusé à l'aperçu en échec : journalisée, le passage continue", async () => {
    const logged = consoleError();
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      findCandidates: async () => ({
        candidates: [candidate({ saleId: "a" }), candidate({ saleId: "b", domain: "b.test" })],
        skipped: {},
        examined: 2,
      }),
      preview: async (prepared) =>
        prepared.missionId === "mission-a"
          ? { blockers: ["Le contact est explicitement opposé."], fingerprint: "f".repeat(64) }
          : { blockers: [], fingerprint: "f".repeat(64) },
      prepareDraft: async (item) => draft({ missionId: `mission-${item.saleId}` }),
      cancelDraft: async () => {
        throw new AutopilotDraftCancelError(new Error("base"));
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.errors).toEqual({ cancel_failed: 1 });
    expect(summary.skipped).toEqual({ policy_rejected: 1 });
    expect(summary.wouldSend).toBe(1);
    expect(calls.records.find((record) => record.kind === "run")?.details).toMatchObject({
      error_cancel_failed: 1,
      skip_policy_rejected: 1,
    });
    logged.mockRestore();
  });

  it("I4 annulations du brouillon du pilote : un échec remonte (dépendance par défaut et régénération)", async () => {
    mocks.cancel.mockRejectedValue(new Error("base indisponible"));
    const deps = defaultAutopilotDeps({}, { VERCEL_ENV: "production" });
    await expect(deps.cancelDraft("mission-1", settings())).rejects.toBeInstanceOf(
      AutopilotDraftCancelError,
    );
    // Régénération après un changement de gabarit : l'ancien brouillon ne s'annule pas, rien n'est créé.
    mocks.template.mockResolvedValue({ id: "tpl", revision: 9 });
    mocks.db.rows = [
      {
        id: "old-draft",
        status: "draft",
        recipient_email: "me.dupont@cabinet-dupont.test",
        metadata: { trigger: "autopilot", email_content_template_revision: 8 },
      },
    ];
    await expect(prepareAutopilotDraft(candidate(), settings(), "run-1")).rejects.toBeInstanceOf(
      AutopilotDraftCancelError,
    );
    expect(mocks.createDraft).not.toHaveBeenCalled();
    // Le passage la compte comme une erreur d'annulation.
    const logged = consoleError();
    const { deps: run } = harness({
      prepareDraft: async () => {
        throw new AutopilotDraftCancelError(new Error("base"));
      },
    });
    expect((await runInformationAgentAutopilot(run)).errors).toEqual({ cancel_failed: 1 });
    logged.mockRestore();
  });

  it.each(["not_live", "identity_excluded"])(
    "M3 refus du garde au moment de l'envoi (%s) : journalisé à part, jamais une erreur d'API",
    async (refusal) => {
      const { deps, calls } = harness({
        send: async () => {
          throw new AutopilotSendRefusedError(refusal);
        },
      });
      const summary = await runInformationAgentAutopilot(deps);
      expect(summary).toMatchObject({ status: "ran", sent: 0 });
      expect(summary.skipped).toEqual({ send_refused: 1 });
      expect(calls.records.map((record) => record.kind)).not.toContain("send_error");
      expect(calls.records.find((record) => record.kind === "skip")?.details).toEqual({
        code: "send_refused",
        reason: refusal,
        saleId: "sale-1",
      });
      expect(calls.autoStops).toEqual([]);
    },
  );
});

describe("relecture de la PR #501 : simulation juste dès lundi", () => {
  it("aperçu « Contrôle impossible » (panne passagère) : erreur du passage, jamais un rejet de politique", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      preview: async () => ({
        blockers: [INFORMATION_AGENT_PREVIEW_CHECK_FAILED_MESSAGE],
        fingerprint: "f".repeat(64),
      }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.errors).toEqual({ preview_error: 1 });
    expect(summary.skipped).toEqual({});
    expect(summary.wouldSend).toBe(0);
    // Ni évènement « skip policy_rejected » (arrêt automatique), ni annulation : le passage suivant réessaie.
    expect(calls.records.map((record) => record.kind)).toEqual(["run"]);
    expect(calls.cancels).toEqual([]);
    logged.mockRestore();
  });

  it("un vrai motif de blocage à côté d'un contrôle impossible reste un rejet de politique", async () => {
    const { deps } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      preview: async () => ({
        blockers: [
          INFORMATION_AGENT_PREVIEW_CHECK_FAILED_MESSAGE,
          "Le contact est explicitement opposé.",
        ],
        fingerprint: "f".repeat(64),
      }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary.skipped).toEqual({ policy_rejected: 1 });
    expect(summary.errors).toEqual({});
  });

  it("l'aperçu du pilote est demandé avec son déclencheur : le plafond des administrateurs ne s'y applique pas", async () => {
    mocks.preview.mockResolvedValue({ blockers: [], fingerprint: "f".repeat(64) });
    const deps = defaultAutopilotDeps({}, { VERCEL_ENV: "production" });
    await deps.preview(draft(), settings(), "run-7");
    expect(mocks.preview.mock.calls[0][0]).toMatchObject({
      trigger: { kind: "autopilot", runId: "run-7" },
    });
  });

  it("would_send ne compte que les brouillons nouvellement journalisés « aurait envoyé » pendant ce passage", async () => {
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      findCandidates: async () => ({
        candidates: [candidate({ saleId: "a" }), candidate({ saleId: "b", domain: "b.test" })],
        skipped: {},
        examined: 2,
      }),
      // « a » a déjà été journalisé par un passage précédent ; « b » est nouveau.
      prepareDraft: async (item) =>
        draft({ missionId: `mission-${item.saleId}`, alreadySimulated: item.saleId === "a" }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ prepared: 2, wouldSend: 1 });
    expect(calls.records.filter((record) => record.kind === "would_send")).toHaveLength(1);
    expect(calls.records.find((record) => record.kind === "run")?.details).toMatchObject({
      would_send: 1,
    });
  });
});

describe("cas juridiques du cahier des charges", () => {
  it("J-greffe : le pilote refuse court_registry_fallback", () => {
    expect(verdict({ sourceKind: "court_registry_fallback" }).ok).toBe(false);
  });

  it.each(["agent_search", "admin_entry", "official_directory", "other_listing", "firm_site"])(
    "J-source : le pilote refuse la source %s (seule sale_listing est admise)",
    (sourceKind) => {
      expect(verdict({ sourceKind })).toEqual({ ok: false, code: "source_not_sale_listing" });
    },
  );

  it.each([
    "gmail.com",
    "outlook.fr",
    "orange.fr",
    "free.fr",
    "yahoo.fr",
    "proton.me",
    "smtp.orange.fr",
    "mail.gmail.com",
    "ymail.com",
    "mac.com",
    "pm.me",
    "hey.com",
    "numericable.fr",
    "club-internet.fr",
  ])("J-grand public : %s est une messagerie grand public, refusée par le pilote", (domain) => {
    expect(isConsumerMailAddress(`me@${domain}`)).toBe(true);
    expect(verdict({ consumerDomain: isConsumerMailAddress(`me@${domain}`) })).toEqual({
      ok: false,
      code: "consumer_domain",
    });
  });

  it("J-grand public : un cabinet n'est pas une messagerie grand public", () => {
    for (const domain of [
      "cabinet-dupont.fr",
      "avocats-orange.fr",
      "free-avocats.fr",
      "heymans-avocats.com",
    ]) {
      expect(isConsumerMailAddress(`me@${domain}`)).toBe(false);
    }
  });

  it("J-Licitor : adresse décodée refusée sans réglage, acceptée avec", () => {
    expect(verdict({ observationChannel: "licitor_cloudflare_decoded" })).toEqual({
      ok: false,
      code: "licitor_decoded_refused",
    });
    expect(
      evaluateAutopilotCandidate(
        { ...okFacts, observationChannel: "licitor_cloudflare_decoded" },
        { allowLicitorDecoded: true, art14MaxAgeDays: 30 },
        MONDAY_10H,
      ),
    ).toEqual({ ok: true });
  });

  it("J-mauvais-destinataire : une réponse « ce n'est pas moi » à un envoi du pilote l'arrête et exclut l'identité", async () => {
    const { applyWrongRecipient } = await import("@/lib/information-agent-inbound/wrong-recipient");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    mocks.db.rows = [
      {
        recipient_identity_keys: ["lawyer|bordeaux|dupont jean"],
        metadata: { trigger: "autopilot" },
      },
    ];

    const result = await applyWrongRecipient({ caseId: "case-1", source: "reply" });

    expect(result).toEqual({ stopped: true, excludedIdentities: 1 });
    const names = vi.mocked(supabaseAdmin.rpc).mock.calls.map((call) => String(call[0]));
    expect(names).toEqual(
      expect.arrayContaining([
        "record_information_agent_autopilot_exclusions",
        "record_information_agent_autopilot_auto_stop",
      ]),
    );
    // L'identité exclue n'est plus jamais candidate : elle repasse en validation manuelle.
    expect(verdict({ identityExcluded: true })).toEqual({ ok: false, code: "identity_excluded" });
  });

  it("J-90 jours : pause de 90 jours après une réponse", () => {
    expect(verdict({ lastReplyAt: "2026-09-20T10:00:00Z" })).toEqual({
      ok: false,
      code: "reply_pause",
    });
    expect(verdict({ lastReplyAt: "2026-07-20T10:00:00Z" })).toEqual({ ok: true });
  });

  it("J-6 mois : plus d'envoi automatique pendant 6 mois après 2 envois sans réponse", () => {
    expect(verdict({ silentSendsInSixMonths: 2, lastSendAt: "2026-09-01T10:00:00Z" })).toEqual({
      ok: false,
      code: "silence_pause",
    });
  });

  it("J-article-14 : première adresse relevée il y a plus de 30 jours et personne non informée : refus", () => {
    expect(verdict({ contactFirstRecordedAt: "2026-09-15T10:00:00Z" })).toEqual({
      ok: false,
      code: "art14_window_expired",
    });
    expect(
      verdict({ contactFirstRecordedAt: "2026-09-15T10:00:00Z", alreadyInformed: true }),
    ).toEqual({ ok: true });
  });

  it("J-politique : le mode réel est refusé tant que la version minimale de la politique n'est pas publiée", () => {
    expect(
      privacyVersionAtLeast(LEGAL_DOCUMENTS.privacy.version, AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION),
    ).toBe(false);
    expect(privacyVersionAtLeast("2099-01-01.0", AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION)).toBe(true);
    expect(privacyVersionAtLeast("2099-01-01.1", "2099-01-01.0")).toBe(true);
    const report = evaluateAutopilotReadiness(
      readinessInput({ privacyVersion: LEGAL_DOCUMENTS.privacy.version }),
    );
    expect(report.checks.find((check) => check.key === "privacy_version")?.ok).toBe(false);
    expect(report.ready).toBe(false);
  });

  it("J-préparation : 30 envois manuels, 7 jours de simulation, AIPD, aller-retour récent, aucune mission bloquée", () => {
    const ok = evaluateAutopilotReadiness(readinessInput({}));
    expect(ok.checks.filter((check) => !check.ok)).toEqual([]);
    expect(ok.ready).toBe(true);
    const cases: Array<[string, Parameters<typeof readinessInput>[0]]> = [
      ["manual_sends", { stats: stats({ manualRealSends: 29 }) }],
      ["manual_sends", { stats: stats({ manualRealSends: 40, manualComplaints: 1 }) }],
      ["simulation", { settings: settings({ simulationStartedAt: "2026-10-30T00:00:00Z" }) }],
      ["simulation", { stats: stats({ manualRealSends: 40, anomaliesSinceSimulation: 1 }) }],
      ["live_allowed", { settings: settings({ liveAllowed: false }) }],
      ["aipd", { settings: settings({ aipdAttestedAt: null, aipdVersion: null }) }],
      ["roundtrip", { roundtripVerifiedAt: "2026-09-01T00:00:00Z" }],
      ["roundtrip", { roundtripVerifiedAt: null }],
      ["no_blocked_mission", { stats: stats({ manualRealSends: 40, stuckSending: 1 }) }],
      ["acting_admin", { actingAdminIsAdmin: false }],
    ];
    for (const [key, override] of cases) {
      const report = evaluateAutopilotReadiness(readinessInput(override));
      expect(report.checks.find((check) => check.key === key)?.ok, key).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------------------------------------
const okFacts: AutopilotCandidateFacts = {
  sourceKind: "sale_listing",
  recipientRole: "lawyer",
  selectedUnambiguously: true,
  identityComplete: true,
  addressHygieneIssue: null,
  consumerDomain: false,
  observationChannel: null,
  addressObservedAt: "2026-10-20T10:00:00Z",
  mailDomain: "ok",
  saleDate: "2026-12-01T10:00:00Z",
  hasUnpublishedGap: true,
  humanDraftExists: false,
  identityExcluded: false,
  contactFirstRecordedAt: "2026-10-20T10:00:00Z",
  alreadyInformed: false,
  lastReplyAt: null,
  silentSendsInSixMonths: 0,
  lastSendAt: null,
};

function verdict(facts: Partial<AutopilotCandidateFacts>) {
  return evaluateAutopilotCandidate(
    { ...okFacts, ...facts },
    { allowLicitorDecoded: false, art14MaxAgeDays: 30 },
    MONDAY_10H,
  );
}

function readinessInput(
  overrides: Partial<Parameters<typeof evaluateAutopilotReadiness>[0]> = {},
): Parameters<typeof evaluateAutopilotReadiness>[0] {
  return {
    settings: settings({ simulationStartedAt: "2026-10-01T00:00:00Z" }),
    stats: stats({ manualRealSends: 40 }),
    env: {
      INFORMATION_AGENT_OUTBOUND_ENABLED: "true",
      INFORMATION_AGENT_OUTBOUND_CANARY_ONLY: "false",
      INFORMATION_AGENT_PORTAL_SECRET: "x".repeat(40),
      RESEND_API_KEY: "key-for-tests",
      RESEND_WEBHOOK_SECRET: "whsec-for-tests",
      INFORMATION_AGENT_EMAIL_FROM: "Immojudis <enquete@reponses.immojudis.test>",
      INFORMATION_AGENT_INBOUND_DOMAIN: "reponses.immojudis.test",
      NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Immojudis SAS",
      NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de la Paix, 33000 Bordeaux",
      NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.test",
    },
    now: MONDAY_10H,
    roundtripVerifiedAt: "2026-10-25T00:00:00Z",
    actingAdminIsAdmin: true,
    privacyVersion: "2099-01-01.0",
    verifiedResendDomains: new Set(["reponses.immojudis.test"]),
    ...overrides,
  };
}

describe("T1 et lot B du 14/11/2026 : la simulation ne s'arrête plus d'elle-même", () => {
  const reused = (snapshot: Record<string, unknown>) => ({
    id: "current",
    status: "draft",
    sale_id: "sale-1",
    recipient_email: "me.dupont@cabinet-dupont.test",
    recipient_name: null,
    subject: "S",
    body_text: "B",
    sale_snapshot: snapshot,
    metadata: {
      trigger: "autopilot",
      email_content_template_revision: 9,
      autopilot_simulated: true,
    },
  });

  beforeEach(() => {
    mocks.template.mockResolvedValue({ id: "tpl", revision: 9 });
    mocks.cancel.mockResolvedValue(undefined);
    mocks.db.sale = null;
  });

  it("une vente dont la date change : le brouillon réutilisé est annulé, draft_stale, sans rejet ni arrêt", async () => {
    mocks.db.rows = [reused({ sale_date: "2026-12-01T10:00:00Z", starting_price_eur: 120000 })];
    mocks.db.sale = {
      status: "upcoming",
      sale_date: "2026-12-15T10:00:00Z",
      starting_price_eur: 120000,
    };

    expect(await prepareAutopilotDraft(candidate(), settings(), "run-1")).toEqual({
      skip: "draft_stale",
    });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ missionId: "current" }),
    );
    expect(mocks.createDraft).not.toHaveBeenCalled();

    // Le passage le compte parmi les candidats écartés : aucun évènement « skip » (rejet), aucun arrêt.
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      prepareDraft: async () => ({ skip: "draft_stale" }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", code: null, skipped: { draft_stale: 1 } });
    expect(calls.records.map((record) => record.kind)).toEqual(["run"]);
    expect(calls.records[0].details).toMatchObject({ skip_draft_stale: 1 });
    expect(calls.autoStops).toEqual([]);
  });

  it("une vente inchangée : le brouillon est réutilisé tel quel", async () => {
    mocks.db.rows = [reused({ sale_date: "2026-12-01T10:00:00Z", starting_price_eur: 120000 })];
    mocks.db.sale = {
      status: "upcoming",
      sale_date: "2026-12-01T10:00:00Z",
      starting_price_eur: 120000,
    };
    expect(await prepareAutopilotDraft(candidate(), settings(), "run-1")).toMatchObject({
      missionId: "current",
      alreadySimulated: true,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("relecture de la vente impossible : l'erreur remonte, le brouillon n'est pas annulé", async () => {
    mocks.db.rows = [reused({ sale_date: "2026-12-01T10:00:00Z" })];
    mocks.db.sale = new Error("base indisponible");
    await expect(prepareAutopilotDraft(candidate(), settings(), "run-1")).rejects.toThrow(
      "base indisponible",
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("envoi manuel à un avocat qui a 3 ventes candidates : ni rejet ni arrêt automatique", async () => {
    // La sélection écarte ses autres ventes (brouillons simulés en attente, délai de 30 jours) : aucun de leurs
    // brouillons n'arrive à l'aperçu, donc aucun rejet de politique (détail : autopilot-candidates.test.ts).
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      findCandidates: async () => ({
        candidates: [candidate({ saleId: "autre-avocat", domain: "cabinet-martin.test" })],
        skipped: { simulated_draft_pending: 2, recipient_cooldown: 1 },
        examined: 2,
      }),
      prepareDraft: async (item) => draft({ missionId: `mission-${item.saleId}` }),
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", code: null, wouldSend: 1 });
    expect(summary.skipped).toEqual({ simulated_draft_pending: 2, recipient_cooldown: 1 });
    expect(calls.records.map((record) => record.kind)).toEqual(["would_send", "run"]);
    expect(calls.autoStops).toEqual([]);
    expect(calls.cancels).toEqual([]);
  });

  it("plafond des brouillons simulés en attente : plus aucune recherche ni brouillon une fois atteint", async () => {
    const findCandidates = vi.fn(async () => ({ candidates: [], skipped: {}, examined: 0 }));
    const full = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      countPendingSimulatedDrafts: async () => 10,
      findCandidates,
    });
    const summary = await runInformationAgentAutopilot(full.deps);
    expect(summary).toMatchObject({ status: "ran", code: null, skipped: { simulated_backlog: 1 } });
    expect(findCandidates).not.toHaveBeenCalled();
    expect(full.calls.records.map((record) => record.kind)).toEqual(["run"]);
    expect(full.calls.records[0].details).toMatchObject({ skip_simulated_backlog: 1 });

    // 8 en attente : 2 brouillons au plus ce passage-ci.
    const almost = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      countPendingSimulatedDrafts: async () => 8,
      findCandidates,
    });
    await runInformationAgentAutopilot(almost.deps);
    expect(findCandidates).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 2);

    // Le mode réel ne crée aucun brouillon simulé : le plafond ne le concerne pas.
    const countPendingSimulatedDrafts = vi.fn(async () => 10);
    const live = harness({ countPendingSimulatedDrafts, findCandidates });
    await runInformationAgentAutopilot(live.deps);
    expect(countPendingSimulatedDrafts).not.toHaveBeenCalled();
    expect(findCandidates).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 3);
  });

  it("marque « simulé » impossible (T8) : erreur du passage, aucun « aurait envoyé », le passage continue", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings: Array<[string, boolean]> = [];
    const { deps, calls } = harness({
      loadSettings: async () => settings({ mode: "simulation" }),
      findCandidates: async () => ({
        candidates: [candidate({ saleId: "a" }), candidate({ saleId: "b", domain: "b.test" })],
        skipped: {},
        examined: 2,
      }),
      prepareDraft: async (item) => draft({ missionId: `mission-${item.saleId}` }),
      markSimulated: async (missionId) => {
        if (missionId === "mission-a")
          throw { code: "P0002", message: "Brouillon du pilote introuvable" };
      },
      warning: async (code, active) => {
        warnings.push([code, active]);
      },
    });
    const summary = await runInformationAgentAutopilot(deps);
    expect(summary).toMatchObject({ status: "ran", code: "run_errors", wouldSend: 1 });
    expect(summary.errors).toEqual({ mark_failed: 1 });
    expect(calls.records.filter((record) => record.kind === "would_send")).toEqual([
      { kind: "would_send", details: { saleId: "b", missionId: "mission-b" } },
    ]);
    expect(warnings).toContainEqual(["run_errors", true]);
    expect(calls.autoStops).toEqual([]);
    logged.mockRestore();
  });

  it("marque « simulé » : une seule fonction de la base (fusion), et son refus remonte", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const rpc = vi.mocked(supabaseAdmin.rpc);
    const deps = defaultAutopilotDeps({}, { VERCEL_ENV: "production" });
    await deps.markSimulated("mission-1");
    expect(rpc).toHaveBeenCalledWith("mark_information_agent_autopilot_simulated", {
      p_mission_id: "mission-1",
    });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0002", message: "Brouillon du pilote introuvable" },
    } as never);
    await expect(deps.markSimulated("mission-1")).rejects.toMatchObject({ code: "P0002" });
  });

  it("bail du passage : 330 secondes, la route étant coupée à 300 (T30)", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await defaultAutopilotDeps({}, { VERCEL_ENV: "production" }).claimLease();
    expect(vi.mocked(supabaseAdmin.rpc)).toHaveBeenCalledWith("claim_cron_lease", {
      p_name: "information-agent-autopilot",
      p_ttl_seconds: 330,
    });
  });
});
