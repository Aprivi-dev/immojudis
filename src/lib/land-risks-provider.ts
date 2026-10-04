import type {
  LandCoordinates,
  LandParcel,
  LandRiskCategory,
  LandRiskFinding,
  LandRisksInput,
  LandRisksResult,
  LandScope,
  LandSourceCheck,
  LandProviderOptions,
} from "./land-report-types";

/**
 * The official API is deliberately called from this server-side adapter only.
 * Keep the token out of URLs and out of the serialised report.
 */
export const GEORISQUES_BASE_URL = "https://www.georisques.gouv.fr";
export const GEORISQUES_OPENAPI_VERSION = "1.12.2";
export const GEORISQUES_V1_QUOTAS = {
  standardPerSecond: 5,
  reportPerSecond: 1,
} as const;
export const GEORISQUES_V2_QUOTA_PER_SECOND = 20;

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_RADIUS_METERS = 1_000;
const V1_MAX_CONCURRENCY = 4;
const V2_MAX_CONCURRENCY = 8;
const V1_MIN_START_INTERVAL_MS = 220;
const MAX_RESPONSE_BYTES = 1_000_000;
const V1_DEFAULT_PACER = createStartPacer(V1_MIN_START_INTERVAL_MS);

type ApiVersion = "v1" | "v2";
type LocationMode = "point" | "radius" | "ppr" | "radon" | "commune" | "geographic";

type QueryContext = {
  input: LandRisksInput;
  version: ApiVersion;
  parcels: LandParcel[];
  parcelIds: string[];
  coordinates: LandCoordinates | null;
  codeInsee: string | null;
  queryScope: LandScope;
  locationMessage: string | null;
};

type RawFinding = {
  category: LandRiskCategory;
  label: string;
  scope?: LandScope;
  status?: LandRiskFinding["status"];
  level?: string | null;
  description: string;
  consequences: string[];
  regulatory?: boolean | null;
  sourceUpdatedAt?: string | null;
  vintage?: string | null;
  parcelIds?: string[];
  distanceM?: number | null;
  precision?: string | null;
  documentUrls?: { label: string; url: string }[];
};

type SourceSpec = {
  key: string;
  label: string;
  v1Path?: string;
  v2Path?: string;
  mode: LocationMode;
  parser: (payload: unknown, context: QueryContext) => RawFinding[];
};

type SourceRun = {
  findings: LandRiskFinding[];
  check: LandSourceCheck;
  warning?: string;
};

type RequestResult =
  | { kind: "success"; payload: unknown; httpStatus: number; paginationMessage?: string }
  | { kind: "empty"; httpStatus: number; message?: string }
  | { kind: "failure"; message: string; httpStatus?: number };

type BodyReadResult = { ok: true; text: string } | { ok: false };

const sourceSpecs: SourceSpec[] = [
  {
    key: "rga",
    label: "Retrait-gonflement des argiles (RGA)",
    v1Path: "/api/v1/rga",
    v2Path: "/api/v2/rga",
    mode: "point",
    parser: parseRga,
  },
  {
    key: "old",
    label: "Obligations légales de débroussaillement (OLD)",
    v1Path: "/api/v1/old",
    v2Path: "/api/v2/old",
    mode: "geographic",
    parser: parseOld,
  },
  {
    key: "mvt",
    label: "Mouvements de terrain",
    v1Path: "/api/v1/mvt",
    v2Path: "/api/v2/mvt",
    mode: "radius",
    parser: parseMvt,
  },
  {
    key: "cavites",
    label: "Cavités souterraines et risque minier",
    v1Path: "/api/v1/cavites",
    v2Path: "/api/v2/cavites",
    mode: "radius",
    parser: parseCavities,
  },
  {
    key: "pprn",
    label: "Plans de prévention des risques naturels (PPRN)",
    v1Path: "/api/v1/gaspar/pprn",
    v2Path: "/api/v2/gaspar/pprn",
    mode: "ppr",
    parser: parsePprn,
  },
  {
    key: "pprt",
    label: "Plans de prévention des risques technologiques (PPRT)",
    v1Path: "/api/v1/gaspar/pprt",
    v2Path: "/api/v2/gaspar/pprt",
    mode: "ppr",
    parser: parsePprt,
  },
  {
    key: "risques",
    label: "Risques recensés par commune (Gaspar)",
    v1Path: "/api/v1/gaspar/risques",
    v2Path: "/api/v2/gaspar/risques",
    mode: "commune",
    parser: parseRisques,
  },
  {
    key: "catnat",
    label: "Arrêtés de catastrophe naturelle (CatNat)",
    v1Path: "/api/v1/gaspar/catnat",
    // There is no /api/v2/gaspar/catnat operation in the current v2 OpenAPI.
    mode: "commune",
    parser: parseCatNat,
  },
  {
    key: "azi",
    label: "Atlas des zones inondables (AZI)",
    v1Path: "/api/v1/gaspar/azi",
    v2Path: "/api/v2/gaspar/azi",
    mode: "radius",
    parser: parseFloodProcedure,
  },
  {
    key: "tri",
    label: "Territoires à risque important d’inondation (TRI)",
    v1Path: "/api/v1/gaspar/tri",
    v2Path: "/api/v2/gaspar/tri",
    mode: "radius",
    parser: parseFloodProcedure,
  },
  {
    key: "radon",
    label: "Potentiel radon",
    v1Path: "/api/v1/radon",
    v2Path: "/api/v2/radon",
    mode: "radon",
    parser: parseRadon,
  },
  {
    key: "seismic",
    label: "Zonage sismique",
    v1Path: "/api/v1/zonage_sismique",
    v2Path: "/api/v2/zonage_sismique",
    mode: "radius",
    parser: parseSeismic,
  },
  {
    key: "ssp",
    label: "Sites et sols pollués (CASIAS, SIS, SUP)",
    v1Path: "/api/v1/ssp",
    v2Path: "/api/v2/ssp",
    mode: "radius",
    parser: parseSsp,
  },
  {
    key: "icpe",
    label: "Installations classées (ICPE)",
    v1Path: "/api/v1/installations_classees",
    v2Path: "/api/v2/installations_classees",
    mode: "radius",
    parser: parseIcpe,
  },
  {
    key: "nuclear",
    label: "Installations nucléaires",
    v1Path: "/api/v1/installations_nucleaires",
    v2Path: "/api/v2/installations_nucleaires",
    // V1 accepts a point/commune but has no rayon parameter.
    mode: "geographic",
    parser: parseNuclear,
  },
];

