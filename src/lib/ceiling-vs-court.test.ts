import { describe, expect, it } from "vitest";
import type { AuctionScenario } from "@/lib/auction-scenarios";
import { ceilingPosition } from "./ceiling-vs-court";

// Les tranches de la base (`app_private.court_auction_scenarios`) : 0-1,1 / 1,1-1,5 / 1,5-2 / 2-3 / 3+.
const SCENARIOS: AuctionScenario[] = [
  { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.2 },
  { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.3 },
  { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.25 },
  { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0.15 },
  { key: "above_3", lowRatio: 3, highRatio: null, probability: 0.1 },
];
const START = 100_000;

describe("ceilingPosition", () => {
  it("compte les tranches entièrement sous le plafond", () => {
    // 1,5 fois la mise à prix : les deux premières tranches (0,2 + 0,3).
    expect(ceilingPosition(SCENARIOS, 150_000, START)).toMatchObject({
      kind: "share",
      share: expect.closeTo(0.5, 6),
      atLeast: false,
      ratio: 1.5,
    });
  });

  it("interpole dans la tranche qui contient le plafond", () => {
    // 1,75 : 0,5 + la moitié de la tranche 1,5 à 2 (0,25 / 2).
    expect(ceilingPosition(SCENARIOS, 175_000, START)).toMatchObject({
      share: expect.closeTo(0.625, 6),
      atLeast: false,
    });
    // 1,05 : la première tranche commence à 1 (pas à 0) — la moitié de 1 à 1,1.
    expect(ceilingPosition(SCENARIOS, 105_000, START)).toMatchObject({
      share: expect.closeTo(0.1, 6),
    });
  });

  it("à la mise à prix exacte, aucune vente n'est au-dessous", () => {
    expect(ceilingPosition(SCENARIOS, 100_000, START)).toMatchObject({ share: 0, atLeast: false });
  });

  it("sous la mise à prix, aucune enchère n'est possible", () => {
    expect(ceilingPosition(SCENARIOS, 99_999, START)).toEqual({ kind: "below_start" });
  });

  it("au-delà de 3 fois la mise à prix, la part est un plancher", () => {
    expect(ceilingPosition(SCENARIOS, 450_000, START)).toMatchObject({
      share: expect.closeTo(0.9, 6),
      atLeast: true,
      ratio: 4.5,
    });
    // Pile à 3 fois : la dernière tranche fermée est comptée en entier, rien d'estimé au-delà.
    expect(ceilingPosition(SCENARIOS, 300_000, START)).toMatchObject({
      share: expect.closeTo(0.9, 6),
      atLeast: false,
    });
  });

  it("normalise des probabilités arrondies qui ne font pas tout à fait 1", () => {
    const rounded = SCENARIOS.map((scenario) => ({
      ...scenario,
      probability: scenario.probability * 0.9999,
    }));
    const position = ceilingPosition(rounded, 450_000, START);
    expect(position).toMatchObject({ share: expect.closeTo(0.9, 6) });
  });

  it("ne chiffre rien sans tranche, sans mise à prix ou avec un plafond inutilisable", () => {
    expect(ceilingPosition([], 150_000, START)).toBeNull();
    expect(ceilingPosition(SCENARIOS, 150_000, 0)).toBeNull();
    expect(ceilingPosition(SCENARIOS, 0, START)).toBeNull();
    expect(ceilingPosition(SCENARIOS, Number.NaN, START)).toBeNull();
    expect(
      ceilingPosition(
        SCENARIOS.map((scenario) => ({ ...scenario, probability: 0 })),
        150_000,
        START,
      ),
    ).toBeNull();
  });
});
