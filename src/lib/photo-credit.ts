import {
  knownSourceLabelFromUrl,
  saleSourceLinks,
  sourceLabelFromUrl,
} from "@/lib/sale-source-links";
import type { AuctionSale } from "@/lib/types";

/** Crédit d'une photo : la source qui la publie et, si on l'a, l'annonce d'origine. */
export type PhotoCredit = { label: string; href: string | null };

/**
 * Crédit d'une photo, d'après l'hôte de son URL d'ORIGINE (jamais celui de notre copie).
 *
 * - `knownOnly` : seules les sources connues sont nommées (cartes de liste) ; sinon l'hôte brut sert
 *   de nom, pour ne jamais présenter une photo sans l'attribuer.
 * - Le lien est celui de l'annonce de cette même source parmi les liens de la vente ; sans lien de
 *   la bonne source, le nom est affiché sans lien (on ne renvoie pas vers une autre source).
 */
export function photoCredit(
  originalUrl: string | null | undefined,
  sale?: Partial<AuctionSale> | null,
  options: { knownOnly?: boolean } = {},
): PhotoCredit | null {
  if (!originalUrl) return null;
  const label = options.knownOnly
    ? knownSourceLabelFromUrl(originalUrl)
    : (knownSourceLabelFromUrl(originalUrl) ?? sourceLabelFromUrl(originalUrl));
  if (!label) return null;
  const href = sale
    ? (saleSourceLinks(sale as AuctionSale).find((link) => link.label === label)?.href ?? null)
    : null;
  return { label, href };
}
