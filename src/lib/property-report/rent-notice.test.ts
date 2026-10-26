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

  it("gives no ANIL credit to an old report, a department rent or an unreadable value", () => {
    expect(reportRentReference(undefined)).toBeNull();
    expect(reportRentReference(null)).toBeNull();
    expect(reportRentReference("anil_commune")).toBeNull();
    expect(reportRentReference({ source: "department_estimate" })).toBeNull();
    expect(reportRentReference({ source: "autre" })).toBeNull();
  });
});
