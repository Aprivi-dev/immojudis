import "server-only";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { distanceKm, validCoordinates } from "@/lib/commune-risks.server";
import {
  METEO_FRANCE_SOURCE_URL,
  type ClimateMonth,
  type ClimateResult,
  type ClimateStationRef,
  type ClimateSummary,
} from "@/lib/environment-reference";

/** Maximum distance between the listing and the station used for each measure. */
export const CLIMATE_STATION_RADIUS_KM = {
  temperature: 40,
  precipitation: 30,
  sunshine: 70,
} as const;
const CANDIDATES_PER_METRIC = 3;
const FIRST_NORMAL_YEAR = 2016;
const MIN_NORMAL_YEARS = 5;
const MIN_MONTHS_FOR_YEAR = 10;
const SEARCH_BOX_DEGREES = { latitude: 0.7, longitude: 1.0 };

type Metric = keyof typeof CLIMATE_STATION_RADIUS_KM;

type StationRow = {
  station_id: string;
  name: string;
  latitude: number;
  longitude: number;
  altitude_m: number | null;
  last_month: string;
  has_temperature: boolean;
  has_precipitation: boolean;
  has_sunshine: boolean;
};

export type MonthRow = {
  station_id: string;
  month: string;
  precipitation_mm: number | null;
  mean_temperature_c: number | null;
  mean_min_temperature_c: number | null;
  mean_max_temperature_c: number | null;
  sunshine_minutes: number | null;
  rain_days: number | null;
  frost_days: number | null;
  hot_days: number | null;
};

type Candidate = StationRow & { distanceKm: number };

const METRIC_FLAG: Record<Metric, keyof StationRow> = {
  temperature: "has_temperature",
  precipitation: "has_precipitation",
  sunshine: "has_sunshine",
};

const METRIC_COLUMN: Record<Metric, keyof MonthRow> = {
  temperature: "mean_temperature_c",
  precipitation: "precipitation_mm",
  sunshine: "sunshine_minutes",
};

/**
 * Météo-France monthly observations around a point: the nearest station for
 * each measure, the latest complete year and the 2016-to-previous-year average.
 * Reads only local tables (imported by the "Reference data import" workflow).
 */
export async function getClimateHistory(
  latitude: number | null,
  longitude: number | null,
  options: { locationSource?: "listing" | "commune"; now?: Date } = {},
): Promise<ClimateResult> {
  if (!validCoordinates(latitude, longitude)) {
    return { status: "unavailable", reason: "location_missing" };
  }
  const now = options.now ?? new Date();
  const roundedLatitude = Math.round(latitude! * 100) / 100;
  const roundedLongitude = Math.round(longitude! * 100) / 100;
  const read = unstable_cache(
    () => computeClimateHistory(roundedLatitude, roundedLongitude, now.getUTCFullYear()),
    [
      "climate-history",
      String(roundedLatitude),
      String(roundedLongitude),
      String(now.getUTCFullYear()),
    ],
    { revalidate: 24 * 60 * 60, tags: ["climate-history"] },
  );
  const result = await read();
  return result.status === "ready"
    ? { ...result, locationSource: options.locationSource ?? "listing" }
    : result;
}

