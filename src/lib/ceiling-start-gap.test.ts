import { describe, expect, it } from "vitest";
import { describeCeilingStartGap } from "@/lib/ceiling-start-gap";

const plan = (maxBid: number, startingPrice: number | null) => ({
  available: true,
  reachable: true,
  maxBid,
  startingPriceGap: startingPrice == null ? null : maxBid - startingPrice,
});

function normalized(value: string | undefined) {
  return value?.replace(/[\u00a0\u202f]/g, " ");
}

describe("describeCeilingStartGap", () => {
  it("says how far above the starting price the ceiling stands", () => {
    const result = describeCeilingStartGap(plan(160_000, 100_000), 100_000);

    expect(result?.kind).toBe("above");
    expect(normalized(result?.text)).toBe(
      "Selon vos hypothèses, vous pouvez enchérir jusqu’à 160 000 €, soit 60 000 € au-dessus de la mise à prix.",
    );
  });

  it("flags a narrow margin below 5 % of the starting price, in words", () => {
    const result = describeCeilingStartGap(plan(104_500, 100_000), 100_000);

    expect(result?.kind).toBe("narrow");
    expect(normalized(result?.text)).toBe(
      "Peu d’écart avec la mise à prix : selon vos hypothèses, vous pouvez enchérir jusqu’à 104 500 €, soit 4 500 € au-dessus de la mise à prix.",
    );
  });

  it("keeps a gap of exactly 5 % in the comfortable state", () => {
    expect(describeCeilingStartGap(plan(105_000, 100_000), 100_000)?.kind).toBe("above");
  });

  it("calls a ceiling equal to the starting price a narrow margin", () => {
    const result = describeCeilingStartGap(plan(100_000, 100_000), 100_000);

    expect(result?.kind).toBe("narrow");
    expect(normalized(result?.text)).toBe(
      "Peu d’écart avec la mise à prix : selon vos hypothèses, vous pouvez enchérir jusqu’à 100 000 €, soit exactement la mise à prix.",
    );
  });

  it("states the shortfall in euros and percent when the ceiling is under the starting price", () => {
    const result = describeCeilingStartGap(plan(88_000, 100_000), 100_000);

    expect(result?.kind).toBe("below");
    expect(result?.gap).toBe(-12_000);
    expect(normalized(result?.text)).toBe(
      "Avec ces hypothèses, votre enchère plafond (88 000 €) est 12 000 € (12 %) sous la mise à prix : le bien ne tient pas à son prix de départ.",
    );
  });

  it("never writes 0 % or −0 % for a shortfall that exists", () => {
    const text = normalized(describeCeilingStartGap(plan(99_999, 100_000), 100_000)?.text);

    expect(text).toContain("(moins de 0,1 %)");
    expect(text).not.toMatch(/−|\(0 %\)/);
    expect(normalized(describeCeilingStartGap(plan(99_000, 100_000), 100_000)?.text)).toContain(
      "(1 %)",
    );
  });

  it("keeps a decimal for a shortfall under 1 %", () => {
    expect(normalized(describeCeilingStartGap(plan(99_500, 100_000), 100_000)?.text)).toContain(
      "(0,5 %)",
    );
  });

  it("compares nothing without a starting price or a reachable ceiling", () => {
    expect(describeCeilingStartGap(plan(100_000, null), null)).toBeNull();
    expect(describeCeilingStartGap(plan(100_000, 0), 0)).toBeNull();
    expect(describeCeilingStartGap({ ...plan(0, 100_000), reachable: false }, 100_000)).toBeNull();
    expect(describeCeilingStartGap({ ...plan(0, 100_000), available: false }, 100_000)).toBeNull();
  });
});
