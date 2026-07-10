import { describe, expect, it } from "vitest";
import {
  featureIncluded,
  isPlanPeriodActive,
  normalizePlanCode,
  PLAN_FEATURES,
  PLAN_LABELS,
  PLAN_LIMITS,
} from "@/lib/plans";

describe("plan matrix", () => {
  it("exposes exactly Découverte and Analyse while folding legacy plans into Analyse", () => {
    expect(Object.keys(PLAN_LABELS)).toEqual(["decouverte", "analyse"]);
    expect(normalizePlanCode("investisseur")).toBe("analyse");
    expect(normalizePlanCode("analyse")).toBe("analyse");
    expect(normalizePlanCode("unknown")).toBe("decouverte");
  });

  it("keeps every premium feature locked for Découverte", () => {
    const unexpectedlyUnlocked = Object.entries(PLAN_FEATURES.decouverte)
      .filter(([feature]) => feature !== "sales.filters")
      .filter(([, access]) => access !== "locked");

    expect(unexpectedlyUnlocked).toEqual([]);
    expect(PLAN_LIMITS.decouverte.propertyReportsPerMonth).toBe(0);
    expect(PLAN_LIMITS.decouverte.pdfExportsPerMonth).toBe(0);
    expect(PLAN_LIMITS.decouverte.favoriteSales).toBe(0);
  });

  it("unlocks all analysis and collaboration capabilities for Analyse", () => {
    expect(Object.values(PLAN_FEATURES.analyse).every((access) => access === "included")).toBe(
      true,
    );
    expect(featureIncluded("analyse", "property.valueEstimate")).toBe(true);
    expect(featureIncluded("analyse", "alerts.realtimeChanges")).toBe(true);
    expect(featureIncluded("analyse", "workspace.collaboration")).toBe(true);
    expect(PLAN_LIMITS.analyse.workspaceCollaborators).toBeGreaterThan(0);
  });

  it("expires paid access at the end of its 30-day period", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(isPlanPeriodActive("active", "2026-07-11T10:00:00.000Z", now)).toBe(true);
    expect(isPlanPeriodActive("active", "2026-07-09T10:00:00.000Z", now)).toBe(false);
    expect(isPlanPeriodActive("expired", "2026-07-11T10:00:00.000Z", now)).toBe(false);
    expect(isPlanPeriodActive("active", null, now)).toBe(true);
  });
});
