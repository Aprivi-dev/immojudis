import { describe, expect, it } from "vitest";
import { reportRentReference } from "./rent-notice";

describe("reportRentReference", () => {
  it("reads the ANIL source a report recorded", () => {
    expect(
      reportRentReference({
        source: "anil_maille",
        reliability: "indicative",
        rentPerM2: 9,
        vintage: 2025,
        sourceUpdatedOn: "2025-12-11",
      }),
    ).toEqual({ source: "anil_maille", vintage: 2025, sourceUpdatedOn: "2025-12-11" });
    expect(reportRentReference({ source: "anil_epci" })).toEqual({
      source: "anil_epci",
      vintage: null,
      sourceUpdatedOn: null,
    });
  });

  it("keeps the credit for a rent computed from the map (median of arrondissements or of the department)", () => {
    for (const source of ["anil_arrondissements_median", "anil_department_median"]) {
      expect(reportRentReference({ source, vintage: 2025, sourceUpdatedOn: "2025-12-11" })).toEqual(
        {
          source,
          vintage: 2025,
          sourceUpdatedOn: "2025-12-11",
        },
      );
    }
  });

  it("gives no ANIL credit to an old report, a department rent or an unreadable value", () => {
    expect(reportRentReference(undefined)).toBeNull();
    expect(reportRentReference(null)).toBeNull();
    expect(reportRentReference("anil_commune")).toBeNull();
    expect(reportRentReference({ source: "department_estimate" })).toBeNull();
    expect(reportRentReference({ source: "autre" })).toBeNull();
  });
});
