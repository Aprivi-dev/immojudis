import { describe, expect, it } from "vitest";
import { findConsignation } from "@/lib/auction-cost-analysis";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import {
  buildCashPlan,
  ceilingConfidence,
  computeCeilingPlan,
  consignationAmount,
  estimatedFeeItems,
  evaluateBid,
  feeSensitivity,
  type CeilingHypotheses,
} from "@/lib/bid-ceiling-engine";
import {
  FEE_REGIMES,
  NOTARY_AUCTION_EMOLUMENT_BRACKETS,
  NOTARY_AUCTION_FEE_REGIME,
  NOTARY_EMOLUMENT_SCALE_DATE,
  NOTARY_EMOLUMENT_SCALE_REFERENCE,
  NOTARY_ONLINE_EMOLUMENT_BRACKETS,
  NOTARY_ONLINE_FEE_REGIME,
  TRIBUNAL_FEE_REGIME,
  labelsOf,
} from "@/lib/fee-regime";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import { notarySaleMode, readNotarySaleConditions } from "@/lib/notary-sale-conditions";
import {
  computeAcquisitionCosts,
  computeEmolumentsHT,
  CSI_RATE,
  TRIBUNAL_EMOLUMENT_BRACKETS,
} from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

function sale(overrides: Record<string, unknown> = {}): AuctionSale {
  return {
    id: "sale-notary",
    sale_venue_type: "notary",
    sale_legal_framework: "voluntary_notarial",
    department: "33",
    property_type: "apartment",
    app_surface_m2: 62,
    app_surface_kind: "habitable",
    starting_price_eur: 60_000,
    occupancy_status: "vacant",
    description: "Appartement libre.",
    ...overrides,
  } as unknown as AuctionSale;
}

const estimate = {
  source: "DVF normalisé",
  sourceUpdatedAt: null,
  subjectSurfaceEstimated: false,
  estimatedValueEur: 220_000,
  actionable: true,
  qualityLabel: "forte",
  sampleSize: 25,
  effectiveSampleSize: 25,
  medianPricePerM2: 3_548,
  p75PricePerM2: 4_080,
} as unknown as CeilingMarketEstimate;

const ONLINE = {
  procedure: "online_tender",
  first_offer_eur: 50_000,
  negotiation_fee_rate: 0.045,
  negotiation_fee_payer: "ACQUEREUR",
  advertising_fees_eur: 1_200,
};
const AUCTION = { procedure: "notarial_auction", deposit_eur: 12_000, overbid_allowed: true };

function hypothesesOf(
  conditions: Record<string, unknown> | null,
  regime = conditions?.procedure === "online_tender"
    ? NOTARY_ONLINE_FEE_REGIME
    : NOTARY_AUCTION_FEE_REGIME,
  choices: CeilingUserChoices = {},
  overrides: Record<string, unknown> = {},
): CeilingHypotheses {
  return buildCeilingHypotheses(
    sale({ sale_conditions: conditions, ...overrides }),
    estimate,
    choices,
    regime,
  );
}

