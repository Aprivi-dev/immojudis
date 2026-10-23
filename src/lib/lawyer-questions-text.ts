import type { InformationAgentQuestionKey } from "@/lib/information-agent-questions";

/**
 * « Mes questions pour l'avocat » : la forme d'une question et la liste en texte brut. Sans dépendance
 * lourde : le composant de la fiche (navigateur) n'importe que ce module, le repérage des points ouverts
 * (`lawyer-questions.ts`, qui lit l'inventaire de la fiche) reste côté serveur.
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

export type LawyerQuestionsResponse = { questions: LawyerQuestion[] };

/** La liste en texte brut, pour la copier. */
export function lawyerQuestionsText(questions: readonly LawyerQuestion[], heading: string): string {
  return [heading, "", ...questions.map((entry, index) => `${index + 1}. ${entry.question}`)].join(
    "\n",
  );
}
