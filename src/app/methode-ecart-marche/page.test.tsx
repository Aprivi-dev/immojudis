// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MARKET_GAP_MAX_DISCOUNT_PCT,
  MARKET_GAP_METHOD_PATH,
  MARKET_GAP_MIN_DISCOUNT_PCT,
  MARKET_GAP_NOT_SIGNIFICANT_LABEL,
} from "@/lib/market-gap";
import {
  MARKET_GAP_BAND_LABELS,
  MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT,
} from "@/lib/market-gap-band";
import { selectStatisticScope } from "@/lib/dvf-market-statistics";
import { URBAN_POPULATION_THRESHOLD } from "@/lib/market-server/constants";
import type { Database } from "@/integrations/supabase/types";
import Page, { metadata } from "./page";

type StatisticRow = Database["public"]["Tables"]["dvf_market_statistics"]["Row"];

function statisticRow(level: StatisticRow["geography_level"], salesCount: number): StatisticRow {
  return {
    geography_level: level,
    geography_code: level,
    geography_label: level,
    parent_code: null,
    segment: "house",
    sales_count: salesCount,
    mean_price_per_m2: 2_000,
    median_price_per_m2: 2_000,
    source_url: "https://example.test",
    source_updated_at: null,
    imported_at: "2026-07-13T16:00:00Z",
  };
}

/**
 * Plus petit nombre de ventes pour lequel `selectStatisticScope` retient la commune, puis
 * l'intercommunalité. Les échelles plus larges, fournies en grand nombre, ne servent que de
 * repli : l'échelle testée n'est retenue que si elle atteint son propre seuil. (Le seuil du
 * département ne s'observe pas : s'il n'est pas atteint, le repli « échelle la mieux fournie » le
 * retient de toute façon.)
 */
function scopeThreshold(level: "commune" | "epci"): number {
  for (let count = 2; count <= 100; count += 1) {
    const rows =
      level === "commune"
        ? {
            commune: statisticRow("commune", count),
            epci: statisticRow("epci", 500),
            department: statisticRow("department", 500),
          }
        : {
            commune: statisticRow("commune", 1),
            epci: statisticRow("epci", count),
            department: statisticRow("department", 500),
          };
    if (selectStatisticScope(rows)?.geography_level === level) return count;
  }
  throw new Error(`aucun seuil pour ${level}`);
}

afterEach(cleanup);

function section(name: string) {
  return screen.getByRole("region", { name });
}

