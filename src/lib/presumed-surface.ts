import { formatSurface } from "@/lib/format/numbers";

/**
 * Surface présumée : la valeur retenue pour un logement sans surface publiée, et les textes qui la
 * disent. Module sans autre dépendance que la mise en forme des nombres : la fiche, la recherche et
 * les alertes affichent ces textes sans charger les règles de `surface.ts`, qui en dépend.
 */

// Surface provisoire retenue pour les très petits logements sans surface publiée :
// les studios et les appartements 1 pièce (T1). À confirmer avant d'enchérir.
export const STUDIO_ESTIMATED_SURFACE_M2 = 20;

/**
 * Mention d'un chiffre calculé sur une surface présumée (`kind` « estimated » de `getSaleSurface` :
 * studio ou T1 sans surface publiée) : rendement, valeur estimée, écart avec le marché. Elle dit la
 * surface retenue et pourquoi. `null` pour une surface mesurée, un terrain ou sans surface : aucune
 * mention. Seule source de ce texte (fiche, rapport et son PDF, e-mail d'alerte). `kind` est une
 * chaîne : le rapport et l'e-mail le relisent dans un instantané enregistré.
 */
export function presumedSurfaceNote(surface: {
  kind: string | null | undefined;
  value: number | null | undefined;
}): string | null {
  if (surface.kind !== "estimated" || surface.value == null || !(surface.value > 0)) return null;
  return `Surface provisoire de ${formatSurface(surface.value)} retenue pour les calculs : l'annonce ne publie pas la surface.`;
}

/**
 * Aide des critères qui comptent la surface présumée de `getSaleSurface` sans changer de
 * comportement : rendement minimal de la recherche et des alertes, surface minimale des alertes.
 */
export const PRESUMED_SURFACE_CRITERIA_NOTE = `Un studio ou un appartement d'une pièce sans surface publiée compte pour une surface provisoire de ${STUDIO_ESTIMATED_SURFACE_M2} m².`;
