// OSM static tile helpers.
// Single tile at zoom 15 ≈ 1.2km wide — perfect for a card thumbnail.

const OSM_BASE = "https://tile.openstreetmap.org";

function lng2tileX(lng: number, z: number) {
  return ((lng + 180) / 360) * Math.pow(2, z);
}
function lat2tileY(lat: number, z: number) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

export function osmTileUrl(lat: number, lng: number, z = 15): string {
  const x = Math.floor(lng2tileX(lng, z));
  const y = Math.floor(lat2tileY(lat, z));
  return `${OSM_BASE}/${z}/${x}/${y}.png`;
}

/** Returns the marker position inside the tile as percentages (0-100). */
export function osmTileMarkerPct(lat: number, lng: number, z = 15) {
  const fx = lng2tileX(lng, z);
  const fy = lat2tileY(lat, z);
  return {
    left: (fx - Math.floor(fx)) * 100,
    top: (fy - Math.floor(fy)) * 100,
  };
}
