import { describe, expect, it } from "vitest";
import { offerComparisonRows } from "./offer-comparison";
import { PLAN_FEATURES } from "./plans";

describe("offerComparisonRows", () => {
  const rows = offerComparisonRows();
  const row = (id: string) => rows.find((candidate) => candidate.id === id)!;

  it("reprend les droits réels de plans.ts", () => {
    expect(row("ceiling").decouverte.included).toBe(
      PLAN_FEATURES.decouverte["property.bidCeiling"] !== "locked",
    );
    expect(row("ceiling").decouverte).toEqual({ included: false, text: "Non inclus" });
    expect(row("ceiling").analyse).toEqual({ included: true, text: "Inclus" });
    expect(row("catalogue").decouverte.included).toBe(true);
    expect(row("directory").decouverte.included).toBe(true);
    expect(row("referrals").decouverte.included).toBe(false);
    expect(row("csv").analyse.included).toBe(true);
  });

  it("chiffre les quotas à partir des limites du plan", () => {
    expect(row("favorites").decouverte.text).toBe("3 favoris");
    expect(row("favorites").analyse.text).toBe("Illimités");
    expect(row("alerts").decouverte.text).toBe("1 alerte, 1 zone");
    expect(row("alerts").analyse.text).toBe("Jusqu’à 25");
  });

  it("n'expose aucun fournisseur ni « Premium »", () => {
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Stripe|Meteostat|ClimaScore|Premium|météo/i);
  });
});
