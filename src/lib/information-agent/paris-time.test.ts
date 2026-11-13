import { describe, expect, it } from "vitest";
import { startOfParisDay } from "@/lib/paris-time";

describe("startOfParisDay", () => {
  it.each([
    // Jour ordinaire d'hiver (UTC+1) et d'été (UTC+2).
    ["2026-01-15T12:00:00Z", "2026-01-14T23:00:00.000Z"],
    ["2026-07-15T12:00:00Z", "2026-07-14T22:00:00.000Z"],
    // Passage à l'heure d'été (29/03/2026) : minuit est à UTC+1, midi à UTC+2.
    ["2026-03-29T10:00:00Z", "2026-03-28T23:00:00.000Z"],
    ["2026-03-29T21:30:00Z", "2026-03-28T23:00:00.000Z"],
    ["2026-03-29T22:30:00Z", "2026-03-29T22:00:00.000Z"],
    // Passage à l'heure d'hiver (25/10/2026) : minuit est à UTC+2, midi à UTC+1.
    ["2026-10-25T12:00:00Z", "2026-10-24T22:00:00.000Z"],
    ["2026-10-25T22:59:59Z", "2026-10-24T22:00:00.000Z"],
    // Juste après minuit à Paris.
    ["2026-10-25T23:00:00Z", "2026-10-25T23:00:00.000Z"],
  ])("%s → %s", (now, start) => {
    expect(startOfParisDay(new Date(now)).toISOString()).toBe(start);
  });
});
