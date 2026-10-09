import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const METEOSTAT_API_URL = "https://meteostat.p.rapidapi.com/point/monthly";
const METEOSTAT_DOCS_URL = "https://dev.meteostat.net/api/point/monthly.html";
const METEOSTAT_RAPIDAPI_HOST = "meteostat.p.rapidapi.com";

/**
 * The RapidAPI free plan is deliberately treated as a hard application
 * budget. The database quota function is the final guard before an upstream
 * request is made.
 */
export const METEOSTAT_MONTHLY_REQUEST_LIMIT = 500;
export const METEOSTAT_CACHE_TTL_SECONDS = 180 * 24 * 60 * 60;
export const METEOSTAT_FAILURE_COOLDOWN_SECONDS = 6 * 60 * 60;
export const METEOSTAT_QUOTA_MONTH_PREFIX = "meteostat";

export type MeteostatMonth = {
  month: string;
  averageTemperatureC: number | null;
  minimumTemperatureC: number | null;
  maximumTemperatureC: number | null;
  precipitationMm: number | null;
  snowDepthMm: number | null;
  sunshineMinutes: number | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  pressureHpa: number | null;
};

export type MeteostatWeather = {
  status: "ready";
  source: "Meteostat";
  sourceUrl: string;
  year: number;
  grid: { latitude: number; longitude: number };
  months: MeteostatMonth[];
  coverage: { observedMonths: number; expectedMonths: number };
  unsupportedMetrics: readonly ["humidity", "uvIndex"];
  fetchedAt: string;
  stale: boolean;
};

export type MeteostatUnavailable = {
  status: "unavailable";
  source: "Meteostat";
  sourceUrl: string;
  reason:
    | "provider_not_configured"
    | "coordinates_missing"
    | "quota_exhausted"
    | "cache_unavailable"
    | "upstream_error"
    | "invalid_payload"
    | "cooldown";
  message: string;
  retryAfter?: string;
};

export type MeteostatResult = MeteostatWeather | MeteostatUnavailable;

export type MeteostatCacheRow = {
  cache_key: string;
  grid_latitude: number;
  grid_longitude: number;
  period_start: string;
  period_end: string;
  payload: unknown | null;
  fetched_at: string | null;
  expires_at: string | null;
  last_error: string | null;
  retry_after: string | null;
};

export type MeteostatCacheStore = {
  read(cacheKey: string): Promise<MeteostatCacheRow | null>;
  writeSuccess(input: {
    cacheKey: string;
    gridLatitude: number;
    gridLongitude: number;
    periodStart: string;
    periodEnd: string;
    payload: unknown;
    fetchedAt: string;
    expiresAt: string;
  }): Promise<void>;
  writeFailure(input: {
    cacheKey: string;
    gridLatitude: number;
    gridLongitude: number;
    periodStart: string;
    periodEnd: string;
    error: string;
    retryAfter: string;
    fetchedAt: string;
    stalePayload?: unknown | null;
    staleFetchedAt?: string | null;
    staleExpiresAt?: string | null;
  }): Promise<void>;
  consumeQuota(monthStart: string): Promise<boolean>;
};

type JsonRecord = Record<string, unknown>;

type ProviderOptions = {
  now?: () => Date;
  fetcher?: typeof fetch;
  store?: MeteostatCacheStore;
  apiKey?: string | null;
};

type ParsedPayload = {
  months: MeteostatMonth[];
};

type MeteostatSupabaseClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        maybeSingle: () => Promise<{ data: unknown; error: { message?: string } | null }>;
      };
    };
    upsert: (
      values: Record<string, unknown>,
      options: { onConflict: string },
    ) => Promise<{ error: { message?: string } | null }>;
  };
};

