import {
  SAMPLE_APP_URL,
  SAMPLE_FROM,
  SAMPLE_RECIPIENT,
  SAMPLE_SALE_A,
  variantFromMessage,
} from "../samples";
import type { EmailTemplateDefinition } from "../types";

/**
 * Emails échangés avec des tiers ou avec l'équipe : mise en relation avec un avocat, incident
 * d'exploitation, message du formulaire de contact. Figés (données de tiers, garde-fous).
 */

const lawyerReferral: EmailTemplateDefinition = {
  key: "lawyer_referral",
  label: "Mise en relation avec un avocat",
  description: "Envoyé à l’avocat référencé quand un compte demande à être mis en relation.",
  category: "lawyer",
  sender: "ALERT_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildLawyerReferralEmailMessage } = await import("@/lib/admin-lawyer-referrals");
    const message = buildLawyerReferralEmailMessage({
      from: SAMPLE_FROM,
      appUrl: SAMPLE_APP_URL,
      recipientEmail: "cabinet@exemple-avocat.fr",
      lawyer: { display_name: "Maître Dupont" },
      request: {
        id: "r1",
        requester_email: SAMPLE_RECIPIENT,
        phone: "06 12 34 56 78",
        preferred_contact_method: "either",
        message: "Bonjour, je souhaite être accompagnée pour l’audience.",
        financing_ready: true,
        max_bid_eur: 150000,
        sale_snapshot: {
          id: SAMPLE_SALE_A,
          title: "Maison à Bordeaux",
          city: "Bordeaux",
          department: "33",
        },
        admin_notes: "Dossier prioritaire",
      } as never,
    });
    return [variantFromMessage("referral", "Demande complète", message)];
  },
};

const operationsIncident: EmailTemplateDefinition = {
  key: "operations_incident",
  label: "Incident d’exploitation",
  description: "Copie par email des alertes d’exploitation, envoyée au propriétaire uniquement.",
  category: "operations",
  sender: "ALERT_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildOperationalAlertEmail } = await import("@/lib/operational-alerts");
    const message = buildOperationalAlertEmail(
      {
        alert_key: "pipeline.stale",
        category: "pipeline",
        severity: "critical",
        event_type: "opened",
        details: { source: "exemple", lagHours: 31 },
        first_seen_at: "2026-11-01T06:00:00Z",
        last_seen_at: "2026-11-01T07:00:00Z",
        resolved_at: null,
        notification_version: 1,
      } as never,
      "production",
      { from: SAMPLE_FROM, to: "proprietaire@exemple.fr" },
    );
    return [variantFromMessage("incident", "Incident ouvert", message)];
  },
};

const repliesReviewDigest: EmailTemplateDefinition = {
  key: "replies_review_digest",
  label: "Résumé quotidien des réponses à relire",
  description:
    "Envoyé au propriétaire : réponses de l’agent à relire et messages non rattachés (sans le corps).",
  category: "operations",
  sender: "ALERT_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildRepliesReviewDigestMessage } = await import("@/lib/replies-review-digest");
    const message = buildRepliesReviewDigestMessage(
      {
        replies: {
          total: 12,
          entries: [
            {
              sender: "Cabinet Exemple <cabinet@exemple-avocat.fr>",
              subject: "Re : Vente du 10 décembre",
            },
            {
              sender: "Greffe civil <greffe@exemple.justice.test>",
              subject: "Re : Demande de pièces",
            },
          ],
        },
        unrouted: {
          total: 1,
          entries: [{ sender: "inconnu@exemple.test", subject: "Question sans référence" }],
        },
      },
      {
        from: SAMPLE_FROM,
        to: "proprietaire@exemple.fr",
        panelUrl: `${SAMPLE_APP_URL}/admin/agent-ia`,
      },
    );
    return [variantFromMessage("digest", "Réponses et messages non rattachés", message)];
  },
};

const contactMessage: EmailTemplateDefinition = {
  key: "contact_message",
  label: "Message du formulaire de contact",
  description: "Reçu par l’équipe quand un visiteur écrit depuis la page Contact (texte seul).",
  category: null,
  sender: "CONTACT_EMAIL_FROM",
  level: "readonly",
  async sample() {
    const { buildContactEmail } = await import("@/lib/contact-message");
    const email = buildContactEmail(
      {
        name: "Marie Durand",
        email: SAMPLE_RECIPIENT,
        subject: "annonce",
        message: "Bonjour, j’ai une question sur l’offre.",
      },
      { to: "contact@immojudis.com", from: SAMPLE_FROM },
    );
    return [
      {
        key: "contact",
        label: "Question sur une annonce",
        subject: email.subject,
        html: null,
        text: email.text,
      },
    ];
  },
};

export const OPERATIONS_EMAIL_TEMPLATES: readonly EmailTemplateDefinition[] = [
  lawyerReferral,
  operationsIncident,
  repliesReviewDigest,
  contactMessage,
];
