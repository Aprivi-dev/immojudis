import "server-only";
import { ConfigurationError, PublicApiError } from "@/lib/api-errors";
import { errorDetailForLog } from "@/lib/error-detail-for-log";
import { assertAdmin } from "@/lib/admin-auth.server";
import { renderInformationRequestEmail } from "../../../emails/information-request";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { assertNoInformationAgentCommercialMention } from "@/lib/information-agent-commercial-guard";
import type { InformationAgentFooterStructure } from "@/lib/information-agent-compliance";
import {
  assertAgentFoundOriginIntact,
  assertInformationAgentSearchedAddressAllowed,
  isAgentFoundRecipient,
} from "@/lib/information-agent/address-search";
import {
  assertInformationAgentSourceAllowed,
  INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
  resolveInformationAgentAddressOrigin,
} from "@/lib/information-agent/address-origin";
import { assertAdminDailyApprovalCap } from "@/lib/information-agent/approval-cap";
import { assertInformationAgentAddressDeliverable } from "@/lib/information-agent/address-deliverability";
import {
  assertInformationAgentCanaryRecipient,
  assertInformationAgentNotarySendAllowed,
  assertInformationAgentOutboundEnabled,
  informationAgentAppOrigin,
  resolveInformationAgentEmailConfig,
} from "@/lib/information-agent/config";
import { informationAgentCaseReference } from "@/lib/information-agent/case-reference";
import { assertInformationAgentContactAllowed } from "@/lib/information-agent/contacts";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import {
  assertCourtRegistryFallbackOriginIntact,
  courtRegistryMissionChecks,
} from "@/lib/information-agent/court-registry-mission";
import {
  assertInformationAgentHasQuestion,
  assertInformationAgentSaleCurrent,
  saleSourceTexts,
} from "@/lib/information-agent/draft-checks";
import {
  buildInformationAgentLegalFooter,
  informationAgentPreviewFingerprint,
} from "@/lib/information-agent/message-guards";
import { assertInformationAgentQuestionsAllowed } from "@/lib/information-agent/recipient-questions";
import { informationAgentAudienceInvitesDocuments } from "@/lib/information-agent/recipient-templates";
import {
  missionRecipient,
  missionSaleReference,
  sentRecipientKind,
} from "@/lib/information-agent/mission-identity";
import { loadOwnedMission } from "@/lib/information-agent/mission-store";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
import {
  assertIssuedAutopilotTrigger,
  type InformationAgentPreviewInput,
  type InformationAgentSendTrigger,
} from "@/lib/information-agent/schemas";

/**
 * Motif d'un contrôle qui n'a pas pu s'exécuter (panne passagère de la base ou d'un service) : rien n'est refusé,
 * l'aperçu est à refaire. Le pilote le compte comme une erreur de son passage, jamais comme un rejet de politique.
 */
export const INFORMATION_AGENT_PREVIEW_CHECK_FAILED_MESSAGE =
  "Contrôle impossible pour le moment : réessayez l’aperçu.";

export type InformationAgentPreviewResponse = {
  ok: true;
  preview: {
    from: string | null;
    to: string;
    replyTo: string;
    subject: string;
    html: string;
    text: string;
  };
  /** Motifs qui empêcheront l'envoi (opposition, délai de 30 jours, configuration…). */
  blockers: string[];
  addressOrigin: {
    text: string;
    url: string | null;
    automated: boolean;
    known: boolean;
    /** Adresse d'un greffe (référentiel des tribunaux) : repère « Greffe » dans l'aperçu. */
    courtRegistry?: boolean;
    /** Pied en variante « structure » (adresse générique sans personne nommée), avec la structure visée. */
    structureAddress?: InformationAgentFooterStructure;
  };
  /** À renvoyer avec « Valider et envoyer » ; null si l'envoi est impossible. */
  fingerprint: string | null;
};

/**
 * Aperçu exact de l'e-mail tel qu'il partira, sans rien enregistrer ni envoyer. Les seuls éléments
 * illustratifs sont le jeton de l'adresse de réponse et le lien privé de dépôt, attribués à l'envoi.
 */
