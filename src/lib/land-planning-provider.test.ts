import { describe, expect, it, vi } from "vitest";
import { fetchLandPlanning } from "./land-planning-provider";

const NOW = () => new Date("2026-10-02T10:00:00.000Z");

function collection(features: unknown[], metadata: Record<string, unknown> = {}) {
  return { type: "FeatureCollection", features, ...metadata };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetcherFor(handler: (url: URL, calls: string[]) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    return handler(url, calls);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const parcel = (
  id: string,
  number: string,
  coordinates: number[][][][] = [
    [
      [
        [3.28, 49.84],
        [3.29, 49.84],
        [3.29, 49.85],
        [3.28, 49.84],
      ],
    ],
  ],
) => ({
  type: "Feature",
  id,
  geometry: { type: "MultiPolygon", coordinates },
  properties: {
    idu: id,
    code_insee: "02691",
    section: "CT",
    numero: number,
    nom_com: "Saint-Quentin",
    contenance: 698,
  },
});

function completeOfficialFixture(url: URL): Response {
  if (url.hostname === "apicarto.ign.fr" && url.pathname === "/api/cadastre/parcelle") {
    return response(collection([parcel("02691000CT0190", "0190")]));
  }
  if (url.hostname === "apicarto.ign.fr" && url.pathname === "/api/gpu/document") {
    return response(
      collection([
        {
          type: "Feature",
          id: "doc-1",
          properties: {
            gpu_doc_id: "doc-1",
            name: "200071892_PLUi_20260520",
            grid_title: "PLUI DU SAINT-QUENTINOIS",
            du_type: "PLUi",
            gpu_status: "production",
          },
        },
      ]),
    );
  }
  if (url.hostname === "apicarto.ign.fr" && url.pathname === "/api/gpu/zone-urba") {
    return response(
      collection([
        {
          type: "Feature",
          id: "zone-1",
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [
                [
                  [3.28, 49.84],
                  [3.29, 49.84],
                  [3.29, 49.85],
                  [3.28, 49.84],
                ],
              ],
            ],
          },
          properties: {
            gpu_doc_id: "doc-1",
            libelle: "UCa2",
            libelong: "Zone urbaine de grands ensembles",
            typezone: "U",
            nomfic: "reglement.pdf#page=73",
          },
        },
      ]),
    );
  }
  if (url.hostname === "apicarto.ign.fr" && url.pathname === "/api/gpu/prescription-lin") {
    return response(
      collection([
        {
          type: "Feature",
          id: "prescription-1",
          geometry: {
            type: "LineString",
            coordinates: [
              [3.28, 49.84],
              [3.29, 49.85],
            ],
          },
          properties: {
            gpu_doc_id: "doc-1",
            libelle: "Alignement à vérifier",
            typepres: "16",
            fichier: "reglement.pdf",
          },
        },
      ]),
    );
  }
  if (url.hostname === "apicarto.ign.fr" && url.pathname.startsWith("/api/gpu/")) {
    return response(collection([]));
  }
  if (
    url.hostname === "www.geoportail-urbanisme.gouv.fr" &&
    url.pathname === "/api/document/doc-1/details"
  ) {
    return response({
      id: "doc-1",
      type: "PLUi",
      legalStatus: "APPROVED",
      effectiveStatus: "EN_VIGUEUR",
      publicationDate: "2026-05-20",
      updateDate: "2026-05-20",
      files: ["reglement.pdf", "procedure_20260520.pdf", "oap_20260520.pdf"],
      writingMaterials: {
        // An untrusted URL must be replaced by the official GPU file route.
        "reglement.pdf": "https://evil.example.invalid/reglement.pdf",
      },
    });
  }
  throw new Error(`Unexpected fixture URL: ${url.toString()}`);
}

