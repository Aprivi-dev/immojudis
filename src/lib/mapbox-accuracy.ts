const round = (value: number) => Number(value.toFixed(6));

/**
 * Disque d'incertitude autour d'un point : polygone GeoJSON de 24 côtés dont le rayon est en mètres.
 * Il sert à l'image fixe (recouvrement `geojson(...)` de l'API Static Images) et à la carte animée de
 * la vue aérienne. Module à part de `mapbox.ts` : celui-ci est recopié dans une dizaine de chunks.
 */
export function uncertaintyCircle(lat: number, lng: number, meters: number) {
  const dLat = meters / 111_320;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const ring = Array.from({ length: 25 }, (_, index) => {
    const angle = (index % 24) * (Math.PI / 12);
    return [round(lng + dLng * Math.cos(angle)), round(lat + dLat * Math.sin(angle))];
  });
  return { type: "Polygon" as const, coordinates: [ring] };
}

/** Recouvrement `geojson(...)` du disque, à passer à `mapboxStaticImageUrl({ overlay })`. */
export function uncertaintyOverlay(lat: number, lng: number, meters: number) {
  const feature = {
    type: "Feature",
    properties: { stroke: "#ffffff", "stroke-width": 2, fill: "#ffffff", "fill-opacity": 0.2 },
    geometry: uncertaintyCircle(lat, lng, meters),
  };
  return `geojson(${encodeURIComponent(JSON.stringify(feature))})`;
}
