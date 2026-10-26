import type {
  LandCoordinates,
  LandParcel,
  LandRiskFinding,
  LandRisksInput,
  LandRisksResult,
  LandScope,
  LandSourceCheck,
  LandProviderOptions,
} from "./land-report-types";
import { asRecordOrNull } from "@/lib/guards";
import {
  type ApiVersion,
  type LocationMode,
  normalizeCodeInsee,
  numberFrom,
  payloadHasNoRecords,
  type QueryContext,
  type RawFinding,
  records,
  type SourceSpec,
  text,
  uniqueStrings,
} from "@/lib/land-risks/helpers";
import {
  parseCatNat,
  parseCavities,
  parseFloodProcedure,
  parseIcpe,
  parseMvt,
  parseNuclear,
  parseOld,
  parsePprn,
  parsePprt,
  parseRadon,
  parseRga,
  parseRisques,
  parseSeismic,
  parseSsp,
  parseCommuneTri,
  parseTriZonage,
  summarizeCappedFindings,
} from "@/lib/land-risks/parsers";

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
    // Appartenance : le point est-il DANS la zone d'un scénario du TRI ? (et non « un TRI existe dans un rayon
    // de 1 000 m »). Aucune opération équivalente n'est publiée dans l'OpenAPI v2 : la couche n'est alors pas
    // interrogée (l'API v1 n'est pas mélangée dans un même rapport).
    v1Path: "/api/v1/tri_zonage",
    mode: "point",
    parser: parseTriZonage,
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
 * TRI à la commune (API v1 seulement) : quand la position du bien n'est pas connue avec précision (centre de commune
 * ou commune seule), la couche TRI garde une information au niveau de la commune au lieu de « non vérifiée ».
 */
const TRI_COMMUNE_SPEC: SourceSpec = {
  key: "tri",
  label: "Territoires à risque important d’inondation (TRI), niveau commune",
  v1Path: "/api/v1/gaspar/tri",
  mode: "commune",
  parser: parseCommuneTri,
};

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

/** Résultat d'un appel d'inondation : jamais l'URL, ni une coordonnée, ni le corps de la réponse d'erreur. */
export type FloodApiFailure = {
  kind: "failure";
  /** `http_<statut>`, `timeout` ou `network` : de quoi journaliser sans donnée de la vente. */
  code: string;
};
export type FloodApiRateLimited = { kind: "rate_limited" };

export type TriZonageResult =
  | {
      kind: "ok";
      /** Codes de scénario de chaque entrée rendue (`01For`, `02Moy`, `03Mcc`, `04Fai`) ; vide : hors zone. */
      scenarios: string[];
      /** Date de la carte (`date_arrete_carte`), AAAA-MM-JJ, quand elle est donnée. */
      mapDate: string | null;
    }
  | FloodApiFailure
  | FloodApiRateLimited;

export type CommuneTriResult =
  | { kind: "ok"; hasTri: boolean }
  | FloodApiFailure
  | FloodApiRateLimited;

export type FloodApiOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Cadence : appelé avant chaque requête (voir `createStartPacer`). */
  pace?: () => Promise<void>;
  userAgent?: string;
};

/** Codes de scénario de la cartographie des TRI : forte (01For), moyenne (02Moy), CC (03Mcc), faible (04Fai). */
const TRI_SCENARIO_CODES: readonly string[] = ["01For", "02Moy", "03Mcc", "04Fai"];

export const FLOOD_API_USER_AGENT = "immojudis-flood-risk/1.0 (+https://immojudis.com)";

