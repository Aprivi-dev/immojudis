import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION } from "../../../emails/information-request";
import {
  informationAgentControllerIdentity,
  type InformationAgentAddressOrigin,
  type InformationAgentFooterStructure,
  type InformationAgentLegalFooter,
} from "@/lib/information-agent-compliance";
import {
  informationAgentAiProvider,
  type InformationAgentAiProvider,
} from "@/lib/information-agent-ai-provider";
import { INFORMATION_AGENT_OPT_OUT_PATH } from "@/lib/information-agent-link-paths";
import {
  buildInformationAgentOptOutUrl,
  INFORMATION_AGENT_PORTAL_SECRET_MISSING_MESSAGE,
  informationAgentPortalSecret,
} from "@/lib/information-agent-signed-link";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { courtRegistryDailyCap } from "@/lib/information-agent/court-registry-fallback";
import { InformationAgentInvalidContactEmailError } from "@/lib/information-agent/contacts";
import { ConfigurationError, PublicApiError } from "@/lib/api-errors";

/**
 * Garde-fous du message sortant de l'agent d'information : identité du responsable de traitement, pied
 * art. 14 RGPD, empreinte de l'aperçu.
 */

/** Refuses to send while the data controller identity (art. 14 GDPR) is not configured. */
export function assertInformationAgentControllerIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!informationAgentControllerIdentity(env)) throw controllerIdentityMissing();
}

function controllerIdentityMissing(): ConfigurationError {
  return new ConfigurationError(
    "Identité du responsable de traitement non configurée : envoi impossible (NEXT_PUBLIC_LEGAL_ENTITY_NAME, NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS et NEXT_PUBLIC_LEGAL_CONTACT_EMAIL).",
  );
}

/** Repères affichés dans un aperçu à la place de ce qui n'est pas encore configuré. */
const PREVIEW_PLACEHOLDERS = {
  controllerName: "[Responsable de traitement à configurer]",
  controllerAddress: "[Adresse à configurer]",
  contactEmail: "[Contact à configurer]",
} as const;

/**
 * Pied légal (art. 14 RGPD) d'un email de l'agent, seule construction du pied : envoi, aperçu d'une mission
 * et aperçu du modèle.
 *
 * À l'envoi, tout élément manquant (identité du responsable, secret du lien d'opposition, prestataire d'IA
 * nommé) lève une erreur. En aperçu (`preview`), l'élément manquant est remplacé par un repère « à configurer »
 * et son motif est ajouté à `preview.blockers` : l'administrateur voit le message entier et ce qui bloque.
 * `email: null` (aperçu du modèle, sans destinataire) donne un lien d'opposition d'exemple.
 */
export function buildInformationAgentLegalFooter({
  appUrl,
  email,
  addressOrigin,
  saleReference = null,
  structureOpposition = null,
  recipientKind = null,
  env = process.env,
  preview,
}: {
  appUrl: string;
  email: string | null;
  addressOrigin: InformationAgentAddressOrigin;
  /** L'opposition de cette adresse vaudra pour toute sa structure (`missionRecipient().structureOpposition`). */
  structureOpposition?: InformationAgentFooterStructure | null;
  saleReference?: string | null;
  /**
   * Nature du destinataire du dossier (`sentRecipientKind`) : elle choisit ce que le pied annonce de l'affichage
   * des réponses (avocat poursuivant avec la mention de source, autre professionnel sans nom ni qualité, greffe).
   * Nulle : aucune section.
   */
  recipientKind?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  preview?: { blockers: string[] };
}): InformationAgentLegalFooter {
  const refuse = (error: Error) => {
    if (!preview) throw error;
    preview.blockers.push(error.message);
  };
  const controller = informationAgentControllerIdentity(env);
  if (!controller) refuse(controllerIdentityMissing());
  const optOut = optOutUrl({ appUrl, email, env, refuse });
  let aiProvider: InformationAgentAiProvider;
  try {
    // Lève une erreur si la configuration désigne un prestataire d'IA non nommé dans le pied.
    aiProvider = informationAgentAiProvider(env);
  } catch (error) {
    refuse(error as Error);
    aiProvider = informationAgentAiProvider({});
  }
  return {
    controllerName: controller?.name ?? PREVIEW_PLACEHOLDERS.controllerName,
    controllerAddress: controller?.address ?? PREVIEW_PLACEHOLDERS.controllerAddress,
    contactEmail: controller?.contactEmail ?? PREVIEW_PLACEHOLDERS.contactEmail,
    saleReference,
    addressOrigin: addressOrigin.text,
    // Message à un greffe : variante « greffe » du pied, avec le plafond réellement appliqué (configuration).
    courtRegistryDailyCap: addressOrigin.courtRegistry ? courtRegistryDailyCap(env) : null,
    addressOriginUrl: addressOrigin.url,
    automatedSearch: addressOrigin.automated,
    automatedSearchSource: addressOrigin.searchSource,
    structureAddress: addressOrigin.structureAddress ?? null,
    structureOpposition: addressOrigin.courtRegistry ? null : structureOpposition,
    replyDisplay: addressOrigin.courtRegistry
      ? "court_registry"
      : recipientKind === "source_lawyer"
        ? "source_lawyer"
        : recipientKind
          ? "professional"
          : null,
    aiProvider,
    privacyUrl: new URL("/privacy", appUrl).toString(),
    optOutUrl: optOut,
  };
}

function optOutUrl({
  appUrl,
  email,
  env,
  refuse,
}: {
  appUrl: string;
  email: string | null;
  env: Readonly<Record<string, string | undefined>>;
  refuse: (error: Error) => void;
}): string {
  const placeholder = new URL(INFORMATION_AGENT_OPT_OUT_PATH, appUrl);
  if (email === null) {
    placeholder.search = "?e=exemple&t=exemple";
    return placeholder.toString();
  }
  const secret = informationAgentPortalSecret(env);
  if (!secret) {
    refuse(new ConfigurationError(INFORMATION_AGENT_PORTAL_SECRET_MISSING_MESSAGE));
    return placeholder.toString();
  }
  const normalized = normalizedEmail(email);
  if (!normalized) {
    refuse(new InformationAgentInvalidContactEmailError());
    return placeholder.toString();
  }
  return buildInformationAgentOptOutUrl({ appUrl, email: normalized, secret });
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
  if (!expected) throw new ConfigurationError(INFORMATION_AGENT_PORTAL_SECRET_MISSING_MESSAGE);
  const received = Buffer.from(input.previewFingerprint ?? "", "hex");
  const reference = Buffer.from(expected, "hex");
  if (received.length !== reference.length || !timingSafeEqual(received, reference)) {
    throw new PublicApiError(
      "Le message a changé depuis l’aperçu, ou aucun aperçu n’a été affiché : affichez l’aperçu de la version finale avant d’envoyer.",
      409,
    );
  }
}
