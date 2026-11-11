import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION } from "../../../emails/information-request";
import {
  informationAgentControllerIdentity,
  type InformationAgentAddressOrigin,
  type InformationAgentLegalFooter,
} from "@/lib/information-agent-compliance";
import { informationAgentAiProvider } from "@/lib/information-agent-ai-provider";
import { buildInformationAgentOptOutUrl } from "@/lib/information-agent-opt-out";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { courtRegistryDailyCap } from "@/lib/information-agent/court-registry-fallback";

/**
 * Garde-fous du message sortant de l'agent d'information (identité du responsable de traitement, pied
 * art. 14 RGPD, empreinte de l'aperçu), extraits de `information-agent.ts` qui les réexporte.
 */

/** Refuses to send while the data controller identity (art. 14 GDPR) is not configured. */
export function assertInformationAgentControllerIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!informationAgentControllerIdentity(env)) {
    throw new Error(
      "Identité du responsable de traitement non configurée : envoi impossible (NEXT_PUBLIC_LEGAL_ENTITY_NAME, NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS et NEXT_PUBLIC_LEGAL_CONTACT_EMAIL).",
    );
  }
}

export function informationAgentPortalSecret(env: Readonly<Record<string, string | undefined>>) {
  const secret = env.INFORMATION_AGENT_PORTAL_SECRET?.trim();
  return secret && Buffer.byteLength(secret, "utf8") >= 32 ? secret : null;
}

export function buildInformationAgentLegalFooter({
  appUrl,
  email,
  addressOrigin,
  saleReference = null,
  structureOpposition = false,
  env = process.env,
}: {
  appUrl: string;
  email: string;
  addressOrigin: InformationAgentAddressOrigin;
  /** L'opposition de cette adresse vaudra pour toute sa structure (`missionRecipient().structureOpposition`). */
  structureOpposition?: boolean;
  saleReference?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
}): InformationAgentLegalFooter {
  const controller = informationAgentControllerIdentity(env);
  if (!controller) assertInformationAgentControllerIdentity(env);
  const secret = informationAgentPortalSecret(env);
  if (!secret) throw new Error("Secret du lien d'opposition non configuré : envoi impossible.");
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");
  return {
    controllerName: controller!.name,
    controllerAddress: controller!.address,
    contactEmail: controller!.contactEmail,
    saleReference,
    addressOrigin: addressOrigin.text,
    // Message à un greffe : variante « greffe » du pied, avec le plafond réellement appliqué (configuration).
    courtRegistryDailyCap: addressOrigin.courtRegistry ? courtRegistryDailyCap(env) : null,
    addressOriginUrl: addressOrigin.url,
    automatedSearch: addressOrigin.automated,
    automatedSearchSource: addressOrigin.searchSource,
    structureAddress: Boolean(addressOrigin.structureAddress),
    structureOpposition: structureOpposition && !addressOrigin.courtRegistry,
    // Lève une erreur si la configuration désigne un prestataire d'IA non nommé dans le pied.
    aiProvider: informationAgentAiProvider(env),
    privacyUrl: new URL("/privacy", appUrl).toString(),
    optOutUrl: buildInformationAgentOptOutUrl({ appUrl, email: normalized, secret }),
  };
}

const PREVIEW_FINGERPRINT_CONTEXT = "immojudis:information-agent:preview:v1";

/**
 * Empreinte HMAC du contenu exact affiché dans l'aperçu (destinataire, objet, texte, origine,
 * version du gabarit) et de l'administrateur qui l'a vu. Seul le serveur peut la produire : un
 * envoi sans aperçu préalable, ou après une modification non prévisualisée, est refusé.
 */
export function informationAgentPreviewFingerprint(
  {
    adminId,
    missionId,
    recipientEmail,
    recipientName,
    subject,
    bodyText,
    recipientOriginUrl,
  }: {
    adminId: string;
    missionId: string;
    recipientEmail: string;
    recipientName?: string | null;
    subject: string;
    bodyText: string;
    recipientOriginUrl?: string | null;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const secret = informationAgentPortalSecret(env);
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(
      `${PREVIEW_FINGERPRINT_CONTEXT}:${JSON.stringify({
        adminId,
        missionId,
        recipientEmail: normalizedEmail(recipientEmail) ?? recipientEmail.trim().toLowerCase(),
        recipientName: recipientName?.trim() || null,
        subject: subject.trim(),
        bodyText: bodyText.trim(),
        recipientOriginUrl: recipientOriginUrl?.trim() || null,
        emailTemplateVersion: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
      })}`,
    )
    .digest("hex");
}

export function assertInformationAgentPreviewFingerprint({
  adminId,
  input,
}: {
  adminId: string;
  input: {
    missionId: string;
    recipientEmail: string;
    recipientName?: string | null;
    subject: string;
    bodyText: string;
    recipientOriginUrl?: string | null;
    previewFingerprint?: string;
  };
}): void {
  const expected = informationAgentPreviewFingerprint({ adminId, ...input });
  if (!expected) {
    throw new Error("Secret du lien d'opposition non configuré : envoi impossible.");
  }
  const received = Buffer.from(input.previewFingerprint ?? "", "hex");
  const reference = Buffer.from(expected, "hex");
  if (received.length !== reference.length || !timingSafeEqual(received, reference)) {
    throw new Error(
      "Le message a changé depuis l’aperçu, ou aucun aperçu n’a été affiché : affichez l’aperçu de la version finale avant d’envoyer.",
    );
  }
}
