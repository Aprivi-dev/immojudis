import type { EmailTemplateSummary } from "@/lib/email-templates/registry";
import { formatDateTime } from "@/lib/format/dates";
import type { EmailAddressesReport, WebhookStatus } from "./addresses";
import type { DnsLookup } from "./dns";
import type { ResendFailure } from "./resend";

/**
 * Textes et mise en forme des onglets « Adresses » et « Modèles », composés ici : le navigateur reçoit
 * des libellés prêts à afficher et un seul composant d'affichage (budget de JavaScript de la route
 * `/admin/emails`, voir `scripts/check-build-budgets.mjs`). Rien de ce qui est renvoyé ne contient un
 * secret : les rapports d'origine sont déjà filtrés (`env.ts`, `resend.ts`).
 */

export type EmailViewTone = "ok" | "bad" | "warn" | "neutral";
export type EmailViewBadge = { text: string; tone: EmailViewTone };
/** `bad` : ligne en rouge (valeur manquante, enregistrement non vérifié). */
type EmailViewLine = { text: string; mono?: boolean; bad?: boolean };
type EmailViewItem = {
  title: string;
  /** Nom technique (variable d'environnement, clé de gabarit), en police à chasse fixe. */
  code?: string;
  badges: EmailViewBadge[];
  lines: EmailViewLine[];
};
export type EmailViewSection = {
  title: string;
  description?: string;
  notice?: { text: string; tone: EmailViewTone };
  items: EmailViewItem[];
};
export type EmailListView = {
  /** Phrase sous la barre d'outils (date de vérification, périmètre). */
  footnote?: string;
  /** Points à corriger, en tête de page. */
  alerts: string[];
  sections: EmailViewSection[];
};

const FAILURES: Record<ResendFailure, string> = {
  not_configured: "RESEND_API_KEY n’est pas renseignée : Resend n’a pas été interrogé.",
  missing_permission:
    "La clé Resend n’a pas le droit de lire ces informations (clé limitée à l’envoi).",
  invalid_key: "Resend refuse la clé API.",
  rate_limited: "Resend limite le débit : réessayez dans un instant.",
  unavailable: "Resend est indisponible : réessayez dans un instant.",
};

const WEBHOOK_STATES: Record<WebhookStatus["state"], string> = {
  ok: "Actif",
  missing: "Absent chez Resend",
  disabled: "Désactivé",
  events_missing: "Évènements manquants",
  unknown: "Inconnu",
};

const DNS_STATES = {
  present: "présent",
  absent: "absent",
  error: "vérification impossible",
} as const;

const dnsTone = (lookup: DnsLookup<unknown> | undefined): EmailViewTone =>
  lookup?.status === "present" ? "ok" : lookup?.status === "absent" ? "bad" : "warn";

