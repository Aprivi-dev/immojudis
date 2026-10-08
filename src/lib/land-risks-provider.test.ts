import { describe, expect, it } from "vitest";
import type { LandParcel, LandRisksInput } from "./land-report-types";
import { fetchLandRisks } from "./land-risks-provider";

const parcel: LandParcel = {
  id: "02691000CT0190",
  codeInsee: "02691",
  section: "CT",
  number: "0190",
  prefix: "000",
  surfaceM2: 698,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [3.28, 49.84],
        [3.281, 49.84],
        [3.281, 49.841],
        [3.28, 49.841],
        [3.28, 49.84],
      ],
    ],
  },
  match: "stored_reference",
  sourceUrl: "https://cadastre.data.gouv.fr/",
};

const location: LandRisksInput = {
  parcels: [parcel],
  coordinates: { longitude: 3.28, latitude: 49.84 },
  codeInsee: "02691",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchLandRisks", () => {
  it("uses v2 parcel filters with a token and preserves the unknown RGA vintage", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.includes("/api/v2/rga")) {
        return jsonResponse({ content: [{ codeExposition: "3", exposition: "Moyenne" }] });
      }
      if (url.includes("/api/v2/gaspar/pprn")) {
        return jsonResponse({
          content: [
            {
              idGaspar: "ppr-1",
              libPpr: "PPRI vallée de la Somme",
              zonageReglementaire: { zoneRegExists: true },
              dateModification: "2026-01-02",
            },
          ],
        });
      }
      if (url.includes("/api/v2/radon")) {
        return jsonResponse({ content: [{ classePotentiel: "3", codeInsee: "02691" }] });
      }
      if (url.includes("/api/v2/ssp")) {
        return jsonResponse({
          casias: { content: [{ identifiant: "casias-1", nom: "Ancien atelier" }] },
        });
      }
      return jsonResponse({ content: [] });
    };

    const result = await fetchLandRisks(location, {
      token: "test-token",
      fetcher,
      now: () => new Date("2026-10-02T12:00:00.000Z"),
    });

    expect(requests.length).toBe(14);
    expect(requests.every((request) => request.url.includes("/api/v2/"))).toBe(true);
    expect(requests.every((request) => request.authorization === "Bearer test-token")).toBe(true);
    expect(
      requests
        .filter(
          (request) =>
            !request.url.includes("/api/v2/gaspar/risques") &&
            !request.url.includes("/api/v2/radon"),
        )
        .every((request) => request.url.includes("codesParcelle=02691-000-CT-0190")),
    ).toBe(true);
    expect(
      requests
        .find((request) => request.url.includes("/api/v2/gaspar/risques"))
        ?.url.includes("codesInsee=02691"),
    ).toBe(true);
    expect(requests.find((request) => request.url.includes("/api/v2/radon"))?.url).toContain(
      "codesInsee=02691",
    );
    expect(
      requests.some(
        (request) =>
          request.url.includes("rapport_pdf") || request.url.includes("resultats_rapport"),
      ),
    ).toBe(false);

    const rga = result.findings.find((finding) => finding.category === "clay");
    expect(rga?.scope).toBe("parcel");
    expect(rga?.status).toBe("mapped");
    expect(rga?.vintage).toBeNull();
    expect(rga?.precision).toContain("parcelle");
    expect(rga?.level).toBe("Moyenne (classe 3)");
    expect(result.findings.find((finding) => finding.category === "radon")?.level).toBe("Classe 3");
    expect(result.findings.find((finding) => finding.category === "pollution")?.level).toBe(
      "1 enregistrement",
    );
    expect(result.findings.some((finding) => finding.category === "flood")).toBe(true);
    expect(result.findings.some((finding) => finding.category === "pollution")).toBe(true);
    expect(result.checks.find((check) => check.key === "catnat")?.status).toBe("not_checked");
    expect(result.warnings.join(" ")).toContain("absence de risque");
  });

  it("falls back to v1 without relabelling a point/radius result as parcel data", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/api/v1/rga")) {
        return jsonResponse({ codeExposition: "forte", exposition: "Fort" });
      }
      if (url.includes("/api/v1/mvt")) {
        return jsonResponse({
          results: [{ identifiant: "mvt-1", type: "Glissement", lieu: "Berges de la Somme" }],
        });
      }
      if (url.includes("/api/v1/gaspar/catnat")) {
        return jsonResponse({
          results: [
            {
              code_national_catnat: "02-2024-001",
              code_insee: "02691",
              libelle_commune: "Saint-Quentin",
              libelle_risque_jo: "Inondations et coulées de boue",
              date_debut_evt: "2024-01-01",
            },
            {
              code_national_catnat: "02-2023-001",
              code_insee: "02300",
              libelle_commune: "Gauchy",
              libelle_risque_jo: "Inondations et coulées de boue",
              date_debut_evt: "2023-01-01",
            },
          ],
        });
      }
      if (url.includes("/api/v1/gaspar/risques")) {
        return jsonResponse({
          results: [
            {
              code_insee: "02691",
              libelle_commune: "Saint-Quentin",
              risques_detail: [
                { libelle_risque_long: "Transport de marchandises dangereuses", code: "11" },
              ],
            },
            {
              code_insee: "02300",
              libelle_commune: "Gauchy",
              risques_detail: [{ libelle_risque_long: "Inondation", code: "24" }],
            },
          ],
        });
      }
      return jsonResponse({ results: [] });
    };

    const result = await fetchLandRisks(location, {
      token: null,
      fetcher,
      now: () => new Date("2026-10-02T12:00:00.000Z"),
    });

    expect(requests.length).toBe(15);
    expect(requests.every((url) => url.includes("/api/v1/"))).toBe(true);
    expect(requests.every((url) => !url.includes("codesParcelle"))).toBe(true);
    expect(requests.find((url) => url.includes("/api/v1/rga"))).toContain("latlon=3.28%2C49.84");
    expect(requests.find((url) => url.includes("/api/v1/mvt"))).toContain("rayon=1000");
    expect(requests.find((url) => url.includes("/api/v1/gaspar/catnat"))).toContain(
      "code_insee=02691",
    );
    expect(requests.find((url) => url.includes("/api/v1/gaspar/catnat"))).not.toContain("rayon=");
    expect(requests.find((url) => url.includes("/api/v1/gaspar/risques"))).toContain(
      "code_insee=02691",
    );
    expect(requests.find((url) => url.includes("/api/v1/gaspar/risques"))).not.toContain("rayon=");

    expect(result.findings.find((finding) => finding.category === "clay")?.scope).toBe("point");
    expect(result.findings.find((finding) => finding.category === "ground_movement")?.scope).toBe(
      "radius",
    );
    expect(result.findings.find((finding) => finding.category === "flood")?.status).toBe("history");
    expect(result.findings.find((finding) => finding.category === "flood")?.scope).toBe("commune");
    const catnat = result.findings.filter((finding) =>
      finding.label.startsWith("Historique CatNat"),
    );
    expect(catnat).toHaveLength(1);
    expect(catnat[0]?.description).toContain("Saint-Quentin");
    expect(result.checks.find((check) => check.key === "radon")?.scope).toBe("commune");
    const gaspar = result.findings.find((finding) =>
      finding.label.includes("marchandises dangereuses"),
    );
    expect(gaspar?.category).toBe("technological");
    expect(gaspar?.level).toBeNull();
    expect(gaspar?.scope).toBe("commune");
    expect(result.findings.filter((finding) => finding.scope === "commune")).toHaveLength(2);
    expect(result.checks.find((check) => check.key === "mvt")?.scope).toBe("radius");
    expect(result.warnings.join(" ")).toContain("API v1");
    expect(result.warnings.join(" ")).toContain("pas d’une intersection cadastrale");
  });

  it("isolates a failing endpoint and keeps findings from other layers", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/mvt")) return jsonResponse({ message: "upstream failure" }, 500);
      if (url.includes("/api/v1/rga"))
        return jsonResponse({ codeExposition: "faible", exposition: "Faible" });
      return jsonResponse({ results: [] });
    };

    const result = await fetchLandRisks(location, { token: null, fetcher });

    expect(result.checks.find((check) => check.key === "mvt")?.status).toBe("unavailable");
    expect(result.checks.find((check) => check.key === "mvt")?.httpStatus).toBe(500);
    expect(result.checks.find((check) => check.key === "rga")?.status).toBe("available");
    expect(result.findings.some((finding) => finding.category === "clay")).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Mouvements de terrain"))).toBe(true);
  });

  it("does not call the provider without a usable location and exposes every source as unchecked", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({});
    };
    const result = await fetchLandRisks(
      { parcels: [], coordinates: null, codeInsee: null },
      { token: null, fetcher },
    );

    expect(calls).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.checks).toHaveLength(15);
    expect(result.checks.every((check) => check.status === "not_checked")).toBe(true);
    expect(result.warnings.join(" ")).toContain("Localisation insuffisante");
  });

  it("treats the official OLD no-result 404 as empty but keeps an unexpected 404 unavailable", async () => {
    const run = (message: string) =>
      fetchLandRisks(location, {
        token: null,
        fetcher: async (input) => {
          if (String(input).includes("/api/v1/old")) return jsonResponse({ message }, 404);
          return jsonResponse({ results: [] });
        },
      });

    const official = await run("Pas de résultat trouvé");
    expect(official.checks.find((check) => check.key === "old")).toMatchObject({
      status: "empty",
      httpStatus: 404,
      message: expect.stringContaining("Pas de résultat trouvé"),
    });

    const unexpected = await run("Not Found");
    expect(unexpected.checks.find((check) => check.key === "old")).toMatchObject({
      status: "unavailable",
      httpStatus: 404,
    });
  });

  it("marks paginated sources partial and summarizes a capped SSP page", async () => {
    const casias = Array.from({ length: 100 }, (_, index) => ({
      identifiant: `casias-${index + 1}`,
      nom: `Site ${index + 1}`,
    }));
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/ssp")) {
        return jsonResponse({ casias: { results: casias, page: 1, total_pages: 2 } });
      }
      if (url.includes("/api/v1/mvt")) {
        return jsonResponse({
          results: [{ identifiant: "mvt-1", type: "Glissement" }],
          page: 1,
          total_pages: 2,
        });
      }
      if (url.includes("/api/v1/cavites")) {
        return jsonResponse({
          results: [{ identifiant: "cavity-1", type: "Naturelle" }],
          page: 1,
          total_pages: 2,
        });
      }
      return jsonResponse({ results: [] });
    };

    const result = await fetchLandRisks(location, { token: null, fetcher });

    for (const key of ["ssp", "mvt", "cavites"]) {
      expect(result.checks.find((check) => check.key === key)).toMatchObject({
        status: "partial",
        message: expect.stringContaining("paginée"),
      });
    }
    const pollution = result.findings.filter((finding) => finding.category === "pollution");
    expect(pollution).toHaveLength(1);
    expect(pollution[0]?.label).toContain("100 enregistrements");
    expect(
      result.warnings.some(
        (warning) => warning.includes("Sites et sols pollués") && warning.includes("partiel"),
      ),
    ).toBe(true);
  });

  it("does not mark the current Gaspar camelCase one-page envelope as partial", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/gaspar/pprn")) {
        return jsonResponse({
          totalElements: 2,
          totalPages: 1,
          pageNumber: 0,
          pageSize: 100,
          content: [
            { idGaspar: "ppr-1", libPpr: "PPR Somme", modeleProcedure: "PPRN-I" },
            { idGaspar: "ppr-2", libPpr: "PPR Mouvements", modeleProcedure: "PPRN-Mvt" },
          ],
        });
      }
      return jsonResponse({ results: [] });
    };

    const result = await fetchLandRisks(location, { token: null, fetcher });

    expect(result.checks.find((check) => check.key === "pprn")).toMatchObject({
      status: "available",
    });
    expect(result.findings.some((finding) => finding.category === "flood")).toBe(true);
    expect(result.findings.some((finding) => finding.category === "ground_movement")).toBe(true);
  });

  it("marks an exactly capped V1 page partial even without pagination metadata", async () => {
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("/api/v1/mvt")) {
        return jsonResponse({
          results: Array.from({ length: 100 }, (_, index) => ({
            identifiant: `mvt-${index + 1}`,
            type: "Glissement",
          })),
        });
      }
      return jsonResponse({ results: [] });
    };

    const result = await fetchLandRisks(location, { token: null, fetcher });

    expect(result.checks.find((check) => check.key === "mvt")).toMatchObject({
      status: "partial",
      message: expect.stringContaining("atteint la limite de 100"),
    });
    const movements = result.findings.filter((finding) => finding.category === "ground_movement");
    expect(movements).toHaveLength(1);
    expect(movements[0]?.label).toContain("100 enregistrements");
  });

  it("rejects an oversized JSON response without blocking other sources", async () => {
    const oversized = "x".repeat(1_000_001);
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("/api/v1/rga")) return jsonResponse(oversized);
      return jsonResponse({ results: [] });
    };

    const result = await fetchLandRisks(location, { token: null, fetcher });

    expect(result.checks.find((check) => check.key === "rga")).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("limite"),
    });
    expect(result.checks.find((check) => check.key === "mvt")?.status).toBe("empty");
  });
});
