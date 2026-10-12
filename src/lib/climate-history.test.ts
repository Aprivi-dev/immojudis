import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { buildClimateHistory, type MonthRow } from "./climate-history.server";

type Candidate = Parameters<typeof buildClimateHistory>[0][number];

const station = (overrides: Partial<Candidate>): Candidate => ({
  station_id: "33281001",
  name: "BORDEAUX-MERIGNAC",
  latitude: 44.83,
  longitude: -0.69,
  altitude_m: 47,
  last_month: "2026-05-01",
  has_temperature: true,
  has_precipitation: true,
  has_sunshine: false,
  distanceKm: 9.4,
  ...overrides,
});

function months(
  stationId: string,
  years: number[],
  values: (year: number, month: number) => Partial<MonthRow>,
): MonthRow[] {
  return years.flatMap((year) =>
    Array.from({ length: 12 }, (_, index) => ({
      station_id: stationId,
      month: `${year}-${String(index + 1).padStart(2, "0")}-01`,
      precipitation_mm: null,
      mean_temperature_c: null,
      mean_min_temperature_c: null,
      mean_max_temperature_c: null,
      sunshine_minutes: null,
      rain_days: null,
      frost_days: null,
      hot_days: null,
      ...values(year, index + 1),
    })),
  );
}

const years = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

describe("buildClimateHistory", () => {
  it("uses the latest complete year and the 2016-to-previous-year average", () => {
    const merignac = station({});
    const series = months("33281001", years, (year, month) => ({
      mean_temperature_c: year === 2025 ? 15 : 13,
      precipitation_mm: 70,
      rain_days: 10,
      frost_days: month === 1 ? 5 : 0,
      hot_days: month === 7 ? 4 : 0,
    }));
    const result = buildClimateHistory([merignac], new Map([["33281001", series]]), 2026);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.year).toBe(2025);
    expect(result.normalPeriod).toEqual({ startYear: 2016, endYear: 2024 });
    expect(result.summary).toMatchObject({
      meanTemperatureC: 15,
      precipitationMm: 840,
      frostDays: 5,
      hotDays: 4,
      rainDays: 120,
    });
    expect(result.normal.meanTemperatureC).toBe(13);
    expect(result.months[0]).toMatchObject({ meanTemperatureC: 15, normalTemperatureC: 13 });
    expect(result.stations.temperature).toEqual({
      id: "33281001",
      name: "Bordeaux-Merignac",
      distanceKm: 9,
      altitudeM: 47,
    });
    expect(result.stations.sunshine).toBeNull();
  });

  it("falls back to the year before when the last year is not yet published", () => {
    const series = months("33281001", years.slice(0, -1), () => ({
      mean_temperature_c: 12,
      precipitation_mm: 60,
    }));
    const result = buildClimateHistory([station({})], new Map([["33281001", series]]), 2026);

    expect(result.status === "ready" && result.year).toBe(2024);
  });

  it("skips a nearer station whose year is incomplete and takes sunshine from a farther one", () => {
    const near = station({ station_id: "33000001", distanceKm: 3 });
    const far = station({ station_id: "33000002", distanceKm: 15, has_sunshine: true });
    const nearRows = months("33000001", [2025], (_, month) => ({
      mean_temperature_c: month <= 6 ? 14 : null,
      precipitation_mm: month <= 6 ? 50 : null,
    }));
    const farRows = months("33000002", years, () => ({
      mean_temperature_c: 13,
      precipitation_mm: 65,
      sunshine_minutes: 6000,
    }));
    const result = buildClimateHistory(
      [near, far],
      new Map([
        ["33000001", nearRows],
        ["33000002", farRows],
      ]),
      2026,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.stations.temperature?.id).toBe("33000002");
    expect(result.stations.sunshine?.id).toBe("33000002");
    expect(result.months[0].sunshineHours).toBe(100);
    expect(result.summary.sunshineHours).toBe(1200);
  });

  it("reports no station when nothing within range has a usable year", () => {
    const result = buildClimateHistory(
      [station({ distanceKm: 80 })],
      new Map([["33281001", months("33281001", years, () => ({ mean_temperature_c: 12 }))]]),
      2026,
    );

    expect(result).toEqual({ status: "unavailable", reason: "no_station_nearby" });
  });
});
