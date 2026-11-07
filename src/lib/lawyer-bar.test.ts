import { describe, expect, it } from "vitest";
import {
  isLawyerEligibleForSale,
  isProsecutingLawyer,
  isSameBar,
  tribunalBarAssociation,
} from "@/lib/lawyer-bar";

describe("tribunalBarAssociation", () => {
  it("reads the seat of a tribunal judiciaire", () => {
    expect(tribunalBarAssociation("Tribunal judiciaire de Bordeaux")).toBe("Bordeaux");
    expect(tribunalBarAssociation("TJ de Paris — saisie immobilière")).toBe("Paris");
    expect(tribunalBarAssociation("Tribunal de grande instance d'Angoulême")).toBe("Angoulême");
    expect(tribunalBarAssociation("Tribunal judiciaire du Mans")).toBe("Mans");
  });

  it("keeps the hyphens of a compound seat (repasse n° 4)", () => {
    expect(tribunalBarAssociation("TJ Aix-en-Provence")).toBe("Aix-en-Provence");
    expect(tribunalBarAssociation("Tribunal judiciaire d'Aix-en-Provence")).toBe("Aix-en-Provence");
    expect(tribunalBarAssociation("Tribunal judiciaire de Saint-Étienne")).toBe("Saint-Étienne");
    expect(tribunalBarAssociation("TJ Bourg-en-Bresse")).toBe("Bourg-en-Bresse");
    expect(tribunalBarAssociation("TJ Boulogne-sur-Mer")).toBe("Boulogne-sur-Mer");
    expect(tribunalBarAssociation("TJ Fort-de-France")).toBe("Fort-de-France");
    expect(tribunalBarAssociation("TJ Châlons-en-Champagne")).toBe("Châlons-en-Champagne");
    expect(tribunalBarAssociation("TJ Lons-le-Saunier")).toBe("Lons-le-Saunier");
    expect(tribunalBarAssociation("TJ Mont-de-Marsan")).toBe("Mont-de-Marsan");
    expect(tribunalBarAssociation("TJ Saint-Denis-de-La-Réunion")).toBe(
      "Saint-Denis-de-La-Réunion",
    );
  });

  it("still separates a detail introduced by a spaced hyphen or a dash", () => {
    expect(tribunalBarAssociation("TJ de Lyon - audience du 3 mars")).toBe("Lyon");
    expect(tribunalBarAssociation("Tribunal judiciaire de Lyon- audience")).toBe("Lyon");
    expect(tribunalBarAssociation("TJ Aix-en-Provence")).toBe("Aix-en-Provence");
    expect(tribunalBarAssociation("TJ Aix-en-Provence - saisie immobilière")).toBe(
      "Aix-en-Provence",
    );
    expect(
      tribunalBarAssociation("Tribunal judiciaire de Saint-Étienne – chambre des criées"),
    ).toBe("Saint-Étienne");
    expect(tribunalBarAssociation("TJ Bourg-en-Bresse—vente")).toBe("Bourg-en-Bresse");
  });

  it("reads reference names that repeat the court type", () => {
    expect(tribunalBarAssociation("TJ Tribunal judiciaire du Mans")).toBe("Mans");
    expect(tribunalBarAssociation("TJ Tribunal judiciaire du Puy-en-Velay")).toBe("Puy-en-Velay");
    expect(tribunalBarAssociation("TJ Tribunal judiciaire des Sables-d'Olonne")).toBe(
      "Sables-d'Olonne",
    );
    expect(tribunalBarAssociation("TJ Tribunal de Première Instance de Nouméa")).toBe("Nouméa");
  });

  it("returns null when the label does not name a seat, without any city fallback", () => {
    expect(tribunalBarAssociation("Cour d'appel")).toBeNull();
    expect(tribunalBarAssociation("")).toBeNull();
    expect(tribunalBarAssociation(null)).toBeNull();
  });
});

