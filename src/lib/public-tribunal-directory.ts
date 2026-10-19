import { courtShortName } from "@/lib/public-tribunal-activity";

/**
 * Référentiel public des tribunaux : tous ceux que le site connaît, avec ou sans vente à venir.
 * Il sert aux pages `/tribunaux/[slug]` à distinguer un tribunal connu sans vente (page servie, hors
 * index) d'une adresse inconnue (404). Nom, ville et département d'un tribunal sont publics.
 */
export type PublicTribunalDirectoryEntry = {
  code: string;
  name: string;
  /** Nom tel qu'il est enregistré : le filtre « tribunal » de la recherche le compare tel quel. */
  searchName: string;
  city: string | null;
  department: string | null;
};

export type PublicTribunalDirectoryRow = {
  code: string;
  canonical_name: string | null;
  city: string | null;
  department: string | null;
};

export function mapPublicTribunalDirectory(
  rows: readonly PublicTribunalDirectoryRow[],
): PublicTribunalDirectoryEntry[] {
  return rows
    .filter((row) => typeof row.code === "string" && row.code.trim() !== "")
    .map((row) => {
      const searchName = row.canonical_name?.trim() || row.code;
      return {
        code: row.code,
        name: courtShortName(searchName),
        searchName,
        city: row.city,
        department: row.department,
      };
    });
}
