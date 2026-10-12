import { normalizeFrenchSearchText, resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";

/**
 * A boundary returned by the French government's administrative geography API.
 * The catalogue draws this shape as a reading aid only; it never replaces the
 * sale query or invents a geometry from the positions of the results.
 */
export type GeographicBoundaryLevel = "commune" | "department" | "region";

export type GeographicBoundaryGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export type GeographicBoundaryFeature = {
  type: "Feature";
  geometry: GeographicBoundaryGeometry;
  properties: {
    code?: string;
    nom?: string;
    codeDepartement?: string;
    codeRegion?: string;
  };
};

export type GeographicBoundary = {
  type: "FeatureCollection";
  features: GeographicBoundaryFeature[];
  label: string;
  level: GeographicBoundaryLevel;
  bbox: [west: number, south: number, east: number, north: number];
  sourceUrl: "https://www.data.gouv.fr/datasets/contours-administratifs";
};

type BoundaryRequest = {
  endpoint: "communes" | "departements" | "regions";
  level: GeographicBoundaryLevel;
  params: Record<string, string>;
};

type BoundaryFetchOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

export class GeographicBoundaryUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "GeographicBoundaryUpstreamError";
    this.status = options?.status;
  }

  readonly status: number | undefined;
}

const GEO_API_ORIGIN = "https://geo.api.gouv.fr";
const ETALAB_CONTOURS_ORIGIN =
  "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/latest/geojson";
const SOURCE_URL = "https://www.data.gouv.fr/datasets/contours-administratifs" as const;
const MAX_LABEL_LENGTH = 120;
const UPSTREAM_TIMEOUT_MS = 8_000;

const COMMUNE_BOUNDARY_FIELDS = "nom,code,codeDepartement,codeRegion";
const DEPARTMENT_BOUNDARY_FIELDS = "nom,code,codeRegion";
const REGION_BOUNDARY_FIELDS = "nom,code";

/**
 * Resolve the selected search label to one official contour. Exact matching
 * is intentional: a city name shared by several communes must not result in
 * a silently wrong contour on the map.
 */
