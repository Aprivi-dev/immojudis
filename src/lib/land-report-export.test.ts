import { describe, expect, it } from "vitest";
import { landReportToLines } from "./land-report-export";
import type { LandReport } from "./land-report-types";

const CHECKED_AT = "2026-10-02T12:00:00.000Z";

function check(key: string, status: "available" | "empty" | "unavailable") {
  return {
    key,
    label: key,
    status,
    scope: "parcel" as const,
    sourceUrl: "https://example.test/source",
    checkedAt: CHECKED_AT,
  };
}

function makeReport(overrides: Partial<LandReport["planning"]> = {}): LandReport {
  return {
    version: "land-report-v1.1",
    generatedAt: CHECKED_AT,
    planning: {
      locationStatus: "point_candidate",
      coordinates: null,
      codeInsee: "02691",
      parcels: [
        {
          id: "02691000CT0190",
          codeInsee: "02691",
          section: "CT",
          number: "0190",
          prefix: "000",
          surfaceM2: 640,
          geometry: { type: "Polygon", coordinates: [] },
          match: "address_point",
          sourceUrl: "https://cadastre.data.gouv.fr/",
        },
      ],
      zones: [
        {
          id: "z1",
          label: "AU",
          description: "Zone à urbaniser",
          type: "AUc",
          documentId: "d1",
          documentName: "PLUi",
          parcelIds: [],
        },
      ],
      documents: [],
      constraints: [],
      checks: [check("gpu.info-surf", "empty")],
      warnings: [],
      completeCoverage: true,
      ...overrides,
    },
    risks: { findings: [], checks: [check("risks", "unavailable")], warnings: [] },
    rules: {
      rules: [],
      checks: [check("rules", "unavailable")],
      warnings: [],
      completeCoverage: false,
    },
    projects: [],
  };
}

describe("landReportToLines", () => {
  const lines = landReportToLines(makeReport(), "17 rue Roland Garros", {
    listingZone: "A",
    landSurfaceM2: 4_000,
  });
  const text = lines.join("\n");

  it("carries the reservations the screen shows", () => {
    // 1. zone family, 2. parcel only probable, 3. surface gap, 4. listing zone differs,
    // 5. rules not read and partial, 6. risks empty and sources down.
    expect(text).toContain("zone à urbaniser (AU)");
    expect(text).toContain("Parcelle probable d’après l’adresse");
    expect(text).toMatch(/alors que l’annonce indique 4\s000 m²/);
    expect(text).toContain("Zone citée dans l’annonce : A - diffère du zonage officiel");
    expect(text).toContain("Aucun article de la zone n’a pu être extrait");
    expect(text).toContain("Lecture partielle du règlement");
    expect(text).toContain("ne permet pas de conclure à l’absence de risque");
    expect(text).toContain("2 sources indisponibles");
  });

  it("dates the consultation of the sources", () => {
    expect(lines[1]).toMatch(/^Sources consultées le /);
  });

  it("says « none found » only when the servitude layers were read", () => {
    expect(text).toContain("Aucune servitude ni prescription repérée dans les couches consultées.");
    expect(text).not.toContain("Servitudes non vérifiées");
  });

  it("says « not verified » when the source was down or the parcel is missing", () => {
    const down = landReportToLines(
      makeReport({ checks: [check("gpu.info-surf", "unavailable")] }),
      "adresse",
    ).join("\n");
    expect(down).toContain("Servitudes non vérifiées : une partie des couches");
    expect(down).not.toContain("Aucune servitude ni prescription repérée");

    const noParcel = landReportToLines(makeReport({ parcels: [] }), "adresse").join("\n");
    expect(noParcel).toContain("Servitudes non vérifiées : la parcelle n’est pas identifiée");
  });

  it("works without the listing context", () => {
    const bare = landReportToLines(makeReport(), "adresse").join("\n");
    expect(bare).not.toContain("Zone citée dans l’annonce");
    expect(bare).not.toContain("alors que l’annonce indique");
  });
});