/** « 18/12/2013 » (format de l'API) en « 2013-12-18 » ; `null` si illisible. */
export function isoDateFromFrench(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function floodFailure(
  response: Extract<RequestResult, { kind: "failure" }>,
): FloodApiFailure | FloodApiRateLimited {
  if (response.httpStatus === 429) return { kind: "rate_limited" };
  if (response.httpStatus) return { kind: "failure", code: `http_${response.httpStatus}` };
  return { kind: "failure", code: /délai/i.test(response.message) ? "timeout" : "network" };
}

/**
 * Le point est-il dans la zone d'un scénario d'un TRI ? `GET /api/v1/tri_zonage?latlon=<lon>,<lat>` (sans jeton).
 * L'API rend une entrée par type d'inondation, avec le scénario le plus probable dont la zone contient le point.
 */
export async function fetchTriZonage(
  point: LandCoordinates,
  options: FloodApiOptions = {},
): Promise<TriZonageResult> {
  const coordinates = validCoordinates(point);
  if (!coordinates) return { kind: "failure", code: "invalid_position" };
  const url = new URL(`${GEORISQUES_BASE_URL}/api/v1/tri_zonage`);
  url.searchParams.set("latlon", `${coordinates.longitude},${coordinates.latitude}`);
  if (options.pace) await options.pace();
  const response = await requestJson(
    url.toString(),
    "v1",
    options.fetcher ?? fetch,
    options.timeoutMs,
    null,
    options.userAgent ?? FLOOD_API_USER_AGENT,
    true,
  );
  if (response.kind === "failure") return floodFailure(response);
  if (response.kind === "empty") return { kind: "ok", scenarios: [], mapDate: null };
  const entries = records(response.payload, ["code_national_tri", "identifiant_tri"]);
  if (entries.length === 0 && !payloadHasNoRecords(response.payload)) {
    return { kind: "failure", code: "unexpected_shape" };
  }
  // Une entrée sans code de scénario reconnu n'est pas une réponse exploitable : jamais un « ok » vide, qui
  // passerait pour « hors zone ».
  const scenarios: string[] = [];
  for (const entry of entries) {
    const code = text(asRecordOrNull(entry.scenario), ["code"]);
    if (!code || !TRI_SCENARIO_CODES.includes(code)) {
      return { kind: "failure", code: "unexpected_shape" };
    }
    scenarios.push(code);
  }
  const mapDate =
    entries.map((entry) => isoDateFromFrench(entry.date_arrete_carte)).find(Boolean) ?? null;
  return { kind: "ok", scenarios, mapDate };
}

/**
 * La commune compte-t-elle un TRI ? `GET /api/v1/gaspar/tri?code_insee=…`. Une commune sans TRI rend une liste
 * vide (HTTP 200).
 */
export async function fetchCommuneTri(
  codeInsee: string,
  options: FloodApiOptions = {},
): Promise<CommuneTriResult> {
  const code = normalizeCodeInsee(codeInsee);
  if (!code) return { kind: "failure", code: "invalid_commune" };
  const url = new URL(`${GEORISQUES_BASE_URL}/api/v1/gaspar/tri`);
  url.searchParams.set("code_insee", code);
  if (options.pace) await options.pace();
  const response = await requestJson(
    url.toString(),
    "v1",
    options.fetcher ?? fetch,
    options.timeoutMs,
    null,
    options.userAgent ?? FLOOD_API_USER_AGENT,
    true,
  );
  if (response.kind === "failure") return floodFailure(response);
  if (response.kind === "empty") return { kind: "ok", hasTri: false };
  const entries = records(response.payload, ["code_national_tri", "libelle_tri"]);
  if (entries.length === 0 && !payloadHasNoRecords(response.payload)) {
    return { kind: "failure", code: "unexpected_shape" };
  }
  return { kind: "ok", hasTri: entries.length > 0 };
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
  if (
    spec.key === "tri" &&
    spec.mode === "point" &&
    context.version === "v1" &&
    !context.coordinates &&
    context.codeInsee
  ) {
    return runSource(TRI_COMMUNE_SPEC, context, fetcher, options, checkedAt, token, pace);
  }
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
  userAgent?: string,
  /** Appels d'inondation : une redirection est refusée (`redirect: "error"`), jamais suivie vers un autre hôte. */
  refuseRedirect = false,
): Promise<RequestResult> {
  const timeoutMs = boundedTimeout(timeoutOption);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (userAgent) headers["User-Agent"] = userAgent;
  if (version === "v2" && token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetcher(url, {
      headers,
      signal: controller.signal,
      ...(refuseRedirect ? { redirect: "error" as const } : {}),
    });
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
    const record = asRecordOrNull(JSON.parse(body) as unknown);
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
    // Même rayon qu'en v1 pour les couches de proximité : les deux versions interrogent 1 000 m autour du point.
    if (mode === "radius") params.set("rayon", String(DEFAULT_RADIUS_METERS));
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
  if (isRadiusQuery(spec, context)) return "radius";
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

/**
 * Une couche de proximité interrogée autour d'un point (rayon de `DEFAULT_RADIUS_METERS`), en v1 comme en v2.
 * En v2, une parcelle fournie prime sur le point : la requête est alors parcellaire, pas un rayon.
 */
function isRadiusQuery(spec: SourceSpec, context: QueryContext): boolean {
  if (spec.mode !== "radius" || !context.coordinates) return false;
  return context.version === "v1" || context.parcelIds.length === 0;
}

function defaultFindingScope(spec: SourceSpec, context: QueryContext): LandScope {
  if (spec.mode === "commune" || spec.mode === "radon") return "commune";
  if (isRadiusQuery(spec, context)) return "radius";
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

export function createStartPacer(minIntervalMs: number): () => Promise<void> {
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
