// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClimateHistory, ClimateMonth } from "@/lib/environment-reference";
import { ClimateHistoryView, ListingWeatherHistory } from "./ListingWeatherHistory";

vi.mock("@/lib/client-api-core", () => ({
  authHeaders: async () => ({ Authorization: "Bearer test" }),
  readJson: async (response: Response) => response.json(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const emptyMonth = (month: number): ClimateMonth => ({
  month,
  meanTemperatureC: null,
  meanMinTemperatureC: null,
  meanMaxTemperatureC: null,
  precipitationMm: null,
  rainDays: null,
  sunshineHours: null,
  frostDays: null,
  hotDays: null,
  normalTemperatureC: null,
  normalPrecipitationMm: null,
  normalSunshineHours: null,
});

const weather: ClimateHistory = {
  status: "ready",
  year: 2025,
  normalPeriod: { startYear: 2016, endYear: 2024 },
  stations: {
    temperature: { id: "33281001", name: "Bordeaux-Merignac", distanceKm: 9, altitudeM: 47 },
    precipitation: { id: "33281001", name: "Bordeaux-Merignac", distanceKm: 9, altitudeM: 47 },
    sunshine: null,
  },
  months: [
    {
      ...emptyMonth(1),
      meanTemperatureC: 0,
      meanMinTemperatureC: -3,
      meanMaxTemperatureC: 5,
      precipitationMm: 143.1,
      normalTemperatureC: 6.8,
      normalPrecipitationMm: 92.4,
    },
    ...Array.from({ length: 11 }, (_, index) => emptyMonth(index + 2)),
  ],
  summary: {
    meanTemperatureC: null,
    precipitationMm: null,
    sunshineHours: null,
    frostDays: 12,
    hotDays: 0,
    rainDays: null,
  },
  normal: {
    meanTemperatureC: 14.2,
    precipitationMm: 851,
    sunshineHours: null,
    frostDays: 18.4,
    hotDays: 21.3,
    rainDays: 128,
  },
  locationSource: "listing",
  sourceUrl: "https://meteo.data.gouv.fr/datasets/donnees-climatologiques-de-base-mensuelles",
};

function renderWithClient(node: React.ReactNode, client = new QueryClient()) {
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("Météo-France climate history", () => {
  it("keeps the locked preview free of calls and observations", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient();
    client.setQueryData(["sale-weather", "test-sale"], { weather });
    renderWithClient(<ListingWeatherHistory saleId="test-sale" enabled locked />, client);

    expect(screen.getByRole("link", { name: /avec l’offre Analyse/ }).getAttribute("href")).toBe(
      "/offres",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads the history as soon as the block is shown to an Analyse member", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ weather })));
    vi.stubGlobal("fetch", fetcher);
    renderWithClient(<ListingWeatherHistory saleId="test-sale" enabled />);

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sales/test-sale/weather",
      expect.objectContaining({ headers: { Authorization: "Bearer test" } }),
    );
  });

  it("explains why no history is shown instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ weather: { status: "unavailable", reason: "no_station_nearby" } }),
          ),
      ),
    );
    renderWithClient(<ListingWeatherHistory saleId="test-sale" enabled />);

    expect(await screen.findByText(/Aucune station Météo-France/)).toBeTruthy();
  });

  it("keeps zero values and missing observations distinct and shows the normals", () => {
    render(<ClimateHistoryView weather={weather} />);
    const january = screen.getByRole("row", { name: /janvier/ });

    expect(within(january).getByText(/^0 °C/)).toBeTruthy();
    expect(within(january).getByText("(6,8 °C)")).toBeTruthy();
    expect(within(january).getByText(/143,1 mm/)).toBeTruthy();
    expect(screen.getByRole("row", { name: /février/ }).textContent).toBe("février—— / ——");
    expect(screen.queryByText("Soleil")).toBeNull();
  });

  it("names the station, its distance and the open licence", () => {
    render(<ClimateHistoryView weather={weather} />);

    expect(
      screen.getByText("Station Bordeaux-Merignac, à 9 km, altitude 47 m : températures, pluie."),
    ).toBeTruthy();
    expect(screen.getByText(/Licence Ouverte Etalab 2.0/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Météo-France, données climatologiques/ })
        .getAttribute("href"),
    ).toBe(weather.sourceUrl);
  });
});