const defaultStore: MeteostatCacheStore = {
  async read(cacheKey) {
    const client = supabaseAdmin as unknown as MeteostatSupabaseClient;
    const { data, error } = await client
      .from("meteostat_monthly_cache")
      .select(
        "cache_key,grid_latitude,grid_longitude,period_start,period_end,payload,fetched_at,expires_at,last_error,retry_after",
      )
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (error) throw error;
    return (data as MeteostatCacheRow | null) ?? null;
  },
  async writeSuccess(input) {
    const client = supabaseAdmin as unknown as MeteostatSupabaseClient;
    const { error } = await client.from("meteostat_monthly_cache").upsert(
      {
        cache_key: input.cacheKey,
        grid_latitude: input.gridLatitude,
        grid_longitude: input.gridLongitude,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        payload: input.payload,
        fetched_at: input.fetchedAt,
        expires_at: input.expiresAt,
        last_error: null,
        retry_after: null,
        updated_at: input.fetchedAt,
      },
      { onConflict: "cache_key" },
    );
    if (error) throw error;
  },
  async writeFailure(input) {
    const client = supabaseAdmin as unknown as MeteostatSupabaseClient;
    const { error } = await client.from("meteostat_monthly_cache").upsert(
      {
        cache_key: input.cacheKey,
        grid_latitude: input.gridLatitude,
        grid_longitude: input.gridLongitude,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        payload: input.stalePayload ?? null,
        fetched_at: input.staleFetchedAt ?? null,
        expires_at: input.staleExpiresAt ?? null,
        last_error: input.error,
        retry_after: input.retryAfter,
        updated_at: input.fetchedAt,
      },
      { onConflict: "cache_key" },
    );
    if (error) throw error;
  },
  async consumeQuota(monthStart) {
    type QuotaClient = {
      rpc: (
        name: "consume_meteostat_monthly_quota",
        args: { p_month_start: string; p_limit: number },
      ) => Promise<{ data: boolean | null; error: { message?: string } | null }>;
    };
    const client = supabaseAdmin as unknown as QuotaClient;
    const { data, error } = await client.rpc("consume_meteostat_monthly_quota", {
      p_month_start: monthStart,
      p_limit: METEOSTAT_MONTHLY_REQUEST_LIMIT,
    });
    if (error) throw error;
    return data === true;
  },
};

const inFlight = new Map<string, Promise<MeteostatResult>>();

/**
 * Fetch the latest complete calendar year available from Meteostat.
 *
 * Meteostat gives measurements rather than a synthetic score. We preserve
 * that distinction in the response and expose only metrics present in the
 * monthly endpoint; humidity and UV are intentionally not invented.
 */
export function getMeteostatHistoricalWeather(
  latitude: number,
  longitude: number,
  options: ProviderOptions = {},
): Promise<MeteostatResult> {
  // A module-local promise prevents duplicate cold-cache requests within a
  // warm Vercel instance. The database quota remains the cross-instance guard.
  // Test/custom stores intentionally bypass this map so each test stays
  // isolated and callers can use independent stores.
  const now = options.now?.() ?? new Date();
  const apiKey = options.apiKey === undefined ? process.env.METEOSTAT_RAPIDAPI_KEY : options.apiKey;
  if (
    !options.store &&
    !options.fetcher &&
    apiKey?.trim() &&
    validLatitude(latitude) &&
    validLongitude(longitude)
  ) {
    const year = now.getUTCFullYear() - 1;
    const grid = coarseGrid(latitude, longitude);
    const key = buildCacheKey(grid.latitude, grid.longitude, year);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = fetchMeteostatHistoricalWeather(latitude, longitude, {
      ...options,
      now: () => now,
      apiKey,
    });
    inFlight.set(key, promise);
    void promise.then(
      () => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      },
      () => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      },
    );
    return promise;
  }
  return fetchMeteostatHistoricalWeather(latitude, longitude, options);
}

