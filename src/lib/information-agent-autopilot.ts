import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPublishedInformationAgentEmailTemplate } from "@/lib/admin-information-agent-email-template";
import { claimCronLease, releaseCronLease, type CronLease } from "@/lib/cron-lease.server";
import { runAdminInformationAgentAction } from "@/lib/information-agent";
import { createAdminInformationAgentDraft } from "@/lib/information-agent/draft";
import {
  INFORMATION_AGENT_PREVIEW_CHECK_FAILED_MESSAGE,
  previewAdminInformationAgentMission,
} from "@/lib/information-agent/preview";
import {
  findAutopilotCandidates,
  type AutopilotCandidate,
  type AutopilotCandidateSearch,
} from "@/lib/information-agent/autopilot-candidates";
import {
  currentPrivacyVersion,
  evaluateAutopilotReadiness,
  isActiveAdmin,
  loadRoundtripVerifiedAt,
  loadVerifiedResendDomains,
  type AutopilotReadiness,
} from "@/lib/information-agent/autopilot-readiness";
import {
  AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS,
  autopilotBudgetDecision,
  autopilotCaps,
  autopilotRunGate,
  evaluateAutopilotSafety,
  type AutopilotSettings,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";
import { informationAgentCapStructure } from "@/lib/information-agent/contact-structure";
import {
  loadAutopilotSettings,
  loadAutopilotStats,
  loadPendingSimulatedDrafts,
  recordAutopilotAutoStop,
  recordAutopilotEvent,
  syncAutopilotWarning,
} from "@/lib/information-agent/autopilot-settings";
import { assertInformationAgentSaleCurrent } from "@/lib/information-agent/draft-checks";
import {
  INFORMATION_AGENT_CANARY_ONLY_MESSAGE,
  INFORMATION_AGENT_OUTBOUND_DISABLED_MESSAGE,
} from "@/lib/information-agent/config";
import { asObject, cancelMission } from "@/lib/information-agent/mission-store";
import { AdminDailyApprovalCapError } from "@/lib/information-agent/approval-cap";
import {
  InformationAgentSentButUnrecordedError,
  InformationAgentUnverifiedSendError,
} from "@/lib/information-agent/send";
import { ResendRejectedError } from "@/lib/email-alerts";
import { issueAutopilotTrigger } from "@/lib/information-agent/schemas";
import { AutopilotSendRefusedError } from "@/lib/information-agent/autopilot-send-guard";
import { PublicApiError } from "@/lib/api-errors";

/**
 * Pilote automatique de l'agent d'information : UN passage (appelé par `pg_cron` toutes les 10 minutes, via la
 * route `/api/cron/information-agent-autopilot`, seulement si le mode n'est pas « off »).
 *
 * C'est le SEUL expéditeur automatisé de l'agent, et il n'envoie rien lui-même : il prépare le brouillon, rend
 * l'aperçu, puis appelle `runAdminInformationAgentAction` avec l'action `approve_and_send` et `trigger:
 * autopilot`, comme le ferait un administrateur. Un seul chemin d'envoi (`approveAndSendMission`).
 *
 * - `simulation` : brouillons et aperçus, événements `would_send`, ZÉRO appel au fournisseur.
 * - `live` : envoi réel, seulement si le contrôle de préparation est satisfait (il ne l'est pas tant que les
 *   textes juridiques du lot 3 ne sont pas publiés : voir `AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION`).
 * - Contenu : uniquement ce que `buildInformationRequestDraft` produit avec la révision de gabarit publiée.
 *   Aucun texte libre, aucun texte d'IA.
 * - Le gestionnaire ne relance JAMAIS d'exception après un envoi : il rend un résumé partiel (le rejeu d'un
 *   passage est sans danger : bail, `should_send = false`, clé d'idempotence du fournisseur).
 */
export type AutopilotRunSummary = {
  runId: string;
  status: "skipped" | "ran" | "stopped";
  code: string | null;
  mode: AutopilotSettings["mode"];
  examined: number;
  prepared: number;
  wouldSend: number;
  sent: number;
  skipped: Record<string, number>;
  /**
   * Erreurs du passage, par code (`draft_error`, `cancel_failed`, `preview_error`, `mark_failed`) : ni un candidat
   * écarté, ni une erreur d'API. Journalisées dans l'évènement `run` (`error_<code>`) et signalées par l'alerte
   * `run_errors`.
   */
  errors: Record<string, number>;
  warnings: string[];
};

export type PreparedAutopilotDraft = {
  missionId: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  bodyText: string;
  /** Déjà vu en simulation : pas de nouvel événement `would_send`. */
  alreadySimulated: boolean;
};

type AutopilotPreview = { blockers: string[]; fingerprint: string | null };

type SaleSnapshot = Parameters<typeof assertInformationAgentSaleCurrent>[0]["sale_snapshot"];

/** Brouillon simulé en attente, tel que le passage le relit avant de compter le plafond. */
export type PendingSimulatedDraft = {
  missionId: string;
  saleId: string | null;
  saleSnapshot: SaleSnapshot;
};

export type AutopilotDeps = {
  now: () => Date;
  random: () => number;
  newRunId: () => string;
  env: Readonly<Record<string, string | undefined>>;
  loadSettings: () => Promise<AutopilotSettings>;
  loadStats: (now: Date) => Promise<AutopilotStats>;
  readiness: (
    settings: AutopilotSettings,
    stats: AutopilotStats,
    now: Date,
  ) => Promise<AutopilotReadiness>;
  isAdmin: (userId: string | null) => Promise<boolean>;
  claimLease: () => Promise<CronLease>;
  releaseLease: (token: string) => Promise<void>;
  findCandidates: (
    settings: AutopilotSettings,
    now: Date,
    limit: number,
  ) => Promise<AutopilotCandidateSearch>;
  prepareDraft: (
    candidate: AutopilotCandidate,
    settings: AutopilotSettings,
    runId: string,
  ) => Promise<PreparedAutopilotDraft | { skip: string }>;
  preview: (
    draft: PreparedAutopilotDraft,
    settings: AutopilotSettings,
    runId: string,
  ) => Promise<AutopilotPreview>;
  cancelDraft: (missionId: string, settings: AutopilotSettings) => Promise<void>;
  markSimulated: (missionId: string) => Promise<void>;
  /** Brouillons simulés en attente de validation (« Prêtes à valider ») : leur nombre et ceux à relire. */
  listPendingSimulatedDrafts: () => Promise<{ total: number; drafts: PendingSimulatedDraft[] }>;
  /** La vente du brouillon a changé depuis sa préparation (refus 409 du contrôle de l'aperçu). */
  draftIsStale: (draft: PendingSimulatedDraft) => Promise<boolean>;
  send: (
    draft: PreparedAutopilotDraft,
    fingerprint: string,
    settings: AutopilotSettings,
    runId: string,
    checks: Record<string, string | number | boolean | null>,
  ) => Promise<void>;
  record: typeof recordAutopilotEvent;
  autoStop: typeof recordAutopilotAutoStop;
  warning: typeof syncAutopilotWarning;
};

const KNOWN_WARNINGS = [
  "bounce_early",
  "bounce_rate",
  "policy_rejections",
  "delivery_rate",
  "oppositions",
  "api_errors",
  "delayed_24h",
] as const;
const SIMULATION_PER_RUN = 5;
const LIVE_PER_RUN = 3;
/**
 * Bail du passage : `maxDuration = 300` de la route, plus 30 secondes de marge (T30, 14/11/2026). Un passage coupé
 * par la plateforme ne tient plus la place du suivant, 10 minutes plus tard (avec 600 secondes, le bail expirait
 * au moment même de ce passage).
 */
const AUTOPILOT_LEASE_SECONDS = 330;
/**
 * Brouillons simulés en attente relus au plus par passage : le double du plafond. Le pilote n'en crée pas au-delà
 * du plafond ; seuls des brouillons antérieurs au lot B pourraient dépasser, ils seraient relus aux passages suivants.
 */
const PENDING_REVIEW_LIMIT = 2 * AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS;

/**
 * Refus attendus d'un brouillon : les garde-fous de `createAdminInformationAgentDraft` refusent par une
 * `PublicApiError` 400 (aucune lacune, aucune adresse, question non admise) ou 409 (délai de 30 jours, vente déjà
 * sollicitée, opposition, greffe ou adresse retrouvée). Tout le reste (base, bogue, 404 d'une relecture, 503) est
 * une erreur du passage.
 */
const EXPECTED_DRAFT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 409]);

