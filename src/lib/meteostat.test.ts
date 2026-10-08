import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMeteostatHistoricalWeather,
  type MeteostatCacheRow,
  type MeteostatCacheStore,
} from "./meteostat";

const NOW = new Date("2026-10-06T10:00:00.000Z");

class InMemoryStore implements MeteostatCacheStore {
  rows = new Map<string, MeteostatCacheRow>();
  quotaCalls = 0;
  quotaAvailable = true;

  async read(cacheKey: string) {
    return this.rows.get(cacheKey) ?? null;
  }

  async writeSuccess(input: Parameters<MeteostatCacheStore["writeSuccess"]>[0]) {
    this.rows.set(input.cacheKey, {
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
    });
  }

  async writeFailure(input: Parameters<MeteostatCacheStore["writeFailure"]>[0]) {
    this.rows.set(input.cacheKey, {
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
    });
  }

  async consumeQuota() {
    this.quotaCalls += 1;
    return this.quotaAvailable;
  }
}

function monthlyPayload(year: number) {
  return {
    data: [
      {
        date: `${year}-01-01`,
        tavg: 8.4,
        tmin: 2,
        tmax: 14,
        prcp: 37.5,
        snow: 0,
        tsun: 4_500,
        wspd: 12.3,
        wpgt: 44,
        pres: 1_014,
      },
      { date: `${year}-12-01`, tavg: "7.1", tmin: null, tmax: 13 },
      { date: `${year - 1}-12-01`, tavg: 1 },
    ],
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Meteostat historical weather provider", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("requests the latest complete year and stores normalized observations", async () => {
    const store = new InMemoryStore();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("lat")).toBe("44.8400");
      expect(url.searchParams.get("lon")).toBe("-0.5800");
      expect(url.searchParams.get("start")).toBe("2025-01-01");
      expect(url.searchParams.get("end")).toBe("2025-12-31");
      expect(new Headers(init?.headers).get("x-rapidapi-key")).toBe("test-key");
      return response(monthlyPayload(2025));
    }) as unknown as typeof fetch;

    const result = await getMeteostatHistoricalWeather(44.837789, -0.57918, {
      apiKey: "test-key",
      fetcher,
      now: () => NOW,
      store,
    });

    expect(result).toMatchObject({
      status: "ready",
      year: 2025,
      grid: { latitude: 44.84, longitude: -0.58 },
      coverage: { observedMonths: 2, expectedMonths: 12 },
      unsupportedMetrics: ["humidity", "uvIndex"],
      stale: false,
    });
    if (result.status !== "ready") throw new Error("expected ready result");
    expect(result.months[0]).toMatchObject({
      month: "2025-01",
      averageTemperatureC: 8.4,
      precipitationMm: 37.5,
      sunshineMinutes: 4500,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.quotaCalls).toBe(1);
  });

  it("serves a fresh grid-year cache without consuming another upstream request", async () => {
    const store = new InMemoryStore();
    const fetcher = vi.fn(async () => response(monthlyPayload(2025))) as unknown as typeof fetch;

    await getMeteostatHistoricalWeather(44.837789, -0.57918, {
      apiKey: "test-key",
      fetcher,
      now: () => NOW,
      store,
    });
    const result = await getMeteostatHistoricalWeather(44.8377, -0.5791, {
      apiKey: "test-key",
      fetcher,
      now: () => NOW,
      store,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready result");
    expect(result.months[0]).toMatchObject({
      averageTemperatureC: 8.4,
      precipitationMm: 37.5,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.quotaCalls).toBe(1);
  });

  it("fails closed when the application quota is exhausted", async () => {
    const store = new InMemoryStore();
    store.quotaAvailable = false;
    const fetcher = vi.fn(async () => response(monthlyPayload(2025))) as unknown as typeof fetch;

    const result = await getMeteostatHistoricalWeather(44.84, -0.58, {
      apiKey: "test-key",
      fetcher,
      now: () => NOW,
      store,
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "quota_exhausted" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.quotaCalls).toBe(1);
  });

  it("stores an upstream failure cooldown and does not retry it immediately", async () => {
    const store = new InMemoryStore();
    const fetcher = vi.fn(async () =>
      response({ error: "temporary" }, 503),
    ) as unknown as typeof fetch;

    const first = await getMeteostatHistoricalWeather(44.84, -0.58, {
      apiKey: "test-key",
      fetcher,
      now: () => NOW,
      store,
    });
    const second = await getMeteostatHistoricalWeather(44.84, -0.58, {
      apiKey: "test-key",
      fetcher,
      now: () => NOW,
      store,
    });

    expect(first).toMatchObject({ status: "unavailable", reason: "upstream_error" });
    expect(second).toMatchObject({ status: "unavailable", reason: "cooldown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.quotaCalls).toBe(1);
  });

  it("does not call the provider without a server-side key or valid coordinates", async () => {
    const store = new InMemoryStore();
    const fetcher = vi.fn(async () => response(monthlyPayload(2025))) as unknown as typeof fetch;

    await expect(
      getMeteostatHistoricalWeather(Number.NaN, -0.58, {
        apiKey: "test-key",
        fetcher,
        now: () => NOW,
        store,
      }),
    ).resolves.toMatchObject({ reason: "coordinates_missing" });
    await expect(
      getMeteostatHistoricalWeather(44.84, -0.58, {
        apiKey: null,
        fetcher,
        now: () => NOW,
        store,
      }),
    ).resolves.toMatchObject({ reason: "provider_not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.quotaCalls).toBe(0);
  });
});
