import { describe, expect, it } from "vitest";
import {
  ceilingGap,
  unlockCeilingGap,
  UNLOCK_GAP_CONFLICT,
  UNLOCK_GAP_REVIEW,
  UNLOCK_GAP_SURFACE,
  valueGapReason,
} from "@/lib/bid-ceiling-gaps";

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

describe("unlockCeilingGap", () => {
  const inputs = (overrides: Partial<Parameters<typeof unlockCeilingGap>[0]["inputs"]> = {}) => ({
    valuationConflict: null,
    blocked: { critical: false },
    surface: 62,
    ...overrides,
  });

  it("says nothing when no known condition prevents the ceiling", () => {
    expect(unlockCeilingGap({ inputs: inputs() })).toBeNull();
  });

  it("names the missing surface, which the account can enter itself", () => {
    expect(unlockCeilingGap({ inputs: inputs({ surface: null }) })).toEqual({
      reason: UNLOCK_GAP_SURFACE,
      surface: true,
    });
    expect(UNLOCK_GAP_SURFACE).toBe("surface absente");
  });

  it("puts a valuation conflict and an AI review block before the surface", () => {
    expect(
      unlockCeilingGap({
        inputs: inputs({ valuationConflict: "Type contradictoire", surface: null }),
      }),
    ).toEqual({ reason: UNLOCK_GAP_CONFLICT, surface: false });
    expect(
      unlockCeilingGap({ inputs: inputs({ blocked: { critical: true }, surface: null }) }),
    ).toEqual({ reason: UNLOCK_GAP_REVIEW, surface: false });
  });

  it("reads the gap of the plan once the sale is open, but never a pending estimate", () => {
    const missing = { kind: "incomplete" as const, reason: "pas assez de ventes comparables" };
    expect(unlockCeilingGap({ inputs: inputs(), gap: missing })).toEqual({
      reason: "pas assez de ventes comparables",
      surface: false,
    });
    expect(unlockCeilingGap({ inputs: inputs(), gap: missing, pending: true })).toBeNull();
    expect(
      unlockCeilingGap({
        inputs: inputs(),
        gap: { kind: "incomplete", reason: "estimation en cours" },
      }),
    ).toBeNull();
    expect(
      unlockCeilingGap({
        inputs: inputs(),
        gap: { kind: "incomplete", reason: "surface manquante" },
      }),
    ).toEqual({ reason: UNLOCK_GAP_SURFACE, surface: true });
  });

  it("does not treat a computed ceiling without margin as a missing one", () => {
    expect(
      unlockCeilingGap({
        inputs: inputs(),
        gap: { kind: "unprofitable", reason: "aucune enchère rentable" },
      }),
    ).toBeNull();
  });
});
