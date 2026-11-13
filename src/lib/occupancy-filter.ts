import { occupancyClass, type OccupancyClass } from "@/lib/occupancy-status";

/** Codes de `auction_sales.occupancy_status` (contrainte SQL de la migration 20260520202829). */
const OCCUPANCY_STATUS_CODES = [
  "vacant",
  "occupied",
  "rented",
  "owner_occupied",
  "squatted",
  "unknown",
] as const;

/**
 * Filtre « Occupation » de la recherche et des alertes : une vente le passe quand sa classe
 * (`occupancyClass`) est celle du filtre. « Occupé » retient donc aussi un bien occupé par son
 * propriétaire ou squatté.
 */
export function matchesOccupancyFilter(
  status: string | null | undefined,
  filter: OccupancyClass,
): boolean {
  return occupancyClass(status) === filter;
}

/** Les codes de la base qu'un filtre « Occupation » retient : ce que compare la recherche serveur. */
export function occupancyClassCodes(filter: OccupancyClass): string[] {
  return OCCUPANCY_STATUS_CODES.filter((code) => matchesOccupancyFilter(code, filter));
}