/**
 * Fetch the independent Géorisques layers used by the land dossier.
 *
 * With a token, v2 is selected for the whole run so a failed v2 layer is
 * reported as partial/unavailable and is not silently relabelled as a v1
 * point result. Without a token, v1 is used as a documented fallback. V1 has
 * no parcel filters, so a parcel plus a point remains a point/radius query in
 * the result metadata.
 */
export async function fetchLandRisks(
  input: LandRisksInput,
  options: LandProviderOptions = {},
): Promise<LandRisksResult> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const token = resolveToken(options);
  const version: ApiVersion = token ? "v2" : "v1";
  const context = makeContext(input, version);
  const warnings: string[] = [];

  if (!context.coordinates && !context.codeInsee && context.parcelIds.length === 0) {
    warnings.push(
      "Localisation insuffisante : aucun endpoint Géorisques n’est interrogé. Cela ne permet pas de conclure à l’absence de risque.",
    );
  }
  if (version === "v1") {
    warnings.push(
      "Jeton v2 absent : repli sur l’API v1. Les endpoints v1 ne recherchent pas une parcelle ; un point ou une commune reste indiqué avec sa portée réelle.",
    );
    if (input.parcels.length > 0 && context.coordinates) {
      warnings.push(
        "Les couches v1 de proximité associées à une parcelle proviennent du point fourni (ou d’un rayon), pas d’une intersection cadastrale ; CatNat, Gaspar et le radon sont interrogés à la commune par code INSEE.",
      );
    }
  }

  const fetcher = options.fetcher ?? fetch;
  const maxConcurrency = version === "v2" ? V2_MAX_CONCURRENCY : V1_MAX_CONCURRENCY;
  // The documented V1 limit is five calls per second. Four concurrent
  // workers can still burst above that limit when responses are fast, so the
  // real fetch path uses a module-shared start-time pacer. Injected fetchers
  // remain immediate so unit tests stay deterministic.
  const pace = version === "v1" && options.fetcher === undefined ? V1_DEFAULT_PACER : undefined;
  const runs = await runWithConcurrency(sourceSpecs, maxConcurrency, async (spec) =>
    runSource(spec, context, fetcher, options, checkedAt, token, pace),
  );

  const findings = dedupeFindings(runs.flatMap((run) => run.findings));
  const checks = runs.map((run) => run.check);
  for (const run of runs) if (run.warning) warnings.push(run.warning);

  if (findings.length === 0) {
    warnings.push(
      "Aucun constat exploitable n’a été retourné. Une couche vide, non interrogée ou indisponible ne prouve pas l’absence de risque.",
    );
  }

  return {
    findings,
    checks,
    warnings: uniqueStrings(warnings),
  };
}

function resolveToken(options: LandProviderOptions): string | null {
  const configured = options.token === undefined ? process.env.GEORISQUES_API_TOKEN : options.token;
  const value = typeof configured === "string" ? configured.trim() : "";
  return value || null;
}

function makeContext(input: LandRisksInput, version: ApiVersion): QueryContext {
  const parcels = Array.isArray(input.parcels) ? input.parcels : [];
  const parcelIds = uniqueStrings(
    parcels
      .map((parcel) => toV2ParcelCode(parcel))
      .filter((value): value is string => Boolean(value)),
  );
  const codeInsee =
    normalizeCodeInsee(input.codeInsee) ??
    uniqueStrings(
      parcels
        .map((parcel) => normalizeCodeInsee(parcel.codeInsee))
        .filter((value): value is string => Boolean(value)),
    )[0] ??
    null;
  const coordinates = validCoordinates(input.coordinates);
  const queryScope: LandScope =
    version === "v2" && parcelIds.length > 0
      ? "parcel"
      : coordinates
        ? "point"
        : codeInsee
          ? "commune"
          : "point";
  const locationMessage =
    parcelIds.length > 0 || coordinates || codeInsee
      ? null
      : "aucune parcelle, coordonnée ou commune valide";
  return {
    input,
    version,
    parcels,
    parcelIds,
    coordinates,
    codeInsee,
    queryScope,
    locationMessage,
  };
}

