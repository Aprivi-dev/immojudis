import type {
  LandConstraint,
  LandCoordinates,
  LandGeometry,
  LandLocationInput,
  LandParcel,
  LandParcelReference,
  LandPlanningDocument,
  LandPlanningResult,
  LandProviderOptions,
  LandSourceCheck,
  LandSourceStatus,
  LandZone,
} from "./land-report-types";
import { asRecord, decimalCommaNumberValue } from "@/lib/guards";

const API_CARTO_BASE_URL = "https://apicarto.ign.fr/api";
const CADASTRE_URL = `${API_CARTO_BASE_URL}/cadastre/parcelle`;
const GEOCODING_URL = "https://data.geopf.fr/geocodage/search";
const GPU_BASE_URL = `${API_CARTO_BASE_URL}/gpu`;
const GPU_DOCUMENT_API_BASE_URL = "https://www.geoportail-urbanisme.gouv.fr/api";
const DEFAULT_TIMEOUT_MS = 7_500;
const DEFAULT_MAX_PARCELS = 4;
const DEFAULT_MAX_FEATURES_PER_LAYER = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_LINKS_PER_DOCUMENT = 64;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_GEOMETRY_POSITIONS = 100_000;
const MAX_TIMEOUT_MS = 30_000;
const MIN_GEOCODE_SCORE = 0.65;

const ALLOWED_LINK_HOSTS = new Set([
  "apicarto.ign.fr",
  "data.geopf.fr",
  "geoportail-urbanisme.gouv.fr",
  "www.geoportail-urbanisme.gouv.fr",
]);

const GPU_LAYER_DEFINITIONS = [
  { key: "document", endpoint: "document", label: "Documents d’urbanisme" },
  { key: "zone-urba", endpoint: "zone-urba", label: "Zonage d’urbanisme" },
  {
    key: "prescription-surf",
    endpoint: "prescription-surf",
    label: "Prescriptions surfaciques",
  },
  {
    key: "prescription-lin",
    endpoint: "prescription-lin",
    label: "Prescriptions linéaires",
  },
  {
    key: "prescription-pct",
    endpoint: "prescription-pct",
    label: "Prescriptions ponctuelles",
  },
  { key: "info-surf", endpoint: "info-surf", label: "Informations surfaciques" },
  { key: "info-lin", endpoint: "info-lin", label: "Informations linéaires" },
  { key: "info-pct", endpoint: "info-pct", label: "Informations ponctuelles" },
  { key: "assiette-sup-s", endpoint: "assiette-sup-s", label: "Assiettes SUP surfaciques" },
  { key: "assiette-sup-l", endpoint: "assiette-sup-l", label: "Assiettes SUP linéaires" },
  { key: "assiette-sup-p", endpoint: "assiette-sup-p", label: "Assiettes SUP ponctuelles" },
] as const;

type ProviderOptions = LandProviderOptions & {
  maxFeaturesPerLayer?: number;
  maxParcels?: number;
  maxPages?: number;
  maxResponseBytes?: number;
};

type JsonRecord = Record<string, unknown>;
type GeoJsonFeature = {
  type?: unknown;
  id?: unknown;
  geometry?: unknown;
  properties?: unknown;
};

type FetchIssue = {
  kind: "timeout" | "http" | "network" | "invalid_payload";
  message: string;
  retriable: boolean;
  httpStatus?: number;
};

type FetchJsonResult =
  | { ok: true; data: unknown; httpStatus: number }
  | { ok: false; issue: FetchIssue };

type CollectionResult = {
  features: GeoJsonFeature[];
  status: "available" | "empty" | "partial" | "unavailable";
  issue?: FetchIssue;
  httpStatus?: number;
  sourceUpdatedAt?: string;
};

type ParcelResolution = {
  parcels: LandParcel[];
  status: LandSourceStatus;
  scope: "parcel" | "point";
  pointOnly: boolean;
  warnings: string[];
  checkUrl: string;
  issue?: FetchIssue;
  httpStatus?: number;
};

type TargetGeometry = {
  geometry: LandGeometry | { type: "Point"; coordinates: [number, number] };
  parcelIds: string[];
  scope: "parcel" | "point";
};

type FeatureWithParcels = {
  feature: GeoJsonFeature;
  parcelIds: Set<string>;
};

type DocumentMeta = {
  document: LandPlanningDocument;
  rawFiles: string[];
  procedurePresent: boolean;
  oapPresent: boolean;
  detailIssue?: FetchIssue;
};

type LocationResolution = {
  coordinates: LandLocationInput["coordinates"];
  codeInsee: string | null;
  geocodeCheck: LandSourceCheck;
  warnings: string[];
};

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function codeInseeValue(value: unknown): string | null {
  const code = text(value);
  return code && /^(?:\d{5}|2[AB]\d{3})$/.test(code) ? code : null;
}

function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  const parsed = decimalCommaNumberValue(value);
  return parsed != null && parsed >= min && parsed <= max ? parsed : null;
}

function propertiesOf(feature: GeoJsonFeature): JsonRecord {
  return asRecord(feature.properties);
}

