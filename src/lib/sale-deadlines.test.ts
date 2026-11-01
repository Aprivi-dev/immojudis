import { describe, expect, it } from "vitest";
import { buildSaleDeadlinesCalendarFile } from "./sale-calendar";
import { DEADLINES_CONFIRM_NOTICE, saleDeadlines, saleDeadlinesApply } from "./sale-deadlines";

const base = {
  saleDate: "2026-10-14T12:00:00.000Z",
  venueType: "tribunal",
  legalFramework: "judicial_seizure",
  now: new Date("2026-10-16T09:00:00.000Z"),
};

describe("saleDeadlinesApply", () => {
  it("ne vise que les saisies immobilières au tribunal", () => {
    expect(saleDeadlinesApply({ venueType: "tribunal", legalFramework: "judicial_seizure" })).toBe(
      true,
    );
    for (const legalFramework of ["insolvency", "judicial_partition", "voluntary_notarial", null]) {
      expect(saleDeadlinesApply({ venueType: "tribunal", legalFramework })).toBe(false);
    }
    expect(saleDeadlinesApply({ venueType: "notary", legalFramework: "judicial_seizure" })).toBe(
      false,
    );
  });
});

describe("saleDeadlines", () => {
  it("date la fin du délai de surenchère (10 jours) et le paiement (2 mois plus tard), sources citées", () => {
    const deadlines = saleDeadlines(base)!;
    expect(deadlines.map((deadline) => [deadline.key, deadline.isoDay])).toEqual([
      ["surenchere", "2026-10-24"],
      ["paiement", "2026-12-24"],
    ]);
    expect(deadlines[0].source).toContain("R. 322-50");
    expect(deadlines[1].source).toContain("R. 322-56");
    // Dates « au plus tôt », jamais des échéances fermes.
    expect(deadlines.every((deadline) => /au plus tôt/.test(deadline.label))).toBe(true);
    expect(deadlines[0].caveat).toContain("art. 641 et 642 du CPC");
    expect(deadlines[0].caveat).toContain("n’est pas calculée");
  });

  it("compte les dix jours depuis le jour civil de Paris de l'audience", () => {
    // 23 h 30 à Paris le 14 octobre (21 h 30 UTC) : toujours le 14.
    expect(saleDeadlines({ ...base, saleDate: "2026-10-14T21:30:00.000Z" })![0].isoDay).toBe(
      "2026-10-24",
    );
    // 0 h 30 à Paris le 15 octobre (22 h 30 UTC la veille) : le 15.
    expect(saleDeadlines({ ...base, saleDate: "2026-10-14T22:30:00.000Z" })![0].isoDay).toBe(
      "2026-10-25",
    );
  });

  it("ramène le paiement au dernier jour d'un mois plus court", () => {
    // Audience le 21 décembre : surenchère le 31 décembre, paiement « le 31 février » -> 28 février.
    const deadlines = saleDeadlines({ ...base, saleDate: "2026-12-21T12:00:00.000Z" })!;
    expect(deadlines[0].isoDay).toBe("2026-12-31");
    expect(deadlines[1].isoDay).toBe("2027-02-28");
  });

  it("ne produit rien hors saisie immobilière ou sans date d'audience", () => {
    expect(saleDeadlines({ ...base, legalFramework: "insolvency" })).toBeNull();
    expect(saleDeadlines({ ...base, venueType: "notary" })).toBeNull();
    expect(saleDeadlines({ ...base, saleDate: null })).toBeNull();
    expect(saleDeadlines({ ...base, saleDate: "pas une date" })).toBeNull();
  });
});

describe("buildSaleDeadlinesCalendarFile", () => {
  const origin = "https://www.immojudis.example";
  const saleId = "A1B2C3D4-0000-4000-8000-1234567890AB";
  const file = buildSaleDeadlinesCalendarFile(
    { saleId, deadlines: saleDeadlines(base), propertyType: "house", city: "Bordeaux" },
    { origin, now: base.now },
  )!;
  const ics = file.body.replace(/\r\n /g, "");

  it("écrit deux événements sur la journée, à confirmer, avec leurs sources", () => {
    expect(file.filename).toBe("immojudis-echeancier-a1b2c3d4.ics");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261024");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261224");
    expect(ics).toContain("STATUS:TENTATIVE");
    expect(ics).toContain("SUMMARY:Fin du délai de surenchère\\, au plus tôt – Maison à Bordeaux");
    expect(ics).toContain("art. R. 322-50 du CPCE");
    expect(ics).toContain("art. R. 322-56 du CPCE");
    expect(ics).toContain(DEADLINES_CONFIRM_NOTICE);
    expect(ics).toContain(`UID:deadline-surenchere-${saleId.toLowerCase()}@www.immojudis.example`);
  });

  it("n'écrit ni rappel, ni prix, ni adresse, ni lien", () => {
    expect(ics).not.toContain("VALARM");
    expect(ics).not.toMatch(/€|euros?/i);
    expect(ics).not.toContain("LOCATION");
    expect(ics).not.toContain("URL:");
  });

  it("rend null sans échéance", () => {
    expect(
      buildSaleDeadlinesCalendarFile(
        { saleId, deadlines: null, propertyType: null, city: null },
        { origin },
      ),
    ).toBeNull();
    expect(
      buildSaleDeadlinesCalendarFile(
        { saleId, deadlines: [], propertyType: null, city: null },
        { origin },
      ),
    ).toBeNull();
  });
});
