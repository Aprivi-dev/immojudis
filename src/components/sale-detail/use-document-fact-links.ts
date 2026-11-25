"use client";

import { useEffect, useState } from "react";
import { documentNoteSentences, type DocumentNoteItem } from "@/lib/document-fact-sources";
import { documentFactLinks } from "@/lib/document-fact-links";

const NO_LINKS: ReadonlyMap<string, string> = new Map();

/**
 * Liens vers les pièces citées par les mentions d'un bloc de la fiche des comptes (`DocumentFactSourceNote`) :
 * seulement pour une pièce que la vue sert déjà (`documents_rich` de la vente : offre Analyse, vente débloquée). Les
 * empreintes se calculent après l'affichage ; d'ici là, la mention est du texte.
 */
export function useDocumentFactLinks(
  documents: unknown,
  items: readonly DocumentNoteItem[],
): ReadonlyMap<string, string> {
  // Les pièces citées (empreinte et page) : les appelants passent une liste neuve à chaque rendu, l'effet ne se
  // relance que si les pièces citées ou les pièces servies changent.
  const cited = documentNoteSentences(items)
    .filter((sentence) => sentence.documentKey)
    .map((sentence) => `${sentence.documentKey}|${sentence.page}`)
    .join(",");
  const [links, setLinks] = useState<ReadonlyMap<string, string>>(NO_LINKS);
  useEffect(() => {
    if (!cited || !Array.isArray(documents)) {
      setLinks(NO_LINKS);
      return;
    }
    const wanted = cited.split(",").map((entry) => {
      const [documentKey, page] = entry.split("|");
      return { documentKey, page: Number(page) };
    });
    let current = true;
    documentFactLinks(documents, wanted)
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
  }, [cited, documents]);
  return links;
}