describe("barèmes d'émoluments du notaire", () => {
  it("reprennent les taux de la recherche du 26/10, avec les seuils de tranche du barème du tribunal", () => {
    expect(NOTARY_AUCTION_EMOLUMENT_BRACKETS.map((bracket) => bracket.rate)).toEqual([
      0.0774, 0.03192, 0.02129, 0.01597,
    ]);
    expect(NOTARY_ONLINE_EMOLUMENT_BRACKETS.map((bracket) => bracket.rate)).toEqual([
      0.0387, 0.01596, 0.01064, 0.00799,
    ]);
    const thresholds = (brackets: readonly { upTo: number }[]) =>
      brackets.map((bracket) => bracket.upTo);
    expect(thresholds(NOTARY_AUCTION_EMOLUMENT_BRACKETS)).toEqual(
      thresholds(TRIBUNAL_EMOLUMENT_BRACKETS),
    );
    expect(thresholds(NOTARY_ONLINE_EMOLUMENT_BRACKETS)).toEqual(
      thresholds(TRIBUNAL_EMOLUMENT_BRACKETS),
    );
  });

  it("sont déclarés avec une date de relevé et une référence « à confirmer sur Légifrance »", () => {
    for (const regime of [NOTARY_AUCTION_FEE_REGIME, NOTARY_ONLINE_FEE_REGIME]) {
      expect(regime.emolumentScale.date).toBe(NOTARY_EMOLUMENT_SCALE_DATE);
      expect(regime.emolumentScale.reference).toBe(NOTARY_EMOLUMENT_SCALE_REFERENCE);
    }
    expect(NOTARY_EMOLUMENT_SCALE_DATE).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(NOTARY_EMOLUMENT_SCALE_REFERENCE).toMatch(/25\/02\/2026/);
  });

  it("applique chaque barème tranche par tranche (100 000 €)", () => {
    // 6 500 × 7,74 % + 10 500 × 3,192 % + 43 000 × 2,129 % + 40 000 × 1,597 %
    expect(computeEmolumentsHT(100_000, NOTARY_AUCTION_EMOLUMENT_BRACKETS)).toBeCloseTo(
      503.1 + 335.16 + 915.47 + 638.8,
      2,
    );
    // 6 500 × 3,87 % + 10 500 × 1,596 % + 43 000 × 1,064 % + 40 000 × 0,799 %
    expect(computeEmolumentsHT(100_000, NOTARY_ONLINE_EMOLUMENT_BRACKETS)).toBeCloseTo(
      251.55 + 167.58 + 457.52 + 319.6,
      2,
    );
  });
});

