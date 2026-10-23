import { isInMetropolitanFrance } from "@/lib/search/map-framing";

type Box = { south: number; north: number; west: number; east: number };

/** Départements et régions d'outre-mer : des rectangles serrés autour de chaque territoire. */
const OVERSEAS_BOXES: readonly Box[] = [
  // Guadeloupe, Saint-Barthélemy, Saint-Martin
  { south: 15.8, north: 18.2, west: -63.2, east: -60.9 },
  // Martinique
  { south: 14.3, north: 14.95, west: -61.3, east: -60.7 },
  // Guyane
  { south: 2.0, north: 5.9, west: -54.7, east: -51.5 },
  // La Réunion
  { south: -21.5, north: -20.8, west: 55.1, east: 55.9 },
  // Mayotte
  { south: -13.1, north: -12.5, west: 44.9, east: 45.4 },
  // Saint-Pierre-et-Miquelon
  { south: 46.7, north: 47.2, west: -56.5, east: -56.0 },
];

/**
 * Vrai si le point tombe en France métropolitaine (Corse comprise) ou dans un territoire d'outre-mer
 * (DROM). Écarte (0, 0), les coordonnées inversées (latitude et longitude échangées) et les points
 * sans rapport avec la France, que ±90/±180 laissent passer.
 */
export function isInFrance(latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (isInMetropolitanFrance(latitude, longitude)) return true;
  return OVERSEAS_BOXES.some(
    (box) =>
      latitude >= box.south &&
      latitude <= box.north &&
      longitude >= box.west &&
      longitude <= box.east,
  );
}
