/**
 * Cadrage de la carte du catalogue : la France métropolitaine (Corse comprise), jamais
 * l'Afrique du Nord ni l'Atlantique que produisent des coordonnées inversées ou erronées.
 */
export const METROPOLITAN_FRANCE_BOUNDS = {
  west: -5.8,
  south: 41.0,
  east: 9.8,
  north: 51.5,
} as const;

export function isInMetropolitanFrance(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= METROPOLITAN_FRANCE_BOUNDS.south &&
    latitude <= METROPOLITAN_FRANCE_BOUNDS.north &&
    longitude >= METROPOLITAN_FRANCE_BOUNDS.west &&
    longitude <= METROPOLITAN_FRANCE_BOUNDS.east
  );
}

/** Les points qui servent à cadrer la carte : ceux qui sont plausiblement en métropole. */
export function framingPoints<T extends { latitude: number; longitude: number }>(
  points: readonly T[],
): T[] {
  return points.filter((point) => isInMetropolitanFrance(point.latitude, point.longitude));
}

/** Libellé d'un groupe de ventes sur la carte : un nombre de ventes, jamais un prix. */
export function clusterSalesLabel(count: number): string {
  return `${count.toLocaleString("fr-FR")} vente${count > 1 ? "s" : ""}`;
}
