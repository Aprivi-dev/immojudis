import { describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan } from "@/lib/bid-ceiling-engine";
import { NOTARY_AUCTION_FEE_REGIME, NOTARY_ONLINE_FEE_REGIME } from "@/lib/fee-regime-notary";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import { computeAcquisitionCosts } from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

/**
 * Plafond des ventes notariales : hypothèses (`buildCeilingHypotheses` avec les deux régimes notariaux)
 * et cas limites du moteur. Les frais sont recalculés à la main, sans passer par le moteur.
 */

function notarialSale(conditions: Record<string, unknown> | null, overrides = {}): AuctionSale {
  return {
    id: "sale-notarial",
    source_type: "notaires",
    department: "33",
    property_type: "apartment",
    occupancy_status: "vacant",
    app_surface_m2: 60,
    app_surface_kind: "habitable",
    starting_price_eur: 150_000,
    description: "Appartement. Garantie de 3 000 € à déposer.",
    ...(conditions ? { sale_conditions: conditions } : {}),
    ...overrides,
  } as unknown as AuctionSale;
}

function estimateFor(value: number, surface = 60): CeilingMarketEstimate {
  return {
    source: "DVF normalisé",
    sourceUpdatedAt: null,
    subjectSurfaceEstimated: false,
    estimatedValueEur: value,
    actionable: true,
    qualityLabel: "forte",
    sampleSize: 25,
    effectiveSampleSize: 25,
    medianPricePerM2: Math.round(value / surface),
    p75PricePerM2: Math.round((value / surface) * 1.15),
  } as unknown as CeilingMarketEstimate;
}

const ONLINE = {
  procedure: "online_tender",
  price_nature: "first_offer_possible",
  first_offer_eur: 120_000,
  negotiation_fee_rate: 0.05,
  negotiation_fee_payer: "ACQUEREUR",
  advertising_fees_eur: 1_200,
};
const AUCTION = {
  procedure: "notarial_auction",
  price_nature: "mise_a_prix",
  adjudication_type: "VOLONTAIRE",
  origin: "ADJUDICATION",
};

