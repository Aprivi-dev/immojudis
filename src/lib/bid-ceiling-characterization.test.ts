// Filet de non-régression du plafond : chaque résultat ci-dessous a été calculé avec le moteur
// AVANT toute évolution du lot 0 puis écrit en dur. Si un résultat change volontairement,
// incrémentez CEILING_ENGINE_VERSION et mettez à jour ce test.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { CEILING_ENGINE_VERSION, computeCeilingPlan } from "@/lib/bid-ceiling-engine";
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
    expected: { maxBid: 176500, budget: 198000, acquisitionFeesTotal: 21419, binding: "valeur" },
  },
  {
    name: "33, appartement libre, frais préalables par défaut, habiter",
    sale: tribunalSale({ ...apartment33, starting_price_eur: 60_000, occupancy_status: "vacant" }),
    estimate: estimateFor(220_000, 62),
    choices: {},
    expected: { maxBid: 175500, budget: 198000, acquisitionFeesTotal: 22135, binding: "valeur" },
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
    expected: { maxBid: 132500, budget: 163062, acquisitionFeesTotal: 18602, binding: "rendement" },
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
    expected: { maxBid: 100000, budget: 154000, acquisitionFeesTotal: 15134, binding: "valeur" },
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
    expected: { maxBid: 50500, budget: 100800, acquisitionFeesTotal: 10337, binding: "valeur" },
  },
  {
    name: "36, maison occupée, frais préalables par défaut, habiter",
    sale: tribunalSale({ ...house36, starting_price_eur: 25_000, occupancy_status: "occupied" }),
    estimate: estimateFor(120_000, 110, "correcte", 12),
    choices: {},
    expected: { maxBid: 85500, budget: 108000, acquisitionFeesTotal: 13628, binding: "valeur" },
  },
  {
    name: "36, maison louée, frais préalables par défaut, habiter, estimation fragile",
    sale: tribunalSale({ ...house36, starting_price_eur: 25_000, occupancy_status: "rented" }),
    estimate: estimateFor(120_000, 110, "fragile", 5),
    choices: {},
    expected: { maxBid: 80500, budget: 93960, acquisitionFeesTotal: 13278, binding: "valeur" },
  },
  {
    name: "36, maison libre, frais préalables par défaut, louer",
    sale: tribunalSale({ ...house36, starting_price_eur: 25_000, occupancy_status: "vacant" }),
    estimate: estimateFor(120_000, 110, "correcte", 12),
    choices: { project: "louer", profile: "prudent" },
    expected: { maxBid: 88000, budget: 102000, acquisitionFeesTotal: 13802, binding: "valeur" },
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
    expected: { maxBid: 342500, budget: 378000, acquisitionFeesTotal: 35059, binding: "valeur" },
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
    expected: { maxBid: 300000, budget: 357000, acquisitionFeesTotal: 32365, binding: "valeur" },
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
    expected: { maxBid: 245500, budget: 272888, acquisitionFeesTotal: 27089, binding: "rendement" },
  },
  {
    name: "75, appartement libre, mise à prix proche de la valeur, habiter",
    sale: tribunalSale({ ...apartment75, starting_price_eur: 330_000, occupancy_status: "vacant" }),
    estimate: estimateFor(420_000, 45),
    choices: {},
    expected: { maxBid: 342000, budget: 378000, acquisitionFeesTotal: 35816, binding: "valeur" },
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
    expected: { maxBid: 0, budget: 144000, acquisitionFeesTotal: 6821, binding: "valeur" },
  },
];

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
});

// Empreinte de la table ci-dessus (ventes, hypothèses et résultats figés), enregistrée par version du
// moteur. Elle n'est pas recalculée depuis le moteur : changer un résultat figé sans changer
// CEILING_ENGINE_VERSION fait échouer le test de garde.
const FINGERPRINTS_BY_ENGINE_VERSION: Record<string, string> = {
  "2026-10-26.1": "ef301937dabe1dc0",
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
