import { afterEach, describe, expect, it, vi } from "vitest";
import { computeAcquisitionCosts } from "./profitability";
import { estimateGrossYieldPct, geocodeAdministrativeArea } from "./geo";
import { defaultRentPerM2 } from "./rent-reference";
vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));
afterEach(() => vi.unstubAllGlobals());
it("geocodes administrative areas without confusing them with streets", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      features: [{ geometry: { coordinates: [-0.6, 44.8] }, properties: { name: "Gironde" } }],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await geocodeAdministrativeArea("Gironde")).toMatchObject({ lat: 44.8, lng: -0.6 });
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.searchParams.get("types")).toBe("region,district");
  expect(url.searchParams.get("q")).toBe("Gironde");
});

describe("estimateGrossYieldPct", () => {
  it("rapporte le loyer de référence au coût total d'acquisition, pas au prix + 10 %", () => {
    const total = computeAcquisitionCosts({ price: 100_000, department: "33" }).totalCost;
    const expected = ((50 * (defaultRentPerM2("33") as number) * 12) / total) * 100;
    expect(estimateGrossYieldPct(100_000, 50, "33")).toBeCloseTo(expected, 6);
    expect(estimateGrossYieldPct(100_000, 50, "Gironde")).toBeCloseTo(expected, 6);
  });

  it("n'invente aucun loyer pour un département sans référence", () => {
    expect(defaultRentPerM2("23")).toBeNull();
    expect(defaultRentPerM2("19")).toBeNull();
    expect(estimateGrossYieldPct(100_000, 50, "23")).toBeNull();
    expect(estimateGrossYieldPct(100_000, 50, null)).toBeNull();
  });
});
