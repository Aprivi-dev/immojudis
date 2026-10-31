import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enforceIp: vi.fn(), shared: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/property-reports", () => ({ getSharedPropertyReport: mocks.shared }));

import { GET } from "./route";

const call = () =>
  GET(new Request("https://immojudis.test/api/property-reports/share/token"), {
    params: Promise.resolve({ token: "token" }),
  });

describe("GET /api/property-reports/share/[token]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.enforceIp.mockResolvedValue(undefined);
  });

  it("serves a shared report without caching it", async () => {
    mocks.shared.mockResolvedValue({ id: "report-1" });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ report: { id: "report-1" } });
  });

  it("answers 404 for an unknown or expired link", async () => {
    mocks.shared.mockRejectedValue(new Error("Rapport partagé introuvable ou expiré."));

    expect((await call()).status).toBe(404);
  });

  it("answers 500, not 404, when reading the report fails", async () => {
    mocks.shared.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const response = await call();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
