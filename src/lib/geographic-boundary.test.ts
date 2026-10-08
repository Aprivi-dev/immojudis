import { describe, expect, it, vi } from "vitest";
import {
  boundaryRequestForLabel,
  buildGeographicBoundaryUrl,
  fetchGeographicBoundary,
} from "./geographic-boundary";

function geoJson(...features: unknown[]) {
  return { type: "FeatureCollection", features };
}

function feature(nom: string, code = "33063") {
  return {
    type: "Feature",
    properties: { nom, code },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-0.7, 44.8],
          [-0.5, 44.8],
          [-0.5, 44.95],
          [-0.7, 44.95],
          [-0.7, 44.8],
        ],
      ],
    },
  };
}

describe("official geographic boundaries", () => {
  it("targets the official department contour for a department code", () => {
    const request = boundaryRequestForLabel("33");
    expect(request).toMatchObject({
      endpoint: "departements",
      level: "department",
      params: { code: "33" },
    });
    expect(buildGeographicBoundaryUrl(request!)).toContain(
      "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/latest/geojson/departements-1000m.geojson",
    );
  });

  it("accepts one exact commune match and computes a fitting box", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(geoJson(feature("Bordeaux"))), {
          status: 200,
          headers: { "content-type": "application/geo+json" },
        }),
    );

    const boundary = await fetchGeographicBoundary("Bordeaux", {
      fetcher: fetcher as typeof fetch,
    });

    expect(boundary).toMatchObject({
      label: "Bordeaux",
      level: "commune",
      bbox: [-0.7, 44.8, -0.5, 44.95],
      sourceUrl: "https://www.data.gouv.fr/datasets/contours-administratifs",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("geometry=contour");
  });

  it("fails closed when a city name has multiple exact official matches", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify(geoJson(feature("Saint-Denis", "93066"), feature("Saint-Denis", "97411"))),
          {
            status: 200,
          },
        ),
    );

    await expect(
      fetchGeographicBoundary("Saint-Denis", { fetcher: fetcher as typeof fetch }),
    ).resolves.toBeNull();
  });

  it("matches a region alias against the official region name", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(geoJson(feature("Île-de-France", "11"))), {
          status: 200,
        }),
    );

    const boundary = await fetchGeographicBoundary("IDF", {
      fetcher: fetcher as typeof fetch,
    });

    expect(boundary?.label).toBe("Île-de-France");
    expect(boundary?.level).toBe("region");
  });

  it("selects a department from the real Etalab collection shape", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            geoJson(feature("Ain", "01"), feature("Gironde", "33"), feature("Rhône", "69")),
          ),
          { status: 200 },
        ),
    );

    const boundary = await fetchGeographicBoundary("Gironde", {
      fetcher: fetcher as typeof fetch,
    });

    expect(boundary).toMatchObject({ label: "Gironde", level: "department" });
    expect(boundary?.features).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("departements-1000m.geojson");
  });

  it("selects a region from the real Etalab collection shape", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify(geoJson(feature("Bretagne", "53"), feature("Nouvelle-Aquitaine", "75"))),
          { status: 200 },
        ),
    );

    const boundary = await fetchGeographicBoundary("Nouvelle-Aquitaine", {
      fetcher: fetcher as typeof fetch,
    });

    expect(boundary).toMatchObject({ label: "Nouvelle-Aquitaine", level: "region" });
    expect(boundary?.features).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("regions-1000m.geojson");
  });

  it("raises an upstream error so the route can return an uncached 503", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("unavailable", { status: 503 }),
    );

    await expect(
      fetchGeographicBoundary("Gironde", { fetcher: fetcher as typeof fetch }),
    ).rejects.toMatchObject({ name: "GeographicBoundaryUpstreamError", status: 503 });
  });

  it("forwards an abort signal so a stale search cannot update the map", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("The operation was aborted", "AbortError");
    });

    const promise = fetchGeographicBoundary("Bordeaux", {
      fetcher: fetcher as typeof fetch,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