describe("buildCeilingHypotheses : vente interactive (notary_online)", () => {
  const hypotheses = (
    conditions: Record<string, unknown> | null,
    choices: CeilingUserChoices = {},
  ) =>
    buildCeilingHypotheses(
      notarialSale(conditions),
      estimateFor(220_000),
      choices,
      NOTARY_ONLINE_FEE_REGIME,
    );

  it("part de la première offre possible, sans frais préalables, avocat ni garantie", () => {
    const result = hypotheses(ONLINE);
    expect(result.regime?.key).toBe("notary_online");
    expect(result.startingPrice).toBe(120_000);
    expect(result.fees.fpt).toBe(0);
    expect(result.fees.lawyerFees).toBe(0);
    // Une vente par offres n'a pas de garantie, même si l'annonce cite « 3 000 € à déposer ».
    expect(result.consignation).toBeNull();
    expect(result.feesSource.fpt).toBe("document");
  });

  it("lit les honoraires de négociation et la publicité de l'annonce quand l'acquéreur paie", () => {
    const result = hypotheses(ONLINE);
    expect(result.fees.negotiationFeeRate).toBe(0.05);
    expect(result.fees.advertisingFees).toBe(1_200);
    expect(result.feesSource).toMatchObject({ negotiation: "document", advertising: "document" });
  });

  it("calcule les frais d'une offre de 200 000 € comme à la main", () => {
    // Émoluments HT (barème des offres) : 6 500 × 3,87 % = 251,55 ; 10 500 × 1,596 % = 167,58 ;
    // 43 000 × 1,064 % = 457,52 ; 140 000 × 0,799 % = 1 118,60 ; soit 1 995,25 HT, 2 394,30 TTC.
    // Droits (33 : 6,32 %) et CSI (0,10 %) sur le prix + la publicité (1 200) : 201 200 → 12 715,84 et
    // 201,20. Négociation à la charge de l'acquéreur : 5 % de 200 000 = 10 000 (hors base des droits).
    // Total : 2 394,30 + 12 715,84 + 201,20 + 10 000 + 1 200 = 26 511,34.
    const result = hypotheses(ONLINE);
    const costs = computeAcquisitionCosts({ price: 200_000, ...result.fees });
    expect(costs.emolumentsTTC).toBeCloseTo(2_394.3, 2);
    expect(costs.registrationDuties).toBeCloseTo(12_715.84, 2);
    expect(costs.csi).toBeCloseTo(201.2, 2);
    expect(costs.negotiationFees).toBeCloseTo(10_000, 6);
    expect(costs.acquisitionFeesTotal).toBeCloseTo(26_511.34, 2);
  });

  it("ne compte aucun honoraire de négociation quand le vendeur les paie", () => {
    const result = hypotheses({ ...ONLINE, negotiation_fee_payer: "VENDEUR" });
    expect(result.fees.negotiationFeeRate).toBe(0);
    expect(result.feesSource.negotiation).toBe("document");
  });

  it("compte pour « à confirmer » ce que l'annonce ne dit pas, sans inventer de taux", () => {
    const result = hypotheses({ procedure: "online_tender", first_offer_eur: 120_000 });
    expect(result.fees.negotiationFeeRate).toBe(0);
    expect(result.fees.advertisingFees).toBe(0);
    expect(result.feesSource).toMatchObject({ negotiation: "defaut", advertising: "defaut" });
  });

  it("préfère les frais saisis par la personne à ceux de l'annonce", () => {
    const result = hypotheses(ONLINE, { negotiationFeeRatePct: 3, advertisingFees: 500 });
    expect(result.fees.negotiationFeeRate).toBeCloseTo(0.03, 10);
    expect(result.fees.advertisingFees).toBe(500);
    expect(result.feesSource).toMatchObject({ negotiation: "saisie", advertising: "saisie" });
  });

  it("sans conditions lisibles (compte Découverte), repart du prix de la ligne et ne devine rien", () => {
    const result = hypotheses(null);
    expect(result.startingPrice).toBe(150_000);
    expect(result.fees.negotiationFeeRate).toBe(0);
  });
});

describe("buildCeilingHypotheses : vente à la bougie (notary_auction)", () => {
  const hypotheses = (choices: CeilingUserChoices = {}) =>
    buildCeilingHypotheses(
      notarialSale(AUCTION, { starting_price_eur: 80_000 }),
      estimateFor(220_000),
      choices,
      NOTARY_AUCTION_FEE_REGIME,
    );

  it("garde la mise à prix, compte les frais d'organisation et n'a ni frais préalables ni avocat", () => {
    const result = hypotheses();
    expect(result.regime?.key).toBe("notary_auction");
    expect(result.startingPrice).toBe(80_000);
    expect(result.fees.fpt).toBe(0);
    expect(result.fees.lawyerFees).toBe(0);
    expect(result.fees.organizationFeeRate).toBe(0.02);
  });

  it("calcule les frais d'un prix de 100 000 € comme à la main", () => {
    // Émoluments HT (barème de l'adjudication) : 503,10 + 335,16 + 915,47 + 638,80 = 2 392,53 ; TTC
    // 2 871,036. Organisation et publicité : 2 % × 100 000 × 1,2 = 2 400. Droits sur 102 400 (33 :
    // 6,32 %) : 6 471,68 ; CSI 0,10 % : 102,40.
    // Total : 2 871,036 + 2 400 + 6 471,68 + 102,40 = 11 845,116.
    const costs = computeAcquisitionCosts({ price: 100_000, ...hypotheses().fees });
    expect(costs.emolumentsTTC).toBeCloseTo(2_871.036, 2);
    expect(costs.organizationFees).toBeCloseTo(2_400, 6);
    expect(costs.registrationDuties).toBeCloseTo(6_471.68, 2);
    expect(costs.csi).toBeCloseTo(102.4, 2);
    expect(costs.acquisitionFeesTotal).toBeCloseTo(11_845.116, 2);
  });
});

