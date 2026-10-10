import "server-only";
import type { DvfFeature, Ring } from "@/lib/market-server/types";

function outerRings(geometry: DvfFeature["geometry"]): Ring[] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const coords = geometry.coordinates as unknown[];
  if (geometry.type === "MultiPolygon") {
    return coords
      .map((polygon) => firstRing(polygon))
      .filter((ring): ring is Ring => ring !== null);
  }
  if (geometry.type === "Polygon") {
    const ring = firstRing(coords);
    return ring ? [ring] : [];
  }
  return [];
}

function firstRing(polygon: unknown): Ring | null {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const ring = polygon[0];
  if (!Array.isArray(ring)) return null;
  const cleaned: Ring = [];
  for (const point of ring) {
    if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") {
      cleaned.push([point[0], point[1]]);
    }
  }
  return cleaned.length >= 3 ? cleaned : null;
}

function ringCentroid(ring: Ring): [number, number] {
  let x = 0;
  let y = 0;
  for (const [lng, lat] of ring) {
    x += lng;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

export function featureCentroid(geometry: DvfFeature["geometry"]): [number, number] | null {
  const rings = outerRings(geometry);
  if (rings.length === 0) return null;
  return ringCentroid(rings[0]);
}

function pointInRing(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInFeature(
  geometry: DvfFeature["geometry"],
  lng: number,
  lat: number,
): boolean {
  return outerRings(geometry).some((ring) => pointInRing(ring, lng, lat));
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radius = 6_371_000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

export function bboxAround(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { xmin: lng - dLng, ymin: lat - dLat, xmax: lng + dLng, ymax: lat + dLat };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