function isExpectedDraftRefusal(error: unknown): boolean {
  return error instanceof PublicApiError && EXPECTED_DRAFT_REFUSAL_STATUSES.has(error.status);
}

/** Annulation d'un brouillon du pilote impossible : remonte marquée comme telle, jamais avalée. */
export class AutopilotDraftCancelError extends Error {
  constructor(cause: unknown) {
    super("Autopilot draft cancellation failed", { cause });
    this.name = "AutopilotDraftCancelError";
  }
}

async function cancelAutopilotDraft(adminId: string, missionId: string): Promise<void> {
  try {
    await cancelMission({ adminId, missionId });
  } catch (error) {
    throw new AutopilotDraftCancelError(error);
  }
}

/**
 * Nature d'une erreur pour les journaux : nom et code (base, fournisseur), jamais le message (il peut porter une
 * adresse).
 */
function errorKind(error: unknown): { name: string; code: string | null } | null {
  if (error == null) return null;
  const code = (error as { code?: unknown } | null)?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code.slice(0, 20) : null,
  };
}

function actingAuth(userId: string): SupabaseAuthContext {
  return {
    supabase: supabaseAdmin as unknown as SupabaseAuthContext["supabase"],
    userId,
    claims: {} as SupabaseAuthContext["claims"],
    accountTier: "premium",
    userRole: "admin",
    isAdmin: true,
    hasProfile: true,
  };
}