describe("official land planning provider", () => {
  it("matches an explicit parcel without geocoding and exposes GPU evidence", async () => {
    const { fetcher, calls } = fetcherFor((url) => completeOfficialFixture(url));

    const result = await fetchLandPlanning(
      {
        references: [{ codeInsee: "02691", section: "CT", number: "190", source: "document" }],
      },
      { fetcher, now: NOW },
    );

    expect(result.locationStatus).toBe("references_matched");
    expect(result.completeCoverage).toBe(true);
    expect(result.parcels[0]).toMatchObject({
      id: "02691000CT0190",
      codeInsee: "02691",
      section: "CT",
      number: "0190",
      match: "document_reference",
    });
    expect(result.zones[0]).toMatchObject({
      label: "UCa2",
      documentId: "doc-1",
      startPage: 73,
    });
    expect(result.constraints[0]).toMatchObject({
      kind: "prescription",
      layer: "prescription-lin",
      documentUrl:
        "https://www.geoportail-urbanisme.gouv.fr/api/document/doc-1/files/reglement.pdf",
    });
    expect(result.constraints[0]?.geometry).toBeUndefined();
    expect(result.documents[0]).toMatchObject({
      id: "doc-1",
      legalStatus: "APPROVED",
      effectiveStatus: "EN_VIGUEUR",
      downloadable: true,
    });
    expect(
      result.documents[0]?.files.every((file) => new URL(file.url).hostname.endsWith("gouv.fr")),
    ).toBe(true);
    expect(result.checks.find((check) => check.key === "geocode.address")).toMatchObject({
      status: "not_checked",
    });
    expect(calls.some((url) => url.includes("/geocodage/search"))).toBe(false);
    expect(result.checks.find((check) => check.key === "gpu.procedure")?.sourceUrl).toBe(
      "https://www.geoportail-urbanisme.gouv.fr/api/document",
    );
  });

  it("validates the address commune while querying the whole explicit parcel", async () => {
    const { fetcher, calls } = fetcherFor((url) => {
      if (url.hostname === "data.geopf.fr" && url.pathname === "/geocodage/search") {
        return response(
          collection([
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [3.287, 49.85] },
              properties: {
                label: "10 rue Exemple, 02100 Saint-Quentin",
                score: 0.95,
                city: "Saint-Quentin",
                postcode: "02100",
                citycode: "02691",
              },
            },
          ]),
        );
      }
      return completeOfficialFixture(url);
    });

    const result = await fetchLandPlanning(
      {
        address: "10 rue Exemple",
        postalCode: "02100",
        city: "Saint-Quentin",
        codeInsee: "02691",
        references: [{ codeInsee: "02691", section: "CT", number: "190", source: "listing" }],
      },
      { fetcher, now: NOW },
    );

    const cadastreCalls = calls.filter((url) => url.includes("/api/cadastre/parcelle"));
    expect(result.locationStatus).toBe("references_matched");
    expect(result.coordinates).toEqual({ longitude: 3.287, latitude: 49.85 });
    expect(result.codeInsee).toBe("02691");
    expect(result.checks.find((check) => check.key === "geocode.address")).toMatchObject({
      status: "available",
    });
    expect(cadastreCalls).toHaveLength(1);
    expect(cadastreCalls[0]).toContain("section=CT");
    expect(cadastreCalls[0]).toContain("numero=0190");
    expect(cadastreCalls[0]).not.toContain("geom=");
    const zoneCall = calls.find((url) => url.includes("/api/gpu/zone-urba"));
    expect(zoneCall).toBeDefined();
    expect(JSON.parse(new URL(zoneCall!).searchParams.get("geom") ?? "{}").type).toBe(
      "MultiPolygon",
    );
    expect(result.zones[0]?.geometry?.type).toBe("MultiPolygon");
    expect(result.zones[0]?.parcelIds).toEqual(["02691000CT0190"]);
    expect(
      result.checks.filter(
        (check) =>
          check.key.startsWith("gpu.") &&
          !["gpu.document-details", "gpu.procedure", "gpu.oap"].includes(check.key),
      ),
    ).toHaveLength(11);
    expect(result.checks.every((check) => new URL(check.sourceUrl).protocol === "https:")).toBe(
      true,
    );
    expect(result.completeCoverage).toBe(true);
    const urls = [
      ...result.documents.flatMap((document) => [
        document.sourceUrl,
        ...document.files.map((file) => file.url),
      ]),
      ...result.zones.flatMap((zone) => (zone.regulationUrl ? [zone.regulationUrl] : [])),
      ...result.constraints.flatMap((constraint) =>
        constraint.documentUrl ? [constraint.documentUrl] : [],
      ),
    ];
    expect(urls.every((url) => new URL(url).hostname.endsWith("gouv.fr"))).toBe(true);
  });

  it("rejects a low-score address and does not turn it into a cadastral point", async () => {
    const { fetcher, calls } = fetcherFor((url) => {
      if (url.hostname === "data.geopf.fr" && url.pathname === "/geocodage/search") {
        return response(
          collection([
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [3.287, 49.85] },
              properties: {
                label: "10 rue Exemple, 02100 Saint-Quentin",
                score: 0.42,
                city: "Saint-Quentin",
                postcode: "02100",
                citycode: "02691",
              },
            },
          ]),
        );
      }
      throw new Error(`Unexpected fixture URL: ${url.toString()}`);
    });

    const result = await fetchLandPlanning(
      {
        address: "10 rue Exemple",
        postalCode: "02100",
        city: "Saint-Quentin",
        codeInsee: "99999",
      },
      { fetcher, now: NOW },
    );

    expect(result.locationStatus).toBe("unresolved");
    expect(result.parcels).toHaveLength(0);
    expect(result.codeInsee).toBeNull();
    expect(result.checks.find((check) => check.key === "geocode.address")).toMatchObject({
      status: "empty",
      message: expect.stringContaining("score"),
    });
    expect(calls.some((url) => url.includes("/api/cadastre/parcelle"))).toBe(false);
  });

  it("does not infer a parcel from a city-only input", async () => {
    const { fetcher, calls } = fetcherFor((url) => {
      throw new Error(`Unexpected network request: ${url.toString()}`);
    });

    const result = await fetchLandPlanning(
      { city: "Saint-Quentin", postalCode: "02100" },
      { fetcher, now: NOW },
    );

    expect(result.locationStatus).toBe("unresolved");
    expect(result.checks).toHaveLength(2);
    expect(result.checks.find((check) => check.key === "geocode.address")).toMatchObject({
      status: "not_checked",
    });
    expect(result.warnings.join(" ")).toContain("ville seule");
    expect(calls).toHaveLength(0);
  });

  it("keeps an empty cadastral response distinct from an unavailable API", async () => {
    const { fetcher } = fetcherFor((url) => {
      if (url.hostname === "apicarto.ign.fr" && url.pathname === "/api/cadastre/parcelle") {
        return response(collection([]));
      }
      throw new Error(`Unexpected fixture URL: ${url.toString()}`);
    });

    const result = await fetchLandPlanning(
      {
        references: [{ codeInsee: "02691", section: "CT", number: "9999", source: "listing" }],
      },
      { fetcher, now: NOW },
    );

    expect(result.parcels).toHaveLength(0);
    expect(result.checks.find((check) => check.key === "cadastre.parcels")).toMatchObject({
      status: "empty",
    });
  });

  it("rejects non-finite or non-closed cadastral geometry", async () => {
    const { fetcher } = fetcherFor((url) => {
      if (url.hostname === "apicarto.ign.fr" && url.pathname === "/api/cadastre/parcelle") {
        return response(
          collection([
            {
              type: "Feature",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [3.28, 49.84],
                    [3.29, 49.84],
                    [3.29, 49.85],
                  ],
                ],
              },
              properties: {
                idu: "02691000CT0190",
                code_insee: "02691",
                section: "CT",
                numero: "0190",
              },
            },
          ]),
        );
      }
      throw new Error(`Unexpected fixture URL: ${url.toString()}`);
    });

    const result = await fetchLandPlanning(
      {
        references: [{ codeInsee: "02691", section: "CT", number: "0190", source: "document" }],
      },
      { fetcher, now: NOW },
    );

    expect(result.parcels).toHaveLength(0);
    expect(result.checks.find((check) => check.key === "cadastre.parcels")).toMatchObject({
      status: "empty",
    });
  });

  it("rejects an oversized official response before parsing it", async () => {
    const { fetcher } = fetcherFor((url) => {
      if (url.hostname === "data.geopf.fr" && url.pathname === "/geocodage/search") {
        return new Response("{" + "x".repeat(2_000), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "2001",
          },
        });
      }
      throw new Error(`Unexpected fixture URL: ${url.toString()}`);
    });

    const result = await fetchLandPlanning(
      { address: "10 rue Exemple", city: "Saint-Quentin" },
      { fetcher, now: NOW, maxResponseBytes: 1_024 },
    );

    expect(result.checks.find((check) => check.key === "geocode.address")).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("trop volumineuse"),
    });
  });

  it("records a geocoding timeout instead of falling back to a stored commune", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;

    const result = await fetchLandPlanning(
      {
        address: "10 rue Exemple",
        city: "Saint-Quentin",
        codeInsee: "99999",
      },
      { fetcher, now: NOW, timeoutMs: 250 },
    );

    expect(result.locationStatus).toBe("unresolved");
    expect(result.codeInsee).toBeNull();
    expect(result.checks.find((check) => check.key === "geocode.address")).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("Délai dépassé"),
    });
    expect(calls).toHaveLength(1);
  });

  it("drops a contradictory stored code and keeps point results explicitly ambiguous", async () => {
    const { fetcher, calls } = fetcherFor((url) => {
      if (url.hostname === "data.geopf.fr" && url.pathname === "/geocodage/search") {
        return response(
          collection([
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [3.287, 49.85] },
              properties: {
                label: "10 rue Exemple, 02100 Saint-Quentin",
                score: 0.95,
                city: "Saint-Quentin",
                postcode: "02100",
                citycode: "02691",
              },
            },
          ]),
        );
      }
      if (url.hostname === "apicarto.ign.fr" && url.pathname === "/api/cadastre/parcelle") {
        expect(url.searchParams.get("code_insee")).toBeNull();
        return response(
          collection([
            parcel("02691000CT0190", "0190"),
            parcel("02691000CT0191", "0191", [
              [
                [
                  [3.287, 49.849],
                  [3.288, 49.849],
                  [3.288, 49.85],
                  [3.287, 49.849],
                ],
              ],
            ]),
          ]),
        );
      }
      if (url.hostname === "apicarto.ign.fr" && url.pathname.startsWith("/api/gpu/")) {
        return response(collection([]));
      }
      throw new Error(`Unexpected fixture URL: ${url.toString()}`);
    });

    const result = await fetchLandPlanning(
      {
        address: "10 rue Exemple",
        postalCode: "02100",
        city: "Saint-Quentin",
        codeInsee: "99999",
        references: [{ codeInsee: "99999", section: "CT", number: "190", source: "stored" }],
      },
      { fetcher, now: NOW },
    );

    expect(result.locationStatus).toBe("ambiguous");
    expect(result.codeInsee).toBe("02691");
    expect(result.parcels).toHaveLength(2);
    expect(result.parcels.every((candidate) => candidate.match === "address_point")).toBe(true);
    expect(result.warnings.join(" ")).toContain("contredisait");
    expect(result.warnings.join(" ")).toContain("ne prouve pas");
    expect(
      calls
        .filter((url) => url.includes("/api/cadastre/parcelle"))
        .every((url) => !url.includes("99999")),
    ).toBe(true);
    expect(result.completeCoverage).toBe(false);
  });
});
