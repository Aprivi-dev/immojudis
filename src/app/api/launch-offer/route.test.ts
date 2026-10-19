import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ active: vi.fn(), ipLimit: vi.fn() }));
vi.mock("@/lib/launch-offer.server", () => ({ isLaunchOfferActive: mocks.active }));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.ipLimit }));

import { GET } from "./route";

const request = () => new Request("https://example.test/api/launch-offer");

describe("GET /api/launch-offer", () => {
  beforeEach(() => {
    mocks.active.mockReset();
    mocks.ipLimit.mockReset();
  });

  it("répond l'état de la base, sans donnée personnelle, mis en cache 30 s au CDN", async () => {
    mocks.active.mockResolvedValue(true);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: true });
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=30");
  });

  it("répond `false` quand l'offre est coupée", async () => {
    mocks.active.mockResolvedValue(false);
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