/** Motifs d'aperçu que la simulation tolère : elle n'envoie jamais, l'environnement peut donc rester fermé. */
export function blockersAfterSimulationTolerance(blockers: readonly string[]): string[] {
  return blockers.filter(
    (blocker) =>
      blocker !== INFORMATION_AGENT_OUTBOUND_DISABLED_MESSAGE &&
      blocker !== INFORMATION_AGENT_CANARY_ONLY_MESSAGE,
  );
}

export function defaultAutopilotDeps(
  overrides: Partial<AutopilotDeps> = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): AutopilotDeps {
  return {
    now: () => new Date(),
    random: Math.random,
    newRunId: randomUUID,
    env,
    loadSettings: loadAutopilotSettings,
    loadStats: loadAutopilotStats,
    readiness: async (settings, stats, now) =>
      evaluateAutopilotReadiness({
        settings,
        stats,
        env,
        now,
        roundtripVerifiedAt: await loadRoundtripVerifiedAt(),
        actingAdminIsAdmin: await isActiveAdmin(settings.actingAdminId),
        privacyVersion: currentPrivacyVersion(),
        verifiedResendDomains: await loadVerifiedResendDomains(
          env.RESEND_API_KEY?.trim(),
          fetchImpl,
        ),
      }),
    isAdmin: isActiveAdmin,
    claimLease: () => claimCronLease("information-agent-autopilot", AUTOPILOT_LEASE_SECONDS),
    releaseLease: (token) => releaseCronLease("information-agent-autopilot", token),
    findCandidates: (settings, now, limit) =>
      findAutopilotCandidates({ settings, now, limit, env }),
    prepareDraft: prepareAutopilotDraft,
    preview: async (draft, settings, runId) => {
      const response = await previewAdminInformationAgentMission({
        auth: actingAuth(settings.actingAdminId ?? ""),
        env: env as NodeJS.ProcessEnv,
        input: {
          missionId: draft.missionId,
          recipientEmail: draft.recipientEmail,
          recipientName: draft.recipientName,
          subject: draft.subject,
          bodyText: draft.bodyText,
          recipientOriginUrl: null,
        },
        trigger: issueAutopilotTrigger(runId),
      });
      return { blockers: response.blockers, fingerprint: response.fingerprint };
    },
    cancelDraft: (missionId, settings) =>
      cancelAutopilotDraft(settings.actingAdminId ?? "", missionId),
    // Fusion faite par la base, en une instruction (T8) : aucune lecture préalable qui, en échec, ferait écraser
    // `metadata` (le brouillon passerait pour celui d'un administrateur). Refus contrôlé si ce n'est plus un
    // brouillon du pilote ; toute erreur remonte.
    markSimulated: async (missionId) => {
      const { error } = await supabaseAdmin.rpc("mark_information_agent_autopilot_simulated", {
        p_mission_id: missionId,
      });
      if (error) throw error;
    },
    listPendingSimulatedDrafts: async () => {
      const { rows, total } = await loadPendingSimulatedDrafts({ limit: PENDING_REVIEW_LIMIT });
      return {
        total,
        drafts: rows.map((row) => ({
          missionId: row.id,
          saleId: row.sale_id,
          saleSnapshot: row.sale_snapshot,
        })),
      };
    },
    draftIsStale: (draft) =>
      reusedDraftIsStale({ sale_id: draft.saleId, sale_snapshot: draft.saleSnapshot }),
    send: async (draft, fingerprint, settings, runId, checks) => {
      await runAdminInformationAgentAction({
        auth: actingAuth(settings.actingAdminId ?? ""),
        input: {
          action: "approve_and_send",
          missionId: draft.missionId,
          approvalConfirmed: true,
          previewFingerprint: fingerprint,
          recipientEmail: draft.recipientEmail,
          recipientName: draft.recipientName,
          recipientOriginUrl: null,
          subject: draft.subject,
          bodyText: draft.bodyText,
        },
        fetchImpl,
        trigger: issueAutopilotTrigger(runId, checks),
      });
    },
    record: recordAutopilotEvent,
    autoStop: recordAutopilotAutoStop,
    warning: syncAutopilotWarning,
    ...overrides,
  };
}

