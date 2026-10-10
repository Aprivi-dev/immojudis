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