export function buildAddressesView(report: EmailAddressesReport): EmailListView {
  const addresses: EmailViewSection = {
    title: "Expéditeurs et adresses",
    description:
      "Valeur effective, après les replis du code. Elles se changent dans l’environnement de déploiement.",
    items: report.addresses.map((row) => ({
      title: row.label,
      code: row.variable,
      badges: [
        ...(row.origin === "fallback"
          ? [{ text: `Repli : ${row.fallbackFrom}`, tone: "warn" as const }]
          : []),
        ...(row.origin === "missing" ? [{ text: "Non configuré", tone: "bad" as const }] : []),
      ],
      lines: [
        row.value ? { text: row.value, mono: true } : { text: row.consequence ?? "", bad: true },
        ...(row.usedBy.length > 0 ? [{ text: `Utilisé par : ${row.usedBy.join(", ")}` }] : []),
      ],
    })),
  };

  const secrets: EmailViewSection = {
    title: "Secrets",
    description: "Seul l’état renseigné ou absent est affiché, jamais la valeur.",
    items: report.secrets.map((secret) => ({
      title: secret.purpose,
      code: secret.name,
      badges: [
        secret.configured ? { text: "Renseigné", tone: "ok" } : { text: "Absent", tone: "bad" },
      ],
      lines: [],
    })),
  };

  const domains: EmailViewSection = {
    title: "Domaines chez Resend",
    items: [],
  };
  if (!report.resend.ok) {
    domains.notice = { text: FAILURES[report.resend.failure], tone: "bad" };
  } else {
    if (report.resend.domains.length === 0) {
      domains.notice = { text: "Aucun domaine déclaré chez Resend.", tone: "warn" };
    }
    domains.items = report.resend.domains.map((domain) => ({
      title: domain.name,
      badges: [
        { text: domain.status, tone: domain.status === "verified" ? "ok" : "bad" },
        ...(domain.sending ? [{ text: "Envoi", tone: "neutral" as const }] : []),
        ...(domain.receiving ? [{ text: "Réception", tone: "neutral" as const }] : []),
      ],
      lines: domain.records.map((record) => ({
        text: `${record.kind} (${record.type}) : ${record.status}`,
        bad: record.status !== "verified",
      })),
    }));
  }

  const dns: EmailViewSection = {
    title: "Vérification publique des DNS",
    description: "Ce que voit le reste d’Internet, sans passer par Resend.",
    items: report.dns.map((check) => ({
      title: check.domain,
      badges: [
        { text: `DMARC : ${DNS_STATES[check.dmarc.status]}`, tone: dnsTone(check.dmarc) },
        { text: `SPF : ${DNS_STATES[check.spf.status]}`, tone: dnsTone(check.spf) },
        ...(check.mx
          ? [{ text: `MX (réception) : ${DNS_STATES[check.mx.status]}`, tone: dnsTone(check.mx) }]
          : []),
      ],
      lines: [
        ...(check.dmarc.status === "present"
          ? [
              { text: check.dmarc.value, mono: true },
              ...(check.dmarc.inheritedFrom
                ? [{ text: `Politique héritée de ${check.dmarc.inheritedFrom}.` }]
                : []),
            ]
          : []),
        ...(check.dmarc.status === "absent"
          ? [
              { text: "Valeur recommandée pour DMARC :", bad: true },
              { text: report.dmarcRecommended, mono: true },
            ]
          : []),
        ...(check.mx?.status === "present"
          ? [{ text: check.mx.value.join(", "), mono: true }]
          : []),
      ],
    })),
  };

  const webhooks: EmailViewSection = {
    title: "Webhooks",
    description: "Routes du site que Resend doit appeler, et évènements attendus.",
    items: [],
  };
  if (!report.webhooks.ok) {
    webhooks.notice = { text: FAILURES[report.webhooks.failure], tone: "bad" };
  } else {
    webhooks.items = report.webhooks.items.map((hook) => ({
      title: hook.label,
      badges: [
        { text: WEBHOOK_STATES[hook.state], tone: hook.state === "ok" ? "ok" : "bad" },
        hook.secretConfigured
          ? { text: "Secret de signature renseigné", tone: "ok" }
          : { text: "Secret de signature absent", tone: "bad" },
      ],
      lines: [
        { text: hook.path, mono: true },
        ...(hook.missingEvents.length > 0
          ? [{ text: `Manquant : ${hook.missingEvents.join(", ")}`, bad: true }]
          : []),
      ],
    }));
  }

  return {
    footnote: `Vérifié le ${formatDateTime(report.checkedAt)} (résultat gardé 60 s). La boîte de contact (Google Workspace) n’utilise pas Resend : elle n’apparaît pas ici.`,
    alerts: report.alerts.map((alert) => alert.message),
    sections: [addresses, secrets, domains, dns, webhooks],
  };
}

export const EMAIL_LEVEL_LABELS = {
  editable: "Textes éditables (bientôt)",
  readonly: "Lecture seule",
  supabase: "Supabase",
} as const;

export function buildTemplatesView(templates: readonly EmailTemplateSummary[]): EmailListView {
  return {
    alerts: [],
    sections: [
      {
        title: "Modèles d’emails",
        description:
          "Lecture seule pour l’instant : la modification des textes arrivera dans une prochaine étape.",
        items: templates.map((template) => ({
          title: template.label,
          code: `${template.key} · ${template.sender ?? "expéditeur hors environnement"}`,
          badges: [
            {
              text: EMAIL_LEVEL_LABELS[template.level],
              tone: template.level === "editable" ? "warn" : "neutral",
            },
            { text: `Catégorie : ${template.category ?? "aucune"}`, tone: "neutral" },
          ],
          lines: [{ text: template.description }],
        })),
      },
    ],
  };
}