async function fetchMeteostatHistoricalWeather(
  latitude: number,
  longitude: number,
  options: ProviderOptions = {},
): Promise<MeteostatResult> {
  const now = options.now?.() ?? new Date();
  const unavailableBase = {
    source: "Meteostat" as const,
    sourceUrl: METEOSTAT_DOCS_URL,
  };

  if (!validLatitude(latitude) || !validLongitude(longitude)) {
    return {
      ...unavailableBase,
      status: "unavailable",
      reason: "coordinates_missing",
      message: "Coordonnées géographiques absentes ou invalides.",
    };
  }

  const apiKey = options.apiKey === undefined ? process.env.METEOSTAT_RAPIDAPI_KEY : options.apiKey;
  if (!apiKey?.trim()) {
    return {
      ...unavailableBase,
      status: "unavailable",
      reason: "provider_not_configured",
      message: "La source météo n’est pas configurée.",
    };
  }

  const year = now.getUTCFullYear() - 1;
  const periodStart = `${year}-01-01`;
  const periodEnd = `${year}-12-31`;
  const grid = coarseGrid(latitude, longitude);
  const cacheKey = buildCacheKey(grid.latitude, grid.longitude, year);
  const store = options.store ?? defaultStore;

  let cached: MeteostatCacheRow | null;
  try {
    cached = await store.read(cacheKey);
  } catch (error) {
    console.error("[Meteostat] cache read failed", error);
    return {
      ...unavailableBase,
      status: "unavailable",
      reason: "cache_unavailable",
      message: "Le cache météo est momentanément indisponible.",
    };
  }

  const parsedCached = cached ? parseCachedPayload(cached.payload, year) : null;
  if (cached && parsedCached && isFutureDate(cached.expires_at, now)) {
    return readyResult({
      grid,
      year,
      parsed: parsedCached,
      fetchedAt: cached.fetched_at ?? now.toISOString(),
      stale: false,
    });
  }

  if (cached && isFutureDate(cached.retry_after, now)) {
    if (parsedCached) {
      return readyResult({
        grid,
        year,
        parsed: parsedCached,
        fetchedAt: cached.fetched_at ?? now.toISOString(),
        stale: true,
      });
    }
    return {
      ...unavailableBase,
      status: "unavailable",
      reason: "cooldown",
      message: "La source météo a échoué récemment. Un nouvel essai sera effectué plus tard.",
      retryAfter: cached.retry_after ?? undefined,
    };
  }

  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  let quotaAvailable: boolean;
  try {
    quotaAvailable = await store.consumeQuota(monthStart);
  } catch (error) {
    console.error("[Meteostat] quota check failed", error);
    return {
      ...unavailableBase,
      status: "unavailable",
      reason: "cache_unavailable",
      message: "Le contrôle du quota météo est momentanément indisponible.",
    };
  }
  if (!quotaAvailable) {
    if (parsedCached) {
      return readyResult({
        grid,
        year,
        parsed: parsedCached,
        fetchedAt: cached?.fetched_at ?? now.toISOString(),
        stale: true,
      });
    }
    return {
      ...unavailableBase,
      status: "unavailable",
      reason: "quota_exhausted",
      message: "Le quota mensuel gratuit de la source météo est atteint.",
    };
  }

  const fetcher = options.fetcher ?? fetch;
  try {
    const payload = await fetchMonthly(
      fetcher,
      grid.latitude,
      grid.longitude,
      periodStart,
      periodEnd,
      apiKey,
    );
    const parsed = parseMeteostatPayload(payload, year);
    if (!parsed) {
      await recordFailure(store, {
        cacheKey,
        grid,
        periodStart,
        periodEnd,
        error: "Réponse Meteostat inexploitable.",
        now,
        cached,
      });
      return {
        ...unavailableBase,
        status: "unavailable",
        reason: "invalid_payload",
        message: "La réponse météo n’a pas le format attendu.",
      };
    }

    const fetchedAt = now.toISOString();
    // Monthly observations arrive with a delay: refresh incomplete years sooner.
    const cacheTtlSeconds = parsed.months.length === 12 ? METEOSTAT_CACHE_TTL_SECONDS : 7 * 86400;
    const expiresAt = new Date(now.getTime() + cacheTtlSeconds * 1_000).toISOString();
    await store.writeSuccess({
      cacheKey,
      gridLatitude: grid.latitude,
      gridLongitude: grid.longitude,
      periodStart,
      periodEnd,
      payload: parsed,
      fetchedAt,
      expiresAt,
    });
    return readyResult({ grid, year, parsed, fetchedAt, stale: false });
  } catch (error) {
    const message = upstreamErrorMessage(error);
    await recordFailure(store, {
      cacheKey,
      grid,
      periodStart,
      periodEnd,
      error: message,
      now,
      cached,
    });
    if (parsedCached) {
      return readyResult({
        grid,
        year,
        parsed: parsedCached,
        fetchedAt: cached?.fetched_at ?? now.toISOString(),
        stale: true,
      });
    }
    return {
      ...unavailableBase,
      status: "unavailable",
      reason: "upstream_error",
      message: "La source météo est momentanément indisponible.",
    };
  }
}

export function coarseGrid(
  latitude: number,
  longitude: number,
): {
  latitude: number;
  longitude: number;
} {
  return {
    latitude: Number(latitude.toFixed(2)),
    longitude: Number(longitude.toFixed(2)),
  };
}

export function buildCacheKey(latitude: number, longitude: number, year: number): string {
  return `meteostat:${latitude.toFixed(2)}:${longitude.toFixed(2)}:${year}`;
}

export function parseMeteostatPayload(payload: unknown, year: number): ParsedPayload | null {
  const record = asRecord(payload);
  if (!Array.isArray(record.data)) return null;
  const months = record.data
    .map((value) => parseMonth(value, year))
    .filter((value): value is MeteostatMonth => value != null)
    .sort((a, b) => a.month.localeCompare(b.month));
  if (!months.length) return null;
  return { months };
}

