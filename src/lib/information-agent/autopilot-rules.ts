/**
 * Règles du pilote automatique de l'agent d'information. MODULE PUR : aucun accès réseau, base ni horloge
 * (l'heure et le hasard sont des arguments). Sa table de cas est la matrice de tests
 * (`autopilot-rules.test.ts`, `information-agent-autopilot.scenarios.test.ts`).
 *
 * Périmètre validé par le propriétaire (02/11/2026) : le pilote n'écrit qu'à l'avocat poursuivant dont l'adresse
 * figure dans l'annonce de la vente (`source_kind = sale_listing`). Greffes, adresses retrouvées par recherche,
 * saisies d'administrateur, messageries grand public, notaires, commissaires et gestionnaires : validation
 * manuelle uniquement. Aucune relance.
 */
import { isWithinAutopilotSendWindow } from "@/lib/information-agent/paris-time";

export type AutopilotMode = "off" | "simulation" | "live";

export type AutopilotSettings = {
  mode: AutopilotMode;
  actingAdminId: string | null;
  capTotalOverride: number | null;
  allowLicitorDecoded: boolean;
  art14RuleEnabled: boolean;
  art14MaxAgeDays: number;
  aipdAttestedAt: string | null;
  aipdVersion: string | null;
  simulationStartedAt: string | null;
  pausedUntil: string | null;
  autoStoppedAt: string | null;
  autoStopReason: string | null;
};

export type AutopilotWeekStats = {
  week: number;
  sent: number;
  complaints: number;
  permanent_bounces: number;
};

/** Compteurs lus en base (`information_agent_autopilot_stats`), manuels inclus dans les totaux du jour. */
export type AutopilotStats = {
  sentTodayTotal: number;
  sentLastHourTotal: number;
  lastSendAt: string | null;
  todayByDomain: Record<string, number>;
  weekByDomain: Record<string, number>;
  todayByCourt: Record<string, number>;
  recentDomains: string[];
  firstAutopilotSendAt: string | null;
  autopilotTotal: number;
  first100Complaints: number;
  first30PermanentBounces: number;
  matureTotal: number;
  maturePermanentBounces: number;
  last24hSent: number;
  last24hDelayed: number;
  last24hDelivered: number;
  last24hFailed: number;
  complaints14d: number;
  sent14d: number;
  oppositions14d: number;
  weeks: AutopilotWeekStats[];
  consecutiveApiErrors: number;
  rejected7d: number;
  unverifiedOpen: number;
  stuckSending: number;
  manualRealSends: number;
  manualComplaints: number;
  manualPermanentBounces: number;
  wouldSendDays: number;
  anomaliesSinceSimulation: number;
};

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const record = (value: unknown): Record<string, number> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([key, count]) => [key, num(count)]))
    : {};

