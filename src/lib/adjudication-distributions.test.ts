import { describe, expect, it } from "vitest";
import {
  adjudicationDistributionSchema,
  adjudicationEnrichmentSchema,
  bidBands,
} from "./adjudication-distributions";

const fixture = () => ({
  sampleSize: 10,
  hammerPriceMiddle50Eur: { p25: 50000, p75: 150000 },
  ratioMiddle50: { p25: 1, p75: 2 },
  bidDistribution: bidBands.map((band) => ({ band, count: 2, share: 0.2 })),
});

describe("adjudication distributions", () => {
  it("vérifie les frontières et la cohérence des six tranches avec le regroupement historique", () => {
    const value = {
      ...fixture(),
      detailedBidDistribution: [
        { band: "below_starting", count: 2, share: 0.2 },
        { band: "at_starting", count: 2, share: 0.2 },
        { band: "above_1_below_1_5", count: 2, share: 0.2 },
        { band: "from_1_5_below_2", count: 2, share: 0.2 },
        { band: "from_2_below_3", count: 1, share: 0.1 },
        { band: "at_least_3", count: 1, share: 0.1 },
      ],
    };
    expect(adjudicationDistributionSchema.safeParse(value).success).toBe(true);
    value.detailedBidDistribution[0].count = 1;
    value.detailedBidDistribution[0].share = 0.1;
    value.detailedBidDistribution[5].count = 2;
    value.detailedBidDistribution[5].share = 0.2;
    expect(adjudicationDistributionSchema.safeParse(value).success).toBe(false);
  });
  it("refuse une médiane de type hors des quartiles et accepte les anciennes publications", () => {
    const summary = {
      medianHammerPriceEur: 100000,
      medianStartingPriceEur: 60000,
      medianHammerToStartingRatio: 1.5,
      meanHammerToStartingRatio: 1.7,
    };
    expect(adjudicationDistributionSchema.safeParse({ ...fixture(), summary }).success).toBe(true);
    expect(
      adjudicationDistributionSchema.safeParse({
        ...fixture(),
        summary: { ...summary, medianHammerToStartingRatio: 3 },
      }).success,
    ).toBe(false);
    expect(adjudicationDistributionSchema.safeParse(fixture()).success).toBe(true);
  });
  it("validates disjoint property samples and rejects duplicated types", () => {
    const item = { propertyType: "house", distribution: fixture() };
    expect(
      adjudicationEnrichmentSchema.safeParse({ distribution: fixture(), propertyTypes: [item] })
        .success,
    ).toBe(true);
    expect(
      adjudicationEnrichmentSchema.safeParse({
        distribution: fixture(),
        propertyTypes: [item, item],
      }).success,
    ).toBe(false);
    expect(
      adjudicationEnrichmentSchema.safeParse({
        distribution: fixture(),
        propertyTypes: [item, { ...item, propertyType: "apartment" }],
      }).success,
    ).toBe(false);
  });
  it("accepts a complete partition including results below and at the starting price", () => {
    expect(adjudicationDistributionSchema.parse(fixture()).sampleSize).toBe(10);
  });
  it("rejects a duplicated band or inconsistent denominator", () => {
    const value = fixture();
    value.bidDistribution[0] = value.bidDistribution[1];
    expect(adjudicationDistributionSchema.safeParse(value).success).toBe(false);
    expect(adjudicationDistributionSchema.safeParse({ ...fixture(), sampleSize: 11 }).success).toBe(
      false,
    );
  });
  it("rejects reversed quartiles and samples below the threshold", () => {
    expect(adjudicationDistributionSchema.safeParse({ ...fixture(), sampleSize: 9 }).success).toBe(
      false,
    );
    expect(
      adjudicationDistributionSchema.safeParse({ ...fixture(), ratioMiddle50: { p25: 2, p75: 1 } })
        .success,
    ).toBe(false);
  });
});
