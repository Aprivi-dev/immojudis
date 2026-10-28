// Filet de non-régression du plafond : chaque résultat ci-dessous a été calculé avec le moteur
// puis écrit en dur. Si un résultat change volontairement, incrémentez CEILING_ENGINE_VERSION et
// mettez à jour ce test.
//
// Version « 2026-10-26.1 » : résultats calculés AVANT toute évolution du lot 0.
// Version « 2026-10-26.2 » (lot A2, n° 14) : les frais préalables (frais de poursuite taxés) sortent
// de la base des droits de mutation et de la CSI (BOFiP BOI-ENR-DMTOI-10-10-30-20 (Adjudication), § 50) ; les
// émoluments, le budget et le mode limitant ne changent pas, les frais baissent de
// frais préalables × (taux de droits + 0,10 % de CSI), et le plafond peut gagner 500 € (un pas
// d'enchère). Les valeurs de la version précédente sont gardées dans `PREVIOUS_EXPECTED`.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { CEILING_ENGINE_VERSION, computeCeilingPlan } from "@/lib/bid-ceiling-engine";
import { CSI_RATE } from "@/lib/profitability";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import type { AuctionSale } from "@/lib/types";

const PRELIMINARY = "Les frais préalables s’élèvent à 4 250 € TTC.";

function tribunalSale(overrides: Record<string, unknown>): AuctionSale {
  return {
    id: "sale",
    source_type: "tribunal",
    app_surface_kind: "habitable",
    description: "Vente aux enchères publiques.",
    ...overrides,
  } as unknown as AuctionSale;
}

function estimateFor(
  value: number,
  surface: number,
  quality: "forte" | "correcte" | "fragile" = "forte",
  sampleSize = 25,
): CeilingMarketEstimate {
  return {
    source: "DVF normalisé",
    sourceUpdatedAt: null,
    subjectSurfaceEstimated: false,
    estimatedValueEur: value,
    actionable: true,
    qualityLabel: quality,
    sampleSize,
    effectiveSampleSize: sampleSize,
    medianPricePerM2: Math.round(value / surface),
    p75PricePerM2: Math.round((value / surface) * 1.15),
  } as unknown as CeilingMarketEstimate;
}

type Case = {
  name: string;
  sale: AuctionSale;
  estimate: CeilingMarketEstimate;
  choices: CeilingUserChoices;
  expected: {
    maxBid: number;
    budget: number;
    acquisitionFeesTotal: number;
    binding: "valeur" | "rendement";
  };
};

const apartment33 = { department: "33", property_type: "apartment", app_surface_m2: 62 };
const house36 = { department: "36", property_type: "house", app_surface_m2: 110 };
const apartment75 = { department: "75", property_type: "apartment", app_surface_m2: 45 };