async function computeClimateHistory(
  latitude: number,
  longitude: number,
  currentYear: number,
): Promise<ClimateResult> {
  const { data: stations, error } = await supabaseAdmin
    .from("climate_stations")
    .select(
      "station_id,name,latitude,longitude,altitude_m,last_month,has_temperature,has_precipitation,has_sunshine",
    )
    .gte("latitude", latitude - SEARCH_BOX_DEGREES.latitude)
    .lte("latitude", latitude + SEARCH_BOX_DEGREES.latitude)
    .gte("longitude", longitude - SEARCH_BOX_DEGREES.longitude)
    .lte("longitude", longitude + SEARCH_BOX_DEGREES.longitude)
    .gte("last_month", `${currentYear - 1}-01-01`)
    .limit(1000);
  if (error) throw error;
  const candidates = (stations ?? [])
    .map((station) => ({
      ...station,
      distanceKm: distanceKm(latitude, longitude, station.latitude, station.longitude),
    }))
    .sort((left, right) => left.distanceKm - right.distanceKm);
  const shortlist = new Map<string, Candidate>();
  for (const metric of Object.keys(CLIMATE_STATION_RADIUS_KM) as Metric[]) {
    candidates
      .filter(
        (station) =>
          station[METRIC_FLAG[metric]] === true &&
          station.distanceKm <= CLIMATE_STATION_RADIUS_KM[metric],
      )
      .slice(0, CANDIDATES_PER_METRIC)
      .forEach((station) => shortlist.set(station.station_id, station));
  }
  if (shortlist.size === 0) return { status: "unavailable", reason: "no_station_nearby" };

  const monthsByStation = new Map<string, MonthRow[]>();
  await Promise.all(
    [...shortlist.keys()].map(async (stationId) => {
      const { data, error: monthsError } = await supabaseAdmin
        .from("climate_station_months")
        .select(
          "station_id,month,precipitation_mm,mean_temperature_c,mean_min_temperature_c,mean_max_temperature_c,sunshine_minutes,rain_days,frost_days,hot_days",
        )
        .eq("station_id", stationId)
        .gte("month", `${FIRST_NORMAL_YEAR}-01-01`)
        .order("month", { ascending: true })
        .limit(400);
      if (monthsError) throw monthsError;
      monthsByStation.set(stationId, data ?? []);
    }),
  );
  return buildClimateHistory([...shortlist.values()], monthsByStation, currentYear);
}

/** Pure assembly step, exported for tests. */
export function buildClimateHistory(
  shortlist: Candidate[],
  monthsByStation: Map<string, MonthRow[]>,
  currentYear: number,
): ClimateResult {
  const ordered = [...shortlist].sort((left, right) => left.distanceKm - right.distanceKm);
  const pick = (metric: Metric, year: number) =>
    ordered.find(
      (station) =>
        station[METRIC_FLAG[metric]] === true &&
        station.distanceKm <= CLIMATE_STATION_RADIUS_KM[metric] &&
        monthsWithValue(monthsByStation.get(station.station_id), METRIC_COLUMN[metric], year) >=
          MIN_MONTHS_FOR_YEAR,
    ) ?? null;

  let year = currentYear - 1;
  if (!pick("temperature", year) && !pick("precipitation", year)) year -= 1;
  const temperature = pick("temperature", year);
  const precipitation = pick("precipitation", year) ?? null;
  const sunshine = pick("sunshine", year);
  if (!temperature && !precipitation) return { status: "unavailable", reason: "no_station_nearby" };

  const series = (station: Candidate | null) =>
    station ? (monthsByStation.get(station.station_id) ?? []) : [];
  const temperatureRows = series(temperature);
  const precipitationRows = series(precipitation);
  const sunshineRows = series(sunshine);
  const normalEnd = year - 1;

  const months: ClimateMonth[] = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const temp = rowFor(temperatureRows, year, month);
    const rain = rowFor(precipitationRows, year, month);
    const sun = rowFor(sunshineRows, year, month);
    const sunshineMinutes = sun?.sunshine_minutes ?? null;
    const normalSunshine = monthlyNormal(sunshineRows, month, normalEnd, "sunshine_minutes");
    return {
      month,
      meanTemperatureC: temp?.mean_temperature_c ?? null,
      meanMinTemperatureC: temp?.mean_min_temperature_c ?? null,
      meanMaxTemperatureC: temp?.mean_max_temperature_c ?? null,
      precipitationMm: rain?.precipitation_mm ?? null,
      rainDays: rain?.rain_days ?? null,
      sunshineHours: sunshineMinutes == null ? null : round(sunshineMinutes / 60),
      frostDays: temp?.frost_days ?? null,
      hotDays: temp?.hot_days ?? null,
      normalTemperatureC: round(
        monthlyNormal(temperatureRows, month, normalEnd, "mean_temperature_c"),
      ),
      normalPrecipitationMm: round(
        monthlyNormal(precipitationRows, month, normalEnd, "precipitation_mm"),
      ),
      normalSunshineHours: normalSunshine == null ? null : round(normalSunshine / 60),
    };
  });

  const normalMonths = (rows: MonthRow[], column: keyof MonthRow) =>
    Array.from({ length: 12 }, (_, index) => monthlyNormal(rows, index + 1, normalEnd, column));
  const hasNormal = months.some(
    (month) => month.normalTemperatureC != null || month.normalPrecipitationMm != null,
  );

  return {
    status: "ready",
    year,
    normalPeriod: hasNormal ? { startYear: FIRST_NORMAL_YEAR, endYear: normalEnd } : null,
    stations: {
      temperature: stationRef(temperature),
      precipitation: stationRef(precipitation),
      sunshine: stationRef(sunshine),
    },
    months,
    summary: {
      meanTemperatureC: round(average(months.map((month) => month.meanTemperatureC))),
      precipitationMm: round(total(months.map((month) => month.precipitationMm))),
      sunshineHours: round(total(months.map((month) => month.sunshineHours))),
      frostDays: total(months.map((month) => month.frostDays)),
      hotDays: total(months.map((month) => month.hotDays)),
      rainDays: total(months.map((month) => month.rainDays)),
    },
    normal: {
      meanTemperatureC: round(average(normalMonths(temperatureRows, "mean_temperature_c"))),
      precipitationMm: round(total(normalMonths(precipitationRows, "precipitation_mm"))),
      sunshineHours: round(divide(total(normalMonths(sunshineRows, "sunshine_minutes")), 60)),
      frostDays: round(total(normalMonths(temperatureRows, "frost_days"))),
      hotDays: round(total(normalMonths(temperatureRows, "hot_days"))),
      rainDays: round(total(normalMonths(precipitationRows, "rain_days"))),
    } satisfies ClimateSummary,
    locationSource: "listing",
    sourceUrl: METEO_FRANCE_SOURCE_URL,
  };
}

