import { describe, expect, it } from "vitest";
import { ceilingGap, valueGapReason } from "@/lib/bid-ceiling-gaps";

describe("valueGapReason", () => {
  it("names the missing surface first", () => {
    expect(valueGapReason({ surface: null, marketStatus: "queued" })).toBe("surface manquante");
    expect(valueGapReason({ surface: 0 })).toBe("surface manquante");
  });

  it("explains a market estimate that is not ready", () => {
    expect(valueGapReason({ surface: 60, marketStatus: "queued" })).toBe("estimation en cours");
    expect(valueGapReason({ surface: 60, marketStatus: "refreshing" })).toBe("estimation en cours");
    expect(valueGapReason({ surface: 60, marketStatus: "insufficient_data" })).toBe(
      "pas assez de ventes comparables",
    );
    expect(valueGapReason({ surface: 60, marketStatus: "failed" })).toBe("estimation indisponible");
    expect(valueGapReason({ surface: 60 })).toBe("valeur de marché manquante");
  });
});

describe("ceilingGap", () => {
  it("has no gap when a ceiling is computed", () => {
    expect(ceilingGap({ available: true, reachable: true })).toBeNull();
  });

  it("separates a missing input from a calculation without profitable bid", () => {
    expect(ceilingGap({ available: true, reachable: false })).toEqual({
      kind: "unprofitable",
      reason: "aucune enchère rentable",
    });
    expect(
      ceilingGap({ available: false, reachable: false, reason: "Surface du bien manquante" }),
    ).toEqual({ kind: "incomplete", reason: "surface manquante" });
    expect(
      ceilingGap(
        { available: false, reachable: false, reason: "Valeur de marché à compléter" },
        "estimation en cours",
      ),
    ).toEqual({ kind: "incomplete", reason: "estimation en cours" });
  });
});
