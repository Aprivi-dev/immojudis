import { describe, expect, it } from "vitest";
import { buildUsageLimitState, currentMonthUsageWindow } from "@/lib/usage";

describe("feature usage limits", () => {
  it("builds stable UTC monthly usage windows", () => {
    const window = currentMonthUsageWindow(new Date("2026-07-06T08:30:00.000Z"));

    expect(window).toEqual({
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });
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
