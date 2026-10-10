import type {
  LandCoordinates,
  LandGeometry,
  LandLocationInput,
  LandParcelReference,
} from "../land-report-types";
import { asRecord, decimalCommaNumberValue } from "@/lib/guards";

const MAX_GEOMETRY_POSITIONS = 100_000;

const ALLOWED_LINK_HOSTS = new Set([
  "apicarto.ign.fr",
  "data.geopf.fr",
  "geoportail-urbanisme.gouv.fr",
  "www.geoportail-urbanisme.gouv.fr",
]);

export type JsonRecord = Record<string, unknown>;
export type GeoJsonFeature = {
  type?: unknown;
  id?: unknown;
  geometry?: unknown;
  properties?: unknown;
};

export function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

export function codeInseeValue(value: unknown): string | null {
  const code = text(value);
  return code && /^(?:\d{5}|2[AB]\d{3})$/.test(code) ? code : null;
}

export function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  const parsed = decimalCommaNumberValue(value);
  return parsed != null && parsed >= min && parsed <= max ? parsed : null;
}

export function propertiesOf(feature: GeoJsonFeature): JsonRecord {
  return asRecord(feature.properties);
}

export function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isLandGeometry(value: unknown): value is LandGeometry {
  if (!value || typeof value !== "object") return false;
  const geometry = value as { type?: unknown; coordinates?: unknown };
  let positions = 0;
  const isPosition = (candidate: unknown): candidate is number[] => {
    if (!Array.isArray(candidate) || candidate.length < 2) return false;
    const longitude = candidate[0];
    const latitude = candidate[1];
    if (
      typeof longitude !== "number" ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      typeof latitude !== "number" ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      return false;
    }
    for (const coordinate of candidate) {
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) return false;
    }
    positions += 1;
    return positions <= MAX_GEOMETRY_POSITIONS;
  };
  const isRing = (candidate: unknown): candidate is number[][] => {
    if (!Array.isArray(candidate) || candidate.length < 4) return false;
    for (const position of candidate) {
      if (!isPosition(position)) return false;
    }
    const first = candidate[0];
    const last = candidate[candidate.length - 1];
    return (
      Array.isArray(first) && Array.isArray(last) && first[0] === last[0] && first[1] === last[1]
    );
  };
  const isPolygonCoordinates = (candidate: unknown): candidate is number[][][] => {
    if (!Array.isArray(candidate) || candidate.length === 0) return false;
    for (const ring of candidate) {
      if (!isRing(ring)) return false;
    }
    return true;
  };
  if (geometry.type === "Polygon") {
    return isPolygonCoordinates(geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return false;
    for (const polygon of geometry.coordinates) {
      if (!isPolygonCoordinates(polygon)) return false;
    }
    return true;
  }
  return false;
}

export function geometryOf(feature: GeoJsonFeature): LandGeometry | null {
  const direct = feature.geometry;
  if (isLandGeometry(direct)) return direct;
  const properties = propertiesOf(feature);
  return isLandGeometry(properties.truegeometry) ? properties.truegeometry : null;
}

export function safeOfficialUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const allowed = ALLOWED_LINK_HOSTS.has(host);
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

export function featureIdentity(feature: GeoJsonFeature): string {
  const properties = propertiesOf(feature);
  const direct = text(feature.id);
  if (direct) return direct;
  for (const key of ["gid", "id", "gpu_doc_id", "idu", "idzone", "idass", "idgen"]) {
    const value = text(properties[key]);
    if (value) return value;
  }
  return JSON.stringify({ geometry: feature.geometry, properties });
}

export function normaliseReference(
  reference: LandParcelReference,
  input: LandLocationInput,
  allowInputCodeInsee: boolean,
) {
  const codeInsee =
    codeInseeValue(reference.codeInsee) ??
    (allowInputCodeInsee ? codeInseeValue(input.codeInsee) : null);
  const section = text(reference.section)?.toUpperCase() ?? "";
  const rawNumber = text(reference.number) ?? "";
  const number = /^\d+$/.test(rawNumber) ? rawNumber.padStart(4, "0") : rawNumber;
  if (!codeInsee || !section || !number) return null;
  return { ...reference, codeInsee, section, number };
}

export function normaliseComparable(value: unknown): string {
  return (text(value) ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function geocodeCandidateCoordinates(feature: GeoJsonFeature): LandCoordinates | null {
  const geometry = asRecord(feature.geometry);
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const longitude = finiteCoordinate(coordinates[0], -180, 180);
  const latitude = finiteCoordinate(coordinates[1], -90, 90);
  if (longitude == null || latitude == null) return null;
  return { longitude, latitude };
}
