/**
 * Liens des mentions « relevée automatiquement » vers les pièces (lot V3b-2). Module de la fiche des comptes seule
 * (la fiche publique ne sert pas les pièces) : il reste hors du JavaScript initial de la page.
 */

import type { DocumentNoteSentence } from "@/lib/document-fact-sources";
import { safeDocumentUrl } from "@/lib/withdrawn-sources";

/**
 * Liens vers les pièces citées par les mentions, par empreinte : seulement pour une pièce que la vue de la fiche
 * sert déjà (`documents_rich` : offre Analyse, vente débloquée ; vide pour l'offre Découverte), et que la fiche
 * proposerait elle-même (`safeDocumentUrl` : adresse web, source non retirée). Le lien ouvre la page citée
 * (`#page=N`, lu par les lecteurs PDF des navigateurs). Clé : « empreinte|page ».
 */
export async function documentFactLinks(
  documents: unknown,
  sentences: readonly Pick<DocumentNoteSentence, "documentKey" | "page">[],
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  if (!Array.isArray(documents) || !globalThis.crypto?.subtle) return links;
  for (const document of documents) {
    const raw: unknown = document?.url;
    const url = safeDocumentUrl(raw);
    if (typeof raw !== "string" || !url) continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const key = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    for (const { documentKey, page } of sentences) {
      if (documentKey === key)
        links.set(`${key}|${page}`, url.includes("#") ? url : `${url}#page=${page}`);
    }
  }
  return links;
}
