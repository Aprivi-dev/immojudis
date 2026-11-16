import { SAMPLE_APP_URL, SAMPLE_FROM, SAMPLE_RECIPIENT, variantFromMessage } from "../samples";
import type { EmailTemplateDefinition } from "../types";

/**
 * Suivi des demandes de droits (RGPD, rétractation) : l'exploitation est prévenue du dépôt, le demandeur
 * reçoit un accusé de réception puis un email de clôture. Figés : les textes d'effacement citent la
 * politique de confidentialité publiée.
 */

const facts = {
  requestType: "erasure",
  submittedAt: "2026-11-15T09:00:00Z",
  dueAt: "2026-12-15T09:00:00Z",
  subjectKind: "account",
} as const;

const operator: EmailTemplateDefinition = {
  key: "privacy_request_operator",
  label: "Nouvelle demande de droits (exploitation)",
  description:
    "Envoyé au propriétaire au dépôt d’une demande : nature, dates, lien vers Conformité (ni l’adresse ni le message du demandeur).",
  category: "operations",
  sender: "ALERT_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildPrivacyRequestOperatorMessage } = await import("@/lib/privacy-request-emails");
    return [
      variantFromMessage(
        "operator",
        "Demande d’effacement déposée",
        buildPrivacyRequestOperatorMessage(facts, {
          from: SAMPLE_FROM,
          to: "proprietaire@exemple.fr",
          appUrl: SAMPLE_APP_URL,
        }),
      ),
    ];
  },
};

const acknowledgement: EmailTemplateDefinition = {
  key: "privacy_request_acknowledgement",
  label: "Accusé de réception d’une demande de droits",
  description: "Envoyé au demandeur au dépôt : nature, date, échéance et suivi.",
  category: "privacy",
  sender: "TRANSACTIONAL_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildPrivacyRequestAcknowledgementMessage } =
      await import("@/lib/privacy-request-emails");
    const envelope = { from: SAMPLE_FROM, to: SAMPLE_RECIPIENT, appUrl: SAMPLE_APP_URL };
    return [
      variantFromMessage(
        "account",
        "Titulaire d’un compte",
        buildPrivacyRequestAcknowledgementMessage(facts, envelope),
      ),
      variantFromMessage(
        "withdrawal",
        "Rétractation (14 jours)",
        buildPrivacyRequestAcknowledgementMessage(
          { ...facts, requestType: "contract_withdrawal", dueAt: "2026-11-29T09:00:00Z" },
          envelope,
        ),
      ),
      variantFromMessage(
        "professional",
        "Professionnel sans compte",
        buildPrivacyRequestAcknowledgementMessage(
          { ...facts, subjectKind: "information_agent_professional" },
          envelope,
        ),
      ),
    ];
  },
};

const closure: EmailTemplateDefinition = {
  key: "privacy_request_closure",
  label: "Clôture d’une demande de droits",
  description:
    "Envoyé au demandeur quand la demande est traitée ou refusée ; pour un effacement, ce qui a été effacé et ce qui est conservé.",
  category: "privacy",
  sender: "TRANSACTIONAL_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildPrivacyRequestClosureMessage } = await import("@/lib/privacy-request-emails");
    const envelope = { from: SAMPLE_FROM, to: SAMPLE_RECIPIENT, appUrl: SAMPLE_APP_URL };
    const closedAt = "2026-11-20T09:00:00Z";
    return [
      variantFromMessage(
        "erasure",
        "Effacement du compte exécuté",
        buildPrivacyRequestClosureMessage(
          facts,
          { status: "completed", closedAt, erasureExecuted: true, response: null },
          envelope,
        ),
      ),
      variantFromMessage(
        "rejected",
        "Demande refusée, avec motifs",
        buildPrivacyRequestClosureMessage(
          { ...facts, requestType: "rectification" },
          {
            status: "rejected",
            closedAt,
            erasureExecuted: false,
            response: "L’information signalée figure telle quelle dans l’annonce publiée.",
          },
          envelope,
        ),
      ),
    ];
  },
};

export const PRIVACY_EMAIL_TEMPLATES: readonly EmailTemplateDefinition[] = [
  operator,
  acknowledgement,
  closure,
];
