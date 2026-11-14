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
import {
  informationAgentCapStructure,
  sharedMailDomainOf,
  type InformationAgentCapStructure,
} from "@/lib/information-agent/contact-structure";
import { INFORMATION_AGENT_COURT_REGISTRY_FALLBACK } from "@/lib/information-agent/court-registry-fallback";
import { isWithinAutopilotSendWindow } from "@/lib/information-agent/paris-time";
import { startOfParisDay } from "@/lib/paris-time";

export type AutopilotMode = "off" | "simulation" | "live";

export type AutopilotSettings = {
  mode: AutopilotMode;
  actingAdminId: string | null;
  capTotalOverride: number | null;
  allowLicitorDecoded: boolean;
  /** Verrou du lot 3 : faux tant qu'une migration du lot 3 ne l'a pas levé. Le mode réel est alors impossible. */
  liveAllowed: boolean;
  /**
   * Lu pour l'écran seulement : la règle de l'article 14 s'applique toujours (J9, décision du 14/11/2026). La base
   * refuse « faux » depuis 20261119100810 ; une valeur fausse plus ancienne n'a aucun effet sur le pilote.
   */
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
  /**
   * Envois du jour et des 7 derniers jours par structure, pour les seuls domaines PARTAGÉS (`notaires.fr`,
   * `gouv.fr`) : office (`office|<code>`) ou, sans code, boîte (`mailbox|<adresse>`). Comptés par
   * l'application (`sharedStructureCounts`), pas par la fonction SQL. Jamais journalisés.
   */
  todayBySharedStructure: Record<string, number>;
  weekBySharedStructure: Record<string, number>;
  /**
   * Faux tant que ce compte n'a pas été lu en entier (compteurs SQL seuls, ou trop de missions à lire) : le
   * pilote n'écrit alors à aucune adresse d'un domaine partagé, et l'écran d'administration le signale.
   */
  sharedStructureCountsComplete: boolean;
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
  /**
   * Jours (Paris) depuis le début de la simulation avec au moins un envoi simulé ET aucun passage en erreur
   * (`error_<code>` dans le journal d'un passage) : les seuls qui comptent pour la porte du mode réel.
   */
  cleanSimulationDays: number;
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
    // Absents de la fonction SQL : remplis par `loadAutopilotStats` (lecture des missions envoyées).
    todayBySharedStructure: record(r.today_by_shared_structure),
    weekBySharedStructure: record(r.week_by_shared_structure),
    sharedStructureCountsComplete: r.shared_structure_counts_complete === true,
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
    // Absent avant 20261119100820 : 0, la porte reste fermée.
    cleanSimulationDays: num(r.clean_simulation_days),
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
const AUTOPILOT_HARD_DAY_CAP = 60;
const AUTOPILOT_HARD_HOUR_CAP = 12;
/**
 * Plafond par STRUCTURE (cabinet, office notarial, service de l'État) : 1 envoi par jour, 2 par semaine.
 * Sur un domaine propre, la structure est le domaine (comportement inchangé). Sur un domaine partagé par
 * toute une profession (`notaires.fr`, `gouv.fr`), un plafond par domaine bloquerait la profession entière :
 * la structure est l'office (code) ou, sans code, la boîte elle-même.
 */
export const AUTOPILOT_STRUCTURE_DAY_CAP = 1;
export const AUTOPILOT_STRUCTURE_WEEK_CAP = 2;
/** Plafond bas du domaine partagé lui-même, toutes structures confondues (valeur de départ du 11/11/2026). */
export const AUTOPILOT_SHARED_DOMAIN_DAY_CAP = 3;
const AUTOPILOT_COURT_DAY_CAP = 3;
const AUTOPILOT_MIN_GAP_MS = 2 * 60_000;
const AUTOPILOT_MAX_GAP_MS = 12 * 60_000;
const WEEK_MS = 7 * 86_400_000;

/** Une semaine est « propre » : aucune plainte, rebonds définitifs sous 3 % des envois. */
function isCleanAutopilotWeek(week: AutopilotWeekStats | undefined): boolean {
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
  structure = null,
  court,
  now,
  random,
}: {
  stats: AutopilotStats;
  caps: AutopilotCaps;
  domain: string | null;
  /** Unité de plafond du destinataire (`informationAgentCapStructure`) ; obligatoire sur un domaine partagé. */
  structure?: InformationAgentCapStructure | null;
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
    const sharedDomain = sharedMailDomainOf(domain);
    if (sharedDomain) {
      // Domaine partagé : plafond bas du domaine, puis plafond de la structure (office ou boîte).
      const sharedToday = Object.entries(stats.todayByDomain).reduce(
        (total, [sent, count]) =>
          sharedMailDomainOf(sent) === sharedDomain ? total + count : total,
        0,
      );
      if (sharedToday >= AUTOPILOT_SHARED_DOMAIN_DAY_CAP) {
        return { ok: false, scope: "candidate", code: "shared_domain_cap" };
      }
      // Compte par structure incomplet : rien ne part vers un domaine partagé.
      if (!stats.sharedStructureCountsComplete) {
        return { ok: false, scope: "candidate", code: "structure_count_incomplete" };
      }
      // Sans unité de plafond, la structure ne peut pas être comptée : le candidat est écarté.
      if (!structure || structure.sharedDomain !== sharedDomain) {
        return { ok: false, scope: "candidate", code: "structure_unknown" };
      }
      if (
        (stats.todayBySharedStructure[structure.key] ?? 0) >= AUTOPILOT_STRUCTURE_DAY_CAP ||
        (stats.weekBySharedStructure[structure.key] ?? 0) >= AUTOPILOT_STRUCTURE_WEEK_CAP
      ) {
        return { ok: false, scope: "candidate", code: "structure_cap" };
      }
    } else if (
      // Domaine propre : la structure est le domaine.
      (stats.todayByDomain[domain] ?? 0) >= AUTOPILOT_STRUCTURE_DAY_CAP ||
      (stats.weekByDomain[domain] ?? 0) >= AUTOPILOT_STRUCTURE_WEEK_CAP
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

export type SharedStructureCounts = Pick<
  AutopilotStats,
  "todayBySharedStructure" | "weekBySharedStructure" | "sharedStructureCountsComplete"
>;

/** Envoi déjà compté (mission approuvée et non échouée), vu par le compteur des structures. */
export type AutopilotSharedSend = {
  recipientEmail: string;
  officeCode: string | null;
  approvedAt: string;
};

/**
 * Envois du jour (heure de Paris) et des 7 derniers jours par structure, pour les domaines partagés seulement.
 * Les envois vers un domaine propre sont déjà comptés par domaine (fonction SQL) et sont ignorés ici.
 */
export function sharedStructureCounts(
  sends: readonly AutopilotSharedSend[],
  now: Date,
): SharedStructureCounts {
  const dayStart = startOfParisDay(now).getTime();
  const weekStart = now.getTime() - WEEK_MS;
  const todayBySharedStructure: Record<string, number> = {};
  const weekBySharedStructure: Record<string, number> = {};
  for (const send of sends) {
    const structure = informationAgentCapStructure({
      email: send.recipientEmail,
      officeCode: send.officeCode,
    });
    const at = Date.parse(send.approvedAt);
    if (!structure.sharedDomain || !Number.isFinite(at) || at > now.getTime()) continue;
    if (at >= weekStart) {
      weekBySharedStructure[structure.key] = (weekBySharedStructure[structure.key] ?? 0) + 1;
    }
    if (at >= dayStart) {
      todayBySharedStructure[structure.key] = (todayBySharedStructure[structure.key] ?? 0) + 1;
    }
  }
  return { todayBySharedStructure, weekBySharedStructure, sharedStructureCountsComplete: true };
}

// ---------------------------------------------------------------------------------------------------------
// Passage
// ---------------------------------------------------------------------------------------------------------
export type AutopilotRunGate = { ok: true } | { ok: false; code: string };

/** Au plus un passage lancé à la main toutes les 10 minutes (journal : événement `run` avec `manual`). */
export const AUTOPILOT_ON_DEMAND_COOLDOWN_MS = 10 * 60_000;

/**
 * Garde de tête de passage : mode, arrêt, pause, plage horaire. Un passage lancé à la main par un administrateur
 * (`onDemand`) n'existe qu'en simulation (`not_simulation` sinon, réel compris) et seule la plage horaire ne
 * l'arrête pas : il n'envoie jamais rien.
 */
export function autopilotRunGate(
  settings: AutopilotSettings,
  now: Date,
  { onDemand = false }: { onDemand?: boolean } = {},
): AutopilotRunGate {
  if (onDemand && settings.mode !== "simulation") return { ok: false, code: "not_simulation" };
  if (settings.mode === "off") return { ok: false, code: "disabled" };
  if (settings.autoStoppedAt) return { ok: false, code: "auto_stopped" };
  if (settings.pausedUntil && Date.parse(settings.pausedUntil) > now.getTime()) {
    return { ok: false, code: "paused" };
  }
  if (!onDemand && !isWithinAutopilotSendWindow(now)) return { ok: false, code: "outside_window" };
  return { ok: true };
}

/**
 * Cadence de la tâche pg_cron du pilote : toutes les 10 minutes, heure UTC. RÈGLE LIÉE : `cron.schedule` de
 * `immojudis-information-agent-autopilot` (migration 20261110230000) ; les deux changent ensemble.
 */
export const AUTOPILOT_RUN_EVERY_MINUTES = 10;
/** Au-delà de deux semaines sans passage possible (pause la plus longue : 7 jours), on ne cherche plus. */
const NEXT_RUN_HORIZON_MS = 14 * 86_400_000;

/**
 * Prochain passage planifié que la garde de tête laisserait travailler : premier multiple de 10 minutes à partir de
 * `now`, dans la plage d'envoi et hors pause. Nul quand le pilote est éteint ou arrêté automatiquement : aucun
 * passage n'aura lieu avant une action d'un administrateur. Ne dit rien d'une panne de la planification elle-même.
 */
export function nextAutopilotRunAt(settings: AutopilotSettings, now: Date): Date | null {
  const step = AUTOPILOT_RUN_EVERY_MINUTES * 60_000;
  const end = now.getTime() + NEXT_RUN_HORIZON_MS;
  for (let at = Math.ceil(now.getTime() / step) * step; at <= end; at += step) {
    const gate = autopilotRunGate(settings, new Date(at));
    if (gate.ok) return new Date(at);
    if (gate.code === "disabled" || gate.code === "auto_stopped") return null;
  }
  return null;
}

/**
 * Brouillons simulés en attente de validation (« Prêtes à valider ») au plus : à ce nombre, la simulation ne prépare
 * plus de brouillon. Une vente déjà simulée n'est plus reprise par la sélection, sans plafond ils s'accumuleraient
 * (jusqu'à 5 par passage, 27 passages par jour). 10 : l'écran les montre tous, c'est le plafond d'une journée de
 * la phase 2 du mode réel, et plus de trois fois les 1 à 3 envois manuels prévus par jour.
 */
export const AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS = 10;

// ---------------------------------------------------------------------------------------------------------
// Candidat
// ---------------------------------------------------------------------------------------------------------
const AUTOPILOT_MIN_DAYS_BEFORE_SALE = 10;
/**
 * Délai d'information de l'article 14 : réglable de 1 à ce nombre de jours. 90 : décision du propriétaire du
 * 14/11/2026, contre l'avis de juridique-rgpd (art. 14.3.a RGPD : information au plus tard un mois après le relevé),
 * risque accepté par le propriétaire. RÈGLE LIÉE : contrainte `art14_max_age_days between 1 and 90` de
 * `information_agent_autopilot_settings` (migration 20261119100810) et borne du panneau d'administration.
 */
export const AUTOPILOT_ART14_MAX_DAYS = 90;

/** Délai de l'article 14 appliqué : le réglage enregistré, plafonné à 90 jours (une valeur plus ancienne peut dépasser). */
export function effectiveArt14MaxAgeDays(
  settings: Pick<AutopilotSettings, "art14MaxAgeDays">,
): number {
  return Math.min(settings.art14MaxAgeDays, AUTOPILOT_ART14_MAX_DAYS);
}
const AUTOPILOT_ADDRESS_MAX_AGE_DAYS = 183;
const AUTOPILOT_REPLY_PAUSE_DAYS = 90;
const AUTOPILOT_SILENCE_PAUSE_DAYS = 183;
const AUTOPILOT_SILENCE_SENDS = 2;
const DAY_MS = 86_400_000;

/** Ce que le pilote sait d'un candidat avant de préparer son brouillon. */
export type AutopilotCandidateFacts = {
  /** `sale_listing` seulement ; `court_registry_fallback`, autre origine ou origine absente (null) : refusé. */
  sourceKind: string | null;
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
  /** Première fois que l'agent a enregistré l'adresse (`created_at` du contact au registre) ; nul : refus (art. 14). */
  contactFirstRecordedAt: string | null;
  alreadyInformed: boolean;
  lastReplyAt: string | null;
  /** Envois précédents à la même identité depuis 6 mois, sans réponse. */
  silentSendsInSixMonths: number;
  lastSendAt: string | null;
};

export type AutopilotCandidateVerdict = { ok: true } | { ok: false; code: string };

function licitorDecodedRefused(
  observationChannel: string | null,
  settings: Pick<AutopilotSettings, "allowLicitorDecoded">,
): boolean {
  return observationChannel === "licitor_cloudflare_decoded" && !settings.allowLicitorDecoded;
}

function saleTooSoon(saleDate: string | null, now: Date): boolean {
  const at = saleDate ? Date.parse(saleDate) : NaN;
  return !Number.isFinite(at) || (at - now.getTime()) / DAY_MS < AUTOPILOT_MIN_DAYS_BEFORE_SALE;
}

/**
 * Article 14 : une personne jamais informée (aucun envoi précédent à cette adresse ou à cette identité) ne peut
 * l'être que dans les `art14MaxAgeDays` jours (plafonnés à 90) qui suivent le premier enregistrement de son adresse.
 * Sans cette date, la règle est invérifiable : refus. Toujours appliquée (J9, décision du 14/11/2026), quel que soit
 * `art14RuleEnabled`. Seule définition, pour la vérification complète et pour le tri de la file.
 */
export function autopilotArt14Refusal(
  facts: Pick<AutopilotCandidateFacts, "alreadyInformed" | "contactFirstRecordedAt">,
  settings: Pick<AutopilotSettings, "art14MaxAgeDays">,
  now: Date,
): "art14_unknown" | "art14_window_expired" | null {
  if (facts.alreadyInformed) return null;
  if (!facts.contactFirstRecordedAt) return "art14_unknown";
  const days = (now.getTime() - Date.parse(facts.contactFirstRecordedAt)) / DAY_MS;
  return days > effectiveArt14MaxAgeDays(settings) ? "art14_window_expired" : null;
}

/**
 * Refus que la file permet de prononcer AVANT tout examen coûteux (opposition, relevé de l'adresse, DNS, pièces) :
 * données de l'annonce (rôle, identité et adresse du contact retenu, date de la vente) puis, quand le tri de la page
 * les a lues, brouillon d'un administrateur, premier enregistrement de l'adresse et envois précédents. Un fait absent
 * (non lu) ne refuse jamais. Chaque refus rendu ici, `evaluateAutopilotCandidate` le prononcerait aussi (mêmes
 * prédicats) : la file n'écarte jamais un candidat que la vérification complète aurait admis. Le code peut différer
 * du premier motif de la vérification complète.
 *
 * Article 14 : une date de premier enregistrement absente ne refuse pas ici. L'examen enregistre l'adresse de
 * l'annonce avant de lire cette date (`persistInformationAgentContactObservations`) : une adresse encore inconnue
 * du registre y est datée du jour même.
 */
export function autopilotQueueRefusal(
  facts: Pick<
    AutopilotCandidateFacts,
    "recipientRole" | "identityComplete" | "consumerDomain" | "observationChannel" | "saleDate"
  > &
    Partial<
      Pick<
        AutopilotCandidateFacts,
        "humanDraftExists" | "alreadyInformed" | "contactFirstRecordedAt"
      >
    >,
  settings: Pick<AutopilotSettings, "allowLicitorDecoded" | "art14MaxAgeDays">,
  now: Date,
): string | null {
  if (facts.recipientRole !== "lawyer") return "role_not_lawyer";
  if (!facts.identityComplete) return "identity_incomplete";
  if (facts.consumerDomain) return "consumer_domain";
  if (licitorDecodedRefused(facts.observationChannel, settings)) return "licitor_decoded_refused";
  if (saleTooSoon(facts.saleDate, now)) return "sale_too_soon";
  if (facts.humanDraftExists) return "admin_draft_exists";
  if (facts.alreadyInformed === false && facts.contactFirstRecordedAt) {
    return autopilotArt14Refusal(
      { alreadyInformed: false, contactFirstRecordedAt: facts.contactFirstRecordedAt },
      settings,
      now,
    );
  }
  return null;
}

export function evaluateAutopilotCandidate(
  facts: AutopilotCandidateFacts,
  settings: Pick<AutopilotSettings, "allowLicitorDecoded" | "art14MaxAgeDays">,
  now: Date,
): AutopilotCandidateVerdict {
  const no = (code: string): AutopilotCandidateVerdict => ({ ok: false, code });
  const at = now.getTime();
  const daysSince = (iso: string | null) => (iso ? (at - Date.parse(iso)) / DAY_MS : Infinity);
  if (facts.sourceKind === INFORMATION_AGENT_COURT_REGISTRY_FALLBACK) {
    return no("court_registry_refused");
  }
  if (facts.sourceKind !== "sale_listing") return no("source_not_sale_listing");
  if (facts.recipientRole !== "lawyer") return no("role_not_lawyer");
  if (!facts.selectedUnambiguously) return no("contact_ambiguous");
  if (!facts.identityComplete) return no("identity_incomplete");
  if (facts.addressHygieneIssue) return no("address_invalid");
  if (facts.consumerDomain) return no("consumer_domain");
  if (licitorDecodedRefused(facts.observationChannel, settings)) {
    return no("licitor_decoded_refused");
  }
  if (!(daysSince(facts.addressObservedAt) <= AUTOPILOT_ADDRESS_MAX_AGE_DAYS)) {
    return no("address_stale");
  }
  if (facts.mailDomain === "no_mail") return no("mx_invalid");
  if (saleTooSoon(facts.saleDate, now)) return no("sale_too_soon");
  if (!facts.hasUnpublishedGap) return no("no_unpublished_gap");
  if (facts.humanDraftExists) return no("admin_draft_exists");
  if (facts.identityExcluded) return no("identity_excluded");
  const art14 = autopilotArt14Refusal(facts, settings, now);
  if (art14) return no(art14);
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

/**
 * Règles revérifiées JUSTE AVANT l'envoi (l'état a pu changer depuis la sélection) : mêmes règles que la sélection
 * pour tout ce qui dépend de l'origine de l'adresse, du rôle, du domaine, des exclusions, de l'article 14 et des
 * pauses. Les faits propres à la sélection (ambiguïté, lacune, brouillon d'administrateur, date de la vente,
 * résolution DNS) sont contrôlés ailleurs à l'envoi (aperçu, vente à jour, délivrabilité) : ils sont donnés ici
 * comme satisfaits, jamais omis. Même fonction pour la sélection et l'envoi : une seule définition des pauses.
 */
export function evaluateAutopilotSendTime(
  facts: Omit<
    AutopilotCandidateFacts,
    "selectedUnambiguously" | "hasUnpublishedGap" | "humanDraftExists" | "mailDomain" | "saleDate"
  >,
  settings: Pick<AutopilotSettings, "allowLicitorDecoded" | "art14MaxAgeDays">,
  now: Date,
): AutopilotCandidateVerdict {
  return evaluateAutopilotCandidate(
    {
      ...facts,
      selectedUnambiguously: true,
      hasUnpublishedGap: true,
      humanDraftExists: false,
      mailDomain: "ok",
      saleDate: new Date(now.getTime() + 365 * DAY_MS).toISOString(),
    },
    settings,
    now,
  );
}