/**
 * Brouillon réutilisé devenu caduc : la vente a changé depuis sa préparation (date ou mise à prix), ou n'est plus
 * disponible. Même contrôle que l'aperçu (`assertInformationAgentSaleCurrent`) : son refus (409) n'est pas un rejet
 * de politique, le brouillon est annulé et le candidat écarté `draft_stale` (T1, 14/11/2026). Le délai de 30 jours
 * par destinataire, l'autre cause d'un tel refus, est appliqué dès la sélection.
 */
async function reusedDraftIsStale(
  mission: Parameters<typeof assertInformationAgentSaleCurrent>[0],
): Promise<boolean> {
  try {
    await assertInformationAgentSaleCurrent(mission);
    return false;
  } catch (error) {
    if (error instanceof PublicApiError && error.status === 409) return true;
    throw error;
  }
}

/**
 * Brouillon du pilote pour un candidat : le brouillon du pilote est réutilisé s'il est à jour (même révision
 * du gabarit publié, vente inchangée), sinon régénéré, ou annulé s'il est caduc. Un brouillon d'administrateur
 * n'est jamais touché (le candidat est écarté en amont s'il en existe un).
 */
export async function prepareAutopilotDraft(
  candidate: AutopilotCandidate,
  settings: AutopilotSettings,
  runId: string,
): Promise<PreparedAutopilotDraft | { skip: string }> {
  const adminId = settings.actingAdminId ?? "";
  const template = await getPublishedInformationAgentEmailTemplate();
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("sale_id", candidate.saleId)
    .eq("user_id", adminId)
    .in("status", ["draft", "failed"])
    .limit(5);
  if (error) throw error;
  const own = (data ?? []).filter((row) => asObject(row.metadata).trigger === "autopilot");
  const current = own.find(
    (row) =>
      row.status === "draft" &&
      row.recipient_email.toLowerCase() === candidate.email &&
      asObject(row.metadata).email_content_template_revision === template.revision,
  );
  if (current) {
    if (await reusedDraftIsStale(current)) {
      await cancelAutopilotDraft(adminId, current.id);
      return { skip: "draft_stale" };
    }
    return {
      missionId: current.id,
      recipientEmail: current.recipient_email,
      recipientName: current.recipient_name,
      subject: current.subject,
      bodyText: current.body_text,
      alreadySimulated: asObject(current.metadata).autopilot_simulated === true,
    };
  }
  // Révision changée (ou brouillon périmé) : régénération, jamais un texte hors gabarit publié.
  for (const row of own) await cancelAutopilotDraft(adminId, row.id);
  const created = await createAdminInformationAgentDraft({
    auth: actingAuth(adminId),
    input: { saleId: candidate.saleId },
    trigger: issueAutopilotTrigger(runId),
  });
  const mission = created.mission;
  if (
    mission.recipientEmail.toLowerCase() !== candidate.email ||
    mission.recipientKind !== "source_lawyer" ||
    mission.recipientOrigin
  ) {
    await cancelAutopilotDraft(adminId, mission.id);
    return { skip: "draft_recipient_mismatch" };
  }
  return {
    missionId: mission.id,
    recipientEmail: mission.recipientEmail,
    recipientName: mission.recipientName,
    subject: mission.subject,
    bodyText: mission.bodyText,
    alreadySimulated: false,
  };
}

