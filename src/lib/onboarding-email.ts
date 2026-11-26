import "server-only";
import { buildOnboardingEmailHtml } from "../../emails/onboarding";
import type { ResendEmailMessage } from "@/lib/email-alerts";
import { EMAIL_BRAND_NAME } from "@/lib/email-brand";
import { emailNoReplyText } from "@/lib/email-layout";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { departmentFromCode, departmentSearchPath } from "@/lib/department-pages";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";
import { UNLOCK_CALL_TO_ACTION_LABEL, unlockHighlightsInlineText } from "@/lib/sale-unlocks";

/**
 * Email unique de prise en main, le lendemain de l'inscription (décision du propriétaire du 26/11/2026,
 * après avis juridique). Il reste un message de service, et non de la prospection, tant qu'il :
 * - ne parle que de la prise en main du déblocage compris dans le compte gratuit : ce qu'il est, ce
 *   qu'il ouvre, qu'il est unique, quand il est rendu, où le retrouver ;
 * - ne contient AUCUN élément commercial : ni prix, ni offre payante, ni achat, ni lien vers les offres,
 *   ni urgence (`onboarding-email.test.ts` le vérifie) ;
 * - ne met aucune vente en avant : un seul lien, vers le catalogue, filtré sur le département de la
 *   première alerte du compte quand elle en a un ;
 * - dit dans son pied pourquoi la personne le reçoit, avec un lien d'opposition en un clic (portée
 *   `onboarding-email`, aussi en en-tête `List-Unsubscribe`, RFC 8058).
 *
 * Les textes du déblocage sont ceux de l'écran (`sale-unlocks.ts`, carte de déblocage de la fiche) : le
 * message ne peut pas promettre autre chose que lui.
 */

export const ONBOARDING_SUBJECT = `Votre compte ${EMAIL_BRAND_NAME} comprend le déblocage d’une vente`;

/**
 * Quand le déblocage est rendu : la fin de `UNLOCK_CONFIRMATION_TEXT` (carte de déblocage de la fiche,
 * `sale-unlock-panel-texts.ts`), recopiée ici pour ne pas changer le JavaScript de la fiche ;
 * `onboarding-email.test.ts` vérifie que les deux restent identiques.
 */
export const ONBOARDING_UNLOCK_RETURNED_TEXT =
  "Il vous est rendu si la vente est retirée avant d’avoir lieu (conditions générales, article 2).";

/** La raison d'envoi, au pied du message : ce qui en fait un message de service. */
export const ONBOARDING_REASON = `Message unique de prise en main de votre compte ${EMAIL_BRAND_NAME}.`;

export const ONBOARDING_UNSUBSCRIBE_LABEL = "Ne plus recevoir ce message";
export const ONBOARDING_CATALOGUE_LABEL = "Parcourir les ventes";

const INTERNAL_NOTICE = "Test interne : ce message d’exemple n’est envoyé qu’aux administrateurs.";

export function onboardingSubject(internal: boolean): string {
  return `${internal ? "[Test interne] " : ""}${ONBOARDING_SUBJECT}`;
}

/** Le catalogue, filtré sur le département quand le code en désigne un connu ; sinon le catalogue entier. */
function catalogueLink(department: string | null | undefined): { path: string; text: string } {
  const known = departmentFromCode(department);
  if (!known) {
    return {
      path: "/sales",
      text: "Pour trouver la vente qui vous intéresse, parcourez le catalogue :",
    };
  }
  return {
    path: departmentSearchPath(known),
    text: `Pour trouver la vente qui vous intéresse, le catalogue s’ouvre sur le département de votre première alerte, ${known.name} (${known.code}) :`,
  };
}

export function buildOnboardingMessage({
  userId,
  department,
  recipientEmail,
  from,
  appUrl,
  internal = false,
  now = new Date(),
  env,
}: {
  userId: string;
  /** Département de la plus ancienne alerte active du compte (file de la base) ; `null` sans alerte. */
  department: string | null;
  recipientEmail: string;
  from: string;
  appUrl: string;
  /** Mode d'essai (`ONBOARDING_EMAIL_MODE=internal`) : l'objet et l'en-tête le disent. */
  internal?: boolean;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): ResendEmailMessage & { unsubscribeUrl: string } {
  const unsubscribeUrl = `${appUrl}/api/notification-preferences/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken({ userId, scope: { kind: "onboarding-email" }, now, env }),
  )}`;
  const catalogue = catalogueLink(department);
  const catalogueUrl = `${appUrl}${catalogue.path}`;
  const subject = onboardingSubject(internal);
  const heading = "Votre compte comprend le déblocage d’une vente";
  const intro =
    "Votre compte gratuit comprend le déblocage d’une vente. Ce message est le seul que nous vous envoyons à ce sujet.";
  const sections = [
    {
      title: "Ce qu’il ouvre",
      paragraphs: [
        `Il ouvre, pour la vente de votre choix, ${unlockHighlightsInlineText(openFeeRegimesFromEnv(env))}.`,
      ],
    },
    {
      title: "Comment l’utiliser",
      paragraphs: [
        `Votre compte comprend un seul déblocage. Sur la fiche d’une vente, le bouton « ${UNLOCK_CALL_TO_ACTION_LABEL} » l’utilise. ${ONBOARDING_UNLOCK_RETURNED_TEXT}`,
      ],
    },
    {
      title: "Où le retrouver",
      paragraphs: [
        "Votre page « Mon compte » indique si votre déblocage est disponible ou utilisé. La vente débloquée se retrouve ensuite dans « Mes ventes débloquées », depuis le menu « Mon compte ».",
      ],
    },
  ] as const;

  const html = buildOnboardingEmailHtml({
    heading,
    intro,
    sections,
    catalogueText: catalogue.text,
    catalogueLabel: ONBOARDING_CATALOGUE_LABEL,
    catalogueUrl,
    reason: ONBOARDING_REASON,
    unsubscribeLabel: ONBOARDING_UNSUBSCRIBE_LABEL,
    unsubscribeUrl,
    preheader: "Ce qu’il ouvre, comment l’utiliser et où le retrouver.",
    internalNotice: internal ? INTERNAL_NOTICE : null,
    title: subject,
  });

  const text = [
    ...(internal ? [INTERNAL_NOTICE, ""] : []),
    "Bonjour,",
    "",
    intro,
    ...sections.flatMap((section) => ["", section.title, ...section.paragraphs]),
    "",
    catalogue.text,
    `${ONBOARDING_CATALOGUE_LABEL} : ${catalogueUrl}`,
    "",
    ONBOARDING_REASON,
    `${ONBOARDING_UNSUBSCRIBE_LABEL} : ${unsubscribeUrl}`,
    "",
    emailNoReplyText(),
  ].join("\n");

  return {
    from,
    to: recipientEmail,
    // Message automatique : aucune adresse de réponse.
    replyTo: null,
    subject,
    html,
    text,
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}
