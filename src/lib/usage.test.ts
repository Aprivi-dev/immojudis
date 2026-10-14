import { describe, expect, it } from "vitest";
import { buildUsageLimitState, currentMonthUsageWindow } from "@/lib/usage";

describe("feature usage limits", () => {
  it("builds monthly usage windows on the Paris calendar month", () => {
    const summer = currentMonthUsageWindow(new Date("2026-07-06T08:30:00.000Z"));
    // 1er juillet 00 h 00 à Paris (UTC+2) = 30 juin 22 h 00 UTC.
    expect(summer).toEqual({
      periodStart: "2026-06-30T22:00:00.000Z",
      periodEnd: "2026-07-31T22:00:00.000Z",
    });
  });

  it("resets at midnight in Paris, not at midnight UTC", () => {
    // 31/10 23:30 UTC = 1er/11 00:30 à Paris (heure d'hiver) : le compteur de novembre a commencé.
    expect(currentMonthUsageWindow(new Date("2026-10-31T23:30:00.000Z"))).toEqual({
      periodStart: "2026-10-31T23:00:00.000Z",
      periodEnd: "2026-11-30T23:00:00.000Z",
    });
    // 30/11 23:30 UTC = 1er/12 00:30 à Paris.
    expect(currentMonthUsageWindow(new Date("2026-11-30T23:30:00.000Z")).periodStart).toBe(
      "2026-11-30T23:00:00.000Z",
    );
  });

  it("reports remaining quota without going negative", () => {
    const limited = buildUsageLimitState({
      eventKey: "property_report.created",
      label: "Rapports générés",
      used: 7,
      limit: 5,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });
    const unlimited = buildUsageLimitState({
      eventKey: "property_report.pdf_exported",
      label: "Exports PDF",
      used: 42,
      limit: null,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });

    expect(limited.remaining).toBe(0);
    expect(unlimited.remaining).toBeNull();
  });
});
