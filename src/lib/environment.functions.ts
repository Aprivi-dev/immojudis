import { z } from "zod";

const GEOCODING_BASE = "https://data.geopf.fr/geocodage/search";
const OPEN_METEO_ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const ENVIRONMENT_USER_AGENT = "immojudis/1.0 (+https://immojudis-dezt.vercel.app/contact)";
const COMPLETE_YEARS_BACK = 5;

const inputSchema = z.object({
  address: z.string().trim().min(3).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

type GeocodingFeature = {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: {
    label?: string;
    score?: number;
    city?: string;
    postcode?: string;
    context?: string;
    type?: string;
  };
};

type GeocodingResponse = {
  features?: GeocodingFeature[];
};

type OpenMeteoDaily = {
  time?: string[];
  temperature_2m_max?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
  precipitation_sum?: Array<number | null>;
  wind_speed_10m_max?: Array<number | null>;
  sunshine_duration?: Array<number | null>;
  daylight_duration?: Array<number | null>;
  shortwave_radiation_sum?: Array<number | null>;
};

type OpenMeteoArchiveResponse = {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  elevation?: number;
  daily_units?: Record<string, string>;
  daily?: OpenMeteoDaily;
};

type MonthlyBucket = {
  years: Set<number>;
  lowSum: number;
  lowCount: number;
  highSum: number;
  highCount: number;
  precipitationSum: number;
  windSum: number;
  windCount: number;
  sunshineSeconds: number;
  daylightSeconds: number;
  radiationMjM2: number;
};

export type EnvironmentMonthlyPoint = {
  month: number;
  label: string;
  avgLowC: number | null;
  avgHighC: number | null;
  avgPrecipitationMm: number | null;
  avgWindKmh: number | null;
  avgSunshineHours: number | null;
  avgDaylightHours: number | null;
  sunshineRatioPct: number | null;
  avgRadiationKwhM2: number | null;
};

export type EnvironmentResolvedAddress = {
  label: string;
  score: number | null;
  latitude: number;
  longitude: number;
  source: "Coordonnées annonce" | "Géoplateforme";
};

export type EnvironmentalContext = {
  source: "Géoplateforme + Open-Meteo Archive";
  resolvedAddress: EnvironmentResolvedAddress;
  period: {
    startYear: number;
    endYear: number;
    years: number;
  };
  weather: {
    monthly: EnvironmentMonthlyPoint[];
    avgAnnualPrecipitationMm: number | null;
    avgAnnualWindKmh: number | null;
    warmestMonth: EnvironmentMonthlyPoint | null;
    coldestMonth: EnvironmentMonthlyPoint | null;
  };
  sun: {
    monthly: EnvironmentMonthlyPoint[];
    avgAnnualSunshineHours: number | null;
    avgAnnualDaylightHours: number | null;
    avgAnnualRadiationKwhM2: number | null;
    avgSunshineRatioPct: number | null;
    juneSunshineRatioPct: number | null;
    decemberSunshineRatioPct: number | null;
  };
  rawUnits: Record<string, string>;
};

export type EnvironmentalContextResponse = {
  ok: boolean;
  error: string | null;
  context: EnvironmentalContext | null;
};

const MONTH_LABELS = [
  "Jan",
  "Fév",
  "Mar",
  "Avr",
  "Mai",
  "Juin",
  "Juil",
  "Août",
  "Sep",
  "Oct",
  "Nov",
  "Déc",
] as const;

export function environmentalContextCacheControl(response: EnvironmentalContextResponse): string {
  return response.ok
    ? "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800"
    : "public, max-age=300, s-maxage=300";
}

export async function getEnvironmentalContext(
  input: unknown,
): Promise<EnvironmentalContextResponse> {
  const data = inputSchema.parse(input);

  try {
    const resolvedAddress = await resolveAddress({
      address: data.address ?? null,
      lat: data.lat ?? null,
      lng: data.lng ?? null,
    });

    const endYear = new Date().getUTCFullYear() - 1;
    const startYear = endYear - COMPLETE_YEARS_BACK + 1;
    const archive = await fetchOpenMeteoArchive({
      lat: resolvedAddress.latitude,
      lng: resolvedAddress.longitude,
      startYear,
      endYear,
    });

    const monthly = aggregateMonthly(archive.daily, startYear, endYear);
    const context: EnvironmentalContext = {
      source: "Géoplateforme + Open-Meteo Archive",
      resolvedAddress,
      period: {
        startYear,
        endYear,
        years: endYear - startYear + 1,
      },
      weather: buildWeatherSummary(monthly),
      sun: buildSunSummary(monthly),
      rawUnits: archive.daily_units ?? {},
    };

    return { ok: true, error: null, context };
  } catch (err) {
    console.error("Environmental context fetch failed", err);
    return {
      ok: false,
      error: "Données météo et soleil temporairement indisponibles.",
      context: null,
    };
  }
}

async function resolveAddress({
  address,
  lat,
  lng,
}: {
  address: string | null;
  lat: number | null;
  lng: number | null;
}): Promise<EnvironmentResolvedAddress> {
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return {
      label: address?.trim() || "Coordonnées de l'annonce",
      score: null,
      latitude: lat!,
      longitude: lng!,
      source: "Coordonnées annonce",
    };
  }

  if (!address?.trim()) {
    throw new Error("Adresse absente : impossible de localiser les données environnementales.");
  }

  const url = new URL(GEOCODING_BASE);
  url.searchParams.set("q", address.trim());
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": ENVIRONMENT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Géocodage indisponible (${response.status}).`);
  }

  const payload = (await response.json()) as GeocodingResponse;
  const feature = payload.features?.[0];
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error("Adresse non localisée par la Géoplateforme.");
  }

  const lngValue = Number(coordinates[0]);
  const latValue = Number(coordinates[1]);
  if (!Number.isFinite(latValue) || !Number.isFinite(lngValue)) {
    throw new Error("Coordonnées de géocodage invalides.");
  }

  return {
    label: feature?.properties?.label ?? address.trim(),
    score: finiteOrNull(feature?.properties?.score),
    latitude: latValue,
    longitude: lngValue,
    source: "Géoplateforme",
  };
}

