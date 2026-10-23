import { getKeyFactReliabilities, type FactReliabilityMap } from "@/lib/fact-reliability";
import { buildInformationAgentInventory } from "@/lib/information-agent-inventory";
import {
  detectInformationGaps,
  informationAgentQuestionContext,
  informationAgentQuestionText,
} from "@/lib/information-agent-questions";
import type { LawyerQuestion } from "@/lib/lawyer-questions-text";
import type { AuctionSale } from "@/lib/types";

/**
 * « Mes questions pour l'avocat » : ce que la fiche laisse ouvert (date, mise à prix, pièces,
 * occupation, surface, diagnostics…), sous forme de questions que la personne pose à SON avocat.
 *
 * Même source que l'agent d'information : `detectInformationGaps` repère les points manquants ou à
 * confirmer (et les classe), `informationAgentQuestionText` les formule pour un professionnel. Seule la
 * personne qui s'exprime change (« nous » devient « me ») : la liste ne dit rien de plus que la fiche.
 * Module pur, lu côté serveur seulement (`/api/sales/[id]/lawyer-questions`) : l'inventaire de la fiche n'est
 * pas envoyé au navigateur. Rien n'est envoyé à personne.
 */
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