const cases: Case[] = [
  {
    name: "33, appartement libre, frais préalables lus, habiter",
    sale: tribunalSale({
      ...apartment33,
      starting_price_eur: 60_000,
      occupancy_status: "vacant",
      description: `Appartement libre. ${PRELIMINARY}`,
    }),
    estimate: estimateFor(220_000, 62),
    choices: {},
    expected: { maxBid: 176500, budget: 198000, acquisitionFeesTotal: 21147, binding: "valeur" },
  },
  {
    name: "33, appartement libre, frais préalables par défaut, habiter",
    sale: tribunalSale({ ...apartment33, starting_price_eur: 60_000, occupancy_status: "vacant" }),
    estimate: estimateFor(220_000, 62),
    choices: {},
    expected: { maxBid: 176000, budget: 198000, acquisitionFeesTotal: 21856, binding: "valeur" },
  },
  {
    name: "33, appartement occupé, frais préalables par défaut, louer",
    sale: tribunalSale({
      ...apartment33,
      starting_price_eur: 60_000,
      occupancy_status: "occupied",
    }),
    estimate: estimateFor(220_000, 62),
    choices: { project: "louer" },
    expected: { maxBid: 132500, budget: 163062, acquisitionFeesTotal: 18281, binding: "rendement" },
  },
  {
    name: "33, appartement loué, frais préalables lus, revendre",
    sale: tribunalSale({
      ...apartment33,
      starting_price_eur: 60_000,
      occupancy_status: "rented",
      description: `Appartement loué. ${PRELIMINARY}`,
    }),
    estimate: estimateFor(220_000, 62),
    choices: { project: "revendre", works: { key: "rafraichissement", amount: 31_000 } },
    expected: { maxBid: 100500, budget: 154000, acquisitionFeesTotal: 14902, binding: "valeur" },
  },
  {
    name: "36, maison libre, frais préalables lus, revendre avec travaux",
    sale: tribunalSale({
      ...house36,
      starting_price_eur: 25_000,
      occupancy_status: "vacant",
      description: `Maison libre. ${PRELIMINARY}`,
    }),
    estimate: estimateFor(120_000, 110, "correcte", 12),
    choices: { project: "revendre", works: { key: "confort", amount: 33_000 } },
    expected: { maxBid: 50500, budget: 100800, acquisitionFeesTotal: 10116, binding: "valeur" },
  },
  {
    name: "36, maison occupée, frais préalables par défaut, habiter",
    sale: tribunalSale({ ...house36, starting_price_eur: 25_000, occupancy_status: "occupied" }),
    estimate: estimateFor(120_000, 110, "correcte", 12),
    choices: {},
    expected: { maxBid: 86000, budget: 108000, acquisitionFeesTotal: 13403, binding: "valeur" },
  },
  {
    name: "36, maison louée, frais préalables par défaut, habiter, estimation fragile",
    sale: tribunalSale({ ...house36, starting_price_eur: 25_000, occupancy_status: "rented" }),
    estimate: estimateFor(120_000, 110, "fragile", 5),
    choices: {},
    expected: { maxBid: 80500, budget: 93960, acquisitionFeesTotal: 13019, binding: "valeur" },
  },
  {
    name: "36, maison libre, frais préalables par défaut, louer",
    sale: tribunalSale({ ...house36, starting_price_eur: 25_000, occupancy_status: "vacant" }),
    estimate: estimateFor(120_000, 110, "correcte", 12),
    choices: { project: "louer", profile: "prudent" },
    expected: { maxBid: 88000, budget: 102000, acquisitionFeesTotal: 13543, binding: "valeur" },
  },
  {
    name: "75, appartement libre, frais préalables lus, habiter",
    sale: tribunalSale({
      ...apartment75,
      starting_price_eur: 150_000,
      occupancy_status: "vacant",
      description: `Studio libre. ${PRELIMINARY}`,
    }),
    estimate: estimateFor(420_000, 45),
    choices: {},
    expected: { maxBid: 343000, budget: 378000, acquisitionFeesTotal: 34827, binding: "valeur" },
  },
  {
    name: "75, appartement occupé, frais préalables par défaut, revendre",
    sale: tribunalSale({
      ...apartment75,
      starting_price_eur: 150_000,
      occupancy_status: "occupied",
    }),
    estimate: estimateFor(420_000, 45),
    choices: { project: "revendre", profile: "offensif" },
    expected: { maxBid: 300000, budget: 357000, acquisitionFeesTotal: 32044, binding: "valeur" },
  },
  {
    name: "75, appartement loué, frais préalables lus, louer",
    sale: tribunalSale({
      ...apartment75,
      starting_price_eur: 150_000,
      occupancy_status: "rented",
      description: `Appartement loué. ${PRELIMINARY}`,
    }),
    estimate: estimateFor(420_000, 45),
    choices: { project: "louer" },
    expected: { maxBid: 246000, budget: 272888, acquisitionFeesTotal: 26857, binding: "rendement" },
  },
  {
    name: "75, appartement libre, mise à prix proche de la valeur, habiter",
    sale: tribunalSale({ ...apartment75, starting_price_eur: 330_000, occupancy_status: "vacant" }),
    estimate: estimateFor(420_000, 45),
    choices: {},
    expected: { maxBid: 342000, budget: 378000, acquisitionFeesTotal: 35495, binding: "valeur" },
  },
  {
    name: "75, appartement occupé, travaux lourds : aucun prix ne tient",
    sale: tribunalSale({
      ...apartment75,
      starting_price_eur: 150_000,
      occupancy_status: "occupied",
    }),
    estimate: estimateFor(180_000, 45),
    choices: { project: "revendre", works: { key: "devis", amount: 160_000 } },
    expected: { maxBid: 0, budget: 144000, acquisitionFeesTotal: 6500, binding: "valeur" },
  },
];