describe("frais d'une vente à la bougie", () => {
  it("compte les frais d'organisation et de publicité (2 % HT, TVA en sus) dans la base des droits", () => {
    const costs = computeAcquisitionCosts({
      price: 100_000,
      fpt: 0,
      lawyerFees: 0,
      department: "33",
      emolumentBrackets: NOTARY_AUCTION_EMOLUMENT_BRACKETS,
      organizationFeeRate: 0.02,
    });
    expect(costs.organizationFees).toBeCloseTo(2_400, 6);
    const base = 100_000 + 2_400;
    expect(costs.registrationDuties).toBeCloseTo(base * 0.0632, 6);
    expect(costs.csi).toBeCloseTo(base * CSI_RATE, 6);
    expect(costs.acquisitionFeesTotal).toBeCloseTo(
      costs.emolumentsTTC + costs.registrationDuties + costs.csi + 2_400,
      6,
    );
    expect(costs.negotiationFees).toBe(0);
    expect(costs.advertisingFees).toBe(0);
  });

  it("n'a ni avocat ni frais préalables, même quand le texte ou un ancien choix en parle", () => {
    const hypotheses = hypothesesOf(
      AUCTION,
      NOTARY_AUCTION_FEE_REGIME,
      { fpt: 9_000, lawyerFees: 2_000 },
      { description: "Les frais préalables s’élèvent à 4 250 € TTC." },
    );
    expect(hypotheses.fees.fpt).toBe(0);
    expect(hypotheses.fees.lawyerFees).toBe(0);
    expect(hypotheses.fees.organizationFeeRate).toBe(0.02);
    expect(hypotheses.fees.emolumentBrackets).toBe(NOTARY_AUCTION_EMOLUMENT_BRACKETS);
    const fees = computeCeilingPlan(hypotheses).feesAtMaxBid;
    expect(fees.fpt).toBe(0);
    expect(fees.lawyerFees).toBe(0);
    expect(fees.organizationFees).toBeGreaterThan(0);
  });

  it("lit la garantie dans l'annonce ; à défaut 20 % de la mise à prix, signalée par défaut", () => {
    const read = hypothesesOf(AUCTION);
    expect(read.consignation).toBe(12_000);
    expect(read.feesSource.consignation).toBe("document");
    expect(consignationAmount(read, NOTARY_AUCTION_FEE_REGIME.consignation)).toBe(12_000);

    const missing = hypothesesOf({ procedure: "notarial_auction" });
    expect(missing.consignation).toBeNull();
    expect(missing.feesSource.consignation).toBe("defaut");
    expect(consignationAmount(missing, NOTARY_AUCTION_FEE_REGIME.consignation)).toBe(12_000);

    const entered = hypothesesOf({ procedure: "notarial_auction" }, undefined, {
      consignation: 7_500,
    });
    expect(entered.feesSource.consignation).toBe("saisie");
    expect(entered.consignation).toBe(7_500);
  });

  it("n'affiche la surenchère que si l'annonce la prévoit (10 %, 10 jours)", () => {
    const withOverbid = hypothesesOf(AUCTION);
    const plan = computeCeilingPlan(withOverbid);
    const steps = buildCashPlan(withOverbid, plan, plan.maxBid);
    expect(steps.map((step) => step.label)).toEqual([
      "Garantie à déposer",
      "Fin du délai de surenchère",
      "Solde du prix, droits et frais",
    ]);
    const overbid = steps.find((step) => step.label === "Fin du délai de surenchère");
    expect(overbid?.when).toBe("10 jours après");
    expect(overbid?.detail).toMatch(/10 %.*10 jours/);
    for (const conditions of [
      { procedure: "notarial_auction", overbid_allowed: false },
      { procedure: "notarial_auction" },
    ]) {
      const without = hypothesesOf(conditions);
      const labels = buildCashPlan(without, computeCeilingPlan(without), 100_000).map(
        (step) => step.label,
      );
      expect(labels).not.toContain("Fin du délai de surenchère");
      expect(labels).not.toContain("Honoraires de votre avocat");
    }
  });

  it("calcule le solde du prix sous 45 jours avec les frais d'organisation", () => {
    const hypotheses = hypothesesOf(AUCTION);
    const steps = buildCashPlan(hypotheses, computeCeilingPlan(hypotheses), 100_000);
    const balance = steps.find((step) => step.label === "Solde du prix, droits et frais")!;
    const fees = evaluateBid(hypotheses, computeCeilingPlan(hypotheses), 100_000).fees;
    expect(balance.when).toBe("Sous 45 jours");
    expect(balance.amount).toBe(
      Math.round(
        100_000 -
          12_000 +
          fees.registrationDuties +
          fees.csi +
          fees.emolumentsTTC +
          fees.organizationFees,
      ),
    );
    expect(balance.detail).toMatch(/hors débours et formalités du notaire/i);
  });
});

