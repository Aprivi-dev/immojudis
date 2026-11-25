"use client";

import { useEffect, useState } from "react";
import {
  documentFactLinks,
  documentNoteSentences,
  type DocumentNoteItem,
} from "@/lib/document-fact-sources";
import styles from "./DocumentFactSourceNote.module.css";

const NO_LINKS: ReadonlyMap<string, string> = new Map();

/**
 * Mention des valeurs d'un bloc de la fiche relevées automatiquement dans les pièces (lot V3b-2) : une phrase par
 * pièce et par page (« Surface relevée automatiquement dans la pièce « Cahier des conditions », page 12. »). La
 * pièce devient un lien vers le PDF, ouvert à la page citée, seulement quand la vue de la fiche sert déjà cette
 * pièce (`documents`, offre Analyse ou vente débloquée) ; sinon la mention reste du texte. Rien quand aucune valeur
 * affichée ne vient de cette lecture (la règle est `documentSourceForDisplayedValue`).
 */
export function DocumentFactSourceNote({
  items,
  documents,
}: {
  items: readonly DocumentNoteItem[];
  /** Les pièces que la vue sert (`documents_rich`, `documents` de la vente) ; absent : fiche publique. */
  documents?: { documents_rich?: unknown; documents?: unknown };
}) {
  const sentences = documentNoteSentences(items);
  // Les pièces citées (empreinte et page) : les appelants passent une liste neuve à chaque rendu, l'effet ne se
  // relance que si les pièces citées ou les pièces servies changent.
  const cited = sentences
    .filter((sentence) => sentence.documentKey)
    .map((sentence) => `${sentence.documentKey}|${sentence.page}`)
    .join(",");
  const documentsRich = documents?.documents_rich;
  const documentList = documents?.documents;
  const [links, setLinks] = useState<ReadonlyMap<string, string>>(NO_LINKS);
  useEffect(() => {
    if (!cited || (documentsRich == null && documentList == null)) {
      setLinks(NO_LINKS);
      return;
    }
    const wanted = cited.split(",").map((entry) => {
      const [documentKey, page] = entry.split("|");
      return { documentKey, page: Number(page) };
    });
    let current = true;
    documentFactLinks({ documents_rich: documentsRich, documents: documentList }, wanted)
      .then((found) => {
        if (current) setLinks(found.size ? found : NO_LINKS);
      })
      .catch(() => {
        // Sans empreinte calculable, la mention reste du texte.
        if (current) setLinks(NO_LINKS);
      });
    return () => {
      current = false;
    };
  }, [cited, documentsRich, documentList]);
  if (!sentences.length) return null;
  return (
    <>
      {sentences.map((sentence) => {
        const id = `${sentence.documentKey ?? ""}|${sentence.page}`;
        const href = sentence.documentKey ? links.get(id) : undefined;
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
