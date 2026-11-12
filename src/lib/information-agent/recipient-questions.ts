/**
 * Ce que l'agent d'information peut demander, selon le destinataire. MODULE PUR, LISTES FERMÉES
 * (décision du propriétaire du 11/11/2026, relecture juridique du même jour).
 *
 * - avocat poursuivant : inchangé (toutes les questions de `INFORMATION_AGENT_QUESTIONS`) ;
 * - notaire d'une vente notariale et service de l'État d'une cession : les champs de la fiche seulement
 *   (surface, pièces, occupation, visites) et le lieu de consultation du cahier des charges ;
 * - greffe : inchangé, une seule question (quel avocat poursuit), écrite dans `court-registry-template.ts`.
 *
 * Rien n'est demandé sur le vendeur, le débiteur, l'origine du bien ou la procédure. Le texte du message de
 * chaque destinataire est dans `recipient-templates.ts`.
 */
import { PublicApiError } from "@/lib/api-errors";
import {
  INFORMATION_AGENT_QUESTIONS,
  informationAgentQuestionText,
  type InformationAgentQuestionContext,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import type { InformationAgentStructureKind } from "@/lib/information-agent/contact-structure";
import {
  informationAgentSourceRole,
  type InformationAgentOrganizerType,
} from "@/lib/information-agent/listing-contacts";

const INFORMATION_AGENT_QUESTION_AUDIENCES = [
  "lawyer",
  "notary",
  "state_service",
  "other",
] as const;

/** Destinataire pour le choix des questions et du texte. `other` : aucune restriction propre (inchangé). */
export type InformationAgentQuestionAudience =
  (typeof INFORMATION_AGENT_QUESTION_AUDIENCES)[number];

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
  other: ALL_QUESTION_KEYS,
};

/** Libellés propres à la liste courte : jamais les pièces du dossier, jamais le loyer. */
const LISTING_FIELD_QUESTION_TEXT: Record<
  "notary" | "state_service",
  Partial<Record<InformationAgentQuestionKey, string>>
> = {
  notary: {
    documents:
      "Où et comment le cahier des charges de la vente peut-il être consulté (lieu, horaires ou lien de consultation) ?",
    occupancy: "Selon l’annonce ou le cahier des charges, le bien est-il libre, occupé ou loué ?",
  },
  state_service: {
    documents:
      "Où et comment le cahier des charges de la vente peut-il être consulté (lieu, horaires ou lien de consultation) ?",
    occupancy: "Le bien est-il actuellement libre, occupé ou loué ?",
  },
};

/**
 * Destinataire d'une demande. Le rôle établi du destinataire prime ; quand il ne l'est pas (adresse saisie
 * par l'administrateur, « contact de l'annonce », organisateur sans structure), c'est l'ORGANISATEUR DE LA
 * VENTE qui décide : sur une vente notariale ou une cession de l'État, la liste courte s'applique par
 * défaut, à qui que l'on écrive. Quand l'organisateur n'en dit rien, la SOURCE de l'annonce départage, comme
 * pour le rôle (`informationAgentSourceRole`) : une annonce de `notaires` est une vente notariale, une
 * annonce de `cessions_etat` une cession.
 */
export function informationAgentQuestionAudience(recipient: {
  role: string | null | undefined;
  structureKind?: InformationAgentStructureKind | null;
  organizerType: InformationAgentOrganizerType;
  /** Source de l'annonce de la vente (`notaires`, `cessions_etat`, `licitor`…). */
  sourceName: string | null;
}): InformationAgentQuestionAudience {
  if (recipient.role === "notary") return "notary";
  if (recipient.role === "organizer" && recipient.structureKind === "state_service") {
    return "state_service";
  }
  if (recipient.organizerType === "notary") return "notary";
  if (recipient.organizerType === "state_service") return "state_service";
  // Organisateur non déclaré, ou déclaré « avocat poursuivant » sur une source qui n'en publie pas.
  const bySource = informationAgentSourceRole(recipient.sourceName);
  if (bySource?.role === "notary") return "notary";
  if (bySource?.structureKind === "state_service") return "state_service";
  return recipient.role === "lawyer" ? "lawyer" : "other";
}

function isInformationAgentQuestionAudience(
  value: unknown,
): value is InformationAgentQuestionAudience {
  return (INFORMATION_AGENT_QUESTION_AUDIENCES as readonly unknown[]).includes(value);
}

export function isInformationAgentQuestionAllowed(
  audience: InformationAgentQuestionAudience,
  key: InformationAgentQuestionKey,
): boolean {
  return INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE[audience].includes(key);
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
    return LISTING_FIELD_QUESTION_TEXT[audience][key] ?? informationAgentQuestionText(key, context);
  }
  return informationAgentQuestionText(key, context);
}

/**
 * Affiché tel quel à l'administrateur : il doit passer `isPublicErrorMessage` (`api-errors.ts`), qui masque
 * tout message contenant un marqueur technique. « non reconnu » contenait « econn » et était remplacé par
 * « Erreur admin ».
 */
export const INFORMATION_AGENT_AUDIENCE_UNKNOWN_MESSAGE =
  "Destinataire du brouillon non identifié : régénérez le brouillon avec le bouton “Régénérer le brouillon”.";

export const INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE =
  "Requête invalide : sur une vente notariale ou une cession de l'État, l'agent ne demande que la surface, les pièces, l'occupation, les visites et le lieu de consultation du cahier des charges.";

/**
 * Contrôle rejoué à l'aperçu et à l'envoi : les questions enregistrées avec le brouillon sont toutes admises
 * pour le destinataire que le brouillon a retenu. Une valeur enregistrée inconnue est refusée.
 */
export function assertInformationAgentQuestionsAllowed(
  audience: unknown,
  /** `question_keys` de la mission (texte en base). */
  questionKeys: readonly string[],
): void {
  // Valeur absente (brouillon antérieur à ce champ) ou inconnue : rien ne dit à qui ce brouillon s'adresse,
  // donc ni quelles questions ni quel envoi sont admis. Refus, jamais de valeur supposée.
  if (!isInformationAgentQuestionAudience(audience)) {
    throw new Error(INFORMATION_AGENT_AUDIENCE_UNKNOWN_MESSAGE);
  }
  // Avocat et destinataire sans liste propre : inchangé, aucune question n'est écartée ici (les brouillons
  // antérieurs peuvent porter d'anciennes clés). Seule la liste courte est une restriction à rejouer.
  if (audience === "lawyer" || audience === "other") return;
  const allowed: readonly string[] = INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE[audience];
  if (questionKeys.some((key) => !allowed.includes(key))) {
    throw new PublicApiError(INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE, 400);
  }
}
