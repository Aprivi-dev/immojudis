import { describe, expect, it } from "vitest";
import { parisDayMonthLabel, parisMonthName, parisMonthWindow } from "./paris-month";

describe("parisMonthWindow", () => {
  it("coupe le mois à 00 h 00 heure de Paris en été (UTC+2)", () => {
    expect(parisMonthWindow(new Date("2026-07-06T08:30:00.000Z"))).toEqual({
      periodStart: "2026-06-30T22:00:00.000Z",
      periodEnd: "2026-07-31T22:00:00.000Z",
    });
  });

  it("coupe le mois à 00 h 00 heure de Paris en hiver (UTC+1)", () => {
    expect(parisMonthWindow(new Date("2026-12-15T12:00:00.000Z"))).toEqual({
      periodStart: "2026-11-30T23:00:00.000Z",
      periodEnd: "2026-12-31T23:00:00.000Z",
    });
  });

  it("change de mois à minuit à Paris, pas à minuit UTC", () => {
    // 31/10 22:59 UTC = 31/10 23:59 à Paris (UTC+1 après le passage à l'heure d'hiver) : octobre.
    expect(parisMonthWindow(new Date("2026-10-31T22:59:59.000Z")).periodStart).toBe(
      "2026-09-30T22:00:00.000Z",
    );
    // 31/10 23:30 UTC = 1er/11 00:30 à Paris : novembre.
    expect(parisMonthWindow(new Date("2026-10-31T23:30:00.000Z"))).toEqual({
      periodStart: "2026-10-31T23:00:00.000Z",
      periodEnd: "2026-11-30T23:00:00.000Z",
    });
    // 30/11 23:30 UTC = 1er/12 00:30 à Paris : décembre.
    expect(parisMonthWindow(new Date("2026-11-30T23:30:00.000Z")).periodStart).toBe(
      "2026-11-30T23:00:00.000Z",
    );
    // Heure d'été : 30/06 22:30 UTC = 1er/07 00:30 à Paris.
    expect(parisMonthWindow(new Date("2026-06-30T22:30:00.000Z")).periodStart).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    // 1er/07 00:00 Paris exactement : le nouveau mois commence.
    expect(parisMonthWindow(new Date("2026-06-30T22:00:00.000Z")).periodStart).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    expect(parisMonthWindow(new Date("2026-06-30T21:59:59.999Z")).periodStart).toBe(
      "2026-05-31T22:00:00.000Z",
    );
  });

  it("gère le passage à l'heure d'hiver et la fin d'année", () => {
    // Le mois d'octobre 2026 contient le passage à l'heure d'hiver (25/10) : 31 jours + 1 h.
    const october = parisMonthWindow(new Date("2026-10-10T10:00:00.000Z"));
    expect(october).toEqual({
      periodStart: "2026-09-30T22:00:00.000Z",
      periodEnd: "2026-10-31T23:00:00.000Z",
    });
    expect(parisMonthWindow(new Date("2026-12-31T23:30:00.000Z"))).toEqual({
      periodStart: "2026-12-31T23:00:00.000Z",
      periodEnd: "2027-01-31T23:00:00.000Z",
    });
  });
});

describe("libellés en heure de Paris", () => {
  it("nomme le mois civil de Paris et le jour de remise à zéro", () => {
    expect(parisMonthName("2026-10-13T09:00:00.000Z")).toBe("octobre");
    expect(parisMonthName("2026-10-31T23:30:00.000Z")).toBe("novembre");
    expect(parisDayMonthLabel(parisMonthWindow(new Date("2026-10-13T09:00:00Z")).periodEnd)).toBe(
      "1er novembre",
    );
    expect(parisDayMonthLabel("2026-11-12T12:00:00.000Z")).toBe("12 novembre");
  });
});
