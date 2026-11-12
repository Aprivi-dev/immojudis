import "server-only";
import type { Json } from "@/integrations/supabase/types";
import { loadAdminInformationAgentSale } from "@/lib/admin-information-agent-sale";
import {
  discoverInformationAgentContacts,
  type InformationAgentContactCandidate,
} from "@/lib/information-agent/contact-resolution";
import {
  assertCourtRegistryFallbackAddress,
  assertCourtRegistryFallbackLimits,
  courtRegistryFallbackMetadata,
  courtRegistryFallbackOfMission,
  findCourtRegistryFallback,
  type CourtRegistryFallback,
  type CourtRegistryFallbackSaleInput,
} from "@/lib/information-agent/court-registry";
import {
  INFORMATION_AGENT_COURT_REGISTRY_FALLBACK,
  isCourtRegistryFallbackSale,
} from "@/lib/information-agent/court-registry-fallback";
import {
  COURT_REGISTRY_EMAIL_TEMPLATE,
  COURT_REGISTRY_QUESTION,
} from "@/lib/information-agent/court-registry-template";
import type { InformationAgentQuestionKey } from "@/lib/information-agent-questions";

/**
 * Greffe de secours dans le cycle d'une mission (brouillon, aperçu, envoi) : les points d'appel de
 * `information-agent.ts`, regroupés ici pour ne pas alourdir ce module. La règle (quelle vente, quelles
 * adresses) est dans `court-registry-fallback.ts`, la lecture du référentiel et les limites dans
 * `court-registry.ts`.
 */

/**
 * Brouillon adressé à un greffe : sans nom de personne, une seule question (celle du greffe), enregistrée
 * sous la clé « pièces du dossier », la plus proche de la demande.
 */
export const COURT_REGISTRY_DRAFT_OPTIONS = {
  recipientName: null,
  questionKeys: ["documents"] as readonly InformationAgentQuestionKey[],
  questionLines: [COURT_REGISTRY_QUESTION] as readonly string[],
  template: COURT_REGISTRY_EMAIL_TEMPLATE,
};

/**
 * Greffe de secours d'un brouillon : seulement quand la vente au tribunal n'a AUCUN destinataire avocat ou
 * cabinet (ni dans l'annonce, ni au registre, ni retrouvé), qu'aucune adresse n'est saisie et qu'aucun
 * professionnel n'est opposé. Une adresse hésitante ou ambiguë reste à l'administrateur.
 */
export async function findCourtRegistryFallbackForDraft({
  sale,
  explicitRecipientEmail,
  selectedContact,
  contactCandidates,
  candidatesSkippedForOpposition,
}: {
  sale: CourtRegistryFallbackSaleInput;
  explicitRecipientEmail: string | null;
  selectedContact: InformationAgentContactCandidate | null;
  contactCandidates: readonly InformationAgentContactCandidate[];
  candidatesSkippedForOpposition: number;
}): Promise<CourtRegistryFallback | null> {
  if (
    explicitRecipientEmail ||
    selectedContact ||
    contactCandidates.length ||
    candidatesSkippedForOpposition > 0
  ) {
    return null;
  }
  return findCourtRegistryFallback(sale);
}

/** Trace du greffe dans les métadonnées d'un brouillon (origine, tribunal, source du brouillon). */
export function courtRegistryDraftMetadata(fallback: CourtRegistryFallback) {
  return {
    draft_source: "admin_court_registry_fallback",
    ...courtRegistryFallbackMetadata(fallback.court),
  };
}

/** Limites d'un brouillon au greffe : une demande par tribunal et par vente, plafond du jour. */
export async function assertCourtRegistryDraftAllowed(
  fallback: CourtRegistryFallback,
  saleId: string,
): Promise<void> {
  await assertCourtRegistryFallbackLimits({ courtCode: fallback.court.code, saleId });
}

const COURT_REGISTRY_SALE_CHANGED_MESSAGE =
  "La vente n’est plus une vente au tribunal qui justifie une demande au greffe";

/**
 * Relit la vente à l'aperçu et à l'envoi : le tribunal doit être celui du brouillon, la vente toujours une
 * vente au tribunal reconnue (confirmée, hors notaires, cessions de l'État et AGRASC, sans
 * `tribunal_inconsistent`), et l'annonce ne doit donner AUCUN email d'avocat ou de cabinet exploitable.
 * Sinon la demande au greffe n'a plus lieu d'être : régénérer le brouillon.
 */
