import { describe, expect, it } from "vitest";
import {
  matchProsecutedSales,
  personIdentityKey,
  type ProsecutionLawyer,
  type ProsecutionSaleCandidate,
} from "./lawyer-prosecuted-sales";

const durand: ProsecutionLawyer = {
  id: "lawyer-durand",
  displayName: "Maître Claire Durand",
  barAssociation: "Bordeaux",
};

function sale(
  id: string,
  lawyerName: string | null,
  tribunal: string | null = "Tribunal judiciaire de Bordeaux",
  saleDate: string | null = "2026-12-01T09:00:00Z",
): ProsecutionSaleCandidate {
  return { id, lawyerName, tribunal, saleDate };
}

describe("personIdentityKey", () => {
  it("ignores titles, accents, punctuation and the order of the words", () => {
    const key = personIdentityKey("Maître Claire Durand");

    expect(key).toBe("claire durand");
    expect(personIdentityKey("DURAND Claire")).toBe(key);
    expect(personIdentityKey("Me Claire DURAND")).toBe(key);
    expect(personIdentityKey("Jean-Pierre Lefèvre")).toBe(personIdentityKey("LEFEVRE Jean Pierre"));
  });

  it("refuses a name that is not clearly one person", () => {
    for (const name of [
      "Me Dupont",
      "Maître Durand",
      "J. Dupont",
      "Me Claire Durand et Me Marc Lefèvre",
      "Me Claire Durand & associés",
      "Durand, Lefèvre",
      "Me Claire Durand; Me Marc Lefèvre",
      "SCP Durand Lefèvre",
      "SELARL Claire Durand",
      "Cabinet Claire Durand",
      "Claire Durand Avocats",
      "",
      null,
      undefined,
    ]) {
      expect(personIdentityKey(name), String(name)).toBeNull();
    }
  });
});

describe("matchProsecutedSales", () => {
  it("attaches a sale to the lawyer with the same full name at the bar of the tribunal", () => {
    const matches = matchProsecutedSales(
      [durand],
      [
        sale("sale-b", "DURAND Claire"),
        sale("sale-a", "Maître Claire Durand", "TJ de Bordeaux", "2026-11-15T09:00:00Z"),
      ],
    );

    expect(matches.get("lawyer-durand")).toEqual(["sale-a", "sale-b"]);
  });

  it("never matches a lawyer of another bar, even with the same name", () => {
    const matches = matchProsecutedSales(
      [durand],
      [sale("paris", "Maître Claire Durand", "Tribunal judiciaire de Paris")],
    );

    expect(matches.size).toBe(0);
  });

  it("does not match when the tribunal does not name its seat or the lawyer has no bar", () => {
    expect(matchProsecutedSales([durand], [sale("a", "Claire Durand", "Cour d'appel")]).size).toBe(
      0,
    );
    expect(matchProsecutedSales([durand], [sale("b", "Claire Durand", null)]).size).toBe(0);
    expect(
      matchProsecutedSales([{ ...durand, barAssociation: null }], [sale("c", "Claire Durand")])
        .size,
    ).toBe(0);
  });

  it("does not match a family name alone, a firm, a partial name or an extra word", () => {
    const matches = matchProsecutedSales(
      [durand],
      [
        sale("alone", "Me Durand"),
        sale("firm", "SCP Durand Lefèvre"),
        sale("pair", "Me Claire Durand et Me Marc Lefèvre"),
        sale("extra", "Me Claire Marie Durand"),
        sale("other-first-name", "Me Claude Durand"),
        sale("initial", "Me C. Durand"),
      ],
    );

    expect(matches.size).toBe(0);
  });

  it("matches nobody when two referenced lawyers of the same bar share the name", () => {
    const twin: ProsecutionLawyer = { ...durand, id: "lawyer-twin", displayName: "Claire DURAND" };

    const matches = matchProsecutedSales([durand, twin], [sale("a", "Claire Durand")]);

    expect(matches.size).toBe(0);
  });

  it("still matches when the namesake belongs to another bar", () => {
    const parisian: ProsecutionLawyer = { ...durand, id: "lawyer-paris", barAssociation: "Paris" };

    const matches = matchProsecutedSales([durand, parisian], [sale("a", "Claire Durand")]);

    expect([...matches.keys()]).toEqual(["lawyer-durand"]);
  });

  it("resolves bars whose official name differs from the city of the tribunal", () => {
    const bobigny: ProsecutionLawyer = {
      id: "lawyer-bobigny",
      displayName: "Marc Lefèvre",
      barAssociation: "Seine-Saint-Denis",
    };

    const matches = matchProsecutedSales(
      [bobigny],
      [sale("a", "Me Marc LEFEVRE", "Tribunal judiciaire de Bobigny")],
    );

    expect(matches.get("lawyer-bobigny")).toEqual(["a"]);
  });
});