describe("isSameBar", () => {
  it("compares bars through the official CNB naming", () => {
    expect(isSameBar("Bordeaux", "Barreau de Bordeaux")).toBe(true);
    expect(isSameBar("Bobigny", "Seine-Saint-Denis")).toBe(true);
    expect(isSameBar("Bordeaux", "Lyon")).toBe(false);
    expect(isSameBar(null, "Lyon")).toBe(false);
  });

  it("matches the bar of a compound seat read from a tribunal label (repasse n° 4)", () => {
    const cases: Array<[string, string]> = [
      ["TJ Aix-en-Provence", "AIX EN PROVENCE"],
      ["Tribunal judiciaire de Saint-Étienne", "SAINT ETIENNE"],
      ["TJ Bourg-en-Bresse", "AIN"],
      ["TJ Boulogne-sur-Mer", "BOULOGNE SUR MER"],
      ["TJ Fort-de-France", "MARTINIQUE"],
      ["TJ Châlons-en-Champagne", "CHALONS EN CHAMPAGNE"],
      ["TJ Lons-le-Saunier", "JURA"],
      ["TJ Thonon-les-Bains", "THONON LES BAINS LEMAN ET GENEVOIS"],
      ["TJ Évry-Courcouronnes", "ESSONNE"],
      ["TJ Saint-Pierre", "SAINT PIERRE DE LA REUNION"],
      ["TJ Tribunal judiciaire du Mans", "LE MANS"],
    ];
    for (const [tribunal, bar] of cases) {
      expect(isSameBar(tribunalBarAssociation(tribunal), bar), tribunal).toBe(true);
    }
    expect(isSameBar(tribunalBarAssociation("TJ Saint-Étienne"), "SAINT DIE")).toBe(false);
    expect(isSameBar(tribunalBarAssociation("TJ Aix-en-Provence"), "AIX")).toBe(false);
  });
});

describe("isProsecutingLawyer", () => {
  it("recognises the prosecuting lawyer whatever the title or word order", () => {
    expect(
      isProsecutingLawyer({ displayName: "Me Jean Dupont" }, "Maître Jean DUPONT, avocat"),
    ).toBe(true);
    expect(isProsecutingLawyer({ displayName: "Dupont Jean" }, "Me Jean Dupont")).toBe(true);
    expect(
      isProsecutingLawyer(
        { displayName: "Me Autre", firmName: "SELARL Dupont Avocats" },
        "SELARL Dupont Avocats",
      ),
    ).toBe(true);
  });

  it("does not exclude unrelated lawyers or homonyms of a single token", () => {
    expect(isProsecutingLawyer({ displayName: "Me Marie Martin" }, "Me Jean Dupont")).toBe(false);
    expect(isProsecutingLawyer({ displayName: "Me Jean Dupont" }, null)).toBe(false);
    expect(isProsecutingLawyer({ displayName: "Me Jean Dupont" }, "")).toBe(false);
  });
});

describe("isLawyerEligibleForSale", () => {
  const lawyer = { displayName: "Me Marie Martin", firmName: null, barAssociation: "Bordeaux" };

  it("requires the bar of the tribunal", () => {
    expect(
      isLawyerEligibleForSale({ lawyer, saleBar: "Bordeaux", prosecutingLawyerName: null }),
    ).toBe(true);
    expect(isLawyerEligibleForSale({ lawyer, saleBar: "Lyon", prosecutingLawyerName: null })).toBe(
      false,
    );
    expect(isLawyerEligibleForSale({ lawyer, saleBar: null, prosecutingLawyerName: null })).toBe(
      false,
    );
  });

  it("excludes the prosecuting lawyer even in the right bar", () => {
    expect(
      isLawyerEligibleForSale({
        lawyer,
        saleBar: "Bordeaux",
        prosecutingLawyerName: "Maître Marie MARTIN",
      }),
    ).toBe(false);
  });
});
