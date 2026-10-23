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
  MARKET_GAP_BAND_MAX_RADIUS_OTHER_M,
  MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M,
  MARKET_GAP_BAND_MIN_COMPARABLES,
  MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE,
  MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE,
} from "@/lib/market-gap-band";
import { selectStatisticScope } from "@/lib/dvf-market-statistics";
import {
  MARKET_WIDEN_UNTIL_COMPARABLES,
  VALUATION_MODEL_MIN_COVERAGE_PCT,
} from "@/lib/market-comparable-minimums";
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
      "on écarte les 10 % de ventes comparables les moins chères et les 10 % les plus chères",
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
    expect(text).toContain(
      "on écarte les 10 % de ventes comparables les moins chères et les 10 % les plus chères",
    );
    expect(text).not.toMatch(/P10|P90|centile/);
    expect(text).toContain(`${MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT} % de la valeur estimée`);
    expect(text).toContain(MARKET_GAP_BAND_LABELS.insufficient);
    expect(text).toContain("ne remplace ni une visite ni l’avis d’un professionnel");
    expect(text).not.toMatch(/bonne affaire|achetez/i);
  });

  it("nomme les trois libellés descriptifs, la mise à prix basse et la base DVF", () => {
    render(<Page />);
    const text = (
      section("Le repère en trois bandes de la fiche publique").textContent ?? ""
    ).replace(/\s/g, " ");
    for (const band of ["under", "near", "above", "occupied", "occupancy_unknown"] as const) {
      expect(text).toContain(MARKET_GAP_BAND_LABELS[band]);
    }
    expect(text).not.toMatch(/nettement|proche de la valeur/);
    expect(text).toContain("la mise à prix est volontairement basse");
    expect(text).toContain("la base des ventes immobilières déclarées aux notaires");
  });

  it("donne la porte publique à partir des constantes du code", () => {
    render(<Page />);
    const text = (
      section("Le repère en trois bandes de la fiche publique").textContent ?? ""
    ).replace(/\s/g, " ");
    expect(text).toContain(
      `au moins ${MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE} ventes comparables`,
    );
    expect(text).toContain(
      `(${MARKET_GAP_BAND_MIN_COMPARABLES} quand la fourchette vient d’un modèle`,
    );
    expect(text).toContain(
      `échantillon effectif d’au moins ${MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE}`,
    );
    expect(text).toContain(
      `${MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M.toLocaleString("fr-FR")} m`.replace(
        /\s/g,
        " ",
      ),
    );
    expect(text).toContain(
      `${MARKET_GAP_BAND_MAX_RADIUS_OTHER_M.toLocaleString("fr-FR")} m`.replace(/\s/g, " "),
    );
  });

  it("ne présente pas le repli fixe comme une fourchette de ventes comparables", () => {
    render(<Page />);
    const repli = (section("Quand il y a trop peu de ventes").textContent ?? "").replace(
      /\s/g,
      " ",
    );
    expect(repli).toContain("Cette fourchette n’est pas celle des ventes comparables");
    expect(repli).toContain("marge fixe");
    expect(repli).not.toMatch(/P10|P90|centile/);
    const comparables = (
      section("Les ventes comparables : périmètre et période").textContent ?? ""
    ).replace(/\s/g, " ");
    expect(comparables).toContain("marge fixe autour de la valeur");
  });

  it("décrit la fourchette comme un objectif de couverture, pas comme une garantie", () => {
    render(<Page />);
    const text = (
      section("Les ventes comparables : périmètre et période").textContent ?? ""
    ).replace(/\s/g, " ");
    expect(text).toContain("au minimum 8 % de part et d’autre");
    expect(text).toContain("dans huit cas sur dix");
    expect(text).toContain("environ 8 prix de vente sur 10");
    expect(text).toContain("un objectif de construction, pas une garantie");
    expect(text).toContain("n’est pas encore vérifiée");
    expect(text).toContain(
      `un modèle dont l’intervalle en contient moins de ${VALUATION_MODEL_MIN_COVERAGE_PCT} % n’est pas mis en service`,
    );
  });

  it("dit que le rayon continue de s'élargir jusqu'à l'effectif exigé par la porte publique", () => {
    render(<Page />);
    const text = (section("Quand l’estimation est jugée fiable").textContent ?? "").replace(
      /\s/g,
      " ",
    );
    expect(text).toContain(`moins de ${MARKET_WIDEN_UNTIL_COMPARABLES} ventes comparables`);
    expect(text).toContain(
      `${MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M.toLocaleString("fr-FR")} m pour un appartement en ville`.replace(
        /\s/g,
        " ",
      ),
    );
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
