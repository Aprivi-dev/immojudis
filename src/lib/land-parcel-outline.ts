/**
 * Outlines of the parcels found by the land report, ready to draw on the
 * cadastral plan. A parcel cited by the listing or the dossier is « confirmed »;
 * one found around the address point is only probable.
 */
import type { LandGeometry, LandParcel } from "./land-report-types";

export type ParcelOutline = {
  id: string;
  label: string;
  confirmed: boolean;
  geometry: LandGeometry;
};

export type ParcelOutlines = {
  outlines: ParcelOutline[];
  /** [[west, south], [east, north]] */
  bounds: [[number, number], [number, number]];
  center: { lat: number; lng: number };
  confirmed: boolean;
};

function rings(geometry: LandGeometry): number[][][] {
  return geometry.type === "Polygon"
    ? (geometry.coordinates as number[][][])
    : (geometry.coordinates as number[][][][]).flat();
}

export function parcelOutlines(parcels: LandParcel[]): ParcelOutlines | null {
  const outlines = parcels
    .filter((parcel) => parcel.geometry && rings(parcel.geometry).length > 0)
    .map((parcel) => ({
      id: parcel.id,
      label: `Section ${parcel.section} n° ${parcel.number}`,
      confirmed: parcel.match !== "address_point",
      geometry: parcel.geometry,
    }));
  const points = outlines
    .flatMap((outline) => rings(outline.geometry).flat())
    .filter(
      (point) =>
        point.length >= 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]) &&
        Math.abs(point[0]!) <= 180 &&
        Math.abs(point[1]!) <= 90,
    );
  if (!outlines.length || !points.length) return null;
  const west = Math.min(...points.map((point) => point[0]!));
  const east = Math.max(...points.map((point) => point[0]!));
  const south = Math.min(...points.map((point) => point[1]!));
  const north = Math.max(...points.map((point) => point[1]!));
  return {
    outlines,
    bounds: [
      [west, south],
      [east, north],
    ],
    center: { lat: (south + north) / 2, lng: (west + east) / 2 },
    confirmed: outlines.some((outline) => outline.confirmed),
  };
}