export async function fetchGeographicBoundary(
  label: string | null | undefined,
  options: BoundaryFetchOptions = {},
): Promise<GeographicBoundary | null> {
  const request = boundaryRequestForLabel(label);
  if (!request) return null;

  const url = buildGeographicBoundaryUrl(request);
  const timeoutController = options.signal ? null : new AbortController();
  const timeoutId = timeoutController
    ? setTimeout(() => timeoutController.abort(), UPSTREAM_TIMEOUT_MS)
    : null;

  try {
    const response = await (options.fetcher ?? fetch)(url, {
      headers: { accept: "application/geo+json, application/json" },
      signal: options.signal ?? timeoutController?.signal,
      next: { revalidate: 86_400 },
    });
    if (!response.ok) {
      throw new GeographicBoundaryUpstreamError(
        `Le référentiel géographique a répondu ${response.status}.`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      throw new GeographicBoundaryUpstreamError("Réponse GeoJSON invalide.", { cause: error });
    }
    return parseGeographicBoundary(payload, request, label ?? "");
  } catch (error) {
    if (error instanceof GeographicBoundaryUpstreamError) throw error;
    if (options.signal?.aborted) throw error;
    throw new GeographicBoundaryUpstreamError("Référentiel géographique indisponible.", {
      cause: error,
    });
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

export function boundaryRequestForLabel(label: string | null | undefined): BoundaryRequest | null {
  const raw = label?.trim().slice(0, MAX_LABEL_LENGTH) ?? "";
  if (!raw) return null;

  const resolution = resolveFrenchGeoSearch(raw);
  if (resolution.kind === "empty") return null;

  if (resolution.kind === "region") {
    return {
      endpoint: "regions",
      level: "region",
      params: { nom: regionApiLabel(raw), fields: REGION_BOUNDARY_FIELDS },
    };
  }

  if (resolution.kind === "department") {
    const [code] = resolution.departments;
    return {
      endpoint: "departements",
      level: "department",
      params: { code, fields: DEPARTMENT_BOUNDARY_FIELDS },
    };
  }

  if (resolution.kind === "postal_code") {
    return {
      endpoint: "communes",
      level: "commune",
      params: { codePostal: resolution.postalCode, fields: COMMUNE_BOUNDARY_FIELDS },
    };
  }

  return {
    endpoint: "communes",
    level: "commune",
    params: { nom: raw, fields: COMMUNE_BOUNDARY_FIELDS, boost: "population" },
  };
}

export function buildGeographicBoundaryUrl(request: BoundaryRequest): string {
  if (request.endpoint === "departements") {
    return `${ETALAB_CONTOURS_ORIGIN}/departements-1000m.geojson`;
  }
  if (request.endpoint === "regions") {
    return `${ETALAB_CONTOURS_ORIGIN}/regions-1000m.geojson`;
  }

  const params = new URLSearchParams({
    ...request.params,
    format: "geojson",
    geometry: "contour",
  });
  return `${GEO_API_ORIGIN}/communes?${params.toString()}`;
}

export function parseGeographicBoundary(
  payload: unknown,
  request: BoundaryRequest,
  requestedLabel: string,
): GeographicBoundary | null {
  const candidates = normalizeFeatures(payload);
  if (!candidates.length) return null;

  const requestedNames = new Set(
    [request.params.nom, stripAdministrativePrefix(requestedLabel)]
      .filter(Boolean)
      .map((value) => normalizeFrenchSearchText(value)),
  );
  const exactMatches = candidates.filter((feature) => {
    const name = feature.properties.nom;
    return Boolean(name && requestedNames.has(normalizeFrenchSearchText(name)));
  });

  // A numeric department code and a postal code do not appear in `nom`.
  // For those requests the endpoint is already exact, while a postal code
  // may legitimately span several communes and is therefore left hidden.
  const matches =
    request.level === "department" && request.params.code
      ? candidates.filter(
          (feature) =>
            feature.properties.code?.trim().toUpperCase() ===
            request.params.code.trim().toUpperCase(),
        )
      : request.level === "commune" && request.params.codePostal
        ? candidates
        : exactMatches;
  if (matches.length !== 1) return null;

  const feature = matches[0];
  const bbox = bboxForGeometry(feature.geometry);
  if (!bbox) return null;

  return {
    type: "FeatureCollection",
    features: [feature],
    label: feature.properties.nom ?? requestedLabel.trim(),
    level: request.level,
    bbox,
    sourceUrl: SOURCE_URL,
  };
}

function normalizeFeatures(payload: unknown): GeographicBoundaryFeature[] {
  const rawFeatures =
    isRecord(payload) && payload.type === "FeatureCollection" && Array.isArray(payload.features)
      ? payload.features
      : isRecord(payload) && payload.type === "Feature"
        ? [payload]
        : [];

  return rawFeatures.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.type !== "Feature") return [];
    const geometry = candidate.geometry;
    if (!isRecord(geometry)) return [];
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return [];
    if (!validCoordinates(geometry.coordinates, geometry.type)) return [];
    const properties = isRecord(candidate.properties) ? candidate.properties : {};
    return [
      {
        type: "Feature" as const,
        geometry: {
          type: geometry.type,
          coordinates: geometry.coordinates,
        } as GeographicBoundaryGeometry,
        properties: {
          code: stringOrUndefined(properties.code),
          nom: stringOrUndefined(properties.nom),
          codeDepartement: stringOrUndefined(properties.codeDepartement),
          codeRegion: stringOrUndefined(properties.codeRegion),
        },
      },
    ];
  });
}

function bboxForGeometry(
  geometry: GeographicBoundaryGeometry,
): [west: number, south: number, east: number, north: number] | null {
  const coordinates: number[][] = [];
  collectCoordinatePairs(geometry.coordinates, coordinates);
  if (!coordinates.length) return null;

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of coordinates) {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

function collectCoordinatePairs(value: unknown, target: number[][]) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && value.every((item) => typeof item === "number")) {
    const lng = Number(value[0]);
    const lat = Number(value[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) target.push([lng, lat]);
    return;
  }
  for (const item of value) collectCoordinatePairs(item, target);
}

function validCoordinates(value: unknown, type: "Polygon" | "MultiPolygon") {
  if (!Array.isArray(value)) return false;
  const minimumDepth = type === "Polygon" ? 3 : 4;
  return hasCoordinateDepth(value, minimumDepth);
}

function hasCoordinateDepth(value: unknown, depth: number): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (depth === 1) {
    return (
      value.length >= 2 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    );
  }
  return value.every((item) => hasCoordinateDepth(item, depth - 1));
}

function regionApiLabel(value: string) {
  const normalized = normalizeFrenchSearchText(stripAdministrativePrefix(value));
  const aliases: Record<string, string> = {
    ara: "Auvergne-Rhône-Alpes",
    bfc: "Bourgogne-Franche-Comté",
    idf: "Île-de-France",
    paca: "Provence-Alpes-Côte d'Azur",
    reunion: "La Réunion",
  };
  return aliases[normalized] ?? stripAdministrativePrefix(value);
}

function stripAdministrativePrefix(value: string) {
  return value
    .trim()
    .replace(/^(?:région|region|département|departement|dept)\s+/i, "")
    .replace(/^(?:du|de la|de l|des|de|d')\s+/i, "")
    .trim();
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
