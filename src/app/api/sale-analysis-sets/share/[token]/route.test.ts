import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enforceIp: vi.fn(), shared: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/sale-analysis-sets", () => ({ getSharedSaleComparison: mocks.shared }));

import { GET } from "./route";

const call = () =>
  GET(new Request("https://immojudis.test/api/sale-analysis-sets/share/token"), {
    params: Promise.resolve({ token: "token" }),
  });

describe("GET /api/sale-analysis-sets/share/[token]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.enforceIp.mockResolvedValue(undefined);
  });

  it("serves a shared comparison", async () => {
    mocks.shared.mockResolvedValue({ name: "Ma sélection", items: [] });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 404 for an unknown or expired link", async () => {
    mocks.shared.mockRejectedValue(new Error("Comparaison partagée introuvable ou expirée."));

    const response = await call();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ comparison: null });
  });

  it("answers 500, not 404, when reading the comparison fails", async () => {
    mocks.shared.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const response = await call();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "INTERNAL_ERROR",
      comparison: null,
    });
  });
});
