import { knownSourceLabelFromUrl, saleSourceLinks } from "@/lib/sale-source-links";
import type { AuctionSale } from "@/lib/types";

/**
 * Crédit d'une photo : la source qui la publie et, si on l'a, l'annonce d'origine. `label` est
 * `null` quand l'hôte de la photo n'est pas une source connue : le crédit dit alors « source de
 * l'annonce », sans nom ni lien (jamais l'hôte brut d'un CDN).
 */
export type PhotoCredit = { label: string | null; href: string | null };

/**
 * Crédit d'une photo, d'après l'hôte de son URL d'ORIGINE (jamais celui de notre copie).
 *
 * - Seules les sources connues sont nommées. Hôte inconnu : crédit générique, sans lien ; avec
 *   `knownOnly` (cartes de liste), aucun crédit.
 * - Le lien est celui de l'annonce de cette même source parmi les liens de la vente ; sans lien de
 *   la bonne source, le nom est affiché sans lien (on ne renvoie pas vers une autre source).
 */
export function photoCredit(
  originalUrl: string | null | undefined,
  sale?: Partial<AuctionSale> | null,
  options: { knownOnly?: boolean } = {},
): PhotoCredit | null {
  if (!originalUrl) return null;
  const label = knownSourceLabelFromUrl(originalUrl);
  if (!label) return options.knownOnly ? null : { label: null, href: null };
  const href = sale
    ? (saleSourceLinks(sale as AuctionSale).find((link) => link.label === label)?.href ?? null)
    : null;
  return { label, href };
}
