import { lawyerFactMention, type LawyerFactSource } from "@/lib/lawyer-fact-sources";
import styles from "./LawyerFactSourceNote.module.css";

/**
 * Mention de la source « avocat poursuivant » d'une valeur de la fiche, placée sous la valeur. Rien
 * quand la valeur ne vient pas d'une réponse (ou n'est plus celle transmise : la base ne la rend pas).
 */
export function LawyerFactSourceNote({
  source,
  label,
}: {
  source: LawyerFactSource | null | undefined;
  /** Nom de la valeur, quand la mention est dans un bloc qui en affiche plusieurs. */
  label?: string;
}) {
  if (!source) return null;
  return (
    <span className={styles.mention} data-testid="lawyer-fact-source">
      {label ? `${label} : ` : null}
      {lawyerFactMention(source)}
    </span>
  );
}