describe("page « Comment est calculé l’écart avec le marché ? »", () => {
  it("a son adresse canonique, un titre court et une description dans les limites", () => {
    expect(MARKET_GAP_METHOD_PATH).toBe("/methode-ecart-marche");
    expect(metadata.alternates?.canonical).toBe("/methode-ecart-marche");
    expect(String(metadata.title).length + " - Immojudis".length).toBeLessThanOrEqual(60);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(90);
    expect(description.length).toBeLessThanOrEqual(170);
    expect(metadata.openGraph?.url).toBe("/methode-ecart-marche");
  });

  it("porte le contenu principal #contenu et un seul titre de niveau 1", () => {
    const { container } = render(<Page />);
    expect(container.querySelector("main#contenu")).not.toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Comment est calculé l’écart avec le marché ?",
    ]);
  });

  it("donne la formule du code et le sens du signe", () => {
    render(<Page />);
    const formula = section("L’écart, en une formule");
    expect(formula.textContent).toContain(
      "écart = (valeur estimée − mise à prix) ÷ valeur estimée × 100",
    );
    expect(formula.textContent).toContain("positif signifie que la mise à prix est sous");
  });

  it("nomme la source DVF, le périmètre et la période du code", () => {
    render(<Page />);
    const source = section("D’où vient la valeur de marché");
    expect(source.textContent).toContain("DVF");
    const comparables = section("Les ventes comparables : périmètre et période").textContent ?? "";
    for (const fact of [
      "de 150 m pour un appartement en ville à 10 km pour un terrain",
      "10 000 habitants",
      "60 derniers mois",
      "au moins 4",
      "300 à 50 000 € le m²",
      "divisé par deux tous les 24 mois",
      "médiane pondérée",
      "du 10e au 90e centile",
    ]) {
      expect(comparables).toContain(fact);
    }
  });

  it("décrit le repli sur les statistiques agrégées et l'absence de pourcentage", () => {
    render(<Page />);
    const text = section("Quand il y a trop peu de ventes").textContent ?? "";
    expect(text).toContain("au moins 5 ventes");
    expect(text).toContain("au moins 12 ventes");
    expect(text).toContain("au moins 30 ventes");
    expect(text).toContain("24 mois au plus");
    expect(text).toContain("aucun écart en pourcentage");
  });

  it("annonce les seuils du garde-fou à partir des constantes du code", () => {
    render(<Page />);
    const guard = section("Quand l’écart n’est pas affiché");
    const text = guard.textContent ?? "";
    expect(text).toContain(MARKET_GAP_NOT_SIGNIFICANT_LABEL);
    expect(within(guard).getAllByRole("listitem")).toHaveLength(2);
    expect(text).toContain(`de plus de ${MARKET_GAP_MAX_DISCOUNT_PCT} %`);
    expect(text).toContain(`de plus de ${-MARKET_GAP_MIN_DISCOUNT_PCT} %`);
    expect(text).toContain(`moins de ${100 - MARKET_GAP_MAX_DISCOUNT_PCT} %`);
    expect(text).toContain(`plus de ${100 - MARKET_GAP_MIN_DISCOUNT_PCT} %`);
  });

  it("cite les seuils du moteur, lus dans ses constantes et ses fonctions exportées", () => {
    render(<Page />);
    const comparables = section("Les ventes comparables : périmètre et période").textContent ?? "";
    expect(comparables).toContain(
      `${URBAN_POPULATION_THRESHOLD.toLocaleString("fr-FR").replace(/\s/g, " ")} habitants`,
    );
    const repli = (section("Quand il y a trop peu de ventes").textContent ?? "").replace(
      /\s/g,
      " ",
    );
    // « celles de la commune si elles reposent sur au moins 5 ventes, sinon … l'intercommunalité
    // (au moins 12 ventes) ».
    for (const level of ["commune", "epci"] as const) {
      expect(repli).toContain(`au moins ${scopeThreshold(level)} ventes`);
    }
  });

  it("étend le garde-fou aux alertes et à la prévision, sans le promettre ailleurs", () => {
    render(<Page />);
    const text = (section("Quand l’écart n’est pas affiché").textContent ?? "").replace(/\s/g, " ");
    expect(text).toContain("alertes");
    expect(text).toContain("critère de décote minimale");
    expect(text).toContain("Décote de départ");
    expect(text).toContain(MARKET_GAP_NOT_SIGNIFICANT_LABEL);
  });

  it("explique le repère en trois bandes de la fiche publique, sans chiffre ni conseil", () => {
    render(<Page />);
    const bands = section("Le repère en trois bandes de la fiche publique");
    const text = (bands.textContent ?? "").replace(/\s/g, " ");
    expect(within(bands).getAllByRole("listitem")).toHaveLength(3);
    expect(text).toContain("sans aucun chiffre");
    expect(text).toContain("du 10e au 90e centile");
    expect(text).toContain(`${MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT} % de la valeur estimée`);
    expect(text).toContain(MARKET_GAP_BAND_LABELS.insufficient);
    expect(text).toContain("ne remplace ni une visite ni l’avis d’un professionnel");
    expect(text).not.toMatch(/bonne affaire|achetez/i);
  });

  it("énonce les limites sans promettre de conseil", () => {
    render(<Page />);
    const text = section("Les limites à garder en tête").textContent ?? "";
    expect(text).toContain("n’est pas le prix d’adjudication");
    expect(text).toContain("Alsace, la Moselle ni Mayotte");
    expect(text).toContain("ni un conseil juridique ni un conseil financier");
  });

  it("renvoie vers le classement, le simulateur et les ventes", () => {
    const { container } = render(<Page />);
    for (const href of ["/classement-des-annonces", "/simulateur-frais-encheres", "/sales"]) {
      expect(container.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
  });
});
