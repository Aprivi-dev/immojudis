/**
 * Modèle de vue du panneau du pilote automatique : tout est mis en forme côté serveur (libellés français, dates,
 * nombres). Le navigateur n'affiche que des chaînes (budget de JavaScript). Module pur.
 */
import {
  autopilotCaps,
  type AutopilotSettings,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";
import type { AutopilotReadiness } from "@/lib/information-agent/autopilot-readiness";

export type AutopilotView = {
  mode: AutopilotSettings["mode"];
  modeLabel: string;
  /** Raison d'un arrêt automatique ou d'une pause, déjà rédigée ; null sinon. */
  notice: { tone: "alert" | "warn"; text: string } | null;
  counters: Array<{ label: string; value: string }>;
  settings: {
    actingAdminId: string | null;
    capTotalOverride: number | null;
    allowLicitorDecoded: boolean;
    art14RuleEnabled: boolean;
    art14MaxAgeDays: number;
    aipdLabel: string;
  };
  readiness: { ready: boolean; checks: Array<{ label: string; ok: boolean; detail: string }> };
  ready: { count: number; items: string[] };
  events: Array<{ at: string; label: string; detail: string }>;
};

export const AUTOPILOT_STOP_LABELS: Record<string, string> = {
  complaint: "une plainte sur les 100 premiers envois",
  complaints_14d: "deux plaintes en 14 jours",
  bounce_early: "trois rebonds définitifs sur les 30 premiers envois",
  bounce_rate: "taux de rebonds définitifs de 3 % ou plus",
  policy_rejections: "deux rejets de politique ou de contenu en 7 jours",
  delivery_rate: "moins de 95 % de messages remis sur 24 h",
  oppositions: "6 % d’oppositions ou plus sur 14 jours",
  api_errors: "trois erreurs consécutives du fournisseur d’envoi",
  unverified_send: "un envoi dont le résultat est inconnu",
  email_failed: "échec d’envoi (domaine ou quota)",
  acting_admin_invalid: "l’administrateur d’exécution n’est plus administrateur",
  wrong_recipient: "une réponse indique un mauvais destinataire",
  delayed_24h: "plus de 20 % de messages retardés sur 24 h (pause de 24 h)",
};

const EVENT_LABELS: Record<string, string> = {
  mode_changed: "Changement de mode",
  settings_changed: "Réglages modifiés",
  emergency_stop: "Arrêt d’urgence",
  auto_stop: "Arrêt automatique",
  aipd_attested: "AIPD attestée",
  run: "Passage",
  skip: "Candidat écarté",
  would_send: "Envoi simulé",
  sent: "Envoi réel",
  send_error: "Erreur d’envoi",
  wrong_recipient: "Mauvais destinataire",
};

const MODE_LABELS = {
  off: "Éteint",
  simulation: "Simulation (aucun envoi)",
  live: "Réel",
} as const;

const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  }).format(new Date(iso));

function eventDetail(kind: string, reason: string | null, details: unknown): string {
  const record =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  if (kind === "auto_stop" && reason) return AUTOPILOT_STOP_LABELS[reason] ?? reason;
  if (reason) return reason;
  if (kind === "run") {
    return `${record.examined ?? 0} examinées, ${record.prepared ?? 0} préparées, ${record.would_send ?? 0} simulées, ${record.sent ?? 0} envoyées`;
  }
  if (kind === "skip") return String(record.code ?? "");
  return "";
}

export function buildAutopilotView({
  settings,
  stats,
  readiness,
  env,
  now,
  events,
  prepared,
}: {
  settings: AutopilotSettings;
  stats: AutopilotStats;
  readiness: AutopilotReadiness;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  events: Array<{ at: string; kind: string; reason: string | null; details: unknown }>;
  prepared: string[];
}): AutopilotView {
  const caps = autopilotCaps(stats, settings, env, now);
  let notice: AutopilotView["notice"] = null;
  if (settings.autoStoppedAt) {
    const reason = settings.autoStopReason ?? "";
    notice = {
      tone: "alert",
      text: `Arrêt automatique le ${formatDateTime(settings.autoStoppedAt)} : ${AUTOPILOT_STOP_LABELS[reason] ?? reason}. La réactivation est manuelle et journalisée.`,
    };
  } else if (settings.pausedUntil && Date.parse(settings.pausedUntil) > now.getTime()) {
    notice = { tone: "warn", text: `En pause jusqu’au ${formatDateTime(settings.pausedUntil)}.` };
  }
  return {
    mode: settings.mode,
    modeLabel: MODE_LABELS[settings.mode],
    notice,
    counters: [
      {
        label: "Envois aujourd’hui (manuels inclus)",
        value: `${stats.sentTodayTotal} sur ${caps.dayCap}`,
      },
      {
        label: "Envois sur la dernière heure",
        value: `${stats.sentLastHourTotal} sur ${caps.hourCap}`,
      },
      { label: "Phase", value: caps.phase.label },
      { label: "Envois automatiques au total", value: String(stats.autopilotTotal) },
      { label: "Jours de simulation avec envois simulés", value: String(stats.wouldSendDays) },
    ],
    settings: {
      actingAdminId: settings.actingAdminId,
      capTotalOverride: settings.capTotalOverride,
      allowLicitorDecoded: settings.allowLicitorDecoded,
      art14RuleEnabled: settings.art14RuleEnabled,
      art14MaxAgeDays: settings.art14MaxAgeDays,
      aipdLabel: settings.aipdAttestedAt
        ? `Attestée le ${formatDateTime(settings.aipdAttestedAt)} (version ${settings.aipdVersion})`
        : "Non attestée",
    },
    readiness: {
      ready: readiness.ready,
      checks: readiness.checks.map(({ label, ok, detail }) => ({ label, ok, detail })),
    },
    ready: { count: prepared.length, items: prepared },
    events: events.map((event) => ({
      at: formatDateTime(event.at),
      label: EVENT_LABELS[event.kind] ?? event.kind,
      detail: eventDetail(event.kind, event.reason, event.details),
    })),
  };
}
