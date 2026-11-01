import { describe, expect, it } from "vitest";
import { parisWallTimeToInstant, parseVisitSlot, visitSlots } from "./visit-slots";

describe("parisWallTimeToInstant", () => {
  it("lit l'heure de Paris : UTC+2 en été, UTC+1 en hiver", () => {
    expect(parisWallTimeToInstant(2026, 10, 2, 14, 0).toISOString()).toBe(
      "2026-10-02T12:00:00.000Z",
    );
    expect(parisWallTimeToInstant(2026, 12, 15, 9, 30).toISOString()).toBe(
      "2026-12-15T08:30:00.000Z",
    );
  });

  it("tient le jour du changement d'heure d'automne (25 octobre 2026, 3 h devient 2 h)", () => {
    expect(parisWallTimeToInstant(2026, 10, 25, 10, 0).toISOString()).toBe(
      "2026-10-25T09:00:00.000Z",
    );
    expect(parisWallTimeToInstant(2026, 10, 24, 10, 0).toISOString()).toBe(
      "2026-10-24T08:00:00.000Z",
    );
  });
});

describe("parseVisitSlot", () => {
  it("lit un jour et une heure ISO publiés tels quels (heure de Paris)", () => {
    expect(parseVisitSlot("2026-10-02 à 14:00")).toEqual({
      kind: "instant",
      at: new Date("2026-10-02T12:00:00Z"),
    });
    expect(parseVisitSlot("2026-10-02T10:30")).toEqual({
      kind: "instant",
      at: new Date("2026-10-02T08:30:00Z"),
    });
  });

  it("lit une date en français avec ou sans heure", () => {
    expect(parseVisitSlot("mardi 6 octobre 2026 à 10h30")).toEqual({
      kind: "instant",
      at: new Date("2026-10-06T08:30:00Z"),
    });
    expect(parseVisitSlot("Jeudi 3 décembre 2026 de 14h à 15h")).toEqual({
      kind: "instant",
      at: new Date("2026-12-03T13:00:00Z"),
    });
    expect(parseVisitSlot("1er août 2026")).toEqual({ kind: "day", isoDay: "2026-08-01" });
  });

  it("garde un instant ISO avec fuseau", () => {
    expect(parseVisitSlot("2026-10-02T12:00:00Z")).toEqual({
      kind: "instant",
      at: new Date("2026-10-02T12:00:00Z"),
    });
  });

  it("donne un créneau sur la journée quand l'heure n'est pas publiée", () => {
    expect(parseVisitSlot("2026-10-02")).toEqual({ kind: "day", isoDay: "2026-10-02" });
  });

  it("n'invente rien : année absente, texte libre, date impossible ou plusieurs dates", () => {
    for (const text of [
      "mardi 20 octobre",
      "sur rendez-vous",
      "Visite libre",
      "31 février 2026",
      "2026-13-40",
      "du 2 octobre 2026 au 9 octobre 2026",
      "2026-10-02 et 2026-10-09",
      "",
      null,
      42,
    ]) {
      expect(parseVisitSlot(text)).toBeNull();
    }
  });

  it("ignore une heure impossible", () => {
    expect(parseVisitSlot("2026-10-02 à 25:00")).toEqual({ kind: "day", isoDay: "2026-10-02" });
  });
});

describe("visitSlots", () => {
  it("garde les créneaux datés, sans doublon, dans l'ordre", () => {
    const slots = visitSlots([
      "2026-10-09 à 10:00",
      "2026-10-02 à 14:00",
      "2026-10-02 à 14:00",
      "sur rendez-vous",
    ]);
    expect(
      slots.map((slot) => (slot.kind === "instant" ? slot.at.toISOString() : slot.isoDay)),
    ).toEqual(["2026-10-02T12:00:00.000Z", "2026-10-09T08:00:00.000Z"]);
  });

  it("accepte un seul texte, ou rien", () => {
    expect(visitSlots("2026-10-02")).toHaveLength(1);
    expect(visitSlots(null)).toEqual([]);
    expect(visitSlots(undefined)).toEqual([]);
    expect(visitSlots({})).toEqual([]);
  });
});