function emptySummary(runId: string, mode: AutopilotSettings["mode"]): AutopilotRunSummary {
  return {
    runId,
    status: "skipped",
    code: null,
    mode,
    examined: 0,
    prepared: 0,
    wouldSend: 0,
    sent: 0,
    skipped: {},
    errors: {},
    warnings: [],
  };
}

/**
 * Brouillons simulés en attente qui comptent encore pour le plafond : chacun est relu comme à l'aperçu, et celui
 * dont la vente a changé est annulé (`draft_stale`) au lieu de bloquer la simulation jusqu'à une action humaine.
 * Une relecture ou une annulation impossible est une erreur du passage ; le brouillon reste compté.
 */
async function pendingAfterStaleReview(
  deps: AutopilotDeps,
  settings: AutopilotSettings,
  skip: (code: string) => void,
  runError: (code: string, error: unknown, saleId: string | null) => void,
): Promise<number> {
  const { total, drafts } = await deps.listPendingSimulatedDrafts();
  let pending = total;
  for (const draft of drafts) {
    try {
      if (!(await deps.draftIsStale(draft))) continue;
      await deps.cancelDraft(draft.missionId, settings);
    } catch (error) {
      const code =
        error instanceof AutopilotDraftCancelError ? "cancel_failed" : "stale_check_failed";
      runError(code, error, draft.saleId);
      continue;
    }
    skip("draft_stale");
    pending -= 1;
  }
  return pending;
}

