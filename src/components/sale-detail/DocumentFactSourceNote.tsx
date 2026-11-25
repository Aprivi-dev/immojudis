import { documentNoteSentences, type DocumentNoteItem } from "@/lib/document-fact-sources";
import styles from "./DocumentFactSourceNote.module.css";

/**
 * Mention des valeurs d'un bloc de la fiche relevées automatiquement dans les pièces (lot V3b-2) : une phrase par
 * pièce et par page (« Surface relevée automatiquement dans la pièce « Cahier des conditions », page 12. »). La
 * pièce devient un lien vers le PDF, ouvert à la page citée, seulement quand `links` en donne un : la fiche des
 * comptes les calcule (`useDocumentFactLinks`) pour les pièces que sa vue sert déjà ; la fiche publique n'en a pas.
 * Rien quand aucune valeur affichée ne vient de cette lecture (la règle est `documentSourceForDisplayedValue`).
 * Composant sans état : il reste léger dans le JavaScript initial de la fiche publique.
 */
export function DocumentFactSourceNote({
  items,
  links,
}: {
  items: readonly DocumentNoteItem[];
  /** Liens par « empreinte|page » (`documentFactLinks`) ; absent : la mention reste du texte. */
  links?: ReadonlyMap<string, string>;
}) {
  const sentences = documentNoteSentences(items);
  if (!sentences.length) return null;
  return (
    <>
      {sentences.map((sentence) => {
        const id = `${sentence.documentKey ?? ""}|${sentence.page}`;
        const href = sentence.documentKey ? links?.get(id) : undefined;
        return (
          <span
            key={`${id}|${sentence.piece}`}
            className={styles.mention}
            data-testid="document-fact-source"
          >
            {sentence.lead}{" "}
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className={styles.pieceLink}>
                {sentence.piece}
                <span className="sr-only"> (nouvel onglet)</span>
              </a>
            ) : (
              sentence.piece
            )}
            .
          </span>
        );
      })}
    </>
  );
}
