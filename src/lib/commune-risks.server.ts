import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { departmentFromPostalCode, normalizeCommuneName } from "@/lib/commune-names";
import { asRecord } from "@/lib/guards";
import {
  GASPAR_SOURCE_URL,
  type CommuneCatnatEvent,
  type CommuneCatnatType,
  type CommunePreventionPlan,
  type CommuneRiskItem,
  type CommuneRiskResult,
} from "@/lib/environment-reference";

const GEO_API_COMMUNES_URL = "https://geo.api.gouv.fr/communes";
const GEORISQUES_API_BASE = "https://georisques.gouv.fr/api/v1";
const UPSTREAM_TIMEOUT_MS = 2_500;
const COMMUNE_REVALIDATE_SECONDS = 30 * 24 * 60 * 60;
const ZONING_RECHECK_MS = 180 * 24 * 60 * 60 * 1000;
const NEAREST_CENTRE_MAX_KM = 6;

export type SaleLocation = {
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  postalCode: string | null;
  department: string | null;
};

export type ResolvedCommune = {
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
};

type FetchLike = typeof fetch;

/**
 * INSEE code of the commune of a listing.
 *
 * 1. Coordinates: official reverse lookup (geo.api.gouv.fr), cached 30 days.
 * 2. Otherwise, or if that service fails: the local `reference_communes` table,
 *    by postal code and name, then by department and name, then by the nearest
 *    commune centre when only coordinates are known.
 */
export async function resolveSaleCommune(
  location: SaleLocation,
  fetcher: FetchLike = fetch,
): Promise<ResolvedCommune | null> {
  const hasCoordinates = validCoordinates(location.latitude, location.longitude);
  if (hasCoordinates) {
    const code = await reverseGeocodeCommune(location.latitude!, location.longitude!, fetcher);
    if (code) {
      const commune = await readCommune(code);
      return (
        commune ?? { code, name: location.city?.trim() || code, latitude: null, longitude: null }
      );
    }
  }
  const byName = await communeByName(location);
  if (byName) return byName;
  return hasCoordinates ? nearestCommuneCentre(location.latitude!, location.longitude!) : null;
}

