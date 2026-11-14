import { sourceDisplayName } from "@/lib/source-names";

/**
 * Libellés des alertes d'exploitation (`public.operational_alerts`) : seule table de l'administration,
 * partagée par l'accueil, Opérations > Alertes, la supervision des sources et le diagnostic des services.
 * Aucune clé technique n'arrive à l'écran : une clé absente de la table reçoit un libellé de repli lisible.
 *
 * Les clés viennent des migrations de `supabase/` : `app_private.sync_operational_alert` (santé
 * d'exploitation, observateur du pipeline, Agent IA, catalogue) et les fonctions `sync_*_alert(s)`. Une
 * nouvelle clé s'ajoute ici avec la migration qui la crée. Le libellé dit ce qui ne va pas ; les seuils
 * restent dans la base (aucun n'est recopié ici). Module pur, sans import serveur.
 */

type AlertPlace = { href: string; label: string };

/** Endroit où agir sur l'alerte. */
const PLACES = {
  operations: { href: "/admin/operations", label: "Opérations" },
  agentReplies: { href: "/admin/agent-ia?onglet=reponses", label: "Agent IA › Réponses" },
  agentSends: { href: "/admin/agent-ia?onglet=envois", label: "Agent IA › Envois" },
  agentPilot: { href: "/admin/agent-ia?onglet=pilote", label: "Agent IA › Pilote" },
  quality: { href: "/admin/quality", label: "Qualité des données" },
  pepites: { href: "/admin/quality?onglet=pepites", label: "Qualité des données › Pépites" },
  clients: { href: "/admin/comptes?onglet=clients", label: "Comptes › Clients" },
  settings: { href: "/admin/settings", label: "Configuration" },
} satisfies Record<string, AlertPlace>;

type PlaceId = keyof typeof PLACES;
type AlertEntry = readonly [label: string, place: PlaceId];

const ALERT_LABELS: Record<string, AlertEntry> = {
  "pipeline.enrichment.stalled": ["Enrichissement des fiches à l’arrêt", "operations"],
  "pipeline.enrichment.exhausted": [
    "Fiches abandonnées après toutes les tentatives d’enrichissement",
    "operations",
  ],
  "pipeline.import.unhealthy": ["Collectes en échec ou bloquées", "operations"],
  "pipeline.inventory.stale": ["Aucun inventaire complet récent des sources", "operations"],
  "pipeline.scheduler.disabled": ["Planification automatique des collectes coupée", "settings"],
  "pipeline.documents_backlog.low_yield": ["Lecture des pièces jointes trop lente", "operations"],
  "refresh_queue.stale": ["Demandes d’actualisation des fiches en attente", "operations"],
  "catalogue.invalidation.backlog": ["Mises à jour du catalogue en attente", "operations"],
  "catalogue.duplicates.cross_source": ["Doublons entre sources dans le catalogue", "quality"],
  "valuation.queue.degraded": ["File des estimations en difficulté", "quality"],
  "pepites.evaluation.stale": ["Évaluation des pépites en retard", "pepites"],
  "information_agent.unrouted.pending": [
    "Messages reçus sans dossier, en attente de traitement",
    "agentReplies",
  ],
  "information_agent.inbound.stuck": ["Réponses reçues bloquées avant traitement", "agentReplies"],
  "information_agent.mission.stuck": ["Prises de contact bloquées à l’envoi", "agentSends"],
  "information_agent.send.unverified": ["Envois de l’Agent IA au résultat inconnu", "agentSends"],
  "information_agent.delivery.bounce_rate": [
    "Trop d’adresses rejetées sur les envois de l’Agent IA",
    "agentSends",
  ],
  "information_agent.delivery.complaint": [
    "Plainte d’un destinataire de l’Agent IA (message signalé comme indésirable)",
    "agentSends",
  ],
  "information_agent.cron.blocked": ["Tâches planifiées de l’Agent IA bloquées", "agentPilot"],
  "information_agent.autopilot.auto_stop": [
    "Pilote de l’Agent IA arrêté automatiquement",
    "agentPilot",
  ],
  "billing.reconciliation.mismatch": ["Écart entre Stripe et les abonnements", "clients"],
  "stripe.webhook.unhealthy": ["Notifications de paiement Stripe en échec", "clients"],
  "cron.stale": ["Tâches planifiées en retard", "settings"],
  "alerts.delivery.late": ["Alertes e-mail des comptes envoyées en retard", "settings"],
  "retention.sale.overdue": ["Ventes à purger au-delà de leur durée de conservation", "settings"],
  "dvf.freshness": ["Données de ventes de référence (DVF) à actualiser", "settings"],
  "auction_scenarios.snapshot.stale": ["Scénarios d’enchères non recalculés", "settings"],
  "flood_risk.observation.degraded": ["Lecture du risque d’inondation dégradée", "settings"],
  "flood_risk.write_blocked": ["Enregistrement du risque d’inondation bloqué", "settings"],
};

