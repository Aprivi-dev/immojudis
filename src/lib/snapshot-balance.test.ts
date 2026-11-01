import { describe, expect, it } from "vitest";
import {
  buildSnapshotBalance,
  gapWithCeiling,
  parseFinalPriceInput,
  statusAllowsFinalPrice,
} from "./snapshot-balance";

describe("statusAllowsFinalPrice", () => {
  it("n'accepte un prix final que pour une vente remportée ou non remportée", () => {
    expect(statusAllowsFinalPrice("won")).toBe(true);
    expect(statusAllowsFinalPrice("lost")).toBe(true);
    for (const status of ["watching", "reviewing", "bidding", "archived", "", null, undefined]) {
      expect(statusAllowsFinalPrice(status)).toBe(false);
    }
  });
});

describe("parseFinalPriceInput", () => {
  it("lit les séparateurs français, les espaces insécables et le symbole euro", () => {
    expect(parseFinalPriceInput("172 500")).toEqual({ ok: true, value: 172_500 });
    expect(parseFinalPriceInput("172 500 €")).toEqual({ ok: true, value: 172_500 });
    expect(parseFinalPriceInput("172500,60")).toEqual({ ok: true, value: 172_501 });
  });

  it("refuse plutôt que de diviser par mille un point de milliers", () => {
    const result = parseFinalPriceInput("185.000");
    expect(result.ok).toBe(false);
  });

  it("refuse le vide, le texte, zéro et les montants hors borne", () => {
    for (const raw of ["", "  ", "abc", "-5", "0", "0,4", "99999999999"]) {
      expect(parseFinalPriceInput(raw).ok).toBe(false);
    }
  });
});

describe("gapWithCeiling", () => {
  it("compare le prix final au plafond : négatif sous le plafond, positif au-dessus", () => {
    expect(gapWithCeiling(171_000, 180_000)).toEqual({ eur: -9_000, pct: -5 });
    expect(gapWithCeiling(198_000, 180_000)).toEqual({ eur: 18_000, pct: 10 });
    expect(gapWithCeiling(180_000, 180_000)).toEqual({ eur: 0, pct: 0 });
  });

  it("n'existe que si le prix final ET le plafond sont présents", () => {
    expect(gapWithCeiling(null, 180_000)).toBeNull();
    expect(gapWithCeiling(171_000, null)).toBeNull();
    expect(gapWithCeiling(171_000, 0)).toBeNull();
    expect(gapWithCeiling(0, 180_000)).toBeNull();
    expect(gapWithCeiling(undefined, undefined)).toBeNull();
  });
});

describe("buildSnapshotBalance", () => {
  it("compte les ventes remportées et non remportées et moyenne l'écart en pourcentage", () => {
    const balance = buildSnapshotBalance([
      { personalStatus: "won", bidCeilingEur: 100_000, finalPriceEur: 90_000 },
      { personalStatus: "won", bidCeilingEur: 200_000, finalPriceEur: 220_000 },
      { personalStatus: "won", bidCeilingEur: null, finalPriceEur: 50_000 },
      { personalStatus: "lost", bidCeilingEur: 100_000, finalPriceEur: 120_000 },
      { personalStatus: "lost", bidCeilingEur: null, finalPriceEur: null },
      { personalStatus: "watching", bidCeilingEur: 100_000, finalPriceEur: 100_000 },
      { personalStatus: null, bidCeilingEur: null, finalPriceEur: null },
    ]);
    expect(balance.won).toEqual({ count: 3, compared: 2, averageGapPct: 0, aboveCeiling: 1 });
    expect(balance.lost).toEqual({ count: 2, compared: 1, averageGapPct: 20, aboveCeiling: 1 });
  });

  it("ne calcule aucun écart sans vente comparable", () => {
    const balance = buildSnapshotBalance([
      { personalStatus: "won", bidCeilingEur: null, finalPriceEur: 50_000 },
    ]);
    expect(balance.won).toEqual({ count: 1, compared: 0, averageGapPct: null, aboveCeiling: 0 });
    expect(buildSnapshotBalance([]).lost.count).toBe(0);
  });
});
