/**
 * Client-safe shapes of the official reference data shown on a listing:
 * commune risks (GASPAR, Géorisques) and Météo-France climatology.
 */

export type CommuneRiskItem = { code: string; label: string };

export type CommuneCatnatType = { code: string; label: string; count: number };

export type CommuneCatnatEvent = {
  code: string;
  label: string;
  start: string | null;
  end: string | null;
  decree: string | null;
  published: string | null;
};

export type CommunePreventionPlan = {
  family: "PPRN" | "PPRT" | "PPRM";
  kind: string;
  label: string;
  status: string | null;
  prescribedOn: string | null;
  approvedOn: string | null;
  risks: string[];
};

export type CommuneRiskProfile = {
  status: "ready";
  commune: { code: string; name: string };
  risks: CommuneRiskItem[];
  catnatTotal: number;
  catnatByType: CommuneCatnatType[];
  catnatRecent: CommuneCatnatEvent[];
  preventionPlans: CommunePreventionPlan[];
  seismicZone: number | null;
  radonClass: number | null;
  snapshot: string | null;
  sourceUrl: string;
};

export type CommuneRiskUnavailable = {
  status: "unavailable";
  reason: "location_missing" | "commune_not_found" | "profile_missing" | "source_unavailable";
};

export type CommuneRiskResult = CommuneRiskProfile | CommuneRiskUnavailable;

export type ClimateStationRef = {
  id: string;
  name: string;
  distanceKm: number;
  altitudeM: number | null;
};

export type ClimateMonth = {
  month: number;
  meanTemperatureC: number | null;
  meanMinTemperatureC: number | null;
  meanMaxTemperatureC: number | null;
  precipitationMm: number | null;
  rainDays: number | null;
  sunshineHours: number | null;
  frostDays: number | null;
  hotDays: number | null;
  normalTemperatureC: number | null;
  normalPrecipitationMm: number | null;
  normalSunshineHours: number | null;
};

export type ClimateSummary = {
  meanTemperatureC: number | null;
  precipitationMm: number | null;
  sunshineHours: number | null;
  frostDays: number | null;
  hotDays: number | null;
  rainDays: number | null;
};

export type ClimateHistory = {
  status: "ready";
  year: number;
  normalPeriod: { startYear: number; endYear: number } | null;
  stations: {
    temperature: ClimateStationRef | null;
    precipitation: ClimateStationRef | null;
    sunshine: ClimateStationRef | null;
  };
  months: ClimateMonth[];
  summary: ClimateSummary;
  normal: ClimateSummary;
  locationSource: "listing" | "commune";
  sourceUrl: string;
};

export type ClimateUnavailable = {
  status: "unavailable";
  reason: "location_missing" | "no_station_nearby" | "source_unavailable";
};

export type ClimateResult = ClimateHistory | ClimateUnavailable;

export const GEORISQUES_HOME_URL = "https://www.georisques.gouv.fr/";
export const GASPAR_SOURCE_URL =
  "https://www.georisques.gouv.fr/donnees/bases-de-donnees/base-gaspar";
export const METEO_FRANCE_SOURCE_URL =
  "https://meteo.data.gouv.fr/datasets/donnees-climatologiques-de-base-mensuelles";