function stationRef(station: Candidate | null): ClimateStationRef | null {
  return station
    ? {
        id: station.station_id,
        name: titleCase(station.name),
        distanceKm: Math.round(station.distanceKm),
        altitudeM: station.altitude_m,
      }
    : null;
}

function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /(^|[\s'-])(\p{L})/gu,
      (_, separator: string, letter: string) => separator + letter.toUpperCase(),
    );
}

function yearMonth(row: MonthRow): { year: number; month: number } {
  return { year: Number(row.month.slice(0, 4)), month: Number(row.month.slice(5, 7)) };
}

function rowFor(rows: MonthRow[], year: number, month: number): MonthRow | undefined {
  return rows.find((row) => {
    const value = yearMonth(row);
    return value.year === year && value.month === month;
  });
}

function monthsWithValue(
  rows: MonthRow[] | undefined,
  column: keyof MonthRow,
  year: number,
): number {
  return (rows ?? []).filter((row) => yearMonth(row).year === year && row[column] != null).length;
}

function monthlyNormal(
  rows: MonthRow[],
  month: number,
  lastYear: number,
  column: keyof MonthRow,
): number | null {
  const values = rows
    .filter((row) => {
      const value = yearMonth(row);
      return value.month === month && value.year >= FIRST_NORMAL_YEAR && value.year <= lastYear;
    })
    .map((row) => row[column])
    .filter((value): value is number => typeof value === "number");
  return values.length >= MIN_NORMAL_YEARS
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

/** Mean of twelve monthly values; null if any month is missing. */
function average(values: (number | null)[]): number | null {
  const total12 = total(values);
  return total12 == null ? null : total12 / 12;
}

/** Sum of twelve monthly values; null if any month is missing. */
function total(values: (number | null)[]): number | null {
  if (values.length !== 12 || values.some((value) => value == null)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function divide(value: number | null, divisor: number): number | null {
  return value == null ? null : value / divisor;
}

function round(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}