describe("frais d'une vente notariale interactive", () => {
  it("prend la première offre possible pour prix de référence", () => {
    const hypotheses = hypothesesOf(ONLINE);
    expect(hypotheses.startingPrice).toBe(50_000);
    expect(hypotheses.consignation).toBeNull();
    // Sans première offre lue, le montant publié comme prix de départ la remplace.
    expect(hypothesesOf({ procedure: "online_tender" }).startingPrice).toBe(60_000);
  });

  it("compte les honoraires de négociation à la charge de l'acquéreur, hors base des droits", () => {
    const hypotheses = hypothesesOf(ONLINE);
    expect(hypotheses.fees.negotiationFeeRate).toBe(0.045);
    expect(hypotheses.fees.advertisingFees).toBe(1_200);
    expect(hypotheses.feesSource).toMatchObject({
      negotiation: "document",
      advertising: "document",
    });

    const costs = computeAcquisitionCosts({
      price: 100_000,
      fpt: 0,
      lawyerFees: 0,
      department: "33",
      emolumentBrackets: NOTARY_ONLINE_EMOLUMENT_BRACKETS,
      negotiationFeeRate: 0.045,
      advertisingFees: 1_200,
    });
    expect(costs.negotiationFees).toBeCloseTo(4_500, 6);
    expect(costs.advertisingFees).toBe(1_200);
    // Honoraires de négociation hors base ; frais de publicité dans la base (par prudence).
    expect(costs.registrationDuties).toBeCloseTo((100_000 + 1_200) * 0.0632, 6);
    expect(costs.csi).toBeCloseTo((100_000 + 1_200) * CSI_RATE, 6);
    expect(costs.acquisitionFeesTotal).toBeCloseTo(
      costs.emolumentsTTC + costs.registrationDuties + costs.csi + 4_500 + 1_200,
      6,
    );
  });

  it("ne compte rien quand le vendeur paie les honoraires de négociation", () => {
    const hypotheses = hypothesesOf({ ...ONLINE, negotiation_fee_payer: "VENDEUR" });
    expect(hypotheses.fees.negotiationFeeRate).toBe(0);
    expect(hypotheses.feesSource.negotiation).toBe("document");
    expect(estimatedFeeItems(hypotheses)).toEqual([]);
  });

  it("ne devine pas un montant manquant : à confirmer dans les conditions de la vente", () => {
    // Redevable inconnu, taux lu : par prudence l'acquéreur paie, le poste est estimé.
    const unknownPayer = hypothesesOf({ ...ONLINE, negotiation_fee_payer: undefined });
    expect(unknownPayer.fees.negotiationFeeRate).toBe(0.045);
    expect(unknownPayer.feesSource.negotiation).toBe("defaut");
    expect(estimatedFeeItems(unknownPayer)).toEqual([
      { key: "negotiation", label: "Honoraires de négociation", amount: 2_250 },
    ]);
    // Taux absent : rien n'est compté, le poste est estimé sans montant.
    const noRate = hypothesesOf({ ...ONLINE, negotiation_fee_rate: undefined });
    expect(noRate.fees.negotiationFeeRate).toBe(0);
    expect(noRate.feesSource.negotiation).toBe("defaut");
    expect(estimatedFeeItems(noRate)).toEqual([
      { key: "negotiation", label: "Honoraires de négociation", amount: null },
    ]);
    // Frais de publicité absents : 0 €, pas assez important pour être signalé.
    const noAdvertising = hypothesesOf({ ...ONLINE, advertising_fees_eur: undefined });
    expect(noAdvertising.fees.advertisingFees).toBe(0);
    expect(noAdvertising.feesSource.advertising).toBe("defaut");
    expect(estimatedFeeItems(noAdvertising)).toEqual([]);
  });

  it("remplace la valeur lue ou par défaut par la saisie de l'utilisateur (source saisie)", () => {
    const hypotheses = hypothesesOf({ ...ONLINE, negotiation_fee_rate: undefined }, undefined, {
      negotiationFeeRatePct: 3.5,
      advertisingFees: 900,
    });
    expect(hypotheses.fees.negotiationFeeRate).toBeCloseTo(0.035, 10);
    expect(hypotheses.fees.advertisingFees).toBe(900);
    expect(hypotheses.feesSource).toMatchObject({ negotiation: "saisie", advertising: "saisie" });
    expect(estimatedFeeItems(hypotheses)).toEqual([]);
    // Une saisie à 0 : l'utilisateur dit qu'il n'y a pas de honoraires.
    const zero = hypothesesOf(ONLINE, undefined, { negotiationFeeRatePct: 0 });
    expect(zero.fees.negotiationFeeRate).toBe(0);
    expect(zero.feesSource.negotiation).toBe("saisie");
  });

  it("ne lit aucune garantie dans le texte de l'annonce, ni dans une saisie, quand le régime n'en a pas", () => {
    const text = { description: "Appartement libre. Garantie de 3 000 € à la visite." };
    // The parasitic amount is a deposit for a sale by auction, and nothing for a sale by offers.
    expect(findConsignation(sale(text))?.amountEur).toBe(3_000);
    const auctionWithoutDeposit = { procedure: "notarial_auction" };
    expect(
      hypothesesOf(auctionWithoutDeposit, NOTARY_AUCTION_FEE_REGIME, {}, text).consignation,
    ).toBe(3_000);

    const online = hypothesesOf(ONLINE, NOTARY_ONLINE_FEE_REGIME, {}, text);
    expect(online.consignation).toBeNull();
    const entered = hypothesesOf(ONLINE, NOTARY_ONLINE_FEE_REGIME, { consignation: 8_000 }, text);
    expect(entered.consignation).toBeNull();
    const plan = computeCeilingPlan(online);
    expect(buildCashPlan(online, plan, plan.maxBid).map((step) => step.label)).not.toContain(
      "Garantie à déposer",
    );
  });

  it("n'a ni garantie, ni surenchère, ni avocat, ni frais préalables dans le calendrier", () => {
    const hypotheses = hypothesesOf(ONLINE);
    const plan = computeCeilingPlan(hypotheses);
    const steps = buildCashPlan(hypotheses, plan, plan.maxBid);
    expect(steps.map((step) => step.label)).toEqual([
      "Offre",
      "Avant-contrat",
      "Prix, droits et frais",
    ]);
    // Nothing in the listing says no deposit is due: the text only says none is mentioned.
    expect(steps[0].detail).toContain("Aucune garantie indiquée dans l’annonce.");
    expect(steps[0].detail).not.toContain("à déposer");
    const balance = steps.at(-1)!;
    const fees = evaluateBid(hypotheses, plan, plan.maxBid).fees;
    expect(balance.amount).toBe(
      Math.round(
        plan.maxBid +
          fees.registrationDuties +
          fees.csi +
          fees.emolumentsTTC +
          fees.negotiationFees +
          fees.advertisingFees,
      ),
    );
  });
});

