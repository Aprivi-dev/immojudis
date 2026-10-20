import { describe, expect, it } from "vitest";
import { SURENCHERE_WINDOW_DAYS, surenchereWindow } from "@/lib/surenchere-window";

const judicial = { venueType: "tribunal", adjudicationConfirmed: true } as const;

describe("surenchereWindow", () => {
  it("fixe le délai à dix jours après l'audience", () => {
    expect(SURENCHERE_WINDOW_DAYS).toBe(10);
  });

  it("calcule la date indicative à dix jours du jour d'audience, sans compter de jours restants", () => {
    expect(
      surenchereWindow({
        ...judicial,
        saleDate: "2026-10-14T12:00:00.000Z",
        now: new Date("2026-10-16T09:00:00.000Z"),
      }),
    ).toEqual({
      kind: "window",
      hearingDay: "2026-10-14",
      deadline: "2026-10-24",
      adjudicationConfirmed: true,
      expired: false,
    });
  });

  it("prend le jour civil à Paris : une audience à 00 h 30 heure de Paris compte pour ce jour-là", () => {
    const window = surenchereWindow({
      ...judicial,
      saleDate: "2026-10-14T22:30:00.000Z",
      now: new Date("2026-10-15T08:00:00.000Z"),
    });
    expect(window).toMatchObject({ hearingDay: "2026-10-15", deadline: "2026-10-25" });
  });

  it("passe correctement les fins de mois et les années bissextiles", () => {
    expect(
      surenchereWindow({
        ...judicial,
        saleDate: "2028-02-25T10:00:00.000Z",
        now: new Date("2028-02-26T10:00:00.000Z"),
      }),
    ).toMatchObject({ deadline: "2028-03-06" });
    expect(
      surenchereWindow({
        ...judicial,
        saleDate: "2026-12-28T10:00:00.000Z",
        now: new Date("2026-12-29T10:00:00.000Z"),
      }),
    ).toMatchObject({ deadline: "2027-01-07" });
  });

  it("marque la date indicative comme passée le lendemain, sans jamais exposer de jours restants", () => {
    const base = { ...judicial, saleDate: "2026-10-14T12:00:00.000Z" };
    // 23 h à Paris le 24 octobre : la date indicative n'est pas passée.
    const onTheDay = surenchereWindow({ ...base, now: new Date("2026-10-24T21:00:00.000Z") });
    expect(onTheDay).toMatchObject({ expired: false });
    // 00 h 30 à Paris le 25 octobre : passée.
    const after = surenchereWindow({ ...base, now: new Date("2026-10-24T22:30:00.000Z") });
    expect(after).toMatchObject({ expired: true });
    // Le report éventuel au premier jour ouvrable n'est pas calculé : aucune valeur ne le suggère.
    for (const result of [onTheDay, after]) {
      expect(result).not.toHaveProperty("daysLeft");
    }
  });

  it("garde la fenêtre quand le résultat n'est pas connu, sans le présenter comme confirmé", () => {
    expect(
      surenchereWindow({
        venueType: "tribunal",
        adjudicationConfirmed: false,
        saleDate: "2026-10-14T12:00:00.000Z",
        now: new Date("2026-10-15T12:00:00.000Z"),
      }),
    ).toMatchObject({ kind: "window", adjudicationConfirmed: false });
  });

  it("ne calcule aucune fenêtre hors vente judiciaire", () => {
    for (const venueType of ["notary", "state", "online", "unknown", null, undefined]) {
      expect(
        surenchereWindow({
          venueType,
          adjudicationConfirmed: true,
          saleDate: "2026-10-14T12:00:00.000Z",
        }),
      ).toEqual({ kind: "not_applicable" });
    }
  });

  it("ne devine pas une date d'audience absente ou invalide", () => {
    for (const saleDate of [null, undefined, "", "pas une date"]) {
      expect(surenchereWindow({ ...judicial, saleDate })).toEqual({ kind: "no_date" });
    }
  });
});