async function runSource(
  spec: SourceSpec,
  context: QueryContext,
  fetcher: typeof fetch,
  options: LandProviderOptions,
  checkedAt: string,
  token: string | null,
  pace?: () => Promise<void>,
): Promise<SourceRun> {
  const path = context.version === "v2" ? spec.v2Path : spec.v1Path;
  const sourceUrl = `${GEORISQUES_BASE_URL}${path ?? spec.v1Path ?? spec.v2Path ?? ""}`;
  const scope = sourceScope(spec, context);
  const version = GEORISQUES_OPENAPI_VERSION;

  if (!path) {
    return {
      findings: [],
      check: {
        key: spec.key,
        label: spec.label,
        status: "not_checked",
        scope,
        sourceUrl,
        checkedAt,
        version,
        message:
          context.version === "v2"
            ? "Cet endpoint n’est pas publié dans l’OpenAPI v2 actuelle ; l’API v1 n’est pas mélangée dans un même rapport."
            : "Endpoint non disponible dans la configuration Géorisques.",
      },
      warning: `${spec.label} n’est pas interrogé dans cette version de l’API ; son absence ne signifie pas absence de risque.`,
    };
  }

  const params = buildQueryParams(spec, context);
  if (!params) {
    return {
      findings: [],
      check: {
        key: spec.key,
        label: spec.label,
        status: "not_checked",
        scope,
        sourceUrl,
        checkedAt,
        version,
        message: context.locationMessage ?? locationRequirementMessage(spec, context),
        parcelIds: context.parcelIds.length ? context.parcelIds : undefined,
      },
      warning: `${spec.label} n’a pas été interrogé faute de localisation compatible ; cela ne permet pas de conclure à l’absence de risque.`,
    };
  }

  const url = new URL(sourceUrl);
  for (const [key, value] of params) url.searchParams.append(key, value);
  const requestUrl = url.toString();
  if (pace) await pace();
  const response = await requestJson(
    requestUrl,
    context.version,
    fetcher,
    options.timeoutMs,
    token,
  );
  if (response.kind === "failure") {
    const message = response.httpStatus
      ? `${response.message} (HTTP ${response.httpStatus})`
      : response.message;
    return {
      findings: [],
      check: {
        key: spec.key,
        label: spec.label,
        status: "unavailable",
        scope,
        sourceUrl: requestUrl,
        checkedAt,
        version,
        httpStatus: response.httpStatus,
        message,
        parcelIds: context.parcelIds.length ? context.parcelIds : undefined,
      },
      warning: `${spec.label} est indisponible pour ce contrôle ; les autres sources restent exploitables.`,
    };
  }

  if (response.kind === "empty") {
    return {
      findings: [],
      check: {
        key: spec.key,
        label: spec.label,
        status: "empty",
        scope,
        sourceUrl: requestUrl,
        checkedAt,
        version,
        httpStatus: response.httpStatus,
        message: [response.message, emptySourceMessage(spec)].filter(Boolean).join(" "),
        parcelIds: context.parcelIds.length ? context.parcelIds : undefined,
      },
    };
  }

  let rawFindings: RawFinding[];
  try {
    const parsedFindings = spec.parser(response.payload, context);
    rawFindings = response.paginationMessage
      ? summarizeCappedFindings(spec, parsedFindings)
      : parsedFindings;
  } catch (error) {
    const message = `Réponse non interprétable (${errorMessage(error)}).`;
    return {
      findings: [],
      check: {
        key: spec.key,
        label: spec.label,
        status: "partial",
        scope,
        sourceUrl: requestUrl,
        checkedAt,
        version,
        httpStatus: response.httpStatus,
        message,
        parcelIds: context.parcelIds.length ? context.parcelIds : undefined,
      },
      warning: `${spec.label} a répondu mais sa forme n’a pas pu être interprétée ; vérifier la source.`,
    };
  }

  const findings = rawFindings.map((finding, index) =>
    finalizeFinding(finding, spec, context, requestUrl, checkedAt, index),
  );
  const sourceUpdatedAt = rawFindings.map((finding) => finding.sourceUpdatedAt).find(Boolean);
  const explicitlyEmpty = payloadHasNoRecords(response.payload);
  const normalizedStatus: LandSourceCheck["status"] = response.paginationMessage
    ? "partial"
    : findings.length
      ? "available"
      : explicitlyEmpty
        ? "empty"
        : "partial";
  return {
    findings,
    check: {
      key: spec.key,
      label: spec.label,
      status: normalizedStatus,
      scope,
      sourceUrl: requestUrl,
      checkedAt,
      httpStatus: response.httpStatus,
      version,
      sourceUpdatedAt: sourceUpdatedAt ?? undefined,
      message: response.paginationMessage
        ? [
            response.paginationMessage,
            spec.key === "pprn"
              ? "Le flux PPRN couvre plusieurs aléas, dont le littoral lorsqu’il est présent ; le recul du trait de côte n’est pas un endpoint séparé dans cette API."
              : null,
          ]
            .filter(Boolean)
            .join(" ")
        : findings.length
          ? spec.key === "pprn"
            ? "Le flux PPRN couvre plusieurs aléas, dont le littoral lorsqu’il est présent ; le recul du trait de côte n’est pas un endpoint séparé dans cette API."
            : undefined
          : explicitlyEmpty
            ? emptySourceMessage(spec)
            : "La source a répondu dans une forme inattendue ; aucun constat n’a été normalisé.",
      parcelIds: context.parcelIds.length ? context.parcelIds : undefined,
    },
    warning: response.paginationMessage
      ? `${spec.label} est partiel : ${response.paginationMessage}`
      : findings.length === 0
        ? explicitlyEmpty
          ? `${spec.label} n’a retourné aucun enregistrement ; l’absence de constat ne vaut pas absence de risque.`
          : `${spec.label} a répondu dans une forme inattendue ; vérifier le schéma de la source.`
        : undefined,
  };
}