describe("vocabulaire d'une vente par offres", () => {
  const SEARCHED = /ench[èe]re|adjudic/i;

  function strings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (typeof value === "function")
      return strings((value as (amount: string) => string)("120 000 €"));
    if (value && typeof value === "object") return Object.values(value).flatMap(strings);
    return [];
  }

  it("n'écrit ni « enchère » ni « adjudication » dans aucun texte du régime interactif", () => {
    const labels = NOTARY_ONLINE_FEE_REGIME.labels;
    expect(strings(labels).filter((text) => SEARCHED.test(text))).toEqual([]);
    expect(labels.ceilingTerm).toBe("offre plafond");
    expect(labels.ceilingSimulationLabel).toBe("Offre plafond (simulation)");
    expect(labels.referencePriceTerm).toBe("première offre possible");
    expect(labels.byOffers).toBe(true);
  });

  it("n'écrit ni « enchère » ni « adjudication » dans une étape du calcul ni du calendrier", () => {
    for (const occupation of ["libre", "occupe", "loue", "squat", "inconnu"] as const) {
      for (const project of ["habiter", "louer", "revendre"] as const) {
        const hypotheses = hypothesesOf(ONLINE, undefined, {
          occupation,
          project,
          works: { key: "confort", amount: 20_000 },
        });
        const plan = computeCeilingPlan(hypotheses);
        expect(plan.available, `${occupation}/${project}`).toBe(true);
        const steps = [
          ...plan.steps.flatMap((step) => [step.label, step.detail]),
          ...buildCashPlan(hypotheses, plan, 80_000).flatMap((step) => [
            step.when,
            step.label,
            step.detail,
          ]),
        ];
        expect(
          steps.filter((text) => SEARCHED.test(text)),
          `${occupation}/${project}`,
        ).toEqual([]);
      }
    }
  });

  it("porte la mention obligatoire : le vendeur n'est pas tenu de retenir la meilleure offre", () => {
    const labels = labelsOf(hypothesesOf(ONLINE));
    expect(labels.planner.reserveNotice).toBe(
      "Le vendeur n’est pas tenu de retenir la meilleure offre ; prix de réserve inconnu.",
    );
    const plan = computeCeilingPlan(hypothesesOf(ONLINE));
    expect(plan.steps.at(-1)?.detail).toContain(labels.planner.reserveNotice);
  });

  it("dit « hors débours et formalités du notaire » pour les deux régimes, et pas pour le tribunal", () => {
    for (const conditions of [ONLINE, AUCTION]) {
      const hypotheses = hypothesesOf(conditions);
      expect(labelsOf(hypotheses).planner.scopeNote).toBe("Hors débours et formalités du notaire.");
      expect(
        computeCeilingPlan(hypotheses).steps.find((step) => step.key === "fees")?.detail,
      ).toMatch(/Hors débours et formalités du notaire/);
    }
    expect(TRIBUNAL_FEE_REGIME.labels.planner.scopeNote).toBeUndefined();
  });

  it("ne dit pas que le jugement d'adjudication vaut titre d'expulsion pour une vente notariale", () => {
    for (const conditions of [ONLINE, AUCTION]) {
      const hypotheses = hypothesesOf(conditions, undefined, { occupation: "occupe" });
      const release = computeCeilingPlan(hypotheses).steps.find((step) => step.key === "release")!;
      expect(release.detail).toMatch(/délai et coût à confirmer/);
      expect(release.detail).toMatch(
        /hors vente judiciaire, il n’y a pas de titre d’expulsion automatique/,
      );
      expect(release.detail).not.toMatch(/jugement d’adjudication vaut titre d’expulsion/);
      // Le calendrier ne parle pas d'expulsion non plus : le délai et le coût sont à confirmer.
      const plan = computeCeilingPlan(hypotheses);
      const step = buildCashPlan(hypotheses, plan, plan.maxBid).find(
        (item) => item.label === "Libération du bien",
      );
      expect(step?.detail).toBe(
        `Libération du bien et frais annexes (délai et coût à confirmer), sur environ ${hypotheses.occupation.releaseMonths} mois.`,
      );
      expect(step?.detail).not.toMatch(/expulsion/);
    }
  });

  it("retire ce qui est propre au tribunal : avocat poursuivant, R322-41, surenchère de 10 jours, solde sous 2 mois", () => {
    for (const conditions of [ONLINE, { ...AUCTION, overbid_allowed: false }]) {
      const hypotheses = hypothesesOf(conditions);
      const plan = computeCeilingPlan(hypotheses);
      const text = [
        ...strings(labelsOf(hypotheses)),
        ...plan.steps.flatMap((step) => [step.label, step.detail]),
        ...buildCashPlan(hypotheses, plan, plan.maxBid).flatMap((step) => [
          step.label,
          step.detail,
        ]),
      ].join(" | ");
      expect(text).not.toMatch(/avocat poursuivant|R322-41|R\. ?322|sous 2 mois|deux mois/i);
      expect(text).not.toMatch(/surenchère de 10 jours/i);
    }
  });
});