async function fetchOpenMeteoArchive({
  lat,
  lng,
  startYear,
  endYear,
}: {
  lat: number;
  lng: number;
  startYear: number;
  endYear: number;
}): Promise<OpenMeteoArchiveResponse> {
  const url = new URL(OPEN_METEO_ARCHIVE_BASE);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("start_date", `${startYear}-01-01`);
  url.searchParams.set("end_date", `${endYear}-12-31`);
  url.searchParams.set(
    "daily",
    [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "wind_speed_10m_max",
      "sunshine_duration",
      "daylight_duration",
      "shortwave_radiation_sum",
    ].join(","),
  );
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": ENVIRONMENT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo archive indisponible (${response.status}).`);
  }

  const payload = (await response.json()) as OpenMeteoArchiveResponse;
  if (!payload.daily?.time?.length) {
    throw new Error("Open-Meteo n'a renvoyé aucune série quotidienne.");
  }
  return payload;
}

function aggregateMonthly(
  daily: OpenMeteoDaily | undefined,
  startYear: number,
  endYear: number,
): EnvironmentMonthlyPoint[] {
  const buckets = MONTH_LABELS.map<MonthlyBucket>(() => ({
    years: new Set<number>(),
    lowSum: 0,
    lowCount: 0,
    highSum: 0,
    highCount: 0,
    precipitationSum: 0,
    windSum: 0,
    windCount: 0,
    sunshineSeconds: 0,
    daylightSeconds: 0,
    radiationMjM2: 0,
  }));

  const times = daily?.time ?? [];
  times.forEach((dateValue, index) => {
    const date = new Date(`${dateValue}T00:00:00Z`);
    const year = date.getUTCFullYear();
    if (year < startYear || year > endYear) return;

    const monthIndex = date.getUTCMonth();
    const bucket = buckets[monthIndex];
    bucket.years.add(year);

    const low = numberAt(daily?.temperature_2m_min, index);
    if (low != null) {
      bucket.lowSum += low;
      bucket.lowCount += 1;
    }

    const high = numberAt(daily?.temperature_2m_max, index);
    if (high != null) {
      bucket.highSum += high;
      bucket.highCount += 1;
    }

    bucket.precipitationSum += numberAt(daily?.precipitation_sum, index) ?? 0;

    const wind = numberAt(daily?.wind_speed_10m_max, index);
    if (wind != null) {
      bucket.windSum += wind;
      bucket.windCount += 1;
    }

    bucket.sunshineSeconds += numberAt(daily?.sunshine_duration, index) ?? 0;
    bucket.daylightSeconds += numberAt(daily?.daylight_duration, index) ?? 0;
    bucket.radiationMjM2 += numberAt(daily?.shortwave_radiation_sum, index) ?? 0;
  });

  return buckets.map((bucket, index) => {
    const yearCount = bucket.years.size;
    const avgSunshineHours = yearCount ? bucket.sunshineSeconds / 3600 / yearCount : null;
    const avgDaylightHours = yearCount ? bucket.daylightSeconds / 3600 / yearCount : null;
    return {
      month: index + 1,
      label: MONTH_LABELS[index],
      avgLowC: average(bucket.lowSum, bucket.lowCount),
      avgHighC: average(bucket.highSum, bucket.highCount),
      avgPrecipitationMm: yearCount ? round(bucket.precipitationSum / yearCount, 1) : null,
      avgWindKmh: average(bucket.windSum, bucket.windCount),
      avgSunshineHours: roundOrNull(avgSunshineHours, 0),
      avgDaylightHours: roundOrNull(avgDaylightHours, 0),
      sunshineRatioPct:
        bucket.daylightSeconds > 0
          ? round((bucket.sunshineSeconds / bucket.daylightSeconds) * 100, 0)
          : null,
      avgRadiationKwhM2: yearCount ? round(bucket.radiationMjM2 / 3.6 / yearCount, 0) : null,
    };
  });
}

