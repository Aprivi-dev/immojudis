// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_GAP_METHOD_PATH } from "@/lib/market-gap";
import * as policy from "@/lib/pepite-policy";
import { PEPITE_METHOD_PATH, PEPITE_RULE_VERSION, PEPITE_V1 } from "./method";
import Page, { metadata } from "./page";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const plain = (text: string) =>
  text
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function section(name: string) {
  return screen.getByRole("region", { name });
}

function sectionText(name: string) {
  return plain(section(name).textContent ?? "");
}

describe("page « Comment repérons-nous les pépites ? »", () => {
  it("a son adresse canonique, un titre court et une description dans les limites", () => {
    expect(PEPITE_METHOD_PATH).toBe("/methode-pepites");
    expect(metadata.alternates?.canonical).toBe("/methode-pepites");
    expect(String(metadata.title).length + " - Immojudis".length).toBeLessThanOrEqual(60);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(90);
    expect(description.length).toBeLessThanOrEqual(170);
    expect(description).not.toMatch(/garantie|gratuit|bonne affaire/i);
    expect(metadata.openGraph?.url).toBe("/methode-pepites");
  });

  it("porte le contenu principal #contenu et un seul titre de niveau 1", () => {
    const { container } = render(<Page />);
    expect(container.querySelector("main#contenu")).not.toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Comment repérons-nous les pépites ?",
    ]);
  });

  it("dit ce que c'est : un repère calculé automatiquement sur des critères publics, un potentiel d'investissement", () => {
    render(<Page />);
    const text = sectionText("Ce qu’est le repère « Pépite »");
    expect(text).toContain("repère calculé automatiquement par Immojudis");
    expect(text).toContain("critères publics");
    expect(text).toContain(
      "pour signaler un potentiel d’investissement mesuré par deux conditions chiffrées, calculées sur les données disponibles",
    );
    expect(text).toContain(
      "Les ventes comparables passées ont-elles été le plus souvent adjugées sous l’enchère plafond estimée ? Immojudis regarde si au moins 70 % l’ont été.",
    );
    expect(text).toContain(
      "Le coût total estimé au prix de référence, frais compris, représente-t-il au plus 75 % de la valeur estimée (65 % en vente notariale) ?",
    );
    expect(text).toContain(
      "La valeur estimée est celle d’un bien comparable, d’après les ventes DVF passées ; elle ne tient compte ni de l’état du bien ni de son occupation.",
    );
    expect(text).not.toMatch(/nettement sous la valeur|achat probable/);
    expect(text).toContain("enchère plafond estimée");
    expect(text).toContain("offre plafond estimée");
    expect(text).toContain("Une enchère ou une offre plafond est une hypothèse, pas un résultat.");
    expect(text).toContain("petit pictogramme de pépite");
  });

  it("dit ce que ce n'est pas : ni conseil, ni recommandation, ni garantie", () => {
    render(<Page />);
    const text = sectionText("Ce que le repère n’est pas");
    expect(text).toContain("Ce n’est pas un conseil en investissement");
    expect(text).toContain("Ce n’est pas une recommandation d’acheter");
    expect(text).toContain("garantie de prix, de rendement, d’adjudication ni de revente");
  });

  it("reprend les seuils du module de calcul : la page n'annonce que ce que le calcul applique", () => {
    expect(PEPITE_RULE_VERSION).toBe(policy.PEPITE_RULE_VERSION);
    expect(PEPITE_V1).toEqual({
      chanceMinPct: policy.PEPITE_CHANCE_MIN_SHARE * 100,
      maxCostShareCourtPct: policy.PEPITE_COST_MAX_SHARE_COURT * 100,
      maxCostShareNotaryPct: policy.PEPITE_COST_MAX_SHARE_NOTARY * 100,
      exitChanceBelowPct: policy.PEPITE_CHANCE_EXIT_SHARE * 100,
      exitCostShareAbovePct: policy.PEPITE_COST_EXIT_SHARE_COURT * 100,
      exitCostShareNotaryAbovePct: policy.PEPITE_COST_EXIT_SHARE_NOTARY * 100,
      extremeStartingPriceBelowPct: policy.PEPITE_EXTREME_START_RATIO_MIN * 100,
      extremeStartingPriceAbovePct: policy.PEPITE_EXTREME_START_RATIO_MAX * 100,
      favourableEvaluations: policy.PEPITE_FAVOURABLE_EVALUATIONS,
      freezeDaysBeforeSale: policy.PEPITE_FREEZE_DAYS,
      minValueComparables: policy.PEPITE_MIN_VALUE_COMPARABLES,
      historyYears: policy.PEPITE_HISTORY_YEARS,
      courtCompleteBelowSales: policy.PEPITE_COURT_COMPLETE_BELOW_SALES,
      courtReplaceBelowSales: policy.PEPITE_COURT_REPLACE_BELOW_SALES,
      lowStartingPricePct: policy.PEPITE_LOW_STARTING_PRICE_SHARE * 100,
      maxEvaluationAgeHours: policy.PEPITE_MAX_EVALUATION_AGE_HOURS,
    });
  });

  it("donne les seuils de pepite-v1 à partir des constantes de la règle", () => {
    render(<Page />);
    const text = sectionText("Les critères et les seuils");
    expect(PEPITE_RULE_VERSION).toBe("pepite-v1");
    expect(text).toContain("Version pepite-v1.");
    expect(text).not.toContain("indiquée sur cette page");
    expect(PEPITE_V1.chanceMinPct).toBe(70);
    expect(PEPITE_V1.maxCostShareCourtPct).toBe(75);
    expect(PEPITE_V1.maxCostShareNotaryPct).toBe(65);
    expect(text).toContain(`Au moins ${PEPITE_V1.chanceMinPct} % des ventes comparables`);
    expect(text).toContain(`d’au plus ${PEPITE_V1.maxCostShareCourtPct} % de la valeur estimée`);
    expect(text).toContain(`au plus ${PEPITE_V1.maxCostShareNotaryPct} %`);
    expect(text).toContain(`${PEPITE_V1.historyYears} dernières années`);
    expect(text).toContain(`moins de ${PEPITE_V1.courtCompleteBelowSales} ventes comparables`);
    expect(text).toContain(`sous ${PEPITE_V1.courtReplaceBelowSales} ventes`);
    expect(text).toContain("Vente au tribunal");
    expect(text).toContain("Vente notariale à la bougie");
    expect(text).toContain("Vente notariale interactive");
    expect(text).toContain("Vente domaniale ou de type inconnu : pas de repère");
    expect(text).toContain("prix de réserve inconnu");
    expect(text).toContain(
      "L’offre plafond estimée doit en outre être au moins égale à cette première offre",
    );
  });

  it("énonce les garde-fous", () => {
    render(<Page />);
    const guard = section("Les garde-fous");
    const text = plain(guard.textContent ?? "");
    expect(within(guard).getAllByRole("listitem")).toHaveLength(4);
    expect(text).toContain(`au moins ${PEPITE_V1.minValueComparables} ventes comparables`);
    expect(text).toContain("Un terrain seul et un bien mixte n’ont pas de repère");
    expect(PEPITE_V1.extremeStartingPriceBelowPct).toBe(10);
    expect(PEPITE_V1.extremeStartingPriceAbovePct).toBe(150);
    expect(text).toContain(
      `une mise à prix inférieure à ${PEPITE_V1.extremeStartingPriceBelowPct} % ou supérieure à ${PEPITE_V1.extremeStartingPriceAbovePct} % de la valeur estimée signale le plus souvent une erreur de données, et la vente est alors écartée`,
    );
    expect(text).toContain("Un bien libre comme un bien occupé est admis");
    expect(text).toContain("Une occupation inconnue ou un squat excluent le repère");
    expect(text).toContain("signal bloquant");
    expect(text).toContain("valeur basse de la fourchette d’estimation");
  });

  it("décrit la stabilité : deux évaluations, seuils de sortie plus larges, gel à 7 jours", () => {
    render(<Page />);
    const text = sectionText("La stabilité du repère");
    expect(text).toContain(
      `après ${PEPITE_V1.favourableEvaluations} évaluations favorables consécutives`,
    );
    expect(text).toContain(`sous ${PEPITE_V1.exitChanceBelowPct} %`);
    expect(text).toContain(`dépasse ${PEPITE_V1.exitCostShareAbovePct} %`);
    expect(text).toContain(`dépasse ${PEPITE_V1.exitCostShareNotaryAbovePct} %`);
    expect(PEPITE_V1.exitCostShareNotaryAbovePct).toBeGreaterThan(PEPITE_V1.maxCostShareNotaryPct);
    expect(text).toContain(`figé ${PEPITE_V1.freezeDaysBeforeSale} jours avant la vente`);
    expect(PEPITE_V1.exitChanceBelowPct).toBeLessThan(PEPITE_V1.chanceMinPct);
    expect(PEPITE_V1.exitCostShareAbovePct).toBeGreaterThan(PEPITE_V1.maxCostShareCourtPct);
  });

  it("présente le prix probable avec sa réserve, jamais comme une prévision", () => {
    render(<Page />);
    const text = sectionText("Le prix probable et ses limites");
    expect(text).toContain(
      "« Repère statistique tiré de N ventes comparables passées du tribunal (fiabilité X). La moitié de ces ventes s’est conclue dans la fourchette indiquée, l’autre moitié en dehors. Ce n’est pas une prévision : le prix final peut être inférieur ou supérieur. »",
    );
    expect(text).toContain("Lorsqu’il est affiché, le prix probable l’est avec cette réserve");
    expect(text).toContain("offre Analyse ou déblocage de la vente");
    expect(text).toContain("prix de réserve du vendeur est inconnu");
    expect(text).toContain("« enchère plafond estimée »");
    expect(text).toContain("« offre plafond estimée »");
    expect(text).not.toContain("intéressant jusqu’à");
  });

  it("dit qui voit quoi, sans affirmer que des pépites sont déjà affichées", () => {
    const { container } = render(<Page />);
    const text = sectionText("Ce qui est visible, et par qui");
    expect(text).toContain("Lorsqu’il est attribué, le repère « Pépite » est visible par tous");
    expect(text).toContain("réservés à l’offre Analyse ou à un déblocage");
    expect(text).toContain(
      "Cela n’a aucune influence sur l’attribution du repère, qui obéit aux seuls critères publiés sur cette page.",
    );
    const all = plain(container.textContent ?? "");
    expect(all).not.toMatch(/\b(déjà|actuellement)\b[^.]*pépite/i);
    expect(all).not.toMatch(/\d+ pépites/);
    expect(all).not.toMatch(/bonne affaire|achetez|intéressant jusqu’à/i);
  });

  it("liste ce que le repère ne mesure pas", () => {
    render(<Page />);
    const text = sectionText("Ce que le repère ne mesure pas");
    expect(text).toContain("L’état réel du bien");
    expect(text).toContain("Immojudis ne lit pas toutes les pièces");
    expect(text).toContain("ne prouve pas l’absence de risque");
    expect(text).toContain("Le repère ne mesure ni un rendement locatif ni une marge de revente");
    expect(
      within(section("Ce que le repère ne mesure pas"))
        .getByRole("link", { name: "la page de méthode de l’écart avec le marché" })
        .getAttribute("href"),
    ).toBe(MARKET_GAP_METHOD_PATH);
  });

  it("décrit la mise à jour et le retrait", () => {
    render(<Page />);
    const text = sectionText("Mise à jour et retrait");
    expect(text).toContain(`moins de ${PEPITE_V1.maxEvaluationAgeHours} heures`);
    expect(text).toContain("suspendre le repère pour l’ensemble du site");
    expect(text).toContain("Le repère serait recalculé régulièrement");
    expect(text).not.toMatch(/Le repère est recalculé|Il disparaît quand/);
  });

  it("affirme l'indépendance vis-à-vis de toute rémunération", () => {
    render(<Page />);
    const independence = section("Indépendance");
    const text = plain(independence.textContent ?? "");
    expect(text).toContain(
      "Aucune rémunération ne peut obtenir ou améliorer une Pépite : ni les cabinets d’avocats qui achètent une mise en avant, ni les organisateurs, vendeurs ou professionnels qui publient des annonces.",
    );
    expect(text).toContain("sans lien avec le repère");
    expect(text).toContain("ne change pas l’ordre par défaut des annonces");
    expect(
      within(independence)
        .getByRole("link", { name: "Comment sont classées les annonces" })
        .getAttribute("href"),
    ).toBe("/classement-des-annonces");
  });

  it("dit que l'absence du repère ne signifie ni désintérêt ni risque", () => {
    render(<Page />);
    expect(sectionText("Quand il n’y a pas de repère")).toContain(
      "L’absence de ce repère ne signifie pas que le bien est sans intérêt ni qu’il présente un risque.",
    );
  });

  it("permet de signaler une erreur par la page Contact et par email", () => {
    render(<Page />);
    const report = section("Signaler une erreur");
    expect(within(report).getByRole("link", { name: "Contact" }).getAttribute("href")).toBe(
      "/contact",
    );
    expect(
      within(report).getByRole("link", { name: "contact@immojudis.example" }).getAttribute("href"),
    ).toBe("mailto:contact@immojudis.example");
  });

  it("n'emploie ni superlatif promotionnel ni urgence", () => {
    const { container } = render(<Page />);
    const text = plain(container.textContent ?? "");
    expect(text).not.toMatch(
      /meilleur|exceptionnel|incroyable|ne manquez pas|dernière chance|\bvite\b/i,
    );
    expect(text).not.toMatch(/prix plafond|plafond d’enchère|enchère maximale|mise maximale/i);
  });
});