/** Résultats de la version « 2026-10-26.1 » (droits calculés sur prix + frais préalables), par cas. */
const PREVIOUS_EXPECTED: Record<string, { maxBid: number; acquisitionFeesTotal: number }> = {
  "33, appartement libre, frais préalables lus, habiter": {
    maxBid: 176500,
    acquisitionFeesTotal: 21419,
  },
  "33, appartement libre, frais préalables par défaut, habiter": {
    maxBid: 175500,
    acquisitionFeesTotal: 22135,
  },
  "33, appartement occupé, frais préalables par défaut, louer": {
    maxBid: 132500,
    acquisitionFeesTotal: 18602,
  },
  "33, appartement loué, frais préalables lus, revendre": {
    maxBid: 100000,
    acquisitionFeesTotal: 15134,
  },
  "36, maison libre, frais préalables lus, revendre avec travaux": {
    maxBid: 50500,
    acquisitionFeesTotal: 10337,
  },
  "36, maison occupée, frais préalables par défaut, habiter": {
    maxBid: 85500,
    acquisitionFeesTotal: 13628,
  },
  "36, maison louée, frais préalables par défaut, habiter, estimation fragile": {
    maxBid: 80500,
    acquisitionFeesTotal: 13278,
  },
  "36, maison libre, frais préalables par défaut, louer": {
    maxBid: 88000,
    acquisitionFeesTotal: 13802,
  },
  "75, appartement libre, frais préalables lus, habiter": {
    maxBid: 342500,
    acquisitionFeesTotal: 35059,
  },
  "75, appartement occupé, frais préalables par défaut, revendre": {
    maxBid: 300000,
    acquisitionFeesTotal: 32365,
  },
  "75, appartement loué, frais préalables lus, louer": {
    maxBid: 245500,
    acquisitionFeesTotal: 27089,
  },
  "75, appartement libre, mise à prix proche de la valeur, habiter": {
    maxBid: 342000,
    acquisitionFeesTotal: 35816,
  },
  "75, appartement occupé, travaux lourds : aucun prix ne tient": {
    maxBid: 0,
    acquisitionFeesTotal: 6821,
  },
};

describe("computeCeilingPlan on representative tribunal sales (characterization)", () => {
  it.each(cases)("$name", ({ sale, estimate, choices, expected }) => {
    const plan = computeCeilingPlan(buildCeilingHypotheses(sale, estimate, choices));

    const actual = {
      maxBid: plan.maxBid,
      budget: plan.budget,
      acquisitionFeesTotal: Math.round(plan.feesAtMaxBid.acquisitionFeesTotal),
      binding: plan.binding,
    };
    expect(actual).toEqual(expected);
  });

  // Ce que la version « 2026-10-26.2 » change, et seulement cela : à mise égale, les frais baissent
  // des droits et de la CSI que les frais préalables portaient (ils sortent de la base, BOFiP § 50).
  it.each(cases.filter((item) => PREVIOUS_EXPECTED[item.name]?.maxBid === item.expected.maxBid))(
    "$name : à mise égale, les frais baissent de frais préalables × (droits + CSI)",
    ({ name, sale, estimate, choices, expected }) => {
      const fees = buildCeilingHypotheses(sale, estimate, choices).fees;
      const drop = PREVIOUS_EXPECTED[name].acquisitionFeesTotal - expected.acquisitionFeesTotal;
      expect(drop).toBeGreaterThan(0);
      expect(
        Math.abs(drop - fees.fpt * ((fees.registrationRate ?? 0) + CSI_RATE)),
      ).toBeLessThanOrEqual(1);
    },
  );

  it("garde le budget et le mode limitant des résultats d'avant (seuls les frais et le pas d'enchère bougent)", () => {
    for (const item of cases) {
      const previous = PREVIOUS_EXPECTED[item.name];
      expect(previous, item.name).toBeDefined();
      // Le plafond ne bouge que d'un pas d'enchère (500 €), vers le haut : les frais baissent.
      expect(item.expected.maxBid - previous.maxBid).toBeGreaterThanOrEqual(0);
      expect(item.expected.maxBid - previous.maxBid).toBeLessThanOrEqual(500);
    }
  });
});