function buildWeatherSummary(monthly: EnvironmentMonthlyPoint[]): EnvironmentalContext["weather"] {
  const warmestMonth = maxBy(monthly, (month) => month.avgHighC);
  const coldestMonth = minBy(monthly, (month) => month.avgLowC);
  return {
    monthly,
    avgAnnualPrecipitationMm: sumKnown(monthly.map((month) => month.avgPrecipitationMm)),
    avgAnnualWindKmh: averageKnown(monthly.map((month) => month.avgWindKmh)),
    warmestMonth,
    coldestMonth,
  };
}

function buildSunSummary(monthly: EnvironmentMonthlyPoint[]): EnvironmentalContext["sun"] {
  const annualSunshine = sumKnown(monthly.map((month) => month.avgSunshineHours));
  const annualDaylight = sumKnown(monthly.map((month) => month.avgDaylightHours));
  return {
    monthly,
    avgAnnualSunshineHours: annualSunshine,
    avgAnnualDaylightHours: annualDaylight,
    avgAnnualRadiationKwhM2: sumKnown(monthly.map((month) => month.avgRadiationKwhM2)),
    avgSunshineRatioPct:
      annualSunshine != null && annualDaylight != null && annualDaylight > 0
        ? round((annualSunshine / annualDaylight) * 100, 0)
        : null,
    juneSunshineRatioPct: monthly[5]?.sunshineRatioPct ?? null,
    decemberSunshineRatioPct: monthly[11]?.sunshineRatioPct ?? null,
  };
}

function numberAt(values: Array<number | null> | undefined, index: number): number | null {
  const value = values?.[index];
  return finiteOrNull(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function average(sum: number, count: number): number | null {
  return count > 0 ? round(sum / count, 1) : null;
}

function averageKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null);
  if (!known.length) return null;
  return round(known.reduce((sum, value) => sum + value, 0) / known.length, 1);
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null);
  if (!known.length) return null;
  return round(
    known.reduce((sum, value) => sum + value, 0),
    0,
  );
}

function roundOrNull(value: number | null, precision: number): number | null {
  return value == null || !Number.isFinite(value) ? null : round(value, precision);
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function maxBy<T>(items: T[], valueOf: (item: T) => number | null): T | null {
  let best: T | null = null;
  let bestValue = -Infinity;
  for (const item of items) {
    const value = valueOf(item);
    if (value != null && value > bestValue) {
      best = item;
      bestValue = value;
    }
  }
  return best;
}

function minBy<T>(items: T[], valueOf: (item: T) => number | null): T | null {
  let best: T | null = null;
  let bestValue = Infinity;
  for (const item of items) {
    const value = valueOf(item);
    if (value != null && value < bestValue) {
      best = item;
      bestValue = value;
    }
  }
  return best;
}
