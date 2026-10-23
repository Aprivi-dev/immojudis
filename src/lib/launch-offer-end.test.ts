import { describe, expect, it } from "vitest";
import {
  LAUNCH_OFFER_MIN_NOTICE_DAYS,
  daysUntilLaunchOfferEnd,
  launchOfferEndLabel,
  parisToday,
  parseLaunchOfferEndDay,
} from "./launch-offer-end";

describe("launch-offer-end", () => {
  it("ne lit qu'un jour du calendrier qui existe", () => {
    expect(parseLaunchOfferEndDay("2026-12-01")).toBe("2026-12-01");
    expect(parseLaunchOfferEndDay("2028-02-29")).toBe("2028-02-29");
    expect(parseLaunchOfferEndDay("2026-02-29")).toBeNull();
    expect(parseLaunchOfferEndDay("2026-13-01")).toBeNull();
    expect(parseLaunchOfferEndDay("01/12/2026")).toBeNull();
    expect(parseLaunchOfferEndDay(null)).toBeNull();
    expect(parseLaunchOfferEndDay(20261201)).toBeNull();
  });

  it("compte les jours à partir de la date de Paris, pas de celle d'UTC", () => {
    // 22h30 UTC le 22/10 = 00h30 à Paris le 23/10.
    const lateEvening = new Date("2026-10-22T22:30:00Z");
    expect(parisToday(lateEvening)).toBe("2026-10-23");
    expect(daysUntilLaunchOfferEnd("2026-10-23", lateEvening)).toBe(0);
    expect(daysUntilLaunchOfferEnd("2026-12-01", lateEvening)).toBe(39);
    expect(daysUntilLaunchOfferEnd("2026-10-20", lateEvening)).toBe(-3);
  });

  it("écrit la date en toutes lettres et fixe le préavis à 30 jours", () => {
    expect(launchOfferEndLabel("2026-11-30")).toBe("30 novembre 2026");
    expect(launchOfferEndLabel("2026-12-01")).toBe("1 décembre 2026");
    expect(LAUNCH_OFFER_MIN_NOTICE_DAYS).toBe(30);
  });
});
