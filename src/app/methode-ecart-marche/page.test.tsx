// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MARKET_GAP_MAX_DISCOUNT_PCT,
  MARKET_GAP_METHOD_PATH,
  MARKET_GAP_MIN_DISCOUNT_PCT,
  MARKET_GAP_NOT_SIGNIFICANT_LABEL,
} from "@/lib/market-gap";
import Page, { metadata } from "./page";

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
    expect(text).toContain("moins de 24 mois");
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