// Cas recalculés À LA MAIN, sans passer par le moteur de frais : les chiffres du tableau ci-dessus
// viennent du moteur, ceux-ci viennent d'une arithmétique écrite en commentaire (barème de l'avocat
// poursuivant : 7,256 % jusqu'à 6 500 €, 2,993 % jusqu'à 17 000 €, 1,995 % jusqu'à 60 000 €, 1,497 %
// au-delà, HT ; TVA 20 % ; droits de mutation 6,32 % du prix ; CSI 0,10 % du prix ; honoraires de
// l'avocat enchérisseur 1 500 € ; frais préalables lus dans l'annonce : 4 250 €).
describe("computeCeilingPlan : frais recalculés à la main", () => {
  const byName = (name: string) => {
    const found = cases.find((item) => item.name === name);
    if (!found) throw new Error(name);
    return found;
  };
  const plan = (name: string) => {
    const { sale, estimate, choices } = byName(name);
    return computeCeilingPlan(buildCeilingHypotheses(sale, estimate, choices));
  };

  it("33, appartement libre, mise de 176 500 €", () => {
    // Émoluments HT : 6 500 × 7,256 % = 471,64 ; 10 500 × 2,993 % = 314,265 ; 43 000 × 1,995 % =
    // 857,85 ; 116 500 × 1,497 % = 1 744,005 ; soit 3 387,76 HT et 4 065,312 TTC.
    // Droits : 176 500 × 6,32 % = 11 154,80. CSI : 176,50.
    // Frais : 4 065,312 + 11 154,80 + 176,50 + 1 500 + 4 250 = 21 146,612.
    const result = plan("33, appartement libre, frais préalables lus, habiter");
    expect(result.maxBid).toBe(176_500);
    expect(result.feesAtMaxBid.acquisitionFeesTotal).toBeCloseTo(21_146.612, 2);
    // Budget de 198 000 € : 176 500 + 21 146,61 = 197 646,61 y tient.
    expect(result.budget).toBe(198_000);
    expect(176_500 + 21_146.612).toBeLessThanOrEqual(198_000);
    // Le pas suivant (177 000 €) ajoute 500 × 1,497 % × 1,2 = 8,982 d'émoluments, 31,60 de droits et
    // 0,50 de CSI : 177 000 + 21 187,694 = 198 187,694 > 198 000, il ne tient pas.
    expect(177_000 + 21_146.612 + 8.982 + 31.6 + 0.5).toBeGreaterThan(198_000);
  });

  it("75, appartement libre, mise de 343 000 €", () => {
    // Émoluments HT : 471,64 + 314,265 + 857,85 = 1 643,755 pour les 60 000 premiers euros, puis
    // 283 000 × 1,497 % = 4 236,51 ; soit 5 880,265 HT et 7 056,318 TTC.
    // Droits : 343 000 × 6,32 % = 21 677,60. CSI : 343.
    // Frais : 7 056,318 + 21 677,60 + 343 + 1 500 + 4 250 = 34 826,918.
    const result = plan("75, appartement libre, frais préalables lus, habiter");
    expect(result.maxBid).toBe(343_000);
    expect(result.feesAtMaxBid.acquisitionFeesTotal).toBeCloseTo(34_826.918, 2);
    // Budget de 378 000 € : 343 000 + 34 826,92 = 377 826,92 y tient ; le pas suivant ajoute 8,982 +
    // 31,60 + 0,50 de frais, soit 343 500 + 34 868,00 = 378 368,00 > 378 000.
    expect(result.budget).toBe(378_000);
    expect(343_000 + 34_826.918).toBeLessThanOrEqual(378_000);
    expect(343_500 + 34_826.918 + 8.982 + 31.6 + 0.5).toBeGreaterThan(378_000);
  });

  it("aucun prix ne tient quand les travaux dépassent le budget", () => {
    // Budget de 144 000 € (valeur 180 000 €, marge comprise) moins 160 000 € de travaux : négatif.
    // Même une mise nulle coûte 1 500 (avocat) + 5 000 (frais préalables par défaut) = 6 500 €, sans
    // émoluments ni droits puisque le prix est nul : rien ne tient.
    const result = plan("75, appartement occupé, travaux lourds : aucun prix ne tient");
    expect(result.maxBid).toBe(0);
    expect(result.budget - 160_000).toBeLessThan(0);
    expect(result.feesAtMaxBid.acquisitionFeesTotal).toBeCloseTo(6_500, 6);
  });
});

// Empreinte de la table ci-dessus (ventes, hypothèses et résultats figés), enregistrée par version du
// moteur. Elle n'est pas recalculée depuis le moteur : changer un résultat figé sans changer
// CEILING_ENGINE_VERSION fait échouer le test de garde.
const FINGERPRINTS_BY_ENGINE_VERSION: Record<string, string> = {
  // Table d'avant le lot A2 (droits sur prix + frais préalables) : gardée, jamais recalculée.
  "2026-10-26.1": "ef301937dabe1dc0",
  "2026-10-26.2": "486a42258e49b43b",
};

function fingerprint(): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 16);
}

describe("garde de version du moteur", () => {
  it("enregistre les résultats figés sous la version courante du moteur", () => {
    expect(
      fingerprint(),
      `Les résultats figés de ce fichier ne correspondent pas à l'empreinte enregistrée pour ` +
        `CEILING_ENGINE_VERSION="${CEILING_ENGINE_VERSION}". Si ce résultat change volontairement, ` +
        `incrémentez CEILING_ENGINE_VERSION et mettez à jour ce test : ajoutez une entrée ` +
        `"<nouvelle version>": "<empreinte>" à FINGERPRINTS_BY_ENGINE_VERSION (sans modifier celle ` +
        `d'une version déjà publiée).`,
    ).toBe(FINGERPRINTS_BY_ENGINE_VERSION[CEILING_ENGINE_VERSION]);
  });
});
