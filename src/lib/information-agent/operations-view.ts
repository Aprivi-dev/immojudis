/**
 * Modèle de vue des indicateurs d'exploitation de l'agent : tout est mis en forme côté serveur (texte français,
 * pourcentages, durées), le navigateur n'affiche que des chaînes. Chaque taux est donné AVEC son effectif : « 1
 * sur 12 », jamais « 8 % » seul. Module pur.
 */
export type InformationAgentIndicatorsRaw = {
  since: string;
  sent: number;
  delivered: number;
  delayed: number;
  bounced_permanent: number;
  bounced_temporary: number;
  complained: number;
  failed: number;
  oppositions: number;
  replies: number;
  response_median_seconds: number | null;
  response_mean_seconds: number | null;
  unrouted_pending: number;
};

export type InformationAgentOperationsView = {
  windowLabel: string;
  sent: number;
  rows: Array<{
    key: string;
    label: string;
    value: string;
    tone: "ok" | "warn" | "alert" | "plain";
  }>;
  roundtrip: { verifiedAt: string | null; label: string; stale: boolean };
};

const ROUNDTRIP_MAX_AGE_DAYS = 30;

function percent(part: number, whole: number): string {
  return whole > 0 ? ` (${Math.round((part * 1000) / whole) / 10} %)`.replace(".", ",") : "";
}

function ofSent(count: number, sent: number): string {
  return `${count} sur ${sent}${percent(count, sent)}`;
}

export function formatResponseDelay(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "aucune réponse";
  const hours = seconds / 3600;
  if (hours < 1) return "moins d’une heure";
  if (hours < 48) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest ? `${days} j ${rest} h` : `${days} j`;
}

export function roundtripAgeDays(verifiedAt: string | null, now = new Date()): number | null {
  if (!verifiedAt) return null;
  const time = Date.parse(verifiedAt);
  return Number.isFinite(time) ? Math.floor((now.getTime() - time) / 86_400_000) : null;
}

export function buildInformationAgentOperationsView(
  raw: InformationAgentIndicatorsRaw,
  roundtripVerifiedAt: string | null,
  now = new Date(),
): InformationAgentOperationsView {
  const sent = raw.sent;
  const rows: InformationAgentOperationsView["rows"] = [
    { key: "sent", label: "Envoyés", value: String(sent), tone: "plain" },
  ];
  if (sent === 0) {
    rows.push({
      key: "none",
      label: "Remis, rebonds, plaintes, réponses",
      value: "aucun envoi sur la période",
      tone: "plain",
    });
  } else {
    rows.push(
      { key: "delivered", label: "Remis", value: ofSent(raw.delivered, sent), tone: "ok" },
      {
        key: "delayed",
        label: "Retardés",
        value: ofSent(raw.delayed, sent),
        tone: raw.delayed ? "warn" : "plain",
      },
      {
        key: "bounced_permanent",
        label: "Rebonds définitifs",
        value: ofSent(raw.bounced_permanent, sent),
        tone: raw.bounced_permanent ? "alert" : "plain",
      },
      {
        key: "bounced_temporary",
        label: "Rebonds passagers",
        value: ofSent(raw.bounced_temporary, sent),
        tone: raw.bounced_temporary ? "warn" : "plain",
      },
      {
        key: "complained",
        label: "Plaintes",
        value: ofSent(raw.complained, sent),
        tone: raw.complained ? "alert" : "plain",
      },
      {
        key: "oppositions",
        label: "Oppositions",
        value: ofSent(raw.oppositions, sent),
        tone: raw.oppositions ? "warn" : "plain",
      },
      { key: "replies", label: "Réponses", value: ofSent(raw.replies, sent), tone: "plain" },
      {
        key: "delay",
        label: "Délai de réponse (médiane)",
        value: raw.replies
          ? `${formatResponseDelay(raw.response_median_seconds)} sur ${raw.replies} réponse${raw.replies > 1 ? "s" : ""}`
          : "aucune réponse",
        tone: "plain",
      },
    );
  }
  if (raw.unrouted_pending) {
    rows.push({
      key: "unrouted",
      label: "Messages sans dossier à traiter",
      value: String(raw.unrouted_pending),
      tone: "warn",
    });
  }

  const age = roundtripAgeDays(roundtripVerifiedAt, now);
  const stale = age == null || age >= ROUNDTRIP_MAX_AGE_DAYS;
  return {
    windowLabel: "30 derniers jours",
    sent,
    rows,
    roundtrip: {
      verifiedAt: roundtripVerifiedAt,
      stale,
      label:
        age == null
          ? "Jamais vérifié : envoyez-vous un message de test, répondez-y, puis contrôlez qu’il arrive en revue."
          : age === 0
            ? "Vérifié aujourd’hui."
            : `Vérifié il y a ${age} jour${age > 1 ? "s" : ""}${stale ? " : à refaire." : "."}`,
    },
  };
}
