import "server-only";
import { renderInformationRequestEmail } from "../../../emails/information-request";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  informationAgentAiProvider,
  type InformationAgentAiProvider,
} from "@/lib/information-agent-ai-provider";
import { assertNoInformationAgentCommercialMention } from "@/lib/information-agent-commercial-guard";
import {
  informationAgentControllerIdentity,
  type InformationAgentLegalFooter,
} from "@/lib/information-agent-compliance";
import { buildInformationAgentOptOutUrl } from "@/lib/information-agent-opt-out";
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
  assertInformationAgentOutboundEnabled,
  informationAgentAppOrigin,
  informationAgentCaseReference,
  resolveInformationAgentEmailConfig,
} from "@/lib/information-agent/config";
import {
  assertInformationAgentContactAllowed,
  normalizedEmail,
} from "@/lib/information-agent/contacts";
import { courtRegistryDailyCap } from "@/lib/information-agent/court-registry-fallback";
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
  assertInformationAgentControllerIdentity,
  informationAgentPortalSecret,
  informationAgentPreviewFingerprint,
} from "@/lib/information-agent/message-guards";
import {
  missionIdentityKeys,
  missionStructureKeys,
  missionSaleReference,
} from "@/lib/information-agent/mission-identity";
import {
  loadOwnedMission,
  requireInformationAgentAdmin,
} from "@/lib/information-agent/mission-store";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
import type { InformationAgentPreviewInput } from "@/lib/information-agent/schemas";

// Aperçu exact d'un e-mail avant son envoi. Extrait de `information-agent.ts` sans changement de
// comportement.

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
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentPreviewInput;
  env?: NodeJS.ProcessEnv;
}): Promise<InformationAgentPreviewResponse> {
  requireInformationAgentAdmin(auth);
  const mission = await loadOwnedMission(auth.userId, input.missionId);
  const recipient = normalizedEmail(input.recipientEmail);
  if (!recipient) throw new Error("Requête invalide : adresse email du destinataire invalide.");
  const blockers: string[] = [];
  const collect = async (check: () => unknown) => {
    try {
      await check();
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : "Contrôle impossible.");
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
  const identityName = courtFallback ? null : input.recipientName;
  const identityEmail = courtFallback ? null : recipient;
  await collect(() =>
    assertInformationAgentContactAllowed({
      saleId: mission.sale_id,
      email: recipient,
      identityKeys: missionIdentityKeys(mission, identityName, identityEmail),
      structureKeys: courtFallback ? [] : missionStructureKeys(mission, recipient),
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
      identityKeys: missionIdentityKeys(mission, identityName, identityEmail),
      courtRegistryFallback: Boolean(courtFallback),
    }),
  );
  const agentFound = isAgentFoundRecipient(mission, recipient);
  const addressOrigin = await resolveInformationAgentAddressOrigin({
    email: recipient,
    saleId: mission.sale_id,
    manualOriginUrl: agentFound || courtFallback ? null : (input.recipientOriginUrl ?? null),
    fallbackObservedAt: mission.created_at,
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
  await collect(() => assertAdminDailyApprovalCap(auth.userId, { env }));
  await collect(() => resolveInformationAgentEmailConfig(env));
  await collect(() => assertInformationAgentControllerIdentity(env));

  const appUrl = informationAgentAppOrigin(env);
  const controller = informationAgentControllerIdentity(env);
  const secret = informationAgentPortalSecret(env);
  if (!secret) blockers.push("Secret du lien d'opposition non configuré : envoi impossible.");
  const legalFooter: InformationAgentLegalFooter = {
    controllerName: controller?.name ?? "[Responsable de traitement à configurer]",
    controllerAddress: controller?.address ?? "[Adresse à configurer]",
    contactEmail: controller?.contactEmail ?? "[Contact à configurer]",
    saleReference: missionSaleReference(mission),
    addressOrigin: addressOrigin.origin.text,
    courtRegistryDailyCap: addressOrigin.origin.courtRegistry ? courtRegistryDailyCap(env) : null,
    addressOriginUrl: addressOrigin.origin.url,
    automatedSearch: addressOrigin.origin.automated,
    automatedSearchSource: addressOrigin.origin.searchSource,
    aiProvider: previewAiProvider(env, blockers),
    privacyUrl: new URL("/privacy", appUrl).toString(),
    optOutUrl: secret
      ? buildInformationAgentOptOutUrl({ appUrl, email: recipient, secret })
      : new URL("/api/information-agent/opt-out", appUrl).toString(),
  };
  const inboundDomain =
    env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase() || "reponses.immojudis.com";
  const replyTo = `enquete+jeton-attribue-a-l-envoi@${inboundDomain}`;
  const rendered = await renderInformationRequestEmail({
    subject: input.subject,
    bodyText: input.bodyText,
    replyTo,
    caseReference: mission.case_id ? informationAgentCaseReference(mission.case_id) : "IJ-APERCU",
    appUrl,
    contributionUrl: new URL("/contribuer/lien-prive-attribue-a-l-envoi", appUrl).toString(),
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

/** Prestataire d'IA du pied ; une configuration inconnue devient un motif de blocage de l'aperçu. */
function previewAiProvider(
  env: Readonly<Record<string, string | undefined>>,
  blockers: string[],
): InformationAgentAiProvider {
  try {
    return informationAgentAiProvider(env);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "Prestataire d’IA non identifié.");
    return informationAgentAiProvider({});
  }
}