export async function runInformationAgentAutopilot(
  overrides: Partial<AutopilotDeps> = {},
): Promise<AutopilotRunSummary> {
  const deps = defaultAutopilotDeps(overrides);
  const runId = deps.newRunId();
  const now = deps.now();
  let settings = await deps.loadSettings();
  const summary = emptySummary(runId, settings.mode);
  const finish = (status: AutopilotRunSummary["status"], code: string | null) => {
    summary.status = status;
    summary.code = code;
    return summary;
  };

  // 1. Mode, arrêt, pause, plage horaire : aucune lecture de candidat tant qu'une de ces portes est fermée.
  const gate = autopilotRunGate(settings, now);
  if (!gate.ok) return finish("skipped", gate.code);
  // Production seulement : un environnement de prévisualisation ne travaille jamais sur les vraies fiches.
  if (deps.env.VERCEL_ENV !== "production") return finish("skipped", "not_production");

  const lease = await deps.claimLease();
  if (lease.kind === "busy") return finish("skipped", "busy");

  try {
    let stats = await deps.loadStats(now);

    // 2. Arrêts automatiques et alertes à la moitié des seuils.
    const safety = evaluateAutopilotSafety(stats);
    summary.warnings = safety.warnings;
    for (const code of KNOWN_WARNINGS) await deps.warning(code, safety.warnings.includes(code));
    // Le pilote tourne : l'alerte critique d'un arrêt automatique précédent (réactivé à la main) se referme.
    await deps.warning("auto_stop", false);
    if (safety.stop) {
      await deps.autoStop(safety.stop.code, { examined: stats.autopilotTotal });
      return finish("stopped", safety.stop.code);
    }
    if (safety.pause) {
      await deps.autoStop(safety.pause.code, {}, safety.pause.hours);
      return finish("stopped", safety.pause.code);
    }

    // 3. Administrateur d'exécution : rétrogradé ou supprimé, le pilote s'arrête.
    if (!(await deps.isAdmin(settings.actingAdminId))) {
      await deps.autoStop("acting_admin_invalid", {});
      return finish("stopped", "acting_admin_invalid");
    }

    // 4. Mode réel : contrôle de préparation à CHAQUE passage. La simulation s'en passe.
    if (settings.mode === "live") {
      const readiness = await deps.readiness(settings, stats, now);
      if (!readiness.ready) {
        await deps.record("run", runId, {
          code: "not_ready",
          failed: readiness.checks.filter((check) => !check.ok).map((check) => check.key),
        });
        return finish("skipped", "not_ready");
      }
    }

    const skip = (code: string, count = 1) => {
      summary.skipped[code] = (summary.skipped[code] ?? 0) + count;
    };
    // Erreur du passage : comptée et journalisée par son code, jamais rangée parmi les candidats écartés.
    const runError = (code: string, error: unknown, saleId: string | null) => {
      summary.errors[code] = (summary.errors[code] ?? 0) + 1;
      console.error(
        JSON.stringify({
          scope: "information_agent.autopilot",
          level: "error",
          runId,
          code,
          saleId,
          error: errorKind(error),
        }),
      );
    };

    // 5. Candidats : avocat poursuivant de l'annonce, classe A uniquement. En simulation, les brouillons simulés en
    //    attente sont d'abord relus (ceux que la vente a rendus caducs sont annulés, `draft_stale`), puis plafonnés :
    //    plafond atteint, aucune recherche, rien n'est préparé tant qu'un administrateur n'en a pas envoyé ou annulé.
    const live = settings.mode === "live";
    const wanted = live
      ? LIVE_PER_RUN
      : Math.min(
          SIMULATION_PER_RUN,
          AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS -
            (await pendingAfterStaleReview(deps, settings, skip, runError)),
        );
    const backlog = wanted <= 0;
    const search: AutopilotCandidateSearch = backlog
      ? { candidates: [], skipped: { simulated_backlog: 1 }, examined: 0 }
      : await deps.findCandidates(settings, now, wanted);
    summary.examined = search.examined;
    for (const [code, count] of Object.entries(search.skipped)) skip(code, count);

    for (const candidate of search.candidates) {
      // Relecture de l'interrupteur et des compteurs avant CHAQUE envoi.
      settings = await deps.loadSettings();
      if (settings.mode !== summary.mode || settings.autoStoppedAt || settings.mode === "off") {
        skip("interrupted");
        break;
      }
      stats = await deps.loadStats(deps.now());
      const caps = autopilotCaps(stats, settings, deps.env, deps.now());
      const budget = autopilotBudgetDecision({
        stats,
        caps,
        domain: candidate.domain,
        structure: informationAgentCapStructure({
          email: candidate.email,
          officeCode: candidate.officeCode,
        }),
        court: candidate.tribunalCode,
        now: deps.now(),
        random: deps.random(),
      });
      if (!budget.ok) {
        skip(budget.code);
        if (budget.scope === "run") break;
        continue;
      }

      let draft: Awaited<ReturnType<AutopilotDeps["prepareDraft"]>>;
      try {
        draft = await deps.prepareDraft(candidate, settings, runId);
      } catch (error) {
        // Brouillon refusé par les garde-fous (délai de 30 jours, vente déjà sollicitée, opposition…) : on passe.
        if (isExpectedDraftRefusal(error)) skip("draft_refused");
        else {
          const code = error instanceof AutopilotDraftCancelError ? "cancel_failed" : "draft_error";
          runError(code, error, candidate.saleId);
        }
        continue;
      }
      if ("skip" in draft) {
        skip(draft.skip);
        continue;
      }
      summary.prepared += 1;

      const preview = await deps.preview(draft, settings, runId);
      const tolerated = live
        ? preview.blockers
        : blockersAfterSimulationTolerance(preview.blockers);
      // Contrôle qui n'a pas pu s'exécuter (panne passagère) : rien n'est refusé. Erreur du passage, jamais un rejet
      // de politique (arrêt automatique) ; le brouillon est gardé, le passage suivant refait l'aperçu.
      const blockers = tolerated.filter(
        (blocker) => blocker !== INFORMATION_AGENT_PREVIEW_CHECK_FAILED_MESSAGE,
      );
      const checkFailed = blockers.length < tolerated.length;
      if (checkFailed && !blockers.length) {
        runError("preview_error", null, candidate.saleId);
        continue;
      }
      if (blockers.length || !preview.fingerprint) {
        const code = blockers.some((blocker) => /mention commerciale/i.test(blocker))
          ? "content_rejected"
          : "policy_rejected";
        skip(code);
        await deps.record("skip", runId, {
          code,
          saleId: candidate.saleId,
          blockers: blockers.length,
        });
        try {
          await deps.cancelDraft(draft.missionId, settings);
        } catch (error) {
          runError("cancel_failed", error, candidate.saleId);
        }
        continue;
      }

      if (!live) {
        // Seuls les brouillons journalisés « aurait envoyé » pendant ce passage comptent : un brouillon déjà
        // simulé par un passage précédent reste en attente sans être recompté.
        if (!draft.alreadySimulated) {
          try {
            await deps.markSimulated(draft.missionId);
          } catch (error) {
            // Brouillon gardé sans marque ni évènement : le passage suivant le reprend et le marque.
            runError("mark_failed", error, candidate.saleId);
            continue;
          }
          await deps.record("would_send", runId, {
            saleId: candidate.saleId,
            missionId: draft.missionId,
          });
          summary.wouldSend += 1;
        }
        continue;
      }

      // Envoi réel : un seul chemin, celui de l'administrateur, avec trigger = autopilot.
      try {
        await deps.send(draft, preview.fingerprint, settings, runId, {
          phase: caps.phase.index,
          day_cap: caps.dayCap,
          sent_today: stats.sentTodayTotal,
          opposition_checked: true,
          template_revision_current: true,
        });
      } catch (error) {
        if (error instanceof InformationAgentUnverifiedSendError) {
          await deps.autoStop("unverified_send", { saleId: candidate.saleId });
          return finish("stopped", "unverified_send");
        }
        if (!(error instanceof InformationAgentSentButUnrecordedError)) {
          // Ni un plafond (limite, pas une erreur d'API), ni un 429 ne comptent comme erreurs consécutives.
          if (error instanceof AdminDailyApprovalCapError) {
            skip("approval_cap");
            await deps.record("skip", runId, { code: "approval_cap", saleId: candidate.saleId });
            break;
          }
          // Refus du garde ou pilote coupé au moment de l'envoi : une décision, jamais une erreur d'API.
          if (error instanceof AutopilotSendRefusedError) {
            skip("send_refused");
            await deps.record("skip", runId, {
              code: "send_refused",
              reason: error.refusal,
              saleId: candidate.saleId,
            });
            break;
          }
          const rateLimited = error instanceof ResendRejectedError && error.status === 429;
          await deps.record("send_error", runId, {
            status: rateLimited ? 429 : 500,
            saleId: candidate.saleId,
          });
          skip(rateLimited ? "rate_limited" : "send_error");
          break;
        }
        // Accepté par le fournisseur, enregistrement incomplet : le message est parti, il compte comme envoyé.
      }
      // Le message est parti : une panne du journal ne le remet pas en cause (résumé partiel, voir plus bas).
      summary.sent += 1;
      await deps.record("sent", runId, { saleId: candidate.saleId, missionId: draft.missionId });
      break;
    }

    await deps.record("run", runId, {
      mode: settings.mode,
      examined: summary.examined,
      prepared: summary.prepared,
      would_send: summary.wouldSend,
      sent: summary.sent,
      ...Object.fromEntries(
        Object.entries(summary.skipped).map(([code, n]) => [`skip_${code}`, n]),
      ),
      ...Object.fromEntries(
        Object.entries(summary.errors).map(([code, n]) => [`error_${code}`, n]),
      ),
    });
    const hasErrors = Object.keys(summary.errors).length > 0;
    // Alerte d'avertissement : ouverte par un passage en erreur, refermée par un passage sans erreur.
    await deps.warning("run_errors", hasErrors);
    return finish("ran", hasErrors ? "run_errors" : backlog ? "simulated_backlog" : null);
  } catch (error) {
    // Jamais d'exception après un envoi : le résumé partiel suffit, le passage suivant reprend.
    if (summary.sent > 0) return finish("ran", "partial_after_send");
    throw error;
  } finally {
    await deps.releaseLease(lease.token);
  }
}
