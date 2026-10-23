import { getKeyFactReliabilities, type FactReliabilityMap } from "@/lib/fact-reliability";
import { buildInformationAgentInventory } from "@/lib/information-agent-inventory";
import {
  detectInformationGaps,
  informationAgentQuestionContext,
  informationAgentQuestionText,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import type { AuctionSale } from "@/lib/types";

/**
 * « Mes questions pour l'avocat » : ce que la fiche laisse ouvert (date, mise à prix, pièces,
 * occupation, surface, diagnostics…), sous forme de questions que la personne pose à SON avocat.
 *
 * Même source que l'agent d'information : `detectInformationGaps` repère les points manquants ou à
 * confirmer (et les classe), `informationAgentQuestionText` les formule pour un professionnel. Seule la
 * personne qui s'exprime change (« nous » devient « me ») : la liste ne dit rien de plus que la fiche.
 * Module pur : rien n'est envoyé à personne.
 */
export type LawyerQuestion = {
  key: InformationAgentQuestionKey;
  /** Le point de la fiche : « Mise à prix », « Pièces du dossier »… */
  label: string;
  /** La question, à la première personne. */
  question: string;
  /** Pourquoi la fiche la pose (« La mise à prix n’est pas renseignée. »). */
  reason: string;
  /** Peut changer la faisabilité ou la sûreté d'une enchère. */
  blocking: boolean;
};

/** Les questions de l'agent s'adressent au professionnel au nom d'Immojudis : « nous » devient « me ». */
export function inFirstPersonSingular(question: string): string {
  return question
    .replace(/\bnous (?=[aeiouyhéèêàâîïôû])/gi, "m’")
    .replace(/\bnous\b/gi, "me")
    .replace(/\bnos\b/gi, "mes")
    .replace(/\bnotre\b/gi, "mon");
}

/** Les questions de la fiche, les plus importantes d'abord ; vide quand la fiche ne laisse rien d'ouvert. */
export function buildLawyerQuestions(
  sale: AuctionSale,
  facts: FactReliabilityMap = getKeyFactReliabilities(sale),
): LawyerQuestion[] {
  const inventory = buildInformationAgentInventory(sale, facts);
  const context = informationAgentQuestionContext(inventory);
  return detectInformationGaps(sale, facts, inventory)
    .sort((left, right) => right.priority - left.priority)
    .map((gap) => ({
      key: gap.key,
      label: gap.label,
      question: inFirstPersonSingular(informationAgentQuestionText(gap.key, context)),
      reason: gap.reason,
      blocking: gap.blocking,
    }));
}

/** La liste en texte brut, pour la copier ou l'imprimer. */
export function lawyerQuestionsText(questions: readonly LawyerQuestion[], heading: string): string {
  return [heading, "", ...questions.map((entry, index) => `${index + 1}. ${entry.question}`)].join(
    "\n",
  );
}