export function parseAutopilotStats(raw: unknown): AutopilotStats {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    sentTodayTotal: num(r.sent_today_total),
    sentLastHourTotal: num(r.sent_last_hour_total),
    lastSendAt: typeof r.last_send_at === "string" ? r.last_send_at : null,
    todayByDomain: record(r.today_by_domain),
    weekByDomain: record(r.week_by_domain),
    todayByCourt: record(r.today_by_court),
    recentDomains: Array.isArray(r.recent_domains)
      ? r.recent_domains.filter((item): item is string => typeof item === "string")
      : [],
    firstAutopilotSendAt:
      typeof r.first_autopilot_send_at === "string" ? r.first_autopilot_send_at : null,
    autopilotTotal: num(r.autopilot_total),
    first100Complaints: num(r.first100_complaints),
    first30PermanentBounces: num(r.first30_permanent_bounces),
    matureTotal: num(r.mature_total),
    maturePermanentBounces: num(r.mature_permanent_bounces),
    last24hSent: num(r.last24h_sent),
    last24hDelayed: num(r.last24h_delayed),
    last24hDelivered: num(r.last24h_delivered),
    last24hFailed: num(r.last24h_failed),
    complaints14d: num(r.complaints_14d),
    sent14d: num(r.sent_14d),
    oppositions14d: num(r.oppositions_14d),
    weeks: Array.isArray(r.weeks)
      ? (r.weeks as Array<Record<string, unknown>>).map((week) => ({
          week: num(week.week),
          sent: num(week.sent),
          complaints: num(week.complaints),
          permanent_bounces: num(week.permanent_bounces),
        }))
      : [],
    consecutiveApiErrors: num(r.consecutive_api_errors),
    rejected7d: num(r.rejected_7d),
    unverifiedOpen: num(r.unverified_open),
    stuckSending: num(r.stuck_sending),
    manualRealSends: num(r.manual_real_sends),
    manualComplaints: num(r.manual_complaints),
    manualPermanentBounces: num(r.manual_permanent_bounces),
    wouldSendDays: num(r.would_send_days),
    anomaliesSinceSimulation: num(r.anomalies_since_simulation),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Plafonds
// ---------------------------------------------------------------------------------------------------------
/** Plafonds par phase (jour, heure) : semaine 1 à 4, puis croisière. */
export const AUTOPILOT_PHASES = [
  { index: 1, label: "semaine 1", dayCap: 5, hourCap: 3 },
  { index: 2, label: "semaine 2", dayCap: 10, hourCap: 12 },
  { index: 3, label: "semaine 3", dayCap: 20, hourCap: 12 },
  { index: 4, label: "semaine 4", dayCap: 30, hourCap: 12 },
  { index: 5, label: "croisière", dayCap: 40, hourCap: 12 },
] as const;
export const AUTOPILOT_HARD_DAY_CAP = 60;
export const AUTOPILOT_HARD_HOUR_CAP = 12;
export const AUTOPILOT_DOMAIN_DAY_CAP = 1;
export const AUTOPILOT_DOMAIN_WEEK_CAP = 2;
export const AUTOPILOT_COURT_DAY_CAP = 3;
export const AUTOPILOT_DOMAIN_SPACING_MS = 15 * 60_000;
export const AUTOPILOT_MIN_GAP_MS = 2 * 60_000;
export const AUTOPILOT_MAX_GAP_MS = 12 * 60_000;
const WEEK_MS = 7 * 86_400_000;

/** Une semaine est « propre » : aucune plainte, rebonds définitifs sous 3 % des envois. */
export function isCleanAutopilotWeek(week: AutopilotWeekStats | undefined): boolean {
  if (!week || week.sent === 0) return true;
  return week.complaints === 0 && week.permanent_bounces / week.sent < 0.03;
}

/**
 * Phase du pilote, calculée depuis la date du premier envoi réel. Le passage à la phase suivante n'est
 * automatique que si la semaine précédente est propre ; sinon on reste.
 */
export function autopilotPhase(
  firstSendAt: string | null,
  weeks: readonly AutopilotWeekStats[],
  now: Date,
): (typeof AUTOPILOT_PHASES)[number] {
  const first = firstSendAt ? Date.parse(firstSendAt) : NaN;
  if (!Number.isFinite(first)) return AUTOPILOT_PHASES[0];
  const calendar = Math.min(
    Math.max(1, Math.floor((now.getTime() - first) / WEEK_MS) + 1),
    AUTOPILOT_PHASES.length,
  );
  let phase = 1;
  while (phase < calendar && isCleanAutopilotWeek(weeks.find((week) => week.week === phase - 1))) {
    phase += 1;
  }
  return AUTOPILOT_PHASES[phase - 1];
}

export type AutopilotCaps = {
  dayCap: number;
  hourCap: number;
  phase: (typeof AUTOPILOT_PHASES)[number];
};

/** Plafonds effectifs : le minimum entre la phase, le réglage, l'environnement et le plafond dur. */
export function autopilotCaps(
  stats: Pick<AutopilotStats, "firstAutopilotSendAt" | "weeks">,
  settings: Pick<AutopilotSettings, "capTotalOverride">,
  env: Readonly<Record<string, string | undefined>>,
  now: Date,
): AutopilotCaps {
  const phase = autopilotPhase(stats.firstAutopilotSendAt, stats.weeks, now);
  const envCap = Number(env.INFORMATION_AGENT_AUTOPILOT_DAILY_CAP);
  const dayCap = Math.min(
    phase.dayCap,
    settings.capTotalOverride ?? Infinity,
    Number.isInteger(envCap) && envCap > 0 ? envCap : Infinity,
    AUTOPILOT_HARD_DAY_CAP,
  );
  return { dayCap, hourCap: Math.min(phase.hourCap, AUTOPILOT_HARD_HOUR_CAP), phase };
}

export type AutopilotBudgetDecision =
  | { ok: true }
  | { ok: false; scope: "run" | "candidate"; code: string };

/**
 * Peut-on envoyer maintenant ? `random` ∈ [0, 1[ tire l'intervalle de 2 à 12 minutes depuis le dernier envoi.
 * Les codes de portée « run » arrêtent le passage ; ceux de portée « candidate » écartent seulement ce candidat.
 */
export function autopilotBudgetDecision({
  stats,
  caps,
  domain,
  court,
  now,
  random,
}: {
  stats: AutopilotStats;
  caps: AutopilotCaps;
  domain: string | null;
  court: string | null;
  now: Date;
  random: number;
}): AutopilotBudgetDecision {
  if (stats.sentTodayTotal >= caps.dayCap) return { ok: false, scope: "run", code: "cap_reached" };
  if (stats.sentLastHourTotal >= caps.hourCap) return { ok: false, scope: "run", code: "hour_cap" };
  const last = stats.lastSendAt ? Date.parse(stats.lastSendAt) : NaN;
  const gap = AUTOPILOT_MIN_GAP_MS + random * (AUTOPILOT_MAX_GAP_MS - AUTOPILOT_MIN_GAP_MS);
  if (Number.isFinite(last) && now.getTime() - last < gap) {
    return { ok: false, scope: "run", code: "interval" };
  }
  if (domain) {
    if (
      (stats.todayByDomain[domain] ?? 0) >= AUTOPILOT_DOMAIN_DAY_CAP ||
      (stats.weekByDomain[domain] ?? 0) >= AUTOPILOT_DOMAIN_WEEK_CAP
    ) {
      return { ok: false, scope: "candidate", code: "domain_cap" };
    }
    if (stats.recentDomains.includes(domain)) {
      return { ok: false, scope: "candidate", code: "domain_spacing" };
    }
  }
  if (court && (stats.todayByCourt[court] ?? 0) >= AUTOPILOT_COURT_DAY_CAP) {
    return { ok: false, scope: "candidate", code: "court_cap" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------
// Passage
// ---------------------------------------------------------------------------------------------------------
export type AutopilotRunGate = { ok: true } | { ok: false; code: string };

/** Garde de tête de passage : mode, arrêt, pause, plage horaire. */
export function autopilotRunGate(settings: AutopilotSettings, now: Date): AutopilotRunGate {
  if (settings.mode === "off") return { ok: false, code: "disabled" };
  if (settings.autoStoppedAt) return { ok: false, code: "auto_stopped" };
  if (settings.pausedUntil && Date.parse(settings.pausedUntil) > now.getTime()) {
    return { ok: false, code: "paused" };
  }
  if (!isWithinAutopilotSendWindow(now)) return { ok: false, code: "outside_window" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------
// Candidat
// ---------------------------------------------------------------------------------------------------------
export const AUTOPILOT_MIN_DAYS_BEFORE_SALE = 10;
export const AUTOPILOT_ADDRESS_MAX_AGE_DAYS = 183;
export const AUTOPILOT_REPLY_PAUSE_DAYS = 90;
export const AUTOPILOT_SILENCE_PAUSE_DAYS = 183;
export const AUTOPILOT_SILENCE_SENDS = 2;
const DAY_MS = 86_400_000;

/** Ce que le pilote sait d'un candidat avant de préparer son brouillon. */
export type AutopilotCandidateFacts = {
  /** `court_registry_fallback` ou autre origine que l'annonce : refusé. */
  sourceKind: string;
  recipientRole: string;
  /** Le contact est choisi seul par le résolveur (confiance au moins moyenne, écart de 12 points). */
  selectedUnambiguously: boolean;
  identityComplete: boolean;
  addressHygieneIssue: string | null;
  consumerDomain: boolean;
  /** `licitor_cloudflare_decoded` : adresse décodée par le pipeline. */
  observationChannel: string | null;
  addressObservedAt: string | null;
  /** Résolution MX/A : `no_mail` bloque, `unknown` (panne DNS) ne bloque pas. */
  mailDomain: "ok" | "no_mail" | "unknown";
  saleDate: string | null;
  hasUnpublishedGap: boolean;
  humanDraftExists: boolean;
  identityExcluded: boolean;
  /** Première fois que l'agent a enregistré l'adresse (`created_at` du contact), nul si jamais enregistrée. */
  contactFirstRecordedAt: string | null;
  alreadyInformed: boolean;
  lastReplyAt: string | null;
  /** Envois précédents à la même identité depuis 6 mois, sans réponse. */
  silentSendsInSixMonths: number;
  lastSendAt: string | null;
};

export type AutopilotCandidateVerdict = { ok: true } | { ok: false; code: string };

export function evaluateAutopilotCandidate(
  facts: AutopilotCandidateFacts,
  settings: Pick<AutopilotSettings, "allowLicitorDecoded" | "art14RuleEnabled" | "art14MaxAgeDays">,
  now: Date,
): AutopilotCandidateVerdict {
  const no = (code: string): AutopilotCandidateVerdict => ({ ok: false, code });
  const at = now.getTime();
  const daysSince = (iso: string | null) => (iso ? (at - Date.parse(iso)) / DAY_MS : Infinity);
  if (facts.sourceKind === "court_registry_fallback") return no("court_registry_refused");
  if (facts.sourceKind !== "sale_listing") return no("source_not_sale_listing");
  if (facts.recipientRole !== "lawyer") return no("role_not_lawyer");
  if (!facts.selectedUnambiguously) return no("contact_ambiguous");
  if (!facts.identityComplete) return no("identity_incomplete");
  if (facts.addressHygieneIssue) return no("address_invalid");
  if (facts.consumerDomain) return no("consumer_domain");
  if (facts.observationChannel === "licitor_cloudflare_decoded" && !settings.allowLicitorDecoded) {
    return no("licitor_decoded_refused");
  }
  if (!(daysSince(facts.addressObservedAt) <= AUTOPILOT_ADDRESS_MAX_AGE_DAYS)) {
    return no("address_stale");
  }
  if (facts.mailDomain === "no_mail") return no("mx_invalid");
  const saleDate = facts.saleDate ? Date.parse(facts.saleDate) : NaN;
  if (!Number.isFinite(saleDate) || (saleDate - at) / DAY_MS < AUTOPILOT_MIN_DAYS_BEFORE_SALE) {
    return no("sale_too_soon");
  }
  if (!facts.hasUnpublishedGap) return no("no_unpublished_gap");
  if (facts.humanDraftExists) return no("admin_draft_exists");
  if (facts.identityExcluded) return no("identity_excluded");
  if (
    settings.art14RuleEnabled &&
    facts.contactFirstRecordedAt &&
    !facts.alreadyInformed &&
    daysSince(facts.contactFirstRecordedAt) > settings.art14MaxAgeDays
  ) {
    return no("art14_window_expired");
  }
  if (facts.lastReplyAt && daysSince(facts.lastReplyAt) < AUTOPILOT_REPLY_PAUSE_DAYS) {
    return no("reply_pause");
  }
  if (
    facts.silentSendsInSixMonths >= AUTOPILOT_SILENCE_SENDS &&
    daysSince(facts.lastSendAt) < AUTOPILOT_SILENCE_PAUSE_DAYS
  ) {
    return no("silence_pause");
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------
// Arrêt automatique
// ---------------------------------------------------------------------------------------------------------
export type AutopilotSafetyVerdict = {
  /** Arrêt complet (mode « off », alerte critique, réactivation manuelle seulement). */
  stop: { code: string } | null;
  /** Pause du pilote (le mode ne change pas). */
  pause: { code: string; hours: number } | null;
  /** Seuils d'alerte, à la moitié des seuils d'arrêt. */
  warnings: string[];
};

export function evaluateAutopilotSafety(stats: AutopilotStats): AutopilotSafetyVerdict {
  const warnings: string[] = [];
  let stop: string | null = null;
  const stopWith = (code: string) => {
    stop ??= code;
  };

  if (stats.autopilotTotal <= 100 ? stats.first100Complaints >= 1 : stats.complaints14d >= 2) {
    stopWith(stats.autopilotTotal <= 100 ? "complaint" : "complaints_14d");
  }
  if (stats.first30PermanentBounces >= 3) stopWith("bounce_early");
  else if (stats.first30PermanentBounces >= 2) warnings.push("bounce_early");
  if (stats.matureTotal >= 100) {
    const rate = stats.maturePermanentBounces / stats.matureTotal;
    if (rate >= 0.03) stopWith("bounce_rate");
    else if (rate >= 0.015) warnings.push("bounce_rate");
  }
  if (stats.rejected7d >= 2) stopWith("policy_rejections");
  else if (stats.rejected7d >= 1) warnings.push("policy_rejections");
  if (stats.last24hSent >= 20) {
    const delivered = stats.last24hDelivered / stats.last24hSent;
    if (delivered < 0.95) stopWith("delivery_rate");
    else if (delivered < 0.975) warnings.push("delivery_rate");
  }
  if (stats.oppositions14d >= 3 && stats.oppositions14d / Math.max(stats.sent14d, 1) >= 0.06) {
    stopWith("oppositions");
  } else if (
    stats.oppositions14d >= 2 &&
    stats.oppositions14d / Math.max(stats.sent14d, 1) >= 0.03
  ) {
    warnings.push("oppositions");
  }
  if (stats.consecutiveApiErrors >= 3) stopWith("api_errors");
  else if (stats.consecutiveApiErrors >= 2) warnings.push("api_errors");
  if (stats.unverifiedOpen >= 1) stopWith("unverified_send");
  if (stats.last24hFailed >= 1) stopWith("email_failed");

  const delayedShare = stats.last24hSent >= 5 ? stats.last24hDelayed / stats.last24hSent : 0;
  const pause = delayedShare >= 0.2 ? { code: "delayed_24h", hours: 24 } : null;
  if (!pause && delayedShare >= 0.1) warnings.push("delayed_24h");
  return { stop: stop ? { code: stop } : null, pause, warnings };
}

export { isWithinAutopilotSendWindow };