async function requestJson(
  url: string,
  version: ApiVersion,
  fetcher: typeof fetch,
  timeoutOption: number | undefined,
  token: string | null,
): Promise<RequestResult> {
  const timeoutMs = boundedTimeout(timeoutOption);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (version === "v2" && token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetcher(url, { headers, signal: controller.signal });
    if (response.status === 204) return { kind: "empty", httpStatus: response.status };
    if (!response.ok && response.status !== 404) {
      return {
        kind: "failure",
        httpStatus: response.status,
        message: "La source a retourné une erreur",
      };
    }
    const body = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
    if (!body.ok) {
      return {
        kind: "failure",
        httpStatus: response.status,
        message: `La réponse dépasse la limite de ${MAX_RESPONSE_BYTES} octets`,
      };
    }
    if (!response.ok) {
      const message = responseMessage(body.text);
      if (response.status === 404 && officialNoResultMessage(message)) {
        return { kind: "empty", httpStatus: response.status, message: message ?? undefined };
      }
      return {
        kind: "failure",
        httpStatus: response.status,
        message: message ? `La source a retourné : ${message}` : "La source a retourné une erreur",
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.text) as unknown;
    } catch {
      return {
        kind: "failure",
        httpStatus: response.status,
        message: "La réponse JSON est invalide",
      };
    }
    return {
      kind: "success",
      payload,
      httpStatus: response.status,
      paginationMessage: paginationMessage(payload, version),
    };
  } catch (error) {
    return {
      kind: "failure",
      message: controller.signal.aborted
        ? `Délai dépassé après ${timeoutMs} ms`
        : errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<BodyReadResult> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    return { ok: false };
  }
  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= maxBytes
      ? { ok: true, text }
      : { ok: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
}

function responseMessage(body: string): string | null {
  try {
    const record = asRecord(JSON.parse(body) as unknown);
    return text(record, ["message", "error"]);
  } catch {
    return null;
  }
}

function officialNoResultMessage(message: string | null): boolean {
  if (!message) return false;
  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /pas de resultat|aucun resultat|aucune donnee|no result/.test(normalized);
}

function paginationMessage(payload: unknown, version: ApiVersion): string | undefined {
  const limit = version === "v1" ? 100 : 1000;
  if (hasMorePages(payload, version)) {
    return `La réponse est paginée et dépasse la première page interrogée (limite ${limit} enregistrements) ; le dossier est partiel.`;
  }
  if (!hasCompletePageMetadata(payload, version) && hasCappedRows(payload, limit)) {
    return `La réponse atteint la limite de ${limit} enregistrements de la première page ; la couverture peut être partielle et doit être vérifiée dans la source.`;
  }
  return undefined;
}

function hasMorePages(value: unknown, version: ApiVersion, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const totalPages = numberFrom(record.totalPages ?? record.total_pages);
  const pageNumber = numberFrom(record.pageNumber);
  const page = numberFrom(record.page);
  if (totalPages != null && (pageNumber != null || page != null)) {
    // The public V1 Gaspar payload currently uses the V2-style camelCase
    // metadata (pageNumber is zero-based), while older V1 payloads use
    // page/total_pages (page is one-based). Keep the convention attached to
    // the field name rather than to the endpoint version.
    const pagesRead = pageNumber != null ? pageNumber + 1 : Math.max(page ?? 0, 1);
    if (totalPages > pagesRead) return true;
  }
  const next = record.next;
  if (next !== null && next !== undefined && next !== "" && next !== false) return true;
  const totalElements = numberFrom(record.totalElements ?? record.total_elements);
  const rows = ["content", "results", "data"]
    .map((key) => record[key])
    .find((candidate): candidate is unknown[] => Array.isArray(candidate));
  if (totalElements != null && rows && totalElements > rows.length) return true;
  return Object.values(record).some((nested) => hasMorePages(nested, version, seen));
}

function hasCappedRows(value: unknown, limit: number, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const rowKeys = [
    "content",
    "results",
    "data",
    "casias",
    "instructions",
    "conclusions_sis",
    "conclusionsSis",
    "conclusions_sup",
    "conclusionsSup",
  ];
  for (const key of rowKeys) {
    const candidate = record[key];
    if (Array.isArray(candidate) && candidate.length >= limit) return true;
  }
  return Object.values(record).some((nested) => hasCappedRows(nested, limit, seen));
}

function hasCompletePageMetadata(
  value: unknown,
  version: ApiVersion,
  seen = new Set<object>(),
): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const totalPages = numberFrom(record.totalPages ?? record.total_pages);
  const pageNumber = numberFrom(record.pageNumber);
  const page = numberFrom(record.page);
  if (totalPages != null && (pageNumber != null || page != null)) {
    const pagesRead = pageNumber != null ? pageNumber + 1 : Math.max(page ?? 0, 1);
    if (pagesRead >= totalPages) return true;
  }
  return Object.values(record).some((nested) => hasCompletePageMetadata(nested, version, seen));
}

function numberFrom(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function buildQueryParams(spec: SourceSpec, context: QueryContext): URLSearchParams | null {
  const params = new URLSearchParams();
  if (context.version === "v2") {
    if (!addV2Location(params, context, spec.mode)) return null;
    params.set("pageNumber", "0");
    params.set("pageSize", "1000");
    return params;
  }
  if (!addV1Location(params, context, spec.mode)) return null;
  if (spec.mode === "radius" && context.coordinates)
    params.set("rayon", String(DEFAULT_RADIUS_METERS));
  if (spec.key !== "rga" && spec.key !== "old" && spec.key !== "nuclear") {
    params.set("page", "1");
    params.set("page_size", "100");
  }
  return params;
}

function addV2Location(
  params: URLSearchParams,
  context: QueryContext,
  mode: LocationMode,
): boolean {
  if (mode === "commune" || mode === "radon") {
    if (!context.codeInsee) return false;
    params.append("codesInsee", context.codeInsee);
    return true;
  }
  if (context.parcelIds.length > 0) {
    for (const id of context.parcelIds) params.append("codesParcelle", id);
    return true;
  }
  if (context.coordinates) {
    params.set("longitude", String(context.coordinates.longitude));
    params.set("latitude", String(context.coordinates.latitude));
    return true;
  }
  if (context.codeInsee && (mode !== "point" || context.version === "v2")) {
    params.append("codesInsee", context.codeInsee);
    return true;
  }
  return false;
}

function addV1Location(
  params: URLSearchParams,
  context: QueryContext,
  mode: LocationMode,
): boolean {
  if (mode === "commune") {
    if (!context.codeInsee) return false;
    params.set("code_insee", context.codeInsee);
    return true;
  }
  if (mode === "radon") {
    if (!context.codeInsee) return false;
    params.set("code_insee", context.codeInsee);
    return true;
  }
  if (mode === "point") {
    if (!context.coordinates) return false;
    params.set("latlon", `${context.coordinates.longitude},${context.coordinates.latitude}`);
    return true;
  }
  if (mode === "geographic" || mode === "radius") {
    if (context.coordinates) {
      params.set("latlon", `${context.coordinates.longitude},${context.coordinates.latitude}`);
      return true;
    }
    if (context.codeInsee) {
      params.set("code_insee", context.codeInsee);
      return true;
    }
    return false;
  }
  if (mode === "ppr") {
    if (context.coordinates) {
      params.set("longitude", String(context.coordinates.longitude));
      params.set("latitude", String(context.coordinates.latitude));
      return true;
    }
    if (context.codeInsee) {
      params.set("codeInsee", context.codeInsee);
      return true;
    }
  }
  return false;
}

function sourceScope(spec: SourceSpec, context: QueryContext): LandScope {
  if (spec.mode === "commune" || spec.mode === "radon") return "commune";
  if (context.version === "v1" && spec.mode === "radius" && context.coordinates) return "radius";
  if (context.version === "v1" && context.parcels.length > 0 && context.coordinates) return "point";
  if (
    context.queryScope === "parcel" ||
    context.queryScope === "point" ||
    context.queryScope === "commune"
  ) {
    return context.queryScope;
  }
  return "point";
}

function locationRequirementMessage(spec: SourceSpec, context: QueryContext): string {
  if (spec.mode === "commune" || spec.mode === "radon")
    return "Le code INSEE de la commune est requis par cet endpoint.";
  if (spec.mode === "point" || spec.mode === "geographic")
    return "Une coordonnée est requise par cet endpoint v1.";
  return `Aucune localisation compatible avec l’endpoint (${context.version}).`;
}

function emptySourceMessage(spec: SourceSpec): string {
  if (spec.key === "pprn") {
    return "Le flux PPRN n’a retourné aucun enregistrement ; le littoral/recul du trait de côte n’a pas de flux séparé dans cette API, et cela ne prouve pas l’absence de risque.";
  }
  return "La source n’a retourné aucun enregistrement ; cela ne prouve pas l’absence de risque.";
}

function finalizeFinding(
  raw: RawFinding,
  spec: SourceSpec,
  context: QueryContext,
  sourceUrl: string,
  checkedAt: string,
  index: number,
): LandRiskFinding {
  const scope = raw.scope ?? defaultFindingScope(spec, context);
  const status = raw.status ?? statusForScope(scope);
  return {
    id: `${spec.key}-${index + 1}`,
    category: raw.category,
    label: raw.label,
    scope,
    status,
    level: raw.level ?? null,
    description: raw.description,
    consequences: raw.consequences,
    regulatory: raw.regulatory ?? null,
    sourceUrl,
    sourceLabel: spec.label,
    checkedAt,
    sourceUpdatedAt: raw.sourceUpdatedAt ?? null,
    vintage: raw.vintage ?? null,
    parcelIds: raw.parcelIds ?? (scope === "parcel" ? context.parcelIds : undefined),
    distanceM: raw.distanceM ?? null,
    precision: raw.precision ?? precisionFor(scope),
    documentUrls: raw.documentUrls,
  };
}

function defaultFindingScope(spec: SourceSpec, context: QueryContext): LandScope {
  if (spec.mode === "commune" || spec.mode === "radon") return "commune";
  if (context.version === "v1" && spec.mode === "radius" && context.coordinates) return "radius";
  if (
    context.queryScope === "parcel" ||
    context.queryScope === "point" ||
    context.queryScope === "commune"
  ) {
    return context.queryScope;
  }
  return "point";
}

function statusForScope(scope: LandScope): LandRiskFinding["status"] {
  if (scope === "radius") return "nearby";
  if (scope === "commune") return "communal";
  if (scope === "document") return "history";
  return "mapped";
}

function precisionFor(scope: LandScope): string {
  switch (scope) {
    case "parcel":
      return "parcelle cadastrale interrogée par Géorisques";
    case "point":
      return "point géographique";
    case "radius":
      return `rayon ${DEFAULT_RADIUS_METERS} m autour du point`;
    case "commune":
      return "commune (pas une intersection parcellaire)";
    default:
      return "document source";
  }
}

function parseRga(payload: unknown, context: QueryContext): RawFinding[] {
  return records(payload, ["codeExposition", "code_exposition", "exposition"]).flatMap((record) => {
    const exposure = text(record, ["exposition", "libelle", "label"]) ?? "non précisée";
    const code = text(record, ["codeExposition", "code_exposition"]);
    return [
      {
        category: "clay",
        label: `Retrait-gonflement des argiles : ${exposure}`,
        level: code ? `${exposure} (classe ${code})` : exposure,
        description: `Géorisques indique une exposition ${exposure}${code ? ` (code ${code})` : ""}. Le millésime de la donnée n’est pas fourni par cette réponse API.`,
        consequences: [
          "Ne pas déduire la présence ou l’absence d’argile à l’échelle de la parcelle sans étude géotechnique.",
          "Vérifier les règles applicables aux constructions et le classement de la carte RGA en vigueur.",
        ],
        regulatory: false,
        vintage: null,
        precision:
          context.version === "v2" && context.parcelIds.length
            ? "parcelle filtrée par l’API v2"
            : undefined,
        sourceUpdatedAt: dateFrom(record),
      },
    ];
  });
}

function parseOld(payload: unknown): RawFinding[] {
  return records(payload, ["risque", "commune", "departement", "zoneUrbaine"]).map((record) => {
    const risk = text(record, ["risque", "libelle", "label"]) ?? "zone soumise à vérifier";
    return {
      category: "fire",
      label: `Obligations légales de débroussaillement : ${risk}`,
      level: risk,
      description: `La source Géorisques signale ${risk}. Le périmètre exact, les prescriptions locales et la date d’application doivent être vérifiés auprès de la préfecture/commune.`,
      consequences: [
        "Vérifier l’obligation de débroussaillement, sa distance d’application et les prescriptions locales.",
        "Ne pas assimiler ce résultat à une carte de danger incendie ou à une classe parcellaire précise.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record),
    };
  });
}

function parseMvt(payload: unknown): RawFinding[] {
  return records(payload, ["identifiant", "type", "lieu", "code_insee"]).map((record) => {
    const kind = text(record, ["type", "libelle", "nature"]) ?? "mouvement recensé";
    const place = text(record, ["lieu", "commentaire_lieu", "commentaireLieu"]);
    return {
      category: "ground_movement",
      label: `Mouvement de terrain : ${kind}`,
      level: text(record, ["fiabilite", "precision_lieu", "precisionLieu"]),
      description: `Un mouvement de terrain est recensé${place ? ` (${place})` : ""}. La réponse est issue d’une recherche Géorisques par point, rayon ou commune selon la portée indiquée.`,
      consequences: [
        "Vérifier la localisation exacte, la nature du phénomène et les prescriptions du PPR applicable.",
        "Faire examiner les fondations et le sol si le projet est sensible au mouvement de terrain.",
      ],
      regulatory: false,
      sourceUpdatedAt: dateFrom(record),
      distanceM: distanceFrom(record),
    };
  });
}

function parseCavities(payload: unknown): RawFinding[] {
  return records(payload, ["identifiant", "type", "nom", "code_insee"]).map((record) => {
    const kind = text(record, ["type", "nom", "libelle"]) ?? "cavité recensée";
    return {
      category: /minier|mine/i.test(kind) ? "cavity_mining" : "cavity_mining",
      label: `Cavité souterraine : ${kind}`,
      description:
        "Une cavité souterraine est recensée dans la recherche Géorisques. La proximité et la précision de localisation sont celles de la source, pas une preuve d’emprise sur la parcelle.",
      consequences: [
        "Vérifier la distance et la précision de localisation dans la fiche source.",
        "Demander un avis géotechnique avant travaux si le projet peut être affecté.",
      ],
      regulatory: false,
      sourceUpdatedAt: dateFrom(record),
      distanceM: distanceFrom(record),
    };
  });
}

function parseRisques(payload: unknown, context: QueryContext): RawFinding[] {
  const result: RawFinding[] = [];
  for (const record of records(payload, [
    "risques_detail",
    "code_insee",
    "libelle_commune",
    "libelle",
    "idGaspar",
    "uuid",
    "communes",
  ]).filter((record) => matchesRequestedCommune(record, context.codeInsee))) {
    const details = values(record, ["risques_detail", "risquesDetail"]);
    const candidates = details.length ? details : [record];
    for (const detail of candidates) {
      const label =
        text(detail, ["libelle_risque_long", "libelle", "label", "risque"]) ?? "Risque recensé";
      const commune = text(record, ["libelle_commune", "commune", "nom_commune"]);
      result.push({
        category: categoryFromText(label),
        label,
        // Gaspar's numeric code identifies the hazard type; it is not a
        // severity scale and must not be rendered as one.
        level: null,
        scope: "commune",
        description: `${commune ? `La commune ${commune}` : "La commune interrogée"} est associée à « ${label} » dans Gaspar. Cette réponse ne constitue pas à elle seule un classement précis de la parcelle.`,
        consequences: [
          "Ouvrir le document réglementaire ou l’état des risques correspondant pour vérifier le périmètre.",
          "Conserver la portée communale ou de proximité lors de toute décision d’achat.",
        ],
        regulatory: null,
        sourceUpdatedAt: dateFrom(detail) ?? dateFrom(record),
      });
    }
  }
  return result;
}

function parseCatNat(payload: unknown, context: QueryContext): RawFinding[] {
  return records(payload, ["code_national_catnat", "libelle_risque_jo", "code_insee"])
    .filter((record) => matchesRequestedCommune(record, context.codeInsee))
    .map((record) => {
      const risk =
        text(record, ["libelle_risque_jo", "libelle_risque", "libelle"]) ?? "arrêté CatNat";
      const start = text(record, ["date_debut_evt", "dateDebutEvt"]);
      const end = text(record, ["date_fin_evt", "dateFinEvt"]);
      const commune = text(record, ["libelle_commune", "commune", "nom_commune"]);
      return {
        category: categoryFromText(risk),
        label: `Historique CatNat : ${risk}`,
        scope: "commune",
        status: "history",
        description: `Un arrêté de catastrophe naturelle est recensé pour ${commune ? `la commune ${commune}` : "la commune interrogée"}${start ? ` (événement du ${start}${end ? ` au ${end}` : ""})` : ""}. Cet historique communal ne prouve pas à lui seul un dommage sur le bien.`,
        consequences: [
          "Vérifier si le bien a été effectivement touché et si un sinistre a été indemnisé.",
          "Lire l’état des risques et les documents de prévention applicables à la parcelle.",
        ],
        regulatory: null,
        sourceUpdatedAt: dateFrom(record),
      };
    });
}

function parsePprn(payload: unknown): RawFinding[] {
  return records(payload, ["idGaspar", "libPpr", "zonageReglementaire"]).map((record) => {
    const title = text(record, ["libPpr", "libelle", "libBassinRisques"]) ?? "PPR naturel";
    const textValue = valuesAsText(record, [
      "libPpr",
      "libBassinRisques",
      "modeleProcedure",
      "zonageReglementaire",
    ]);
    const category = categoryFromText(textValue);
    const zone = asRecord(recordValue(record, ["zonageReglementaire", "zonage_reglementaire"]));
    const zoneExists = Boolean(recordValue(zone, ["zoneRegExists", "zoneReglementaire", "exists"]));
    return {
      category,
      label: `Plan de prévention des risques naturels : ${title}`,
      level: zoneExists ? "zonage réglementaire signalé" : text(record, ["etatRevision", "etat"]),
      description: `Un PPR naturel est associé au territoire interrogé${zoneExists ? ", avec un zonage réglementaire signalé par l’API" : ""}. Le niveau ou la couleur de zone doit être lu dans le règlement et la carte officielle.`,
      consequences: [
        "Télécharger et lire la carte de zonage et le règlement du PPR avant de conclure sur la constructibilité.",
        "Ne pas transformer une enveloppe de procédure en classement rouge, bleu ou en exposition parcellaire sans intersection de la carte réglementaire.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record, ["dateModification", "date_modification"]),
      documentUrls: urlFromRecord(record),
    };
  });
}

function parsePprt(payload: unknown): RawFinding[] {
  return records(payload, ["idGaspar", "libPpr", "libelle", "libBassinRisques"]).map((record) => {
    const title = text(record, ["libPpr", "libelle", "libBassinRisques"]) ?? "PPR technologique";
    return {
      category: "technological",
      label: `Plan de prévention des risques technologiques : ${title}`,
      level: text(record, ["etatRevision", "etat"]),
      description:
        "Un PPR technologique est associé au territoire interrogé. La zone d’effet et les prescriptions doivent être vérifiées dans les cartes et le règlement officiels.",
      consequences: [
        "Vérifier la carte réglementaire, les servitudes et les prescriptions du PPRT.",
        "Faire confirmer l’impact sur le projet par la collectivité ou le service instructeur.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record, ["dateModification", "date_modification"]),
      documentUrls: urlFromRecord(record),
    };
  });
}

function parseFloodProcedure(payload: unknown): RawFinding[] {
  return records(payload, [
    "code_national_azi",
    "code_national_tri",
    "libelle_azi",
    "libelle_tri",
    "libelle",
  ]).map((record) => {
    const title =
      text(record, ["libelle_azi", "libelle_tri", "libelle", "libBassinRisques"]) ??
      "dispositif d’information inondation";
    return {
      category: "flood",
      label: title,
      description: `La source Géorisques recense « ${title} ». Un atlas ou territoire à risque ne vaut pas automatiquement classement réglementaire de la parcelle.`,
      consequences: [
        "Comparer la parcelle au PPR inondation et à ses prescriptions lorsqu’ils existent.",
        "Vérifier les niveaux d’eau, les accès et les mesures de réduction de vulnérabilité du projet.",
      ],
      regulatory: false,
      sourceUpdatedAt: dateFrom(record),
    };
  });
}

function parseRadon(payload: unknown): RawFinding[] {
  return records(payload, ["classe_potentiel", "classePotentiel", "code_insee", "codeInsee"]).map(
    (record) => {
      const level =
        text(record, ["classe_potentiel", "classePotentiel", "classe", "niveau"]) ?? "non précisé";
      const displayLevel = /^classe\b/i.test(level) ? level : `Classe ${level}`;
      const levelThree = /(^|\D)3(\D|$)|élev/i.test(level);
      return {
        category: "radon",
        label: `Potentiel radon : ${displayLevel}`,
        level: displayLevel,
        scope: "commune",
        description: `Géorisques classe le potentiel radon de la commune au niveau « ${displayLevel} ». Ce résultat communal ne mesure pas la concentration intérieure du logement.`,
        consequences: [
          "Pour un niveau élevé, vérifier les obligations d’information et envisager une mesure dans le bâtiment.",
          "Prendre en compte la ventilation et les caractéristiques du projet de construction ou de rénovation.",
        ],
        regulatory: levelThree,
        sourceUpdatedAt: dateFrom(record),
      };
    },
  );
}

function parseSeismic(payload: unknown): RawFinding[] {
  return records(payload, ["code_zone", "zone_sismicite", "zoneSismicite", "typeZone"]).map(
    (record) => {
      const level =
        text(record, ["zone_sismicite", "zoneSismicite", "code_zone", "typeZone"]) ?? "non précisé";
      const numeric = Number.parseInt(level.replace(/\D/g, ""), 10);
      return {
        category: "earthquake",
        label: `Zonage sismique : ${level}`,
        level,
        description: `Le zonage sismique retourné par Géorisques est « ${level} ». Il s’agit d’un zonage réglementaire général, pas d’une estimation de dommage pour le bâtiment.`,
        consequences: [
          "Vérifier les règles parasismiques applicables au type de construction et à la zone.",
          "Faire confirmer la version réglementaire utilisée pour le permis ou les travaux.",
        ],
        regulatory: Number.isFinite(numeric) ? numeric >= 2 : null,
        sourceUpdatedAt: dateFrom(record),
      };
    },
  );
}

function parseSsp(payload: unknown): RawFinding[] {
  const result: RawFinding[] = [];
  const root = asRecord(payload);
  const nestedKeys = [
    ["casias", "CASIAS"],
    ["instructions", "Instruction"],
    ["conclusions_sis", "SIS"],
    ["conclusionsSis", "SIS"],
    ["conclusions_sup", "SUP"],
    ["conclusionsSup", "SUP"],
  ] as const;
  if (root) {
    for (const [key, label] of nestedKeys) {
      const nestedValue = recordValue(root, [key]);
      const nested = records(nestedValue, [
        "identifiant",
        "id",
        "code_insee",
        "codeInsee",
        "nom",
        "libelle",
        "adresse",
      ]);
      if (nested.length > 0) result.push(sspSummary(nested, label));
    }
  }
  if (result.length === 0) {
    const fallback = records(payload, ["identifiant", "id", "casias", "code_insee", "codeInsee"]);
    if (fallback.length > 0) result.push(sspSummary(fallback, "site ou sol pollué"));
  }
  return result;
}

function summarizeCappedFindings(spec: SourceSpec, findings: RawFinding[]): RawFinding[] {
  if (!findings.length || !["mvt", "cavites"].includes(spec.key) || findings.length < 100) {
    return findings;
  }
  const first = findings[0];
  if (!first) return findings;
  const examples = uniqueStrings(findings.slice(0, 3).map((finding) => finding.label));
  return [
    {
      ...first,
      label: `${spec.label} : ${findings.length} enregistrements sur la première page`,
      level: String(findings.length),
      description: `${spec.label} a retourné ${findings.length} enregistrements sur la première page, qui atteint la limite de l’API. Exemples : ${examples.join(", ")}. La suite doit être vérifiée dans la source paginée ; ces enregistrements ne prouvent pas une emprise sur la parcelle.`,
      consequences: [
        ...first.consequences,
        "Vérifier la pagination et la localisation exacte de chaque phénomène avant de conclure sur le bien.",
      ],
    },
  ];
}

function sspSummary(recordsForKind: Record<string, unknown>[], kind: string): RawFinding {
  const names = uniqueStrings(
    recordsForKind
      .map((record) =>
        text(record, ["nom", "libelle", "raisonSociale", "adresse", "identifiant", "id"]),
      )
      .filter(Boolean),
  ).slice(0, 3);
  const count = recordsForKind.length;
  const countLabel = `${count} enregistrement${count > 1 ? "s" : ""}`;
  const sample = names.length ? ` Exemples : ${names.join(", ")}.` : "";
  return {
    category: "pollution",
    label: `Sites et sols pollués : ${kind} (${countLabel})`,
    level: countLabel,
    description: `La base Géorisques signale ${countLabel} de type ${kind}.${sample} La présence dans la base ne décrit pas à elle seule l’état actuel du sol ni la compatibilité avec le projet.`,
    consequences: [
      "Lire la fiche et les conclusions SIS/SUP lorsqu’elles existent.",
      "Demander une étude de sol et vérifier les restrictions d’usage ou servitudes avant acquisition.",
    ],
    regulatory: /sis|sup/i.test(kind) ? true : null,
    sourceUpdatedAt: recordsForKind.map((record) => dateFrom(record)).find(Boolean),
    documentUrls: recordsForKind.map((record) => urlFromRecord(record)).find(Boolean),
  };
}

function parseIcpe(payload: unknown): RawFinding[] {
  return records(payload, ["codeAIOT", "code_aiot", "raisonSociale", "siret", "codeInsee"]).map(
    (record) => {
      const name =
        text(record, ["raisonSociale", "raison_sociale", "nom", "codeAIOT"]) ??
        "installation classée";
      const seveso = text(record, ["statutSeveso", "statut_seveso"]);
      return {
        category: "technological",
        label: `Installation classée : ${name}`,
        level: seveso,
        description: `Une installation classée est recensée dans la recherche Géorisques${seveso ? ` (statut Seveso : ${seveso})` : ""}. La distance et les servitudes doivent être vérifiées séparément.`,
        consequences: [
          "Vérifier l’arrêté préfectoral, les servitudes et les périmètres d’effets lorsqu’ils existent.",
          "Ne pas déduire une nuisance ou une zone d’effet à partir du seul référencement ICPE.",
        ],
        regulatory: true,
        sourceUpdatedAt: dateFrom(record),
        distanceM: distanceFrom(record),
        documentUrls: urlFromRecord(record),
      };
    },
  );
}

function parseNuclear(payload: unknown): RawFinding[] {
  return records(payload, [
    "nomInstallationNucleaire",
    "nom_installation_nucleaire",
    "site",
    "codeInsee",
  ]).map((record) => {
    const name =
      text(record, [
        "nomInstallationNucleaire",
        "nom_installation_nucleaire",
        "site",
        "exploitant",
      ]) ?? "installation nucléaire";
    const radius = text(record, ["rayonPpi", "rayon_ppi"]);
    return {
      category: "technological",
      label: `Installation nucléaire : ${name}`,
      level: radius ? `PPI ${radius}` : null,
      description: `Une installation nucléaire est recensée (${name}). Le périmètre de protection et les effets doivent être vérifiés dans les documents officiels.`,
      consequences: [
        "Consulter le plan particulier d’intervention et les servitudes applicables.",
        "Vérifier la distance réelle au site, qui peut différer de la recherche par rayon.",
      ],
      regulatory: true,
      sourceUpdatedAt: dateFrom(record),
      distanceM: distanceFrom(record),
    };
  });
}

function records(value: unknown, directKeys: string[] = []): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["content", "results", "data"]) {
    const list = record[key];
    if (Array.isArray(list))
      return list.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  }
  if (directKeys.some((key) => key in record)) return [record];
  return [];
}

function matchesRequestedCommune(
  record: Record<string, unknown>,
  requestedCodeInsee: string | null,
): boolean {
  if (!requestedCodeInsee) return true;
  const returnedCode = text(record, ["code_insee", "codeInsee"]);
  return !returnedCode || normalizeCodeInsee(returnedCode) === requestedCodeInsee;
}

function payloadHasNoRecords(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  const record = asRecord(value);
  if (!record) return true;
  const pagedLists = ["content", "results", "data"].map((key) => record[key]).filter(Array.isArray);
  if (pagedLists.length > 0) return pagedLists.every((list) => list.length === 0);
  const nestedLists = [
    "casias",
    "instructions",
    "conclusions_sis",
    "conclusionsSis",
    "conclusions_sup",
    "conclusionsSup",
  ]
    .map((key) => record[key])
    .filter(Array.isArray);
  if (nestedLists.length > 0) return nestedLists.every((list) => list.length === 0);
  const nestedValues = [
    "casias",
    "instructions",
    "conclusions_sis",
    "conclusionsSis",
    "conclusions_sup",
    "conclusionsSup",
  ]
    .map((key) => record[key])
    .filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
  if (nestedValues.length > 0) return nestedValues.every((item) => payloadHasNoRecords(item));
  return Object.keys(record).length === 0;
}

function values(record: Record<string, unknown> | null, keys: string[]): Record<string, unknown>[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value))
      return value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
    const nested = asRecord(value);
    if (nested) return [nested];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return null;
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return null;
}

function text(record: Record<string, unknown> | null, keys: string[]): string | null {
  const value = recordValue(record, keys);
  if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function valuesAsText(record: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((key) => formatUnknown(record[key]))
    .filter(Boolean)
    .join(" ");
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatUnknown).filter(Boolean).join(" ");
  const record = asRecord(value);
  return record ? Object.values(record).map(formatUnknown).filter(Boolean).join(" ") : "";
}

function dateFrom(record: Record<string, unknown> | null, extraKeys: string[] = []): string | null {
  const value = text(record, [
    ...extraKeys,
    "dateMaj",
    "date_maj",
    "dateModification",
    "date_modification",
    "dateApprobation",
    "date_approbation",
    "date_publication_jo",
    "datePublicationJo",
  ]);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function urlFromRecord(
  record: Record<string, unknown> | null,
): { label: string; url: string }[] | undefined {
  const urls: { label: string; url: string }[] = [];
  for (const key of ["url", "lienPpr", "lien", "documentUrl", "document_url"]) {
    const url = recordValue(record, [key]);
    if (typeof url === "string" && /^https?:\/\//i.test(url))
      urls.push({ label: "Document Géorisques", url });
  }
  return urls.length ? urls : undefined;
}

function distanceFrom(record: Record<string, unknown> | null): number | null {
  const value = recordValue(record, ["distance", "distanceM", "distance_m"]);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function categoryFromText(value: string): LandRiskCategory {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/recul.*cote|trait.*cote|littoral|submersion marine|erosion cotiere/.test(normalized))
    return "coastal";
  if (/pprn[-_ ]?i\b|ppri|ppr.*inond|inond|ruissel|remontee|submersion|crue/.test(normalized))
    return "flood";
  if (/feu.*foret|incendie.*foret|debrouss|forestier/.test(normalized)) return "fire";
  if (/argile|retrait.*gonflement/.test(normalized)) return "clay";
  if (/cavite|carriere|minier|mine/.test(normalized)) return "cavity_mining";
  if (
    /pprn[-_ ]?(?:mvt|mouv)\b|mouvement|glissement|effondrement|affaissement|avalanche|eboulement/.test(
      normalized,
    )
  )
    return "ground_movement";
  if (/pollution|casias|sis|sol pollue|ancien site/.test(normalized)) return "pollution";
  if (
    /icpe|technolog|nucleaire|seveso|canalisation|barrage|marchandises dangereuses|transport.*dangereux|\btmd\b/.test(
      normalized,
    )
  )
    return "technological";
  if (/sism|seisme/.test(normalized)) return "earthquake";
  if (/radon/.test(normalized)) return "radon";
  return "other";
}

function validCoordinates(value: LandCoordinates | null): LandCoordinates | null {
  if (!value || !Number.isFinite(value.longitude) || !Number.isFinite(value.latitude)) return null;
  if (
    value.longitude < -180 ||
    value.longitude > 180 ||
    value.latitude < -90 ||
    value.latitude > 90
  )
    return null;
  return value;
}

function normalizeCodeInsee(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[0-9A-Z]{5}$/.test(normalized) ? normalized : null;
}

function toV2ParcelCode(parcel: LandParcel): string | null {
  const existing = parcel.id.trim().toUpperCase().replace(/\s+/g, "");
  const canonical = existing.match(/^(\d{5})[-_](\d{3})[-_]([A-Z0-9]{1,4})[-_](\d{1,5})$/);
  if (canonical)
    return `${canonical[1]}-${canonical[2]}-${canonical[3]}-${canonical[4].padStart(4, "0")}`;
  const code = normalizeCodeInsee(parcel.codeInsee);
  const section = parcel.section.trim().toUpperCase();
  const number = parcel.number.trim();
  if (code && /^[A-Z0-9]{1,4}$/.test(section) && /^\d{1,5}$/.test(number)) {
    const prefix = (parcel.prefix ?? "000").trim();
    if (/^\d{3}$/.test(prefix)) return `${code}-${prefix}-${section}-${number.padStart(4, "0")}`;
  }
  // A compact identifier is ambiguous when the section contains digits. Use it
  // only when the explicit parcel fields above are unavailable.
  const compact = existing.match(/^(\d{5})(\d{3})([A-Z]{1,2})(\d{1,5})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}-${compact[4].padStart(4, "0")}`;
  return null;
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), 50), 10_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "échec réseau";
}

function uniqueStrings(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function dedupeFindings(findings: LandRiskFinding[]): LandRiskFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify([
      finding.sourceLabel,
      finding.category,
      finding.label,
      finding.description,
      finding.scope,
      finding.sourceUpdatedAt,
      finding.level,
      finding.distanceM,
      finding.documentUrls ?? [],
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      result[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  return result;
}

function createStartPacer(minIntervalMs: number): () => Promise<void> {
  let nextStartAt = 0;
  let queue = Promise.resolve();
  return () => {
    const scheduled = queue.then(async () => {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      nextStartAt = Date.now() + minIntervalMs;
    });
    queue = scheduled.catch(() => undefined);
    return scheduled;
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
