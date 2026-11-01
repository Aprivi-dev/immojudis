import {
  SAMPLE_APP_URL,
  SAMPLE_FROM,
  SAMPLE_RECIPIENT,
  SAMPLE_UNIX_SECONDS,
  variantFromMessage,
} from "../samples";
import type { EmailTemplateDefinition } from "../types";

/**
 * Emails liés au contrat : avis de facturation (Stripe) et confirmation de commande.
 * Expéditeur : `TRANSACTIONAL_EMAIL_FROM`, à défaut `ALERT_EMAIL_FROM`.
 */

const common = { from: SAMPLE_FROM, to: SAMPLE_RECIPIENT, appUrl: SAMPLE_APP_URL } as const;

const paymentFailed: EmailTemplateDefinition = {
  key: "payment_failed",
  label: "Paiement échoué",
  description:
    "Le renouvellement de l’abonnement Analyse a échoué ; l’accès reste ouvert un délai.",
  category: "billing",
  sender: "TRANSACTIONAL_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildPaymentFailedMessage } = await import("@/lib/billing-notices");
    return [
      variantFromMessage(
        "with-date",
        "Prochain prélèvement annoncé",
        buildPaymentFailedMessage({ ...common, nextAttemptAt: SAMPLE_UNIX_SECONDS }),
      ),
      variantFromMessage("without-date", "Sans date de relance", buildPaymentFailedMessage(common)),
    ];
  },
};

const trialEnding: EmailTemplateDefinition = {
  key: "trial_ending",
  label: "Fin de l’essai de l’abonnement",
  description: "L’essai gratuit de l’abonnement Analyse va devenir payant.",
  category: "billing",
  sender: "TRANSACTIONAL_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildTrialEndingMessage } = await import("@/lib/billing-notices");
    return [
      variantFromMessage(
        "trial-ending",
        "Essai bientôt terminé",
        buildTrialEndingMessage({ ...common, trialEnd: SAMPLE_UNIX_SECONDS }),
      ),
    ];
  },
};

const cancellation: EmailTemplateDefinition = {
  key: "cancellation",
  label: "Confirmation de résiliation",
  description: "La résiliation est programmée à la fin de la période, ou immédiate.",
  category: "billing",
  sender: "TRANSACTIONAL_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildCancellationConfirmationMessage } = await import("@/lib/billing-notices");
    return [
      variantFromMessage(
        "scheduled-trial",
        "Programmée, pendant l’essai",
        buildCancellationConfirmationMessage({
          ...common,
          kind: "scheduled",
          accessEndsAt: SAMPLE_UNIX_SECONDS,
          trialing: true,
        }),
      ),
      variantFromMessage(
        "immediate",
        "Immédiate",
        buildCancellationConfirmationMessage({
          ...common,
          kind: "immediate",
          accessEndsAt: SAMPLE_UNIX_SECONDS,
        }),
      ),
    ];
  },
};

const commercialConfirmation: EmailTemplateDefinition = {
  key: "commercial_confirmation",
  label: "Confirmation de commande",
  description:
    "Après le paiement : offre, références, conditions acceptées, droit de rétractation.",
  category: "acceptance",
  sender: "TRANSACTIONAL_EMAIL_FROM",
  level: "readonly",
  // Le HTML se construit à l'intérieur de `sendCommercialConfirmation`, entre la lecture de la base et
  // l'envoi : l'appeler ici exigerait la base et enverrait un email. L'extraction d'un constructeur
  // pur fait partie du lot 5 (refactor des émetteurs).
  sampleUnavailable:
    "Le gabarit est construit à l’intérieur de l’envoi (lecture de la base puis Resend) : aucun aperçu sans modifier cet envoi, prévu au lot 5.",
};

export const BILLING_EMAIL_TEMPLATES: readonly EmailTemplateDefinition[] = [
  paymentFailed,
  trialEnding,
  cancellation,
  commercialConfirmation,
];