function parseCachedPayload(payload: unknown, year: number): ParsedPayload | null {
  if (asRecord(payload).months) {
    const months = asRecord(payload).months;
    if (!Array.isArray(months)) return null;
    const parsed = months
      .map((value) => parseMonth(value, year))
      .filter((value): value is MeteostatMonth => value != null)
      .sort((a, b) => a.month.localeCompare(b.month));
    return parsed.length ? { months: parsed } : null;
  }
  return parseMeteostatPayload(payload, year);
}

function parseMonth(value: unknown, year: number): MeteostatMonth | null {
  const record = asRecord(value);
  const rawDate = textValue(record.date ?? record.month);
  if (!rawDate) return null;
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(rawDate);
  if (!match) return null;
  const monthYear = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthYear !== year || monthNumber < 1 || monthNumber > 12) return null;
  return {
    month: `${monthYear}-${String(monthNumber).padStart(2, "0")}`,
    averageTemperatureC: finiteNumber(record.tavg ?? record.averageTemperatureC),
    minimumTemperatureC: finiteNumber(record.tmin ?? record.minimumTemperatureC),
    maximumTemperatureC: finiteNumber(record.tmax ?? record.maximumTemperatureC),
    precipitationMm: finiteNumber(record.prcp ?? record.precipitationMm),
    snowDepthMm: finiteNumber(record.snow ?? record.snowDepthMm),
    sunshineMinutes: finiteNumber(record.tsun ?? record.sunshineMinutes),
    windSpeedKmh: finiteNumber(record.wspd ?? record.windSpeedKmh),
    windGustKmh: finiteNumber(record.wpgt ?? record.windGustKmh),
    pressureHpa: finiteNumber(record.pres ?? record.pressureHpa),
  };
}

async function fetchMonthly(
  fetcher: typeof fetch,
  latitude: number,
  longitude: number,
  periodStart: string,
  periodEnd: string,
  apiKey: string,
): Promise<unknown> {
  const url = new URL(METEOSTAT_API_URL);
  url.searchParams.set("lat", latitude.toFixed(4));
  url.searchParams.set("lon", longitude.toFixed(4));
  url.searchParams.set("start", periodStart);
  url.searchParams.set("end", periodEnd);
  const response = await fetcher(url, {
    headers: {
      Accept: "application/json",
      "x-rapidapi-host": METEOSTAT_RAPIDAPI_HOST,
      "x-rapidapi-key": apiKey.trim(),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Meteostat upstream HTTP ${response.status}`);
  }
  return response.json();
}

async function recordFailure(
  store: MeteostatCacheStore,
  input: {
    cacheKey: string;
    grid: { latitude: number; longitude: number };
    periodStart: string;
    periodEnd: string;
    error: string;
    now: Date;
    cached: MeteostatCacheRow | null;
  },
): Promise<void> {
  const retryAfter = new Date(
    input.now.getTime() + METEOSTAT_FAILURE_COOLDOWN_SECONDS * 1_000,
  ).toISOString();
  try {
    await store.writeFailure({
      cacheKey: input.cacheKey,
      gridLatitude: input.grid.latitude,
      gridLongitude: input.grid.longitude,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      error: input.error,
      retryAfter,
      fetchedAt: input.now.toISOString(),
      stalePayload: input.cached?.payload,
      staleFetchedAt: input.cached?.fetched_at,
      staleExpiresAt: input.cached?.expires_at,
    });
  } catch (error) {
    // The upstream error remains safe to report to the caller. A failed cache
    // write must not trigger a second upstream request in this invocation.
    console.error("[Meteostat] failure cache write failed", error);
  }
}

function readyResult(input: {
  grid: { latitude: number; longitude: number };
  year: number;
  parsed: ParsedPayload;
  fetchedAt: string;
  stale: boolean;
}): MeteostatWeather {
  return {
    status: "ready",
    source: "Meteostat",
    sourceUrl: METEOSTAT_DOCS_URL,
    year: input.year,
    grid: input.grid,
    months: input.parsed.months,
    coverage: { observedMonths: input.parsed.months.length, expectedMonths: 12 },
    unsupportedMetrics: ["humidity", "uvIndex"],
    fetchedAt: input.fetchedAt,
    stale: input.stale,
  };
}

function isFutureDate(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function upstreamErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Meteostat upstream error";
  return message.length > 240 ? message.slice(0, 240) : message;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
