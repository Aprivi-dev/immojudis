/**
 * Ce que l'agent d'information peut demander, selon le rôle du destinataire. MODULE PUR, LISTES FERMÉES
 * (décision du propriétaire du 11/11/2026).
 *
 * - avocat poursuivant : inchangé (toutes les questions de `INFORMATION_AGENT_QUESTIONS`) ;
 * - notaire d'une vente notariale et service de l'État d'une cession : les champs de la fiche seulement
 *   (surface, pièces, occupation, visites) et le lieu de consultation du cahier des charges ;
 * - greffe : inchangé, une seule question (quel avocat poursuit), écrite dans `court-registry-template.ts`.
 *
 * Rien n'est demandé sur le vendeur, le débiteur, l'origine du bien ou la procédure.
 */
import {
  INFORMATION_AGENT_QUESTIONS,
  informationAgentQuestionText,
  type InformationAgentQuestionContext,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import type { InformationAgentStructureKind } from "@/lib/information-agent/contact-structure";

/** Rôle du destinataire pour le choix des questions. `other` : destinataire dont le rôle n'est pas établi. */
export type InformationAgentQuestionAudience = "lawyer" | "notary" | "state_service" | "other";

const ALL_QUESTION_KEYS = Object.keys(INFORMATION_AGENT_QUESTIONS) as InformationAgentQuestionKey[];

/** Champs de la fiche et lieu de consultation du cahier des charges : rien sur la procédure ni les personnes. */
export const INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS: readonly InformationAgentQuestionKey[] =
  ["surface", "composition", "occupancy", "visit", "documents"];

export const INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE: Record<
  InformationAgentQuestionAudience,
  readonly InformationAgentQuestionKey[]
> = {
  lawyer: ALL_QUESTION_KEYS,
  notary: INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS,
  state_service: INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS,
  // Adresse saisie par un administrateur ou contact sans rôle établi : comportement inchangé.
  other: ALL_QUESTION_KEYS,
};

/**
 * Libellés propres au notaire et au service de l'État, quand la question générale déborde de la liste
 * admise : on ne leur demande pas les pièces du dossier, seulement où le cahier des charges se consulte, et
 * l'occupation sans le loyer.
 */
const LISTING_FIELD_QUESTION_TEXT: Partial<Record<InformationAgentQuestionKey, string>> = {
  documents:
    "Où et comment le cahier des charges de la vente peut-il être consulté (lieu, horaires ou lien de consultation) ?",
  occupancy: "Le bien est-il actuellement libre, occupé ou loué ?",
};

export function informationAgentQuestionAudience(recipient: {
  role: string | null | undefined;
  structureKind?: InformationAgentStructureKind | null;
}): InformationAgentQuestionAudience {
  if (recipient.role === "lawyer") return "lawyer";
  if (recipient.role === "notary") return "notary";
  if (recipient.role === "organizer" && recipient.structureKind === "state_service") {
    return "state_service";
  }
  return "other";
}

export function isInformationAgentQuestionAllowed(
  audience: InformationAgentQuestionAudience,
  key: InformationAgentQuestionKey,
): boolean {
  return INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE[audience].includes(key);
}

/** Les questions admises pour ce destinataire, dans l'ordre donné. */
export function allowedInformationAgentQuestionKeys(
  audience: InformationAgentQuestionAudience,
  keys: readonly InformationAgentQuestionKey[],
): InformationAgentQuestionKey[] {
  return keys.filter((key) => isInformationAgentQuestionAllowed(audience, key));
}

/** Texte exact de la question pour ce destinataire. Une question non admise est une erreur de l'appelant. */
export function informationAgentQuestionTextFor(
  audience: InformationAgentQuestionAudience,
  key: InformationAgentQuestionKey,
  context?: InformationAgentQuestionContext,
): string {
  if (!isInformationAgentQuestionAllowed(audience, key)) {
    throw new Error(`Question « ${key} » non admise pour ce destinataire.`);
  }
  if (audience === "notary" || audience === "state_service") {
    return LISTING_FIELD_QUESTION_TEXT[key] ?? informationAgentQuestionText(key, context);
  }
  return informationAgentQuestionText(key, context);
}

export const INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE =
  "Requête invalide : à un notaire ou à un service de l'État, l'agent ne demande que la surface, les pièces, l'occupation, les visites et le lieu de consultation du cahier des charges.";
