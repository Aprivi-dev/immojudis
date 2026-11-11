/**
 * Clés d'opposition d'un destinataire de l'agent d'information. MODULE PUR et SEULE définition : le
 * brouillon, l'aperçu, l'envoi, la sélection du pilote et la mesure à blanc l'appellent tous, pour qu'une
 * opposition contrôlée à une étape le soit de la même façon aux autres.
 */
import {
  informationAgentAddressKind,
  informationAgentStructureCheckKeys,
  informationAgentStructureKeys,
  isInformationAgentStructureKey,
  type InformationAgentAddressKind,
} from "@/lib/information-agent/contact-structure";
import { informationAgentIdentityKeys } from "@/lib/information-agent/identity";

export type InformationAgentRecipientOppositionKeys = {
  /**
   * Clés PORTÉES par le destinataire (registre, mission) : celles de la personne, et celles de sa structure
   * si l'adresse est générique. Quand l'adresse s'oppose, le déclencheur de la base les verse dans la liste
   * d'opposition : l'opposition d'une adresse générique vaut pour la structure, celle d'une adresse
   * nominative pour la personne seule.
   */
  identityKeys: string[];
  /** Clés à CONTRÔLER avant d'écrire : les précédentes, la structure et ses domaines parents. */
  checkKeys: string[];
};

export function recipientOppositionKeys({
  role,
  name,
  place,
  email,
  officeCode = null,
  addressKind,
  siren = null,
}: {
  role: string | null | undefined;
  name: string | null | undefined;
  place: { bar: string | null; city: string | null };
  /** SIREN du cabinet ou de l'étude, quand le brouillon le connaît. */
  siren?: string | null;
  email: string;
  /** Code de l'office notarial du destinataire, quand l'annonce le publie. */
  officeCode?: string | null;
  /** Nature de l'adresse quand l'annonce la désigne (boîte de service) ; sinon lue dans l'adresse. */
  addressKind?: InformationAgentAddressKind | null;
}): InformationAgentRecipientOppositionKeys {
  const personKeys = informationAgentIdentityKeys({ role, name, ...place, siren });
  const generic = (addressKind ?? informationAgentAddressKind(email)) === "generic";
  const identityKeys = [
    ...new Set([
      ...personKeys,
      ...(generic ? informationAgentStructureKeys({ email, officeCode }) : []),
    ]),
  ];
  return {
    identityKeys,
    checkKeys: [
      ...new Set([...identityKeys, ...informationAgentStructureCheckKeys({ email, officeCode })]),
    ],
  };
}

/** Clés de la personne seule : une clé de structure n'identifie pas un professionnel. */
export function personIdentityKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !isInformationAgentStructureKey(key));
}