describe("frais estimés, à confirmer", () => {
  it("signale les frais préalables par défaut au tribunal, pas ceux lus ni saisis", () => {
    const tribunal = (overrides: Record<string, unknown>, choices: CeilingUserChoices = {}) =>
      buildCeilingHypotheses(
        sale({ sale_venue_type: "tribunal", ...overrides }),
        estimate,
        choices,
        TRIBUNAL_FEE_REGIME,
      );
    expect(estimatedFeeItems(tribunal({}))).toEqual([
      { key: "fpt", label: "Frais préalables", amount: 5_000 },
    ]);
    expect(
      estimatedFeeItems(tribunal({ description: "Les frais préalables s’élèvent à 4 250 € TTC." })),
    ).toEqual([]);
    expect(estimatedFeeItems(tribunal({}, { fpt: 3_000 }))).toEqual([]);
  });

  it("signale la garantie par défaut d'une vente à la bougie, pas celle lue ni saisie", () => {
    expect(estimatedFeeItems(hypothesesOf({ procedure: "notarial_auction" }))).toEqual([
      { key: "consignation", label: "Garantie à déposer", amount: 12_000 },
    ]);
    expect(estimatedFeeItems(hypothesesOf(AUCTION))).toEqual([]);
    expect(
      estimatedFeeItems(
        hypothesesOf({ procedure: "notarial_auction" }, undefined, { consignation: 5_000 }),
      ),
    ).toEqual([]);
  });

  it("ne coiffe pas la fiabilité d'une vente à la bougie pour une garantie par défaut (elle ne change pas le coût)", () => {
    const hypotheses = hypothesesOf({ procedure: "notarial_auction" });
    const confidence = ceilingConfidence(hypotheses);
    expect(confidence.gaps).toContain("garantie à lire dans les conditions de la vente");
    expect(confidence.label).toBe("Solide");
  });

  it("empêche « Solide » quand un honoraire de négociation est estimé, et le dit", () => {
    const estimated = ceilingConfidence(
      hypothesesOf({ ...ONLINE, negotiation_fee_rate: undefined }),
    );
    expect(estimated.label).toBe("À consolider");
    expect(estimated.gaps).toContain(
      "honoraires de négociation à confirmer dans les conditions de la vente",
    );
    expect(ceilingConfidence(hypothesesOf(ONLINE)).label).toBe("Solide");
  });
});

