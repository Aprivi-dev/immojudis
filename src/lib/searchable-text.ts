/** Texte de recherche : minuscules, sans accents, tirets et apostrophes remplacés par des espaces. */
export function searchableText(value: string): string {
  return value
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-'’\s]+/g, " ")
    .trim();
}
