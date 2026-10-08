// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MeteostatWeather } from "@/lib/meteostat";
import { ListingWeatherHistory, MeteostatMonthlyTable } from "./ListingWeatherHistory";

vi.mock("@/lib/client-api-core", () => ({
  authHeaders: async () => ({ Authorization: "Bearer test" }),
  readJson: async (response: Response) => response.json(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const weather: MeteostatWeather = {
  status: "ready",
  source: "Meteostat",
  sourceUrl: "https://meteostat.net/",
  year: 2025,
  grid: { latitude: 44.84, longitude: -0.58 },
  coverage: { observedMonths: 1, expectedMonths: 12 },
  unsupportedMetrics: ["humidity", "uvIndex"],
  fetchedAt: "2026-10-06T00:00:00Z",
  stale: false,
  months: [
    {
      month: "2025-01",
      averageTemperatureC: 0,
      minimumTemperatureC: -3,
      maximumTemperatureC: 5,
      precipitationMm: null,
      snowDepthMm: null,
      sunshineMinutes: 120,
      windSpeedKmh: 8,
      windGustKmh: 15,
      pressureHpa: null,
    },
  ],
};
describe("Meteostat display", () => {
  it("keeps the Premium preview free of provider calls and observations", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient();
    client.setQueryData(["sale-weather", "test-sale"], { weather });
    render(
      <QueryClientProvider client={client}>
        <ListingWeatherHistory saleId="test-sale" enabled locked />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("link", { name: /avec Premium/ }).getAttribute("href")).toBe(
      "/accompagnement",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("0 °C")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps zero values and missing observations distinct; only converts sunshine units", () => {
    render(<MeteostatMonthlyTable weather={weather} />);
    expect(screen.getByText("0 °C")).toBeTruthy();
    expect(screen.getByText("—", { exact: true })).toBeTruthy();
    expect(screen.getByText("2 h")).toBeTruthy();
    expect(screen.getByText(/1 mois disponibles sur 12/)).toBeTruthy();
  });
  it("does not spend provider quota until the user opens the history", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ weather }));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingWeatherHistory saleId="test-sale" enabled />
      </QueryClientProvider>,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByText("0 °C")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
