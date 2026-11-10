import { lawyerNoteSentences, type LawyerNoteItem } from "@/lib/lawyer-fact-sources";
import styles from "./LawyerFactSourceNote.module.css";

/**
 * Mention de la source « avocat poursuivant » des valeurs d'un bloc de la fiche : une phrase par jour de
 * réception (pas la même phrase répétée sous chaque valeur voisine). Une seule valeur sans libellé garde le
 * texte validé tel quel. Rien quand aucune valeur affichée ne vient d'une réponse de l'avocat (la règle est
 * `lawyerSourceForDisplayedValue`).
 */
export function LawyerFactSourceNote({ items }: { items: readonly LawyerNoteItem[] }) {
  const sentences = lawyerNoteSentences(items);
  if (!sentences.length) return null;
  return (
    <>
      {sentences.map((sentence) => (
        <span key={sentence} className={styles.mention} data-testid="lawyer-fact-source">
          {sentence}
        </span>
      ))}
    </>
  );
}
