import { normalizeFrenchSearchText } from "@/lib/search/french-geo-search";

/**
 * Le plus petit morceau des adresses de tribunaux : celui que la fiche d'une vente (composant client)
 * embarque. Il ne contient que l'adresse par code, qui redirige en 308 vers l'adresse lisible (voir
 * `tribunal-pages.ts`, qui porte le reste et reste côté serveur et pages de tribunaux).
 */
export const TRIBUNAL_PAGES_PATH = "/tribunaux";

/**
 * Adresse de repli d'un tribunal : son code, ramené à des minuscules, chiffres et tirets
 * (« justice_tj_1_93 » donne « justice-tj-1-93 »).
 */
export function tribunalCodeSlug(code: string): string {
  return normalizeFrenchSearchText(code).replaceAll(" ", "-");
}

/** Chemin de la page d'un tribunal connu par son seul code (redirigé en 308 vers l'adresse lisible). */
export function tribunalCodePagePath(code: string): string {
  return `${TRIBUNAL_PAGES_PATH}/${tribunalCodeSlug(code)}`;
}
