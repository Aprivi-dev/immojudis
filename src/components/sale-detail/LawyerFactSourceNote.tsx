import { Terme, type TermeKey } from "@/components/ceiling/Terme";
import { lawyerNoteSentences, type LawyerNoteItem } from "@/lib/lawyer-fact-sources";
import styles from "./LawyerFactSourceNote.module.css";

/** Termes de la mention qui ouvrent leur définition du glossaire. */
const GLOSSARY_TERMS: ReadonlyArray<[phrase: string, terme: TermeKey]> = [
  ["avocat poursuivant", "avocat-poursuivant"],
  ["cahier des conditions de vente", "cahier-conditions-vente"],
];
const GLOSSARY_PATTERN = new RegExp(`(${GLOSSARY_TERMS.map(([phrase]) => phrase).join("|")})`);

function withGlossaryTerms(sentence: string) {
  return sentence.split(GLOSSARY_PATTERN).map((part, index) => {
    const terme = GLOSSARY_TERMS.find(([phrase]) => phrase === part)?.[1];
    return terme ? (
      <Terme key={index} terme={terme}>
        {part}
      </Terme>
    ) : (
      part
    );
  });
}

/**
 * Mention de la source « avocat poursuivant » des valeurs d'un bloc de la fiche : une phrase par jour de
 * réception (pas la même phrase répétée sous chaque valeur voisine). Une seule valeur sans libellé garde le
 * texte retenu tel quel. « Avocat poursuivant » et « cahier des conditions de vente » ouvrent leur définition,
 * et le lien « Où consulter le cahier » mène à la section des pièces de la page (`cahierHref`). Rien quand
 * aucune valeur affichée ne vient d'une réponse de l'avocat (la règle est `lawyerSourceForDisplayedValue`).
 */
export function LawyerFactSourceNote({
  items,
  cahierHref,
}: {
  items: readonly LawyerNoteItem[];
  /** Ancre de la section des pièces de la page (`#pieces-et-verifications`, `#documents`). */
  cahierHref: string;
}) {
  const sentences = lawyerNoteSentences(items);
  if (!sentences.length) return null;
  return (
    <>
      {sentences.map((sentence, index) => (
        <span key={sentence} className={styles.mention} data-testid="lawyer-fact-source">
          {withGlossaryTerms(sentence)}
          {/* Un seul lien par bloc, après sa dernière phrase. */}
          {index === sentences.length - 1 ? (
            <>
              {" "}
              <a href={cahierHref} className={styles.cahierLink}>
                Où consulter le cahier
              </a>
            </>
          ) : null}
        </span>
      ))}
    </>
  );
}