describe("computeCeilingPlan : cas limites des deux régimes notariaux", () => {
  const regimes = [NOTARY_AUCTION_FEE_REGIME, NOTARY_ONLINE_FEE_REGIME];

  function plan(
    regime: (typeof regimes)[number],
    {
      price = 100_000,
      value = 220_000,
      choices = {},
    }: { price?: number | null; value?: number; choices?: CeilingUserChoices } = {},
  ) {
    const conditions = regime.key === "notary_online" ? ONLINE : AUCTION;
    const sale = notarialSale(conditions, { starting_price_eur: price });
    return computeCeilingPlan(buildCeilingHypotheses(sale, estimateFor(value), choices, regime));
  }

  /** Aucun nombre non fini (NaN, Infinity), un plafond entier, positif ou nul, au pas de 500 €. */
  function expectSound(result: ReturnType<typeof computeCeilingPlan>) {
    for (const [name, number] of [
      ["maxBid", result.maxBid],
      ["budget", result.budget],
      ["frais", result.feesAtMaxBid.acquisitionFeesTotal],
    ] as const) {
      expect(Number.isFinite(number), name).toBe(true);
    }
    expect(result.maxBid).toBeGreaterThanOrEqual(0);
    expect(result.maxBid % 500).toBe(0);
    expect(result.reachable).toBe(result.maxBid > 0);
  }

  it.each(regimes)("$key : une valeur nulle ne laisse aucun plafond", (regime) => {
    const result = plan(regime, { value: 0 });
    expectSound(result);
    expect(result.maxBid).toBe(0);
    expect(result.reachable).toBe(false);
  });

  it.each(regimes)("$key : un prix de départ nul ou absent ne casse pas le calcul", (regime) => {
    expectSound(plan(regime, { price: 0 }));
    expectSound(plan(regime, { price: null }));
  });

  it.each(regimes)("$key : une valeur d'un milliard reste un nombre fini", (regime) => {
    const result = plan(regime, { value: 1e9 });
    expectSound(result);
    expect(result.maxBid).toBeGreaterThan(0);
  });

  it.each(regimes)("$key : 10 millions de travaux rendent le plafond inatteignable", (regime) => {
    const result = plan(regime, { choices: { works: { key: "devis", amount: 10_000_000 } } });
    expectSound(result);
    expect(result.maxBid).toBe(0);
    expect(result.reachable).toBe(false);
  });

  it.each(regimes)("$key : une marge hors bornes est ramenée entre 0 et 50 %", (regime) => {
    const margin = (customMarginPct: number) => plan(regime, { choices: { customMarginPct } });
    // 100 % compte comme 50 %, -5 % comme 0 %, 1e9 comme 50 %.
    expect(margin(100).maxBid).toBe(margin(50).maxBid);
    expect(margin(1e9).maxBid).toBe(margin(50).maxBid);
    expect(margin(-5).maxBid).toBe(margin(0).maxBid);
    // Plus de marge, un plafond plus bas (ou égal).
    expect(margin(0).maxBid).toBeGreaterThanOrEqual(margin(20).maxBid);
    expect(margin(20).maxBid).toBeGreaterThanOrEqual(margin(50).maxBid);
    // Une marge illisible revient au profil par défaut, sans casser le calcul.
    const unreadable = margin(Number.NaN);
    expectSound(unreadable);
    expect(unreadable.maxBid).toBe(plan(regime).maxBid);
  });

  it("l'offre plafond d'une vente interactive tient compte des honoraires de négociation de l'annonce", () => {
    const withFees = plan(NOTARY_ONLINE_FEE_REGIME);
    const sale = notarialSale({ ...ONLINE, negotiation_fee_payer: "VENDEUR" });
    const sellerPays = computeCeilingPlan(
      buildCeilingHypotheses(sale, estimateFor(220_000), {}, NOTARY_ONLINE_FEE_REGIME),
    );
    // Moins de frais pour l'acquéreur : le même budget permet une offre au moins aussi haute.
    expect(sellerPays.maxBid).toBeGreaterThanOrEqual(withFees.maxBid);
  });
});
