import { describe, expect, it } from "vitest";
import { LAUNCH_OFFER_END_NEEDS_ANALYSIS, LAUNCH_OFFER_END_STAYS } from "./launch-offer-end-lists";
import { PLAN_FEATURES, PLAN_LIMITS } from "./plans";

const free = PLAN_LIMITS.decouverte;
const analysis = PLAN_LIMITS.analyse;

describe("ce qui demandera l’offre Analyse à la fin de l’essai", () => {
  it("met le plafond et les alertes en tête, avec les chiffres de `PLAN_LIMITS`", () => {
    expect(LAUNCH_OFFER_END_NEEDS_ANALYSIS).toEqual([
      `le plafond chiffré sans limite mensuelle (compte gratuit : ${free.monthlyUnlocks} ventes par mois)`,
      `jusqu’à ${analysis.watchedZones} alertes, chaque jour (compte gratuit : ${free.watchedZones}, chaque semaine)`,
      "l’estimation détaillée et les ventes comparables",
      "le rapport PDF et l’export CSV",
      "les pièces du dossier et leur lecture sur toutes les ventes (compte gratuit : vos ventes débloquées)",
    ]);
    expect(LAUNCH_OFFER_END_NEEDS_ANALYSIS.join(" ")).toContain("3 ventes par mois");
    expect(LAUNCH_OFFER_END_NEEDS_ANALYSIS.join(" ")).toContain("jusqu’à 25 alertes");
  });

  it("ne cite le PDF qu’une fois", () => {
    const all = [...LAUNCH_OFFER_END_STAYS, ...LAUNCH_OFFER_END_NEEDS_ANALYSIS].join(" ");
    expect(all.match(/PDF/g)).toHaveLength(1);
  });

  it("ne liste que des fonctions que le compte gratuit n’a pas en entier", () => {
    const { decouverte, analyse } = PLAN_FEATURES;
    for (const feature of [
      "property.bidCeiling",
      "alerts.advanced",
      "property.valueEstimate",
      "property.soldComparables",
      "property.pdfExport",
      "sales.csvExport",
      "property.documentReading",
    ] as const) {
      expect(decouverte[feature], feature).not.toBe("included");
      expect(analyse[feature], feature).toBe("included");
    }
    expect(free.pdfExportsPerMonth).toBe(0);
    expect(analysis.monthlyUnlocks).toBeNull();
  });
});