describe("sensibilité aux frais", () => {
  it("donne ce que 1 000 € de frais de plus font perdre au plafond (autour de 1 000 €)", () => {
    for (const hypotheses of [
      hypothesesOf(ONLINE),
      hypothesesOf(AUCTION),
      buildCeilingHypotheses(
        sale({ sale_venue_type: "tribunal" }),
        estimate,
        {},
        TRIBUNAL_FEE_REGIME,
      ),
    ]) {
      const plan = computeCeilingPlan(hypotheses);
      const loss = feeSensitivity(hypotheses, plan);
      expect(loss).not.toBeNull();
      // Un euro de frais de plus retire un euro (un peu moins avec le coût de l'argent) au prix.
      expect(loss!).toBeGreaterThanOrEqual(850);
      expect(loss!).toBeLessThanOrEqual(1_000);
      expect(loss! % 50).toBe(0);
    }
  });

  it("n'en donne pas quand le plafond n'est pas chiffré ou ne tient pas", () => {
    const noValue = buildCeilingHypotheses(
      sale({ sale_conditions: ONLINE }),
      null,
      {},
      NOTARY_ONLINE_FEE_REGIME,
    );
    expect(feeSensitivity(noValue, computeCeilingPlan(noValue))).toBeNull();
    const heavy = hypothesesOf(ONLINE, undefined, { works: { key: "devis", amount: 400_000 } });
    expect(feeSensitivity(heavy, computeCeilingPlan(heavy))).toBeNull();
  });
});

describe("conditions d'une vente notariale", () => {
  it("lit la procédure, la nature du prix, les frais et la garantie ; ignore les valeurs invalides", () => {
    const read = readNotarySaleConditions(
      sale({
        sale_conditions: {
          ...ONLINE,
          negotiation_fee_payer: "acquereur",
          price_nature: "first_offer_possible",
          adjudication_type: "volontaire",
          origin: "adjudication",
        },
      }),
    );
    expect(read).toEqual({
      procedure: "online_tender",
      adjudicationType: "VOLONTAIRE",
      origin: "ADJUDICATION",
      priceNature: "first_offer_possible",
      firstOfferEur: 50_000,
      depositEur: null,
      advertisingFeesEur: 1_200,
      negotiationFeeRate: 0.045,
      negotiationFeePayer: "ACQUEREUR",
      overbidAllowed: null,
    });
    const invalid = readNotarySaleConditions(
      sale({
        sale_conditions: {
          procedure: "autre",
          first_offer_eur: -1,
          negotiation_fee_rate: 6_000,
          negotiation_fee_payer: "AUTRE",
          overbid_allowed: "oui",
        },
      }),
    );
    expect(invalid).toMatchObject({
      procedure: null,
      firstOfferEur: null,
      negotiationFeeRate: null,
      negotiationFeePayer: null,
      overbidAllowed: null,
    });
  });

  it("lit aussi la forme brute du pipeline (côté serveur) et la nature du prix de raw_payload", () => {
    const raw = readNotarySaleConditions(
      sale({
        raw_payload: {
          starting_price_nature: "first_offer_possible",
          source_property_features: { sale_conditions: { deposit_eur: 9_000 } },
        },
      }),
    );
    expect(raw?.depositEur).toBe(9_000);
    expect(raw?.priceNature).toBe("first_offer_possible");
    expect(notarySaleMode(raw)).toBe("online");
    expect(readNotarySaleConditions(sale())).toBeNull();
    expect(notarySaleMode(null)).toBeNull();
  });
});

