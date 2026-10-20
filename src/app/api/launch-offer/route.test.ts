import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";
import { LAUNCH_OFFER_CACHE_SECONDS } from "@/lib/launch-offer";

const mocks = vi.hoisted(() => ({ active: vi.fn(), ipLimit: vi.fn() }));
const state = (active: boolean, degraded = false) => ({ active, degraded });
vi.mock("@/lib/launch-offer.server", () => ({ readLaunchOfferState: mocks.active }));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.ipLimit }));

import { GET } from "./route";

const request = () => new Request("https://example.test/api/launch-offer");

describe("GET /api/launch-offer", () => {
  beforeEach(() => {
    mocks.active.mockReset();
    mocks.ipLimit.mockReset();
  });

  it("répond l'état de la base, sans donnée personnelle, mis en cache 30 s au CDN", async () => {
    mocks.active.mockResolvedValue(state(true));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: true });
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
  });

  it("laisse au CDN 30 s au plus : avec les 30 s du cache serveur, 60 s de retard maximum", async () => {
    mocks.active.mockResolvedValue(state(true));
    const header = (await GET(request())).headers.get("cache-control") ?? "";
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(header)?.[1]);
    expect(sMaxAge).toBeGreaterThan(0);
    expect(sMaxAge + LAUNCH_OFFER_CACHE_SECONDS).toBeLessThanOrEqual(60);
    expect(sMaxAge).toBe(LAUNCH_OFFER_CACHE_SECONDS);
  });

  it("ne laisse pas le CDN garder une réponse issue d'une erreur de lecture", async () => {
    mocks.active.mockResolvedValue(state(false, true));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("répond `false` quand l'offre est coupée", async () => {
    mocks.active.mockResolvedValue(state(false));
    expect(await (await GET(request())).json()).toEqual({ active: false });
  });

  it("limite les appels par adresse IP", async () => {
    mocks.ipLimit.mockRejectedValue(new RateLimitError());
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(mocks.active).not.toHaveBeenCalled();
  });

  it("répond une erreur générique en cas de panne", async () => {
    mocks.active.mockRejectedValue(new Error("postgres://secret rejected"));
    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("postgres");
  });
});