async function assertCourtRegistrySaleCurrent({
  saleId,
  courtCode,
}: {
  saleId: string | null;
  courtCode: string;
}): Promise<void> {
  if (!saleId) throw new Error(`${COURT_REGISTRY_SALE_CHANGED_MESSAGE} (vente introuvable).`);
  const sale = await loadAdminInformationAgentSale({ auth: { isAdmin: true }, saleId });
  if (sale.tribunal_code?.trim() !== courtCode) {
    throw new Error(
      `${COURT_REGISTRY_SALE_CHANGED_MESSAGE} (le tribunal de la vente a changé depuis le brouillon) : régénérez le brouillon.`,
    );
  }
  if (!isCourtRegistryFallbackSale(sale)) {
    throw new Error(
      `${COURT_REGISTRY_SALE_CHANGED_MESSAGE} (vente non confirmée, incohérente ou hors tribunal) : annulez ce brouillon.`,
    );
  }
  if (discoverInformationAgentContacts(sale).length > 0) {
    throw new Error(
      `${COURT_REGISTRY_SALE_CHANGED_MESSAGE} (l’annonce donne maintenant une adresse d’avocat ou de cabinet) : régénérez le brouillon pour l’écrire à lui.`,
    );
  }
}

/**
 * Contrôles propres au greffe à l'aperçu et avant l'approbation : adresse toujours dans le référentiel,
 * vente relue, limites du tribunal. `fallback` est nul pour toute autre mission (aucun contrôle).
 */
export function courtRegistryMissionChecks({
  mission,
  recipientEmail,
  env,
}: {
  mission: { id: string; sale_id: string | null; metadata: Json; recipient_email: string };
  recipientEmail: string;
  env?: Readonly<Record<string, string | undefined>>;
}): {
  fallback: { courtCode: string; courtName: string | null } | null;
  checks: Array<() => Promise<void>>;
} {
  const fallback = courtRegistryFallbackOfMission(mission, recipientEmail);
  if (!fallback) return { fallback, checks: [] };
  return {
    fallback,
    checks: [
      () => assertCourtRegistryFallbackAddress(fallback.courtCode, recipientEmail),
      () =>
        assertCourtRegistrySaleCurrent({ saleId: mission.sale_id, courtCode: fallback.courtCode }),
      () =>
        assertCourtRegistryFallbackLimits({
          courtCode: fallback.courtCode,
          saleId: mission.sale_id,
          missionId: mission.id,
          env,
        }),
    ],
  };
}

const COURT_REGISTRY_ORIGIN_MISSING_MESSAGE =
  "L’adresse du greffe n’a plus de ligne de registre issue du référentiel des tribunaux : l’origine saisie à la main n’est pas admise, annulez ce brouillon et relancez la préparation.";

/**
 * Une adresse de greffe exige sa ligne de registre (`court_registry_fallback`) : sans elle, ni URL
 * saisie à la main ni saisie d'administrateur ne la « blanchissent » (libellé d'origine et exclusion
 * des adresses de juridiction contournés).
 */
export function assertCourtRegistryFallbackOriginIntact(
  courtFallback: boolean,
  origin: { kind: string | null },
): void {
  if (courtFallback && origin.kind !== INFORMATION_AGENT_COURT_REGISTRY_FALLBACK) {
    throw new Error(COURT_REGISTRY_ORIGIN_MISSING_MESSAGE);
  }
}

function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Métadonnées d'une mission sans la trace d'une demande au greffe (destinataire changé à la main). */
export function withoutCourtRegistryTrace(metadata: Json): Record<string, Json | undefined> {
  const { court_registry_fallback: _court, address_origin: _origin, ...rest } = asObject(metadata);
  return rest;
}

/** Journal d'un message envoyé : un message au greffe se distingue d'un message à un avocat. */
export function courtRegistryMessageMetadata(
  fallback: { courtCode: string; courtName: string | null } | null,
): Record<string, Json> {
  return fallback
    ? {
        address_origin: INFORMATION_AGENT_COURT_REGISTRY_FALLBACK,
        court_code: fallback.courtCode,
        court_name: fallback.courtName,
      }
    : {};
}

/** `court_registry_fallback` si la mission est adressée à un greffe (champ `recipientOrigin` de l'API). */
export function courtRegistryRecipientOrigin(
  metadata: Json,
): typeof INFORMATION_AGENT_COURT_REGISTRY_FALLBACK | null {
  return asObject(metadata).address_origin === INFORMATION_AGENT_COURT_REGISTRY_FALLBACK
    ? INFORMATION_AGENT_COURT_REGISTRY_FALLBACK
    : null;
}
