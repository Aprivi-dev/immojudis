/**
 * Filtres de l'annuaire `/avocats`, lus dans l'adresse :
 *
 * - `saleId=<uuid>` : le barreau du tribunal judiciaire qui juge la vente (règle P4-13), hors
 *   avocat poursuivant ; les autres filtres sont alors ignorés par l'API.
 * - `bar=<barreau>` : un barreau, sous le nom de la ville du tribunal (« Aix-en-Provence »,
 *   « Bobigny ») ou sous son nom officiel (« Seine-Saint-Denis », « Barreau de Lyon »). C'est le
 *   format à utiliser depuis une page tribunal : `/avocats?bar=${encodeURIComponent(barreau)}`,
 *   avec `barreau = tribunalBarAssociation(nom du tribunal)` (`src/lib/lawyer-bar.ts`).
 * - `city=<ville>` : lu comme un barreau quand `bar` est absent.
 * - `department=<code ou nom>` : les barreaux des tribunaux judiciaires du département.
 *
 * Sans aucun de ces filtres, la page invite à choisir un barreau et n'interroge pas l'annuaire.
 */
export type DirectorySearch = {
  saleId?: string;
  bar?: string;
  city?: string;
  department?: string;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads the directory filters from raw URL parameters (server page and tests). */
export function validateDirectorySearch(search: Record<string, unknown>): DirectorySearch {
  return {
    saleId: stringValue(search.saleId),
    bar: stringValue(search.bar),
    city: stringValue(search.city),
    department: stringValue(search.department),
  };
}

/** True when the URL names something to search: otherwise the directory is not queried. */
export function hasDirectoryCriteria(search: DirectorySearch): boolean {
  return Boolean(search.saleId || search.bar || search.city || search.department);
}