function isRecordArray(value: unknown): value is unknown[] {
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

function geometryOf(feature: GeoJsonFeature): LandGeometry | null {
  const direct = feature.geometry;
  if (isLandGeometry(direct)) return direct;
  const properties = propertiesOf(feature);
  return isLandGeometry(properties.truegeometry) ? properties.truegeometry : null;
}

function safeOfficialUrl(value: unknown): string | null {
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

function featureIdentity(feature: GeoJsonFeature): string {
  const properties = propertiesOf(feature);
  const direct = text(feature.id);
  if (direct) return direct;
  for (const key of ["gid", "id", "gpu_doc_id", "idu", "idzone", "idass", "idgen"]) {
    const value = text(properties[key]);
    if (value) return value;
  }
  return JSON.stringify({ geometry: feature.geometry, properties });
}

function normaliseReference(
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

function normaliseComparable(value: unknown): string {
  return (text(value) ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function geocodeCandidateCoordinates(feature: GeoJsonFeature): LandCoordinates | null {
  const geometry = asRecord(feature.geometry);
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const longitude = finiteCoordinate(coordinates[0], -180, 180);
  const latitude = finiteCoordinate(coordinates[1], -90, 90);
  if (longitude == null || latitude == null) return null;
  return { longitude, latitude };
}

type GeocodeCandidate = {
  coordinates: LandCoordinates;
  score: number | null;
  codeInsee: string | null;
  city: string | null;
  postalCode: string | null;
  label: string | null;
};

function geocodeCandidates(data: unknown): GeocodeCandidate[] | null {
  const features = collectionFeatures(data);
  if (!features) return null;
  return features.flatMap((feature) => {
    const coordinates = geocodeCandidateCoordinates(feature);
    if (!coordinates) return [];
    const properties = propertiesOf(feature);
    return [
      {
        coordinates,
        score: decimalCommaNumberValue(properties.score),
        codeInsee: codeInseeValue(
          properties.citycode ??
            properties.city_code ??
            properties.code_insee ??
            properties.municipalitycode,
        ),
        city: text(properties.city ?? properties.municipality),
        postalCode: text(properties.postcode ?? properties.postalcode),
        label: text(properties.label),
      },
    ];
  });
}

function geocodeCandidateMatches(candidate: GeocodeCandidate, input: LandLocationInput): boolean {
  const expectedCity = normaliseComparable(input.city);
  const candidateCity = normaliseComparable(candidate.city);
  if (expectedCity) {
    if (candidateCity && candidateCity !== expectedCity) return false;
    if (
      !candidateCity &&
      candidate.label &&
      !normaliseComparable(candidate.label).includes(expectedCity)
    ) {
      return false;
    }
  }
  const expectedPostal = text(input.postalCode)?.replace(/\s+/g, "");
  const candidatePostal = candidate.postalCode?.replace(/\s+/g, "");
  if (expectedPostal && candidatePostal && !candidatePostal.startsWith(expectedPostal))
    return false;
  return true;
}

function geocodeCheck(
  now: () => Date,
  status: LandSourceStatus,
  sourceUrl: string,
  message?: string,
  httpStatus?: number,
): LandSourceCheck {
  return {
    key: "geocode.address",
    label: "Géocodage de l’adresse",
    status,
    scope: "point",
    sourceUrl,
    checkedAt: nowIso(now),
    ...(message ? { message } : {}),
    ...(httpStatus ? { httpStatus } : {}),
  };
}

async function resolveLocation(
  input: LandLocationInput,
  options: ProviderOptions,
  now: () => Date,
): Promise<LocationResolution> {
  const longitude = finiteCoordinate(input.coordinates?.longitude, -180, 180);
  const latitude = finiteCoordinate(input.coordinates?.latitude, -90, 90);
  const inputCoordinates = longitude != null && latitude != null ? { longitude, latitude } : null;
  const address = text(input.address);

  if (!address) {
    const hasCityOnly = Boolean(text(input.city) || text(input.postalCode));
    return {
      coordinates: inputCoordinates,
      codeInsee: null,
      geocodeCheck: geocodeCheck(
        now,
        "not_checked",
        GEOCODING_URL,
        hasCityOnly
          ? "Une ville seule n’est pas utilisée comme point cadastral ; une référence explicite ou des coordonnées sont nécessaires."
          : "Aucune adresse à géocoder ; les références explicites ou les coordonnées fournies sont utilisées.",
      ),
      warnings:
        hasCityOnly && !inputCoordinates
          ? ["La ville seule ne permet pas de déduire une parcelle cadastrale."]
          : [],
    };
  }

  const query = [address, text(input.postalCode), text(input.city)].filter(Boolean).join(", ");
  const url = queryUrl(GEOCODING_URL, { q: query, limit: 5 });
  const response = await fetchJson(url, options);
  if (!response.ok) {
    return {
      coordinates: inputCoordinates,
      codeInsee: null,
      geocodeCheck: geocodeCheck(
        now,
        "unavailable",
        url,
        response.issue.message,
        response.issue.httpStatus,
      ),
      warnings: [
        "Le géocodage de l’adresse est indisponible ; aucun code commune stocké n’est repris comme preuve.",
      ],
    };
  }

  const candidates = geocodeCandidates(response.data);
  if (!candidates) {
    const message =
      "La réponse officielle de géocodage n’est pas une FeatureCollection exploitable.";
    return {
      coordinates: inputCoordinates,
      codeInsee: null,
      geocodeCheck: geocodeCheck(now, "unavailable", url, message, response.httpStatus),
      warnings: [message],
    };
  }
  const matching = candidates
    .filter((candidate) => geocodeCandidateMatches(candidate, input))
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  const candidate = matching[0];
  if (!candidate || candidate.score == null || candidate.score < MIN_GEOCODE_SCORE) {
    const message = candidate
      ? `Aucun résultat d’adresse suffisamment fiable (score inférieur à ${MIN_GEOCODE_SCORE}).`
      : "Aucun résultat de géocodage ne correspond à la ville ou au code postal fourni.";
    return {
      coordinates: inputCoordinates,
      codeInsee: null,
      geocodeCheck: geocodeCheck(now, "empty", url, message, response.httpStatus),
      warnings: [
        "Le géocodage n’a pas produit de commune suffisamment fiable ; aucune parcelle n’est déduite de l’adresse.",
      ],
    };
  }

  const warnings: string[] = [];
  const inputCodeInsee = text(input.codeInsee);
  if (inputCodeInsee && candidate.codeInsee && inputCodeInsee !== candidate.codeInsee) {
    warnings.push(
      `Le code commune stocké (${inputCodeInsee}) contredit le géocodage officiel (${candidate.codeInsee}) ; le code stocké est écarté.`,
    );
  }
  if (candidate.score < 0.8) {
    warnings.push(
      `Le géocodage est exploitable mais son score reste modéré (${candidate.score.toFixed(2)}).`,
    );
  }
  return {
    coordinates: candidate.coordinates,
    codeInsee: candidate.codeInsee,
    geocodeCheck: geocodeCheck(
      now,
      "available",
      url,
      `Adresse rapprochée avec un score de ${candidate.score.toFixed(2)}${candidate.codeInsee ? `, commune ${candidate.codeInsee}` : ""}.`,
      response.httpStatus,
    ),
    warnings,
  };
}

function referenceKey(codeInsee: string, section: string, number: string): string {
  return `${codeInsee}-${section.toUpperCase()}-${number.padStart(4, "0")}`;
}

function sourceMatch(reference: LandParcelReference): LandParcel["match"] {
  if (reference.source === "document") return "document_reference";
  if (reference.source === "stored") return "stored_reference";
  return "listing_reference";
}

function queryUrl(base: string, parameters: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Erreur réseau inconnue";
}

type ResponseBytesResult = { ok: true; bytes: Uint8Array } | { ok: false; message: string };

async function readResponseBytes(
  response: Response,
  maxResponseBytes: number,
  timeoutPromise: Promise<never>,
): Promise<ResponseBytesResult> {
  if (!response.body) {
    const bytes = await Promise.race([response.arrayBuffer(), timeoutPromise]);
    if (bytes.byteLength > maxResponseBytes) {
      return {
        ok: false,
        message: `Réponse officielle trop volumineuse (${bytes.byteLength} octets, limite ${maxResponseBytes}).`,
      };
    }
    return { ok: true, bytes: new Uint8Array(bytes) };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeoutPromise]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          message: `Réponse officielle trop volumineuse (${total} octets, limite ${maxResponseBytes}).`,
        };
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function fetchJson(url: string, options: ProviderOptions): Promise<FetchJsonResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, MAX_TIMEOUT_MS);
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1_024,
    MAX_RESPONSE_BYTES,
  );
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const headers: Record<string, string> = {
    Accept: "application/geo+json, application/json",
  };
  const token = text(options.token);
  if (token) headers.Authorization = `Bearer ${token}`;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("LAND_PROVIDER_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetcher(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      return {
        ok: false,
        issue: {
          kind: "http",
          message: `Réponse HTTP ${response.status} depuis ${new URL(url).hostname}`,
          retriable: response.status >= 500 || response.status === 429,
          httpStatus: response.status,
        },
      };
    }
    const declaredLength = decimalCommaNumberValue(response.headers.get("content-length"));
    if (declaredLength != null && declaredLength > maxResponseBytes) {
      return {
        ok: false,
        issue: {
          kind: "invalid_payload",
          message: `Réponse officielle trop volumineuse (${declaredLength} octets, limite ${maxResponseBytes}).`,
          retriable: false,
          httpStatus: response.status,
        },
      };
    }
    let data: unknown;
    try {
      const body = await readResponseBytes(response, maxResponseBytes, timeoutPromise);
      if (!body.ok) {
        return {
          ok: false,
          issue: {
            kind: "invalid_payload",
            message: body.message,
            retriable: false,
            httpStatus: response.status,
          },
        };
      }
      data = JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
    } catch (error) {
      if (timedOut || (error instanceof Error && error.message === "LAND_PROVIDER_TIMEOUT")) {
        throw error;
      }
      return {
        ok: false,
        issue: {
          kind: "invalid_payload",
          message: "La réponse officielle n’est pas un JSON exploitable.",
          retriable: false,
          httpStatus: response.status,
        },
      };
    }
    return { ok: true, data, httpStatus: response.status };
  } catch (error) {
    if (timedOut || (error instanceof Error && error.message === "LAND_PROVIDER_TIMEOUT")) {
      return {
        ok: false,
        issue: {
          kind: "timeout",
          message: `Délai dépassé après ${timeoutMs} ms.`,
          retriable: true,
        },
      };
    }
    return {
      ok: false,
      issue: {
        kind: "network",
        message: errorMessage(error),
        retriable: true,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectionFeatures(data: unknown): GeoJsonFeature[] | null {
  const record = asRecord(data);
  if (!isRecordArray(record.features)) return null;
  return record.features.filter((feature): feature is GeoJsonFeature =>
    Boolean(feature && typeof feature === "object"),
  );
}

async function fetchCollection(
  base: string,
  parameters: Record<string, string>,
  options: ProviderOptions,
): Promise<CollectionResult> {
  const limit = Math.min(
    1_000,
    boundedInteger(options.maxFeaturesPerLayer, DEFAULT_MAX_FEATURES_PER_LAYER, 1, 1_000),
  );
  const maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 20);
  const features: GeoJsonFeature[] = [];
  let start = 0;
  let lastStatus: number | undefined;
  let sourceUpdatedAt: string | undefined;
  let issue: FetchIssue | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const url = queryUrl(base, { ...parameters, _limit: limit, _start: start });
    const response = await fetchJson(url, options);
    if (!response.ok) {
      issue = response.issue;
      if (features.length) {
        return {
          features,
          status: "partial",
          issue,
          httpStatus: lastStatus,
          sourceUpdatedAt,
        };
      }
      return { features: [], status: "unavailable", issue };
    }

    lastStatus = response.httpStatus;
    const pageFeatures = collectionFeatures(response.data);
    if (!pageFeatures) {
      issue = {
        kind: "invalid_payload",
        message: "La réponse officielle ne contient pas de FeatureCollection GeoJSON.",
        retriable: false,
        httpStatus: response.httpStatus,
      };
      return features.length
        ? { features, status: "partial", issue, httpStatus: lastStatus, sourceUpdatedAt }
        : { features: [], status: "unavailable", issue };
    }

    const oversizedPage = pageFeatures.length > limit;
    const boundedPageFeatures = pageFeatures.slice(0, limit);
    const firstUpdated = boundedPageFeatures
      .map((feature) => text(propertiesOf(feature).gpu_timestamp))
      .find(Boolean);
    sourceUpdatedAt ??= firstUpdated ?? undefined;
    features.push(...boundedPageFeatures);

    if (oversizedPage) {
      truncated = true;
      break;
    }

    const metadata = asRecord(response.data);
    const matched = decimalCommaNumberValue(metadata.numberMatched ?? metadata.totalFeatures);
    const returned = decimalCommaNumberValue(metadata.numberReturned) ?? boundedPageFeatures.length;
    const hasMoreByTotal = matched != null && start + returned < matched;
    const hasMoreByPage = matched == null && boundedPageFeatures.length >= limit;
    if (!hasMoreByTotal && !hasMoreByPage) break;
    if (page === maxPages - 1) {
      truncated = true;
      break;
    }
    start += Math.max(1, returned);
  }

  const deduped = dedupeFeatures(features);
  return {
    features: deduped,
    status: truncated ? "partial" : deduped.length ? "available" : "empty",
    httpStatus: lastStatus,
    sourceUpdatedAt,
    ...(truncated
      ? {
          issue: {
            kind: "invalid_payload" as const,
            message: `Limite de ${maxPages} page(s) atteinte.`,
            retriable: false,
          },
        }
      : {}),
  };
}

function dedupeFeatures(features: GeoJsonFeature[]): GeoJsonFeature[] {
  const seen = new Set<string>();
  return features.filter((feature) => {
    const key = featureIdentity(feature);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildParcel(
  feature: GeoJsonFeature,
  sourceUrl: string,
  match: LandParcel["match"],
): LandParcel | null {
  const properties = propertiesOf(feature);
  const geometry = geometryOf(feature);
  if (!geometry) return null;
  const codeInsee = codeInseeValue(properties.code_insee ?? properties.insee) ?? "";
  const section = text(properties.section ?? properties.section_cadastrale)?.toUpperCase() ?? "";
  const number =
    text(properties.numero ?? properties.num_parcelle ?? properties.numero_parcelle) ?? "";
  if (!codeInsee || !section || !number) return null;
  const id =
    text(properties.idu ?? properties.parcel_id ?? properties.id) ??
    featureIdentity(feature) ??
    referenceKey(codeInsee, section, number);
  return {
    id,
    codeInsee,
    section,
    number,
    prefix: text(properties.prefix ?? properties.com_abs ?? properties.prefixe) ?? "000",
    city: text(properties.nom_com ?? properties.commune ?? properties.city) ?? undefined,
    surfaceM2: decimalCommaNumberValue(
      properties.contenance ?? properties.surface ?? properties.surface_m2,
    ),
    geometry,
    match,
    sourceUrl,
  };
}

async function resolveParcels(
  input: LandLocationInput,
  options: ProviderOptions,
): Promise<ParcelResolution> {
  const maxParcels = boundedInteger(options.maxParcels, DEFAULT_MAX_PARCELS, 1, 20);
  const allowInputCodeInsee =
    Boolean(text(input.address)) ||
    (input.references ?? []).some((reference) => reference.source !== "stored");
  const references = (input.references ?? [])
    .map((reference) => normaliseReference(reference, input, allowInputCodeInsee))
    .filter((reference): reference is NonNullable<ReturnType<typeof normaliseReference>> =>
      Boolean(reference),
    )
    .slice(0, maxParcels);
  const warnings: string[] = [];
  if ((input.references?.length ?? 0) > references.length) {
    warnings.push(
      "Une ou plusieurs références cadastrales sont incomplètes : un code commune explicite est requis lorsque l’adresse n’est pas validée.",
    );
  }

  if (references.length) {
    const results = await Promise.all(
      references.map(async (reference) => {
        const prefix = text(reference.prefix);
        const url = queryUrl(CADASTRE_URL, {
          code_insee: reference.codeInsee,
          section: reference.section,
          numero: reference.number,
          prefixe: prefix ?? undefined,
          source_ign: "PCI",
          _limit: 2,
          _start: 0,
        });
        const response = await fetchCollection(
          CADASTRE_URL,
          {
            code_insee: reference.codeInsee,
            section: reference.section,
            numero: reference.number,
            ...(prefix ? { prefixe: prefix } : {}),
            source_ign: "PCI",
          },
          // A parcel reference is unique; asking for two rows lets the
          // collection helper distinguish one returned row from truncation.
          { ...options, maxFeaturesPerLayer: 2, maxPages: 1 },
        );
        return { reference, response, url };
      }),
    );
    const parcels = results.flatMap(({ reference, response, url }) =>
      response.features
        .map((feature) => buildParcel(feature, url, sourceMatch(reference)))
        .filter((parcel): parcel is LandParcel => Boolean(parcel)),
    );
    const unique = dedupeParcels(parcels);
    const issue = results.find(({ response }) => response.issue)?.response.issue;
    if (results.some(({ response }) => response.status === "unavailable") && !unique.length) {
      return {
        parcels: [],
        status: "unavailable",
        scope: "parcel",
        pointOnly: false,
        warnings: [
          ...warnings,
          "La résolution des références cadastrales officielles est indisponible.",
        ],
        checkUrl: CADASTRE_URL,
        issue,
      };
    }
    const missing = references.some(
      (reference) =>
        !unique.some(
          (parcel) =>
            parcel.codeInsee === reference.codeInsee &&
            parcel.section === reference.section &&
            parcel.number === reference.number,
        ),
    );
    if (missing)
      warnings.push(
        "Une ou plusieurs références explicites n’ont pas été retrouvées dans le cadastre officiel.",
      );
    if (unique.length > 1)
      warnings.push(
        "Plusieurs parcelles explicites sont rattachées : l’analyse reste multi-parcellaire.",
      );
    const hasUnavailable = results.some(({ response }) => response.status === "unavailable");
    const hasPartial = results.some(({ response }) => response.status === "partial");
    const status: LandSourceStatus = hasUnavailable
      ? unique.length
        ? "partial"
        : "unavailable"
      : hasPartial || (missing && unique.length)
        ? "partial"
        : unique.length
          ? "available"
          : "empty";
    return {
      parcels: unique.slice(0, maxParcels),
      status,
      scope: "parcel",
      pointOnly: false,
      warnings,
      checkUrl: CADASTRE_URL,
      issue,
      httpStatus: results.find(({ response }) => response.httpStatus)?.response.httpStatus,
    };
  }

  const longitude = finiteCoordinate(input.coordinates?.longitude, -180, 180);
  const latitude = finiteCoordinate(input.coordinates?.latitude, -90, 90);
  if (longitude == null || latitude == null) {
    return {
      parcels: [],
      status: "empty",
      scope: "point",
      pointOnly: true,
      warnings: ["Aucune référence cadastrale ni coordonnée exploitable n’est disponible."],
      checkUrl: CADASTRE_URL,
    };
  }

  const point = { type: "Point", coordinates: [longitude, latitude] } as const;
  const url = queryUrl(CADASTRE_URL, {
    geom: JSON.stringify(point),
    source_ign: "PCI",
    _limit: maxParcels,
    _start: 0,
  });
  const response = await fetchCollection(
    CADASTRE_URL,
    { geom: JSON.stringify(point), source_ign: "PCI" },
    { ...options, maxFeaturesPerLayer: maxParcels },
  );
  const parcels = dedupeParcels(
    response.features
      .map((feature) => buildParcel(feature, url, "address_point"))
      .filter((parcel): parcel is LandParcel => Boolean(parcel)),
  ).slice(0, maxParcels);
  warnings.push(
    "Le point fourni ou géocodé produit des parcelles candidates ; il ne prouve pas le rattachement juridique du bien.",
  );
  if (parcels.length > 1)
    warnings.push(
      "Plusieurs parcelles intersectent le point : aucune n’est sélectionnée automatiquement.",
    );
  return {
    parcels,
    status: response.status,
    scope: "point",
    pointOnly: true,
    warnings,
    checkUrl: url,
    issue: response.issue,
    httpStatus: response.httpStatus,
  };
}

function dedupeParcels(parcels: LandParcel[]): LandParcel[] {
  const seen = new Set<string>();
  return parcels.filter((parcel) => {
    const key = parcel.id || referenceKey(parcel.codeInsee, parcel.section, parcel.number);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function targetGeometries(parcels: LandParcel[], input: LandLocationInput): TargetGeometry[] {
  if (parcels.length) {
    return parcels.map((parcel) => ({
      geometry: parcel.geometry,
      parcelIds: [parcel.id],
      scope: "parcel" as const,
    }));
  }
  const longitude = finiteCoordinate(input.coordinates?.longitude, -180, 180);
  const latitude = finiteCoordinate(input.coordinates?.latitude, -90, 90);
  if (longitude == null || latitude == null) return [];
  return [
    {
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      parcelIds: [],
      scope: "point",
    },
  ];
}

function isConstraintLayer(layer: string): boolean {
  return (
    layer.startsWith("prescription-") ||
    layer.startsWith("info-") ||
    layer.startsWith("assiette-sup-")
  );
}

function addFeature(
  target: Map<string, FeatureWithParcels>,
  feature: GeoJsonFeature,
  parcelIds: string[],
) {
  const key = featureIdentity(feature);
  const existing = target.get(key);
  if (existing) {
    for (const parcelId of parcelIds) existing.parcelIds.add(parcelId);
    return;
  }
  target.set(key, { feature, parcelIds: new Set(parcelIds) });
}

async function fetchGpuLayers(
  targets: TargetGeometry[],
  options: ProviderOptions,
  now: () => Date,
): Promise<{
  layerFeatures: Map<string, FeatureWithParcels[]>;
  checks: LandSourceCheck[];
  issues: FetchIssue[];
}> {
  const layerFeatures = new Map<string, FeatureWithParcels[]>();
  const checks: LandSourceCheck[] = [];
  const issues: FetchIssue[] = [];

  for (const layer of GPU_LAYER_DEFINITIONS) {
    const merged = new Map<string, FeatureWithParcels>();
    const responses: CollectionResult[] = [];
    for (const target of targets) {
      const response = await fetchCollection(
        `${GPU_BASE_URL}/${layer.endpoint}`,
        { geom: JSON.stringify(target.geometry) },
        options,
      );
      responses.push(response);
      for (const feature of response.features) addFeature(merged, feature, target.parcelIds);
      if (response.issue) issues.push(response.issue);
    }
    const values = [...merged.values()];
    layerFeatures.set(layer.key, values);
    const hasUnavailable = responses.some((response) => response.status === "unavailable");
    const hasPartial = responses.some((response) => response.status === "partial");
    const hasAvailable = responses.some((response) => response.status === "available");
    const hasEmpty =
      responses.length > 0 && responses.every((response) => response.status === "empty");
    let status: LandSourceStatus = "empty";
    if (hasUnavailable && (hasAvailable || hasEmpty)) status = "partial";
    else if (hasUnavailable) status = "unavailable";
    else if (hasPartial) status = "partial";
    else if (hasAvailable) status = "available";
    const issue = responses.find((response) => response.issue)?.issue;
    const sourceUpdatedAt = responses.map((response) => response.sourceUpdatedAt).find(Boolean);
    checks.push({
      key: `gpu.${layer.key}`,
      label: layer.label,
      status,
      scope: targets.some((target) => target.scope === "parcel") ? "parcel" : "point",
      sourceUrl: `${GPU_BASE_URL}/${layer.endpoint}`,
      checkedAt: nowIso(now),
      ...(issue ? { message: issue.message, httpStatus: issue.httpStatus } : {}),
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      parcelIds: [...new Set(values.flatMap((value) => [...value.parcelIds]))],
    });
  }

  return { layerFeatures, checks, issues };
}

function documentIdentity(feature: GeoJsonFeature): string | null {
  const properties = propertiesOf(feature);
  return (
    text(properties.gpu_doc_id) ??
    text(properties.document_id) ??
    text(properties.id) ??
    text(properties.idurba) ??
    text(feature.id)
  );
}

function safeDocumentFileUrl(documentId: string, fileName: string, value: unknown): string | null {
  const provided = safeOfficialUrl(value);
  if (provided) return provided;
  const safeName = fileName.trim();
  if (!safeName) return null;
  return safeOfficialUrl(
    `${GPU_DOCUMENT_API_BASE_URL}/document/${encodeURIComponent(documentId)}/files/${encodeURIComponent(safeName)}`,
  );
}

function documentField(properties: JsonRecord, key: string): string | null {
  return text(properties[key]);
}

function mapDocumentBase(feature: GeoJsonFeature): DocumentMeta | null {
  const properties = propertiesOf(feature);
  const id = documentIdentity(feature);
  if (!id) return null;
  const name =
    documentField(properties, "name") ??
    documentField(properties, "idurba") ??
    documentField(properties, "partition") ??
    id;
  const sourceUrl = safeOfficialUrl(
    `${GPU_DOCUMENT_API_BASE_URL}/document/${encodeURIComponent(id)}/details`,
  );
  if (!sourceUrl) return null;
  const type = documentField(properties, "du_type") ?? documentField(properties, "type") ?? "GPU";
  const title =
    documentField(properties, "grid_title") ??
    documentField(properties, "title") ??
    documentField(properties, "name") ??
    name;
  return {
    document: {
      id,
      name,
      type,
      title,
      legalStatus:
        documentField(properties, "legalStatus") ?? documentField(properties, "legal_status"),
      effectiveStatus:
        documentField(properties, "effectiveStatus") ??
        documentField(properties, "effective_status"),
      publicationDate:
        documentField(properties, "publicationDate") ?? documentField(properties, "datvalid"),
      updatedAt:
        documentField(properties, "gpu_timestamp") ?? documentField(properties, "updateDate"),
      sourceUrl,
      files: [],
      downloadable: false,
    },
    rawFiles: [],
    procedurePresent: false,
    oapPresent: false,
  };
}

function documentFiles(detail: JsonRecord, documentId: string): { name: string; url: string }[] {
  const files: string[] = [];
  const rawFiles = detail.files;
  if (isRecordArray(rawFiles)) {
    for (const file of rawFiles) {
      if (typeof file === "string" && file.trim()) files.push(file.trim());
      else if (file && typeof file === "object") {
        const record = asRecord(file);
        const name = text(record.name ?? record.fileName ?? record.filename);
        if (name) files.push(name);
      }
    }
  }
  const writingMaterials = asRecord(detail.writingMaterials);
  return [...new Set(files)]
    .slice(0, MAX_LINKS_PER_DOCUMENT)
    .map((name) => ({
      name,
      url: safeDocumentFileUrl(documentId, name, writingMaterials[name]) ?? "",
    }))
    .filter((file) => Boolean(file.url));
}

async function enrichDocuments(
  layerFeatures: Map<string, FeatureWithParcels[]>,
  options: ProviderOptions,
  now: () => Date,
): Promise<{ documents: DocumentMeta[]; checks: LandSourceCheck[]; warnings: string[] }> {
  const bases = new Map<string, DocumentMeta>();
  for (const feature of layerFeatures.get("document") ?? []) {
    const base = mapDocumentBase(feature.feature);
    if (base) bases.set(base.document.id, base);
  }
  for (const feature of [...layerFeatures.values()].flat()) {
    const properties = propertiesOf(feature.feature);
    const id =
      text(properties.gpu_doc_id) ?? text(properties.document_id) ?? text(properties.idurba);
    if (id && !bases.has(id)) {
      const base = mapDocumentBase(feature.feature);
      if (base) bases.set(id, base);
    }
  }

  const warnings: string[] = [];
  const metas: DocumentMeta[] = [];
  let unavailable = false;
  let partial = false;
  for (const [id, base] of bases) {
    const url = `${GPU_DOCUMENT_API_BASE_URL}/document/${encodeURIComponent(id)}/details`;
    const response = await fetchJson(url, options);
    if (!response.ok) {
      base.detailIssue = response.issue;
      unavailable = true;
      metas.push(base);
      continue;
    }
    const detail = asRecord(response.data);
    const rawFiles = isRecordArray(detail.files)
      ? detail.files
          .map((file) =>
            typeof file === "string" ? file.trim() : (text(asRecord(file).name) ?? ""),
          )
          .filter(Boolean)
      : [];
    const files = documentFiles(detail, id);
    base.rawFiles = rawFiles;
    base.procedurePresent = rawFiles.some((file) => /proc(?:e|é)dure/i.test(file));
    base.oapPresent = rawFiles.some((file) => /(?:^|[_-])oap(?:[_\-.]|$)|orientation/i.test(file));
    base.document.files = files;
    base.document.legalStatus = text(detail.legalStatus) ?? base.document.legalStatus;
    base.document.effectiveStatus = text(detail.effectiveStatus) ?? base.document.effectiveStatus;
    base.document.publicationDate = text(detail.publicationDate) ?? base.document.publicationDate;
    base.document.updatedAt =
      text(detail.updateDate ?? detail.statusDate ?? detail.gpu_timestamp) ??
      base.document.updatedAt;
    base.document.downloadable =
      Boolean(asRecord(detail.supCategory).downloadable) || files.length > 0;
    if (!files.length && rawFiles.length) partial = true;
    metas.push(base);
  }

  const status: LandSourceStatus = !bases.size
    ? "empty"
    : unavailable && metas.some((meta) => !meta.detailIssue)
      ? "partial"
      : unavailable
        ? "unavailable"
        : partial
          ? "partial"
          : "available";
  if (unavailable)
    warnings.push("Les métadonnées détaillées d’au moins un document GPU sont indisponibles.");
  const check: LandSourceCheck = {
    key: "gpu.document-details",
    label: "Métadonnées détaillées GPU",
    status,
    scope: "document",
    sourceUrl: `${GPU_DOCUMENT_API_BASE_URL}/document`,
    checkedAt: nowIso(now),
    ...(unavailable
      ? { message: "Une ou plusieurs fiches document GPU n’ont pas pu être chargées." }
      : {}),
  };
  return { documents: metas, checks: [check], warnings };
}

function documentForId(documents: DocumentMeta[], id: string | null): DocumentMeta | undefined {
  if (!id) return undefined;
  return documents.find((document) => document.document.id === id);
}

function regulationLink(
  properties: JsonRecord,
  documents: DocumentMeta[],
  documentId: string | null,
): { url: string | null; file: string | null; page: number | null } {
  const file = text(properties.nomfic ?? properties.regulationFile ?? properties.fichier);
  const direct = safeOfficialUrl(properties.urlfic ?? properties.urlreg ?? properties.url);
  const page = file?.match(/#page=(\d+)/i)?.[1];
  const pageNumber = page ? Number(page) : null;
  const document = documentForId(documents, documentId);
  const basename = file?.split("#")[0].split("?")[0].split("/").pop();
  const mapped = basename
    ? document?.document.files.find((candidate) => candidate.name === basename)?.url
    : undefined;
  return { url: direct ?? mapped ?? null, file, page: pageNumber };
}

function mapZones(features: FeatureWithParcels[], documents: DocumentMeta[]): LandZone[] {
  return features.map(({ feature, parcelIds }) => {
    const properties = propertiesOf(feature);
    const documentId =
      text(properties.gpu_doc_id) ?? text(properties.document_id) ?? text(properties.idurba);
    const document = documentForId(documents, documentId);
    const regulation = regulationLink(properties, documents, documentId);
    return {
      id: featureIdentity(feature),
      label: text(properties.libelle ?? properties.lib_idzone ?? properties.typezone) ?? "Zone GPU",
      description:
        text(properties.libelong ?? properties.description ?? properties.libelle) ??
        "Zone d’urbanisme intersectée par la géométrie interrogée.",
      type: text(properties.typezone ?? properties.type) ?? "unknown",
      documentId: documentId ?? "",
      documentName:
        document?.document.name ??
        text(properties.idurba ?? properties.partition) ??
        "Document GPU",
      parcelIds: [...parcelIds],
      regulationUrl: regulation.url,
      regulationFile: regulation.file,
      startPage: regulation.page,
      ...(geometryOf(feature) ? { geometry: geometryOf(feature) as LandGeometry } : {}),
    };
  });
}

function constraintKind(layer: string): LandConstraint["kind"] {
  if (layer.startsWith("prescription-")) return "prescription";
  if (layer.startsWith("info-")) return "information";
  return "servitude";
}

function mapConstraints(
  features: Map<string, FeatureWithParcels[]>,
  documents: DocumentMeta[],
): LandConstraint[] {
  const constraints: LandConstraint[] = [];
  for (const [layer, values] of features) {
    if (!isConstraintLayer(layer)) continue;
    for (const { feature, parcelIds } of values) {
      const properties = propertiesOf(feature);
      const label =
        text(
          properties.libelle ??
            properties.libelong ??
            properties.typeass ??
            properties.nomsuplitt ??
            properties.nomass ??
            properties.type,
        ) ?? "Contrainte GPU";
      const documentId =
        text(properties.gpu_doc_id) ?? text(properties.document_id) ?? text(properties.idurba);
      const directUrl = safeOfficialUrl(properties.urlreg ?? properties.urlfic ?? properties.url);
      const documentUrl = directUrl ?? regulationLink(properties, documents, documentId).url;
      const detailParts = [
        text(properties.libelong),
        text(properties.typeass),
        text(properties.fichier),
        text(properties.nomsuplitt),
      ].filter((part): part is string => Boolean(part));
      const geometry = geometryOf(feature);
      constraints.push({
        id: `${layer}:${featureIdentity(feature)}`,
        kind: constraintKind(layer),
        label,
        typeCode: text(
          properties.typepres ??
            properties.typeinfo ??
            properties.suptype ??
            properties.typeass ??
            properties.type,
        ),
        layer,
        parcelIds: [...parcelIds],
        documentId,
        documentUrl,
        detail: detailParts.length
          ? detailParts.join(" · ")
          : `Preuve API Carto GPU · couche ${layer} · objet ${featureIdentity(feature)}`,
        isEnvelope: layer.startsWith("assiette-sup-"),
        ...(geometry ? { geometry } : {}),
      });
    }
  }
  return constraints;
}

function checkForCoverage(
  documents: DocumentMeta[],
  now: () => Date,
): { checks: LandSourceCheck[]; warnings: string[]; complete: boolean } {
  const hasProcedure = documents.some((document) => document.procedurePresent);
  const hasOap = documents.some((document) => document.oapPresent);
  const warnings: string[] = [];
  if (!hasProcedure)
    warnings.push("Aucune pièce de procédure GPU n’a été identifiée dans les documents détaillés.");
  if (!hasOap)
    warnings.push("Aucune pièce OAP GPU n’a été identifiée dans les documents détaillés.");
  const checks: LandSourceCheck[] = [
    {
      key: "gpu.procedure",
      label: "Pièce de procédure GPU",
      status: hasProcedure ? "available" : documents.length ? "empty" : "unavailable",
      scope: "document",
      sourceUrl: `${GPU_DOCUMENT_API_BASE_URL}/document`,
      checkedAt: nowIso(now),
      message: hasProcedure
        ? undefined
        : "Aucune pièce de procédure identifiée dans les fiches GPU.",
    },
    {
      key: "gpu.oap",
      label: "Pièces OAP GPU",
      status: hasOap ? "available" : documents.length ? "empty" : "unavailable",
      scope: "document",
      sourceUrl: `${GPU_DOCUMENT_API_BASE_URL}/document`,
      checkedAt: nowIso(now),
      message: hasOap ? undefined : "Aucune pièce OAP identifiée dans les fiches GPU.",
    },
  ];
  return { checks, warnings, complete: hasProcedure && hasOap };
}

export async function fetchLandPlanning(
  input: LandLocationInput,
  options: ProviderOptions = {},
): Promise<LandPlanningResult> {
  const now = options.now ?? (() => new Date());
  const location = await resolveLocation(input, options, now);
  const inputCodeInsee = codeInseeValue(input.codeInsee);
  const references = (input.references ?? []).filter((reference) => {
    const referenceCode = codeInseeValue(reference.codeInsee);
    const inheritedFromInputCode = Boolean(
      referenceCode && inputCodeInsee && referenceCode === inputCodeInsee,
    );
    if (
      (reference.source === "stored" || inheritedFromInputCode) &&
      referenceCode &&
      location.codeInsee &&
      referenceCode !== location.codeInsee
    ) {
      return false;
    }
    return true;
  });
  const skippedReferences = references.length !== (input.references?.length ?? 0);
  const effectiveInput: LandLocationInput = {
    ...input,
    coordinates: location.coordinates,
    codeInsee: location.codeInsee,
    references,
  };
  const resolution = await resolveParcels(effectiveInput, options);
  const targets = targetGeometries(resolution.parcels, effectiveInput);
  const warnings = [...location.warnings, ...resolution.warnings];
  if (skippedReferences) {
    warnings.push(
      "Une référence cadastrale fournie contredisait la commune géocodée et n’a pas été utilisée comme preuve.",
    );
  }
  const resolvedCodeInsee = location.codeInsee ?? resolution.parcels[0]?.codeInsee ?? null;

  if (!targets.length) {
    warnings.push("Aucune géométrie exploitable n’a permis d’interroger les couches GPU.");
    return {
      locationStatus: resolution.parcels.length > 1 ? "ambiguous" : "unresolved",
      coordinates: location.coordinates ?? null,
      codeInsee: resolvedCodeInsee,
      parcels: resolution.parcels,
      zones: [],
      documents: [],
      constraints: [],
      checks: [
        location.geocodeCheck,
        {
          key: "cadastre.parcels",
          label: "Parcelles cadastrales",
          status: resolution.status,
          scope: resolution.scope,
          sourceUrl: resolution.checkUrl,
          checkedAt: nowIso(now),
          ...(resolution.issue ? { message: resolution.issue.message } : {}),
          ...(resolution.httpStatus ? { httpStatus: resolution.httpStatus } : {}),
          parcelIds: resolution.parcels.map((parcel) => parcel.id),
        },
      ],
      warnings,
      completeCoverage: false,
    };
  }

  const gpu = await fetchGpuLayers(targets, options, now);
  const documentDetails = await enrichDocuments(gpu.layerFeatures, options, now);
  const coverage = checkForCoverage(documentDetails.documents, now);
  warnings.push(...documentDetails.warnings, ...coverage.warnings);
  const checks: LandSourceCheck[] = [
    location.geocodeCheck,
    {
      key: "cadastre.parcels",
      label: "Parcelles cadastrales",
      status: resolution.status,
      scope: resolution.scope,
      sourceUrl: resolution.checkUrl,
      checkedAt: nowIso(now),
      ...(resolution.issue ? { message: resolution.issue.message } : {}),
      ...(resolution.httpStatus ? { httpStatus: resolution.httpStatus } : {}),
      parcelIds: resolution.parcels.map((parcel) => parcel.id),
    },
    ...gpu.checks,
    ...documentDetails.checks,
    ...coverage.checks,
  ];
  const allLayersChecked = gpu.checks.every(
    (check) => check.status === "available" || check.status === "empty",
  );
  const hasTimeout = checks.some((check) => check.message?.includes("Délai dépassé"));
  const hasUnavailable = checks.some((check) => check.status === "unavailable");
  const hasPartial = checks.some((check) => check.status === "partial");
  const locationStatus =
    resolution.parcels.length > 1
      ? "ambiguous"
      : resolution.pointOnly
        ? "point_candidate"
        : resolution.parcels.length
          ? "references_matched"
          : "unresolved";
  if (resolution.parcels.length > 1) {
    warnings.push(
      "Le dossier couvre plusieurs parcelles : les zones et contraintes sont conservées sans choisir une parcelle principale.",
    );
  }
  return {
    locationStatus,
    coordinates: location.coordinates ?? null,
    codeInsee: resolvedCodeInsee,
    parcels: resolution.parcels,
    zones: mapZones(gpu.layerFeatures.get("zone-urba") ?? [], documentDetails.documents),
    documents: documentDetails.documents.map((meta) => meta.document),
    constraints: mapConstraints(gpu.layerFeatures, documentDetails.documents),
    checks,
    warnings,
    completeCoverage:
      allLayersChecked &&
      !hasTimeout &&
      !hasUnavailable &&
      !hasPartial &&
      !resolution.pointOnly &&
      coverage.complete,
  };
}