/** `pipeline.source.<source>.<contrôle>` : une alerte par source supervisée. */
const SOURCE_CHECK_LABELS: Record<string, string> = {
  missed: "inventaire complet en retard",
  drop: "nombre d’annonces en forte baisse",
  publication: "échecs de publication",
  publication_stale: "publication complète en retard",
  stale_listings: "fiches non revérifiées à temps",
};

/** Familles dont la clé porte un nom variable (source, contrôle, code d'avertissement). */
const FAMILIES: Array<{ prefix: string; describe: (rest: string) => AlertEntry }> = [
  {
    prefix: "pipeline.source.",
    describe: (rest) => {
      const cut = rest.lastIndexOf(".");
      const source = cut > 0 ? rest.slice(0, cut) : rest;
      const check = cut > 0 ? own(SOURCE_CHECK_LABELS, rest.slice(cut + 1)) : undefined;
      return [`Source ${sourceName(source)} : ${check ?? "anomalie de collecte"}`, "operations"];
    },
  },
  {
    prefix: "catalogue.source_absence.",
    describe: (source) => [
      `Source ${sourceName(source)} : trop de ventes absentes d’un coup, retrait bloqué`,
      "operations",
    ],
  },
  { prefix: "catalogue.quality.", describe: () => ["Contrôle qualité du catalogue", "quality"] },
  {
    prefix: "fact_registry.",
    describe: () => ["Registre des pièces : contrôle de cohérence", "agentReplies"],
  },
  {
    prefix: "information_agent.autopilot.warning.",
    describe: () => ["Pilote de l’Agent IA proche d’un seuil d’arrêt", "agentPilot"],
  },
];

/**
 * Repli d'une clé absente des tables ci-dessus, d'après son premier segment. Les alertes `reference.*`
 * (référentiels externes) passent toujours par ici : le contrôle de sécurité interdit de nommer leurs
 * tables privées hors de leur module de lecture.
 */
const FALLBACKS: Record<string, AlertEntry> = {
  pipeline: ["Alerte de collecte non répertoriée", "operations"],
  catalogue: ["Alerte du catalogue non répertoriée", "quality"],
  information_agent: ["Alerte de l’Agent IA non répertoriée", "agentPilot"],
  reference: ["Référentiel externe (loyers, zonage) à actualiser", "settings"],
};
const DEFAULT_FALLBACK: AlertEntry = ["Alerte d’exploitation non répertoriée", "settings"];

/** Nom lisible de la source ; une source absente de la table garde son nom de supervision. */
function sourceName(source: string): string {
  return sourceDisplayName(source) ?? source;
}

/** Lecture d'une table sans remonter au prototype (`constructor`, `toString`…). */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export type OperationalAlertDescription = { label: string; place: AlertPlace };

/** Libellé français d'une alerte et lien vers l'endroit où agir. Jamais la clé brute. */
export function describeOperationalAlert(key: string): OperationalAlertDescription {
  const family = FAMILIES.find((item) => key.startsWith(item.prefix));
  const [label, place] =
    own(ALERT_LABELS, key) ??
    family?.describe(key.slice(family.prefix.length)) ??
    own(FALLBACKS, key.split(".")[0]) ??
    DEFAULT_FALLBACK;
  return { label, place: PLACES[place] };
}

const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critique",
  warning: "Avertissement",
};

export function operationalAlertSeverityLabel(severity: string): string {
  return own(SEVERITY_LABELS, severity) ?? "Gravité inconnue";
}

/** État de la notification envoyée à l'équipe (`notification_status`). */
const NOTIFICATION_LABELS: Record<string, string> = {
  pending: "En attente",
  processing: "En cours d’envoi",
  delivered: "Envoyée",
  failed: "En échec",
};

export function operationalAlertNotificationLabel(status: string): string {
  return own(NOTIFICATION_LABELS, status) ?? "État inconnu";
}
