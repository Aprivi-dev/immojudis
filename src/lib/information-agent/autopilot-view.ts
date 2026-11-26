/**
 * Modèle de vue du panneau du pilote automatique : tout est mis en forme côté serveur (libellés français, dates,
 * nombres). Le navigateur n'affiche que des chaînes (budget de JavaScript). Module pur.
 */
import { formatNumericDateTime } from "@/lib/format/dates";
import {
  AUTOPILOT_ART14_LIVE_MAX_DAYS,
  AUTOPILOT_ART14_MAX_DAYS,
  AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS,
  AUTOPILOT_ON_DEMAND_COOLDOWN_MS,
  autopilotCaps,
  effectiveArt14MaxAgeDays,
  nextAutopilotRunAt,
  type AutopilotSettings,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";
import type { AutopilotReadiness } from "@/lib/information-agent/autopilot-readiness";

/** Brouillon préparé par le pilote en simulation, que l'administrateur peut ouvrir pour le valider. */
export type AutopilotPreparedDraft = { missionId: string; saleId: string; label: string };

export type AutopilotView = {
  mode: AutopilotSettings["mode"];
  modeLabel: string;
  /** « Dernier passage planifié : … · prochain passage : … », heure de Paris. */
  runs: string;
  /** Arrêté automatiquement (mode « off » posé par un seuil) ; le motif en clair est dans `notice`. */
  autoStopped: boolean;
  /** Raison d'un arrêt automatique ou d'une pause, déjà rédigée ; null sinon. */
  notice: { tone: "alert" | "warn"; text: string } | null;
  counters: Array<{ label: string; value: string }>;
  /** Envois du jour (manuels inclus) rapportés au plafond, par exemple « 3 sur 10 » : bandeau de synthèse. */
  sentToday: string;
  settings: {
    actingAdminId: string | null;
    capTotalOverride: number | null;
    allowLicitorDecoded: boolean;
    /** Faux seulement pour une valeur antérieure à la contrainte de la base : l'écran propose de la rétablir. */
    art14RuleEnabled: boolean;
    art14MaxAgeDays: number;
    /** État de la règle de l'article 14 et bornes du délai, déjà rédigés. */
    art14Label: string;
    aipdLabel: string;
  };
  /**
   * Contrôle de préparation au mode réel. `action` : ce qu'il faut faire pour une condition non remplie, en une
   * phrase simple ; null pour une condition remplie.
   */
  readiness: {
    ready: boolean;
    checks: Array<{ label: string; ok: boolean; detail: string; action: string | null }>;
  };
  /**
   * Brouillons simulés en attente (`count` : tous, `items` : les plus récents, au plus le plafond), avec leur
   * plafond (`label`) et, une fois atteint, la rotation des plus anciens par le pilote (`notice`).
   */
  ready: { count: number; label: string; notice: string | null; items: AutopilotPreparedDraft[] };
  events: Array<{ at: string; label: string; detail: string }>;
};

const AUTOPILOT_STOP_LABELS: Record<string, string> = {
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
  // Expéditeur non vérifié : arrêt sans exclusion, à confirmer par le bouton « Mauvais destinataire ».
  wrong_recipient_unverified:
    "une réponse non authentifiée indique un mauvais destinataire (à confirmer par le bouton « Mauvais destinataire »)",
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

/**
 * Codes d'un passage du pilote : candidats écartés, refus, erreurs, gardes de tête (T31 et P12, 14/11/2026). Une
 * ligne par code écrit dans `autopilot-rules.ts`, `autopilot-candidates.ts`, `autopilot-send-guard.ts` et
 * `information-agent-autopilot.ts` : `autopilot-view.test.ts` relit ces fichiers et échoue sur un code sans libellé.
 * Lexique commenté pour l'exploitation : `docs/runbooks/information-agent.md` (« Piloter le pilote »).
 */
const AUTOPILOT_CODE_LABELS: Record<string, string> = {
  // Gardes de tête de passage.
  disabled: "pilote éteint",
  auto_stopped: "arrêt automatique, réactivation manuelle",
  paused: "pilote en pause",
  outside_window: "hors de la plage d’envoi",
  not_production: "hors de la production",
  busy: "un autre passage est en cours",
  not_ready: "contrôle de préparation au mode réel non satisfait",
  roundtrip_proof_error:
    "preuve d’aller-retour illisible (panne passagère) : aucun envoi en mode réel",
  not_live: "pilote plus en mode réel",
  // Passage lancé à la main par un administrateur.
  on_demand_started: "passage à la demande lancé",
  not_simulation: "passage à la demande hors du mode Simulation",
  on_demand_cooldown: `passage à la demande déjà lancé il y a moins de ${AUTOPILOT_ON_DEMAND_COOLDOWN_MS / 60_000} minutes`,
  // Sélection : file, puis examen du candidat.
  not_class_a: "aucun contact unique dans l’annonce",
  role_not_lawyer: "destinataire autre qu’un avocat",
  consumer_domain: "messagerie grand public",
  licitor_decoded_refused: "adresse Licitor décodée, non ouverte au pilote",
  sale_too_soon: "vente dans moins de 10 jours",
  notary_send_closed: "vente notariale, envois aux notaires fermés",
  simulated_draft_pending: "brouillon simulé déjà en attente de validation",
  contact_ambiguous: "contact ambigu",
  address_invalid: "adresse invalide",
  opposed: "opposition ou rebond définitif",
  address_excluded: "adresse exclue ou structure inconnue",
  opposition_check_failed: "contrôle d’opposition impossible (panne passagère)",
  court_registry_refused: "greffe, jamais sollicité par le pilote",
  source_not_sale_listing: "adresse absente de l’annonce",
  identity_incomplete: "identité incomplète (nom et barreau ou ville)",
  address_stale: "adresse relevée il y a plus de 6 mois",
  mx_invalid: "domaine sans messagerie",
  no_unpublished_gap: "aucune information à demander",
  admin_draft_exists: "brouillon d’un administrateur sur la vente",
  identity_excluded: "identité exclue du pilote",
  art14_unknown: "article 14 : date du premier relevé inconnue",
  art14_window_expired: "article 14 : adresse relevée depuis plus longtemps que le délai",
  reply_pause: "réponse reçue il y a moins de 90 jours",
  silence_pause: "deux envois sans réponse en 6 mois",
  recipient_cooldown: "destinataire déjà sollicité il y a moins de 30 jours",
  // Plafonds.
  simulated_backlog: "plafond des brouillons simulés en attente atteint",
  cap_reached: "plafond du jour atteint",
  hour_cap: "plafond de l’heure atteint",
  interval: "intervalle entre deux envois",
  shared_domain_cap: "plafond du domaine partagé atteint",
  structure_count_incomplete: "compte par office ou service incomplet",
  structure_unknown: "office ou service inconnu",
  structure_cap: "plafond de l’office ou du service atteint",
  domain_cap: "plafond du cabinet atteint",
  domain_spacing: "même cabinet il y a moins de 15 minutes",
  court_cap: "plafond du tribunal atteint",
  approval_cap: "plafond de validations atteint",
  // Brouillon, aperçu et envoi.
  interrupted: "pilote coupé pendant le passage",
  draft_refused: "brouillon refusé par les garde-fous",
  draft_recipient_mismatch: "brouillon adressé à un autre destinataire",
  template_not_approved: "modèle de message non approuvé pour l’envoi automatique",
  draft_stale: "brouillon caduc (vente changée), annulé",
  draft_rotated:
    "brouillon simulé le plus ancien annulé par le pilote (rotation automatique du jour, plafond atteint)",
  policy_rejected: "rejet de politique à l’aperçu",
  content_rejected: "rejet de contenu à l’aperçu",
  send_refused: "refusé au dernier contrôle avant l’envoi",
  rate_limited: "limite de débit du fournisseur",
  send_error: "erreur du fournisseur d’envoi",
  // Erreurs du passage.
  run_errors: "passage en erreur",
  partial_after_send: "passage interrompu après un envoi",
  draft_error: "erreur à la préparation du brouillon",
  cancel_failed: "annulation d’un brouillon impossible",
  preview_error: "aperçu impossible (panne passagère)",
  mark_failed: "brouillon simulé non marqué",
  stale_check_failed: "relecture d’un brouillon simulé impossible",
};

/** Lecture d'une table sans remonter au prototype (`constructor`, `toString`…). */
function own(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Libellé français d'un code du pilote (passage ou arrêt automatique) ; null s'il n'est pas répertorié. */
export function autopilotCodeLabel(code: string): string | null {
  return own(AUTOPILOT_CODE_LABELS, code) ?? own(AUTOPILOT_STOP_LABELS, code) ?? null;
}

/** Jamais un code brut à l'écran sans le dire : un code inconnu est signalé comme tel. */
function codeText(code: unknown): string {
  const value = String(code ?? "");
  return autopilotCodeLabel(value) ?? `motif non répertorié (${value})`;
}

/**
 * « libellé (n) » pour chaque compte `<préfixe><code>` d'un passage : son journal (`skip_`, `error_`) ou le résumé
 * rendu après un passage à la demande (préfixe vide).
 */
export function countsByCode(record: Record<string, unknown>, prefix: string): string {
  return Object.entries(record)
    .filter(([key, count]) => key.startsWith(prefix) && typeof count === "number" && count > 0)
    .map(([key, count]) => `${codeText(key.slice(prefix.length))} (${count})`)
    .join(", ");
}

/**
 * Ce qu'il faut faire pour remplir chaque condition du contrôle de préparation, par clé de
 * `evaluateAutopilotReadiness`. `autopilot-view.test.ts` relit ce fichier et échoue sur une clé sans phrase.
 */
const READINESS_ACTIONS: Record<string, string> = {
  outbound_env:
    "Ouvrez l’envoi réel dans la configuration de l’hébergement et coupez le mode d’essai (voir le détail).",
  secrets: "Ajoutez les clés manquantes dans la configuration de l’hébergement (voir le détail).",
  from_domain: "Choisissez une adresse d’expédition sur le domaine de réception (voir le détail).",
  resend_domain: "Faites vérifier le domaine d’envoi chez Resend, pour l’envoi et la réception.",
  roundtrip:
    "Vérifiez la réception d’une vraie réponse, puis cliquez sur « J’ai vérifié l’aller-retour réel » plus bas.",
  privacy_version: "Publiez la politique de confidentialité à jour.",
  live_allowed:
    "Rien à faire ici : ce verrou se lève à la mise en ligne des textes juridiques du lot 3.",
  art14_live: `Ramenez le délai de l’article 14 à ${AUTOPILOT_ART14_LIVE_MAX_DAYS} jours au plus, dans « Conformité » plus bas.`,
  aipd: "Attestez l’AIPD ci-dessous.",
  manual_sends:
    "Continuez les envois à la main depuis l’onglet « À contacter », sans plainte ni rebond.",
  simulation: "Laissez le pilote en simulation jusqu’à la durée demandée, sans anomalie.",
  template_approved:
    "Relisez le modèle de message publié (onglet « Réglages »), puis inscrivez son empreinte dans la configuration de l’hébergement et redéployez (voir le détail).",
  no_blocked_mission: "Traitez les envois bloqués ou à vérifier dans l’onglet « Envois ».",
  acting_admin:
    "Vérifiez que le compte qui a lancé la simulation est toujours administrateur, ou réessayez plus tard.",
};

const MODE_LABELS = {
  off: "Éteint",
  simulation: "Simulation (aucun envoi)",
  live: "Réel",
} as const;

function eventDetail(kind: string, reason: string | null, details: unknown): string {
  const record =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  if (kind === "auto_stop" && reason) return codeText(reason);
  if (reason) return reason;
  if (kind === "run" && record.code === "on_demand_started") return "";
  if (kind === "run") {
    if (record.code) return codeText(record.code);
    const skipped = countsByCode(record, "skip_");
    const errors = countsByCode(record, "error_");
    return [
      `${record.examined ?? 0} examinées, ${record.prepared ?? 0} préparées, ${record.would_send ?? 0} simulées, ${record.sent ?? 0} envoyées`,
      skipped ? `écartées : ${skipped}` : null,
      errors ? `en erreur : ${errors}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (kind === "skip") {
    return record.reason
      ? `${codeText(record.code)} : ${codeText(record.reason)}`
      : codeText(record.code);
  }
  if (kind === "send_error") {
    return record.status === 429 ? codeText("rate_limited") : codeText("send_error");
  }
  return "";
}

/**
 * Règle de l'article 14 et délai appliqué. Une valeur enregistrée avant la contrainte de la base (règle coupée, délai
 * de plus de 30 jours) est montrée avec ce que le pilote applique vraiment, et l'invitation à la rétablir.
 */
function art14Label(settings: Pick<AutopilotSettings, "art14RuleEnabled" | "art14MaxAgeDays">) {
  const rule = settings.art14RuleEnabled
    ? "appliqué à chaque candidat, non désactivable"
    : "désactivé dans les réglages enregistrés (le pilote l’applique quand même) : à rétablir";
  const applied = effectiveArt14MaxAgeDays(settings);
  const delay =
    applied === settings.art14MaxAgeDays
      ? `${applied} jours`
      : `enregistré : ${settings.art14MaxAgeDays} jours, appliqué : ${applied} : à rétablir`;
  return `${rule} · délai d’information : ${delay} (réglable de 1 à ${AUTOPILOT_ART14_MAX_DAYS})`;
}

/**
 * « Dernier passage planifié : … · prochain passage : … » (P12). Un passage lancé à la main n'y compte pas
 * (`loadLastAutopilotRunAt`) : la ligne dit si la tâche planifiée tourne.
 */
function runsLine(settings: AutopilotSettings, now: Date, lastRunAt: string | null): string {
  const next = nextAutopilotRunAt(settings, now);
  // Un arrêt automatique éteint aussi le pilote : il est nommé en premier, c'est lui qu'il faut lever.
  const nextText = next
    ? formatNumericDateTime(next.toISOString())
    : settings.autoStoppedAt
      ? `aucun (${codeText("auto_stopped")})`
      : settings.mode === "off"
        ? `aucun (${codeText("disabled")})`
        : "aucun dans les 14 prochains jours";
  return `Dernier passage planifié : ${lastRunAt ? formatNumericDateTime(lastRunAt) : "aucun"} · prochain passage : ${nextText}`;
}

/**
 * Passage lancé à la main par un administrateur (`details.manual`, posé par l'exécuteur du pilote) : sa trace de
 * début (`on_demand_started`), puis son événement de fin. Null pour tout autre événement.
 */
function onDemandRunLabel(event: { kind: string; details: unknown }): string | null {
  const details =
    event.details && typeof event.details === "object"
      ? (event.details as Record<string, unknown>)
      : {};
  if (event.kind !== "run" || details.manual !== true) return null;
  return details.code === "on_demand_started"
    ? "Passage à la demande lancé"
    : "Passage à la demande";
}

const AUTOPILOT_SHARED_COUNTS_INCOMPLETE_NOTICE =
  "Compte des envois par office ou service incomplet (trop de demandes sur 8 jours) : le pilote n’écrit à aucune adresse en notaires.fr ou gouv.fr tant qu’il l’est. Les autres compteurs restent exacts.";

export function buildAutopilotView({
  settings,
  stats,
  readiness,
  env,
  now,
  events,
  lastRunAt,
  prepared,
}: {
  settings: AutopilotSettings;
  stats: AutopilotStats;
  readiness: AutopilotReadiness;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  events: Array<{ at: string; kind: string; reason: string | null; details: unknown }>;
  /** Date du dernier évènement `run` d'un passage planifié (`loadLastAutopilotRunAt`). */
  lastRunAt: string | null;
  /** Brouillons simulés en attente : leur nombre total et les plus récents. */
  prepared: { total: number; items: AutopilotPreparedDraft[] };
}): AutopilotView {
  const caps = autopilotCaps(stats, settings, env, now);
  let notice: AutopilotView["notice"] = null;
  if (settings.autoStoppedAt) {
    notice = {
      tone: "alert",
      text: `Arrêt automatique le ${formatNumericDateTime(settings.autoStoppedAt)} : ${codeText(settings.autoStopReason)}. La réactivation est manuelle et journalisée.`,
    };
  } else if (settings.pausedUntil && Date.parse(settings.pausedUntil) > now.getTime()) {
    notice = {
      tone: "warn",
      text: `En pause jusqu’au ${formatNumericDateTime(settings.pausedUntil)}.`,
    };
  } else if (!stats.sharedStructureCountsComplete) {
    notice = { tone: "warn", text: AUTOPILOT_SHARED_COUNTS_INCOMPLETE_NOTICE };
  }
  return {
    mode: settings.mode,
    modeLabel: MODE_LABELS[settings.mode],
    runs: runsLine(settings, now, lastRunAt),
    autoStopped: Boolean(settings.autoStoppedAt),
    notice,
    sentToday: `${stats.sentTodayTotal} sur ${caps.dayCap}`,
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
      {
        label: "dont jours effectifs (sans passage en erreur)",
        value: String(stats.cleanSimulationDays),
      },
    ],
    settings: {
      actingAdminId: settings.actingAdminId,
      capTotalOverride: settings.capTotalOverride,
      allowLicitorDecoded: settings.allowLicitorDecoded,
      art14RuleEnabled: settings.art14RuleEnabled,
      art14MaxAgeDays: settings.art14MaxAgeDays,
      art14Label: art14Label(settings),
      aipdLabel: settings.aipdAttestedAt
        ? `Attestée le ${formatNumericDateTime(settings.aipdAttestedAt)} (version ${settings.aipdVersion})`
        : "Non attestée",
    },
    readiness: {
      ready: readiness.ready,
      checks: readiness.checks.map(({ key, label, ok, detail }) => ({
        label,
        ok,
        detail,
        // Clé sans phrase : aucune action, le détail s'affiche déjà (le test des clés l'interdit en pratique).
        action: ok ? null : (own(READINESS_ACTIONS, key) ?? null),
      })),
    },
    ready: {
      count: prepared.total,
      label: `Prêtes à valider (${prepared.total} sur ${AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS} au plus)`,
      notice:
        prepared.total >= AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS
          ? "Plafond atteint : une fois par jour au plus, tant qu’aucun passage planifié n’a fait d’envoi simulé ce jour-là, la simulation annule son brouillon en attente le plus ancien pour en préparer un nouveau. Envoyez ceux que vous retenez avant qu’ils ne soient annulés."
          : null,
      items: prepared.items,
    },
    events: events.map((event) => ({
      at: formatNumericDateTime(event.at),
      label: onDemandRunLabel(event) ?? EVENT_LABELS[event.kind] ?? event.kind,
      detail: eventDetail(event.kind, event.reason, event.details),
    })),
  };
}