describe("tables des régimes notariaux", () => {
  it("déclarent les deux régimes, sans domanial", () => {
    expect(Object.keys(FEE_REGIMES).sort()).toEqual([
      "notary_auction",
      "notary_online",
      "tribunal",
    ]);
    expect(NOTARY_AUCTION_FEE_REGIME.kind).toBe("notarial");
    expect(NOTARY_ONLINE_FEE_REGIME.kind).toBe("notarial");
    expect(NOTARY_AUCTION_FEE_REGIME.consignation).toMatchObject({ rate: 0.2, estimated: true });
    expect(NOTARY_ONLINE_FEE_REGIME.consignation).toBeNull();
    expect(NOTARY_AUCTION_FEE_REGIME.organizationFeeRate).toBe(0.02);
    expect(NOTARY_ONLINE_FEE_REGIME.buyerFeesFromListing).toBe(true);
  });
});

describe("garantie d'un compte qui a débloqué la vente et d'un compte Analyse (reporté du lot 0)", () => {
  // La vue des ventes débloquées ne sert ni raw_payload ni les blocs complets : sans la projection
  // `sale_conditions`, la garantie lue dans l'annonce (`deposit_eur`) lui manquait et la fiche affichait
  // 20 % de la mise à prix, quand le compte Analyse voyait le montant lu.
  const projection = { procedure: "notarial_auction", deposit_eur: 12_000, overbid_allowed: true };
  const unlockedView = sale({
    sale_conditions: projection,
    source_blocks: { consignation: 12_000 },
  });
  const analysisView = sale({ sale_conditions: projection });
  const withoutProjection = sale({ source_blocks: null });

  it("affichent la même garantie, la même source et le même calendrier", () => {
    const build = (item: AuctionSale) =>
      buildCeilingHypotheses(item, estimate, {}, NOTARY_AUCTION_FEE_REGIME);
    const unlocked = build(unlockedView);
    const analysis = build(analysisView);
    expect(unlocked.consignation).toBe(12_000);
    expect(analysis.consignation).toBe(12_000);
    expect(unlocked.feesSource.consignation).toBe("document");
    expect(analysis.feesSource.consignation).toBe("document");
    const cash = (hypotheses: CeilingHypotheses) =>
      buildCashPlan(hypotheses, computeCeilingPlan(hypotheses), 80_000);
    expect(cash(unlocked)).toEqual(cash(analysis));
    expect(cash(unlocked)[0]).toMatchObject({ label: "Garantie à déposer", amount: 12_000 });
  });

  it("sans la projection, la garantie retombe sur la valeur par défaut signalée : c'est ce que la migration corrige", () => {
    const hypotheses = buildCeilingHypotheses(
      withoutProjection,
      estimate,
      {},
      NOTARY_AUCTION_FEE_REGIME,
    );
    expect(hypotheses.consignation).toBeNull();
    expect(hypotheses.feesSource.consignation).toBe("defaut");
  });

  it("lit aussi la garantie d'un compte Analyse dans la projection quand les blocs de la source manquent", () => {
    expect(findConsignation(analysisView)).toMatchObject({ amountEur: 12_000 });
    expect(findConsignation(sale({ source_blocks: null }))).toBeNull();
  });
});