export async function previewAdminInformationAgentMission({
  auth,
  input,
  env = process.env,
  trigger,
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentPreviewInput;
  env?: NodeJS.ProcessEnv;
  /** Interne : le pilote automatique, comme pour l'envoi (`approveAndSendMission`) ; absent pour un administrateur. */
  trigger?: InformationAgentSendTrigger;
}): Promise<InformationAgentPreviewResponse> {
  assertAdmin(auth);
  assertIssuedAutopilotTrigger(trigger);
  const mission = await loadOwnedMission(auth.userId, input.missionId);
  const recipient = normalizedEmail(input.recipientEmail);
  if (!recipient) {
    throw new PublicApiError("Requête invalide : adresse email du destinataire invalide.", 400);
  }
  const blockers: string[] = [];
  // Un refus ou un réglage manquant est écrit pour l'administrateur ; une panne n'est jamais recopiée.
  const collect = async (check: () => unknown) => {
    try {
      await check();
    } catch (error) {
      if (error instanceof PublicApiError || error instanceof ConfigurationError) {
        blockers.push(error.message);
      } else {
        console.error(
          JSON.stringify({ scope: "information_agent.preview", error: errorDetailForLog(error) }),
        );
        blockers.push(INFORMATION_AGENT_PREVIEW_CHECK_FAILED_MESSAGE);
      }
    }
  };

  if (mission.status !== "draft" && mission.status !== "failed") {
    blockers.push("Cette mission n’est plus un brouillon : elle ne peut pas être envoyée.");
  }
  const { fallback: courtFallback, checks: courtChecks } = courtRegistryMissionChecks({
    mission,
    recipientEmail: recipient,
    env,
  });
  for (const check of courtChecks) await collect(check);
  const missionTarget = missionRecipient(mission, input.recipientName, recipient);
  const oppositionKeys = courtFallback ? { identityKeys: [], checkKeys: [] } : missionTarget.keys;
  await collect(() =>
    assertInformationAgentQuestionsAllowed(missionTarget.questionAudience, mission.question_keys),
  );
  await collect(() =>
    assertInformationAgentNotarySendAllowed({ ...missionTarget, email: recipient }, env),
  );
  await collect(() =>
    assertInformationAgentContactAllowed({
      saleId: mission.sale_id,
      email: recipient,
      identityKeys: oppositionKeys.identityKeys,
      checkKeys: oppositionKeys.checkKeys,
      courtRegistryAddress: Boolean(courtFallback),
    }),
  );
  await collect(() =>
    assertNoInformationAgentCommercialMention(`${input.subject}\n${input.bodyText}`, {
      ignore: saleSourceTexts(mission),
    }),
  );
  await collect(() => assertInformationAgentHasQuestion(input.bodyText));
  await collect(() => assertInformationAgentSaleCurrent(mission));
  await collect(() =>
    assertInformationAgentRecipientCooldown({
      email: recipient,
      missionId: mission.id,
      identityKeys: oppositionKeys.identityKeys,
      courtRegistryFallback: Boolean(courtFallback),
    }),
  );
  const agentFound = isAgentFoundRecipient(mission, recipient);
  const addressOrigin = await resolveInformationAgentAddressOrigin({
    email: recipient,
    saleId: mission.sale_id,
    manualOriginUrl: agentFound || courtFallback ? null : (input.recipientOriginUrl ?? null),
    fallbackObservedAt: mission.created_at,
    structureAddress: courtFallback ? null : missionTarget.structureAddress,
  });
  if (!addressOrigin.known) blockers.push(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
  await collect(() => assertAgentFoundOriginIntact(agentFound, addressOrigin));
  await collect(() =>
    assertCourtRegistryFallbackOriginIntact(Boolean(courtFallback), addressOrigin),
  );
  await collect(() => assertInformationAgentSourceAllowed(addressOrigin));
  await collect(() => assertInformationAgentSearchedAddressAllowed(addressOrigin.origin, env));
  await collect(() => assertInformationAgentOutboundEnabled(env));
  await collect(() => assertInformationAgentCanaryRecipient(recipient, env));
  await collect(() => assertInformationAgentAddressDeliverable(recipient));
  // Même règle qu'à l'envoi : le pilote a ses propres plafonds, celui des administrateurs ne s'y applique pas.
  if (!trigger) await collect(() => assertAdminDailyApprovalCap(auth.userId, { env }));
  await collect(() => resolveInformationAgentEmailConfig(env));

  const appUrl = informationAgentAppOrigin(env);
  // Identité du responsable, secret du lien d'opposition et prestataire d'IA : repères et motifs de blocage.
  const legalFooter = buildInformationAgentLegalFooter({
    appUrl,
    email: recipient,
    addressOrigin: addressOrigin.origin,
    saleReference: missionSaleReference(mission),
    structureOpposition: courtFallback ? null : missionTarget.structureOpposition,
    recipientKind: sentRecipientKind(mission, recipient),
    env,
    preview: { blockers },
  });
  // Sans domaine de réception, `resolveInformationAgentEmailConfig` a déjà ajouté le motif de blocage.
  const inboundDomain =
    env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase() ||
    "[domaine de réception à configurer]";
  const replyTo = `enquete+jeton-attribue-a-l-envoi@${inboundDomain}`;
  const rendered = await renderInformationRequestEmail({
    subject: input.subject,
    bodyText: input.bodyText,
    replyTo,
    caseReference: mission.case_id ? informationAgentCaseReference(mission.case_id) : "IJ-APERCU",
    appUrl,
    // Aucun lien de dépôt dans un message à un notaire (aucune invitation à joindre des documents).
    contributionUrl: informationAgentAudienceInvitesDocuments(missionTarget.questionAudience)
      ? new URL("/contribuer/lien-prive-attribue-a-l-envoi", appUrl).toString()
      : undefined,
    legalFooter,
  });
  await collect(() =>
    assertNoInformationAgentCommercialMention(`${rendered.html}\n${rendered.text}`, {
      appOrigin: appUrl,
      allowedUrls: [addressOrigin.origin.url],
      ignore: [legalFooter.saleReference, ...saleSourceTexts(mission)],
    }),
  );
  return {
    ok: true,
    preview: {
      from: env.INFORMATION_AGENT_EMAIL_FROM?.trim() || null,
      to: input.recipientName?.trim() ? `${input.recipientName.trim()} <${recipient}>` : recipient,
      replyTo,
      subject: input.subject,
      html: rendered.html,
      text: rendered.text,
    },
    blockers: [...new Set(blockers)],
    addressOrigin: { ...addressOrigin.origin, known: addressOrigin.known },
    fingerprint: informationAgentPreviewFingerprint({ adminId: auth.userId, ...input }, env),
  };
}
