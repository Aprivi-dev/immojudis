import type { Database, Json } from "@/integrations/supabase/types";
import type { InformationAgentFooterStructure } from "@/lib/information-agent-compliance";
import {
  INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE,
  informationAgentAddressKind,
  informationAgentOfficeCodeFor,
  isInformationAgentStructureKind,
  isInformationAgentStructureKey,
  type InformationAgentAddressKind,
} from "@/lib/information-agent/contact-structure";
import {
  recipientOppositionKeys,
  type InformationAgentRecipientOppositionKeys,
} from "@/lib/information-agent/opposition-keys";
import { tribunalBarAssociation } from "@/lib/lawyer-bar";
import type { AuctionSale } from "@/lib/types";

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];

function asRecord(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Barreau du tribunal de la vente, à défaut sa ville : le lieu de l'identité du professionnel. */
export function saleIdentityPlace(sale: Pick<AuctionSale, "tribunal" | "city">): {
  bar: string | null;
  city: string | null;
} {
  return { bar: tribunalBarAssociation(sale.tribunal), city: sale.city?.trim() || null };
}

function metadataText(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Ce que le brouillon sait du destinataire d'une mission, relu avec le nom et l'adresse éventuellement
 * corrigés par l'administrateur. Rôle, lieu et office viennent du brouillon (`metadata.contact_identity`).
 */
export type InformationAgentMissionRecipient = {
  /** Clés d'opposition (`recipientOppositionKeys`) : portées par la mission et à contrôler. */
  keys: InformationAgentRecipientOppositionKeys;
  role: string | null;
  addressKind: InformationAgentAddressKind;
  /**
   * Variante « structure » du pied : adresse générique ET aucune personne nommée. Avec un nom (« Me … »
   * attaché à l'adresse générique d'un cabinet), le pied ordinaire s'applique. `null` sinon.
   */
  structureAddress: InformationAgentFooterStructure | null;
  /** L'opposition de cette adresse vaudra pour toute sa structure (adresse générique d'une structure connue). */
  structureOpposition: InformationAgentFooterStructure | null;
  /**
   * `metadata.question_audience` tel qu'enregistré ; `undefined` pour un brouillon antérieur à ce champ, que
   * l'aperçu et l'envoi refusent (`assertInformationAgentQuestionsAllowed`) : il doit être régénéré.
   */
  questionAudience: Json | undefined;
};

export function missionRecipient(
  mission: MissionRow,
  recipientName: string | null | undefined,
  recipientEmail: string,
): InformationAgentMissionRecipient {
  const metadata = asRecord(mission.metadata);
  const identity = asRecord(metadata.contact_identity ?? {});
  const selected = metadataText(asRecord(metadata.contact_discovery ?? {}).selected_email);
  const email = recipientEmail.trim().toLowerCase();
  // Ce que le brouillon sait de SON adresse (nature désignée par l'annonce, office du notaire) ne vaut plus
  // pour une adresse saisie ensuite : seul l'office de la vente peut encore s'y appliquer.
  const sameAddress = selected?.toLowerCase() === email;
  const storedKind = metadataText(identity.address_kind);
  const addressKind: InformationAgentAddressKind =
    sameAddress && (storedKind === "generic" || storedKind === "nominative")
      ? storedKind
      : informationAgentAddressKind(email);
  const role =
    metadataText(identity.role) ?? (mission.recipient_kind === "source_lawyer" ? "lawyer" : null);
  const name = recipientName?.trim() || mission.recipient_name;
  const keys = recipientOppositionKeys({
    role,
    name,
    place: { bar: metadataText(identity.bar), city: metadataText(identity.city) },
    siren: metadataText(identity.siren),
    email,
    officeCode: informationAgentOfficeCodeFor({
      email,
      officeCode: sameAddress ? metadataText(identity.office_code) : null,
      saleOfficeCode: metadataText(identity.sale_office_code),
    }),
    addressKind,
  });
  // Structure du destinataire : celle que le brouillon a retenue pour SON adresse, sinon celle du rôle.
  const storedStructure = sameAddress ? metadataText(identity.structure_kind) : null;
  const structure: InformationAgentFooterStructure = isInformationAgentStructureKind(
    storedStructure,
  )
    ? storedStructure
    : ((role === "lawyer" || role === "notary"
        ? INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE[role]
        : null) ?? "unknown");
  return {
    keys,
    role,
    addressKind,
    structureAddress: addressKind === "generic" && !name?.trim() ? structure : null,
    structureOpposition: keys.identityKeys.some(isInformationAgentStructureKey) ? structure : null,
    questionAudience: metadata.question_audience,
  };
}

/** Référence de la vente pour le pied du message : titre, lieu et tribunal du brouillon. */
export function missionSaleReference(mission: MissionRow): string | null {
  const snapshot = asRecord(mission.sale_snapshot);
  const parts = [snapshot.title, snapshot.city, snapshot.tribunal]
    .map(metadataText)
    .filter((part): part is string => Boolean(part));
  return parts.length ? [...new Set(parts)].join(" — ") : null;
}
