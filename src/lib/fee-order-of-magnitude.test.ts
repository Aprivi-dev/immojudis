import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_FEES_EXAMPLE_PCT, HOME_FEES_EXAMPLE_PRICE } from "@/components/home/HomeSections";
import { computeAcquisitionCosts, DEFAULTS } from "@/lib/profitability";

/**
 * Les ordres de grandeur des frais écrits en dur dans le guide et dans deux articles (« environ
 * 13 % du prix pour un bien à 150 000 € ») doivent rester ceux du simulateur avec ses hypothèses par
 * défaut, comme le bandeau de l'accueil qui les calcule (`HOME_FEES_EXAMPLE_PCT`). Si le moteur ou
 * ses hypothèses changent, ce test échoue : les textes sont à revoir.
 */
const ROOT = join(__dirname, "..");

function fees(price: number) {
  return computeAcquisitionCosts({
    price,
    fpt: DEFAULTS.fpt,
    lawyerFees: DEFAULTS.lawyerFees,
    works: 0,
    department: null,
  });
}

/** « 19 719 € » → 19719 (espaces fines et insécables comprises). */
function euros(text: string): number {
  return Number(text.replace(/[^\d]/g, ""));
}

function resource(slug: string): string {
  return readFileSync(join(ROOT, "content/resources", `${slug}.json`), "utf8");
}

describe("ordres de grandeur des frais écrits dans les contenus", () => {
  it("le guide écrit le même pourcentage que l'accueil, pour le même prix", () => {
    const source = readFileSync(
      join(ROOT, "app/ventes-immobilieres-judiciaires/resources-guide.tsx"),
      "utf8",
    );
    const match = /environ (\d+)\\u00a0% du prix pour un bien à (\d+)\\u202f(\d{3})\\u00a0€/.exec(
      source,
    );
    expect(match).not.toBeNull();
    expect(Number(`${match![2]}${match![3]}`)).toBe(HOME_FEES_EXAMPLE_PRICE);
    expect(Number(match![1])).toBe(HOME_FEES_EXAMPLE_PCT);
    expect(Math.round(fees(HOME_FEES_EXAMPLE_PRICE).acquisitionFeesPct)).toBe(
      HOME_FEES_EXAMPLE_PCT,
    );
  });

  it("l'article sur les frais garde le total, la part et le tableau par prix du simulateur", () => {
    const text = resource("frais-vente-encheres-judiciaire");
    const example = fees(150_000);
    const pct = Math.round(example.acquisitionFeesPct);
    expect(text).toContain(`environ ${pct} % du prix pour un bien à 150 000 €`);
    expect(text).toContain(`Le total des frais représente environ ${pct} % du prix`);
    const total = /"Total des frais", "[^"]*", "environ ([\d  ]+) €"/.exec(text);
    expect(total).not.toBeNull();
    expect(euros(total![1])).toBe(Math.round(example.acquisitionFeesTotal));

    const rows = [...text.matchAll(/\["([\d  ]+) €", "environ ([\d  ]+) €", "environ (\d+) %"\]/g)];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const [, price, written, share] of rows) {
      const result = fees(euros(price));
      expect(euros(written), price).toBe(Math.round(result.acquisitionFeesTotal / 100) * 100);
      expect(Number(share), price).toBe(Math.round(result.acquisitionFeesPct));
    }
  });

  it("l'article sur le prix plafond garde les frais à l'enchère plafond de son exemple", () => {
    const text = resource("prix-plafond-encheres-immobilieres");
    const match =
      /environ ([\d  ]+) € pour une enchère d’environ ([\d  ]+) €, soit environ (\d+) % du prix/.exec(
        text,
      );
    expect(match).not.toBeNull();
    const result = fees(euros(match![2]));
    // « environ 19 600 € » pour 19 547 € calculés : l'article arrondit à la centaine supérieure.
    // L'écart admis est d'une centaine d'euros, le pas d'arrondi de l'article.
    expect(Math.abs(euros(match![1]) - result.acquisitionFeesTotal)).toBeLessThan(100);
    expect(Number(match![3])).toBe(Math.round(result.acquisitionFeesPct));
    expect(text).toContain(`environ ${Number(match![3])} % du prix : un ordre de grandeur`);
  });
});