async function reverseGeocodeCommune(
  latitude: number,
  longitude: number,
  fetcher: FetchLike,
): Promise<string | null> {
  const url = new URL(GEO_API_COMMUNES_URL);
  url.searchParams.set("lat", latitude.toFixed(5));
  url.searchParams.set("lon", longitude.toFixed(5));
  url.searchParams.set("fields", "code,nom");
  url.searchParams.set("format", "json");
  try {
    const response = await fetcher(url, {
      next: { revalidate: COMMUNE_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    } as RequestInit);
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const first = Array.isArray(payload) ? asRecord(payload[0]) : null;
    const code = typeof first?.code === "string" ? first.code : null;
    return code && INSEE_PATTERN.test(code) ? code : null;
  } catch {
    return null;
  }
}

const INSEE_PATTERN = /^[0-9][0-9AB][0-9]{3}$/;
const COMMUNE_COLUMNS =
  "code_insee,name,name_normalized,department_code,postal_codes,latitude,longitude";

type CommuneRow = {
  code_insee: string;
  name: string;
  name_normalized: string;
  department_code: string;
  postal_codes: string[];
  latitude: number | null;
  longitude: number | null;
};

function toResolved(row: CommuneRow): ResolvedCommune {
  return { code: row.code_insee, name: row.name, latitude: row.latitude, longitude: row.longitude };
}

async function readCommune(code: string): Promise<ResolvedCommune | null> {
  const { data, error } = await supabaseAdmin
    .from("reference_communes")
    .select(COMMUNE_COLUMNS)
    .eq("code_insee", code)
    .maybeSingle();
  if (error || !data) return null;
  return toResolved(data);
}

async function communeByName(location: SaleLocation): Promise<ResolvedCommune | null> {
  const name = normalizeCommuneName(stripArrondissement(location.city));
  const postalCode = /^\d{5}$/.test(location.postalCode?.trim() ?? "")
    ? location.postalCode!.trim()
    : null;
  if (postalCode) {
    const { data, error } = await supabaseAdmin
      .from("reference_communes")
      .select(COMMUNE_COLUMNS)
      .contains("postal_codes", [postalCode])
      .limit(50);
    if (!error && data?.length) {
      const match = data.find((row) => row.name_normalized === name);
      if (match) return toResolved(match);
      if (data.length === 1 && !name) return toResolved(data[0]);
    }
  }
  if (!name) return null;
  const department =
    departmentFromPostalCode(postalCode) ?? normalizedDepartment(location.department);
  let query = supabaseAdmin
    .from("reference_communes")
    .select(COMMUNE_COLUMNS)
    .eq("name_normalized", name)
    .limit(5);
  if (department) query = query.eq("department_code", department);
  const { data, error } = await query;
  if (error || !data?.length) return null;
  // Without a department, a name shared by several communes stays ambiguous.
  return data.length === 1 ? toResolved(data[0]) : null;
}

async function nearestCommuneCentre(
  latitude: number,
  longitude: number,
): Promise<ResolvedCommune | null> {
  const delta = 0.08;
  const { data, error } = await supabaseAdmin
    .from("reference_communes")
    .select(COMMUNE_COLUMNS)
    .gte("latitude", latitude - delta)
    .lte("latitude", latitude + delta)
    .gte("longitude", longitude - delta * 1.5)
    .lte("longitude", longitude + delta * 1.5)
    .limit(200);
  if (error || !data?.length) return null;
  let best: { row: CommuneRow; distance: number } | null = null;
  for (const row of data) {
    if (row.latitude == null || row.longitude == null) continue;
    const distance = distanceKm(latitude, longitude, row.latitude, row.longitude);
    if (!best || distance < best.distance) best = { row, distance };
  }
  return best && best.distance <= NEAREST_CENTRE_MAX_KM ? toResolved(best.row) : null;
}

/** "Paris 12e Arrondissement" / "Marseille 8ème" -> "Paris" / "Marseille". */
function stripArrondissement(city: string | null | undefined): string {
  return (city ?? "")
    .replace(/\b\d{1,2}\s*(?:e|er|ème|eme)?\s*(?:arrondissement|arr\.?)?\s*$/iu, "")
    .replace(/\s*\(\d{5}\)\s*$/u, "")
    .trim();
}

function normalizedDepartment(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  if (/^\d$/.test(code)) return `0${code}`;
  return /^(\d{2}|2A|2B|97[1-8])$/.test(code) ? code : null;
}

type ProfileRow = {
  code_insee: string;
  commune_name: string;
  risks: unknown;
  catnat_total: number;
  catnat_by_type: unknown;
  catnat_recent: unknown;
  prevention_plans: unknown;
  seismic_zone: number | null;
  radon_class: number | null;
  gaspar_snapshot: string | null;
  zoning_checked_at: string | null;
  source_url: string;
};

const PROFILE_COLUMNS =
  "code_insee,commune_name,risks,catnat_total,catnat_by_type,catnat_recent,prevention_plans,seismic_zone,radon_class,gaspar_snapshot,zoning_checked_at,source_url";

/** GASPAR profile of a commune, completed once with its seismic zone and radon class. */
export async function getCommuneRiskProfile(
  commune: ResolvedCommune,
  options: { fetcher?: FetchLike; now?: Date } = {},
): Promise<CommuneRiskResult> {
  const { data, error } = await supabaseAdmin
    .from("commune_risk_profiles")
    .select(PROFILE_COLUMNS)
    .eq("code_insee", commune.code)
    .maybeSingle();
  if (error) return { status: "unavailable", reason: "source_unavailable" };
  if (!data) return { status: "unavailable", reason: "profile_missing" };
  let row = data as ProfileRow;
  const now = options.now ?? new Date();
  if (needsZoning(row, now)) {
    row = await completeZoning(row, options.fetcher ?? fetch, now);
  }
  return {
    status: "ready",
    commune: { code: row.code_insee, name: commune.name || row.commune_name },
    risks: riskItems(row.risks),
    catnatTotal: row.catnat_total,
    catnatByType: catnatTypes(row.catnat_by_type),
    catnatRecent: catnatEvents(row.catnat_recent),
    preventionPlans: preventionPlans(row.prevention_plans),
    seismicZone: row.seismic_zone,
    radonClass: row.radon_class,
    snapshot: row.gaspar_snapshot,
    sourceUrl: row.source_url || GASPAR_SOURCE_URL,
  };
}

function needsZoning(row: ProfileRow, now: Date): boolean {
  if (row.seismic_zone != null && row.radon_class != null) return false;
  if (!row.zoning_checked_at) return true;
  return now.getTime() - Date.parse(row.zoning_checked_at) > ZONING_RECHECK_MS;
}

/**
 * The seismic zone and radon potential are not in the GASPAR archive. They are
 * read once per commune from the Géorisques API and stored; a failure leaves
 * the profile usable and is retried after the recheck delay only if nothing was stored.
 */
async function completeZoning(row: ProfileRow, fetcher: FetchLike, now: Date): Promise<ProfileRow> {
  const [seismic, radon] = await Promise.all([
    georisquesFirst(fetcher, "zonage_sismique", row.code_insee),
    georisquesFirst(fetcher, "radon", row.code_insee),
  ]);
  const seismicZone = boundedInteger(seismic?.code_zone, 1, 5) ?? row.seismic_zone;
  const radonClass = boundedInteger(radon?.classe_potentiel, 1, 3) ?? row.radon_class;
  if (seismic === undefined && radon === undefined) return row;
  const update = {
    seismic_zone: seismicZone,
    radon_class: radonClass,
    zoning_checked_at: now.toISOString(),
  };
  await supabaseAdmin.from("commune_risk_profiles").update(update).eq("code_insee", row.code_insee);
  return { ...row, ...update };
}

/** First record of a Géorisques v1 answer; `undefined` when the call failed. */
async function georisquesFirst(
  fetcher: FetchLike,
  path: string,
  codeInsee: string,
): Promise<Record<string, unknown> | null | undefined> {
  try {
    const url = new URL(`${GEORISQUES_API_BASE}/${path}`);
    url.searchParams.set("code_insee", codeInsee);
    const response = await fetcher(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const payload = asRecord(await response.json());
    const rows = Array.isArray(payload?.data) ? payload.data : null;
    if (!rows) return undefined;
    return asRecord(rows[0]) ?? null;
  } catch {
    return undefined;
  }
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  const number = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= min && number <= max
    ? number
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function riskItems(value: unknown): CommuneRiskItem[] {
  return records(value).flatMap((item) => {
    const code = text(item.code);
    const label = text(item.label);
    return code && label ? [{ code, label }] : [];
  });
}

function catnatTypes(value: unknown): CommuneCatnatType[] {
  return records(value).flatMap((item) => {
    const code = text(item.code);
    const label = text(item.label);
    const count = typeof item.count === "number" ? item.count : null;
    return code && label && count != null ? [{ code, label, count }] : [];
  });
}

function catnatEvents(value: unknown): CommuneCatnatEvent[] {
  return records(value).flatMap((item) => {
    const code = text(item.code);
    const label = text(item.label);
    return code && label
      ? [
          {
            code,
            label,
            start: text(item.start),
            end: text(item.end),
            decree: text(item.decree),
            published: text(item.published),
          },
        ]
      : [];
  });
}

function preventionPlans(value: unknown): CommunePreventionPlan[] {
  return records(value).flatMap((item) => {
    const family = item.family;
    const label = text(item.label);
    if ((family !== "PPRN" && family !== "PPRT" && family !== "PPRM") || !label) return [];
    return [
      {
        family,
        kind: text(item.kind) ?? family,
        label,
        status: text(item.status),
        prescribedOn: text(item.prescribed_on),
        approvedOn: text(item.approved_on),
        risks: Array.isArray(item.risks)
          ? item.risks.filter((risk): risk is string => typeof risk === "string")
          : [],
      },
    ];
  });
}

export function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
