import { describe, expect, it } from "vitest";
import {
  describePreviousPassage,
  describeTimelineEvent,
  mapSalePassages,
  salePassagesTeaser,
} from "./sale-passages";

describe("sale passages", () => {
  const raw = {
    timeline: [
      { kind: "first_seen", observed_at: "2026-09-20T10:00:00Z", backfilled: true },
      {
        kind: "starting_price_changed",
        previous: 120000,
        value: 90000,
        observed_at: "2026-10-01T10:00:00Z",
      },
      {
        kind: "postponed",
        previous: "upcoming",
        value: "postponed",
        observed_at: "2026-10-02T10:00:00Z",
      },
      { kind: "unexpected", observed_at: "2026-10-03T10:00:00Z" },
    ],
    previous_passages: [
      {
        sale_date: "2026-09-16T07:00:00Z",
        starting_price_eur: "170000",
        status: "unknown_outcome",
      },
    ],
  };

  it("keeps known events and summarizes the history", () => {
    const result = mapSalePassages(raw, 90000);
    expect(result.timeline.map((event) => event.kind)).toEqual([
      "first_seen",
      "starting_price_changed",
      "postponed",
    ]);
    expect(result.previousPassages).toEqual([
      { saleDate: "2026-09-16T07:00:00Z", startingPriceEur: 170000, status: "unknown_outcome" },
    ]);
    expect(result.summary).toEqual({
      previousPassageCount: 1,
      priceChangePct: -25,
      postponementCount: 1,
    });
  });

  it("falls back to the previous passage to measure the price change", () => {
    const result = mapSalePassages({ previous_passages: raw.previous_passages }, 188000);
    expect(result.summary.priceChangePct).toBe(11);
    expect(mapSalePassages(null, 100000).summary).toEqual({
      previousPassageCount: 0,
      priceChangePct: null,
      postponementCount: 0,
    });
  });

  it("tells a free account that the price went down, never by how much", () => {
    const dropped = mapSalePassages(
      { previous_passages: [{ sale_date: "2026-01-10", starting_price_eur: 100000 }] },
      80000,
    );
    expect(salePassagesTeaser(dropped)).toEqual({
      access: "teaser",
      summary: { previousPassageCount: 1, postponementCount: 0, priceDropped: true },
    });
    expect(JSON.stringify(salePassagesTeaser(dropped))).not.toMatch(/priceChangePct|-20|2026/);
    const raised = mapSalePassages(
      { previous_passages: [{ sale_date: "2026-01-10", starting_price_eur: 100000 }] },
      120000,
    );
    expect(salePassagesTeaser(raised).summary.priceDropped).toBe(false);
    expect(salePassagesTeaser(mapSalePassages(null, 100000)).summary.priceDropped).toBe(false);
  });

  it("describes each event in plain French", () => {
    const [, price, postponed] = mapSalePassages(raw, 90000).timeline;
    expect(describeTimelineEvent(price).title).toBe("Mise à prix baissée");
    expect(describeTimelineEvent(price).detail).toMatch(/120\s000\s€ → 90\s000\s€ \(-25 %\)/);
    expect(describeTimelineEvent(postponed).title).toBe("Vente reportée");
    expect(
      describeTimelineEvent({
        kind: "sale_date_changed",
        previous: "2026-11-20T09:00:00+01:00",
        value: "2026-12-04T09:00:00+01:00",
        observedAt: "",
        backfilled: false,
      }).detail,
    ).toBe("Du 20 novembre 2026 au 4 décembre 2026");
  });

  it("compares an earlier passage with today's starting price", () => {
    const passage = { saleDate: "2026-09-16T07:00:00Z", startingPriceEur: 170000, status: null };
    expect(describePreviousPassage(passage, 188000)).toEqual({
      title: "Audience du 16 septembre 2026",
      detail: expect.stringMatching(/Mise à prix 170\s000\s€ · aujourd’hui \+11 %/),
    });
    expect(describePreviousPassage(passage, 170000).detail).toContain("même mise à prix");
  });
});
