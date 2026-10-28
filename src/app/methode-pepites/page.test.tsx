// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_GAP_METHOD_PATH } from "@/lib/market-gap";
import { FLOOD_FORBIDDEN_WORDS } from "@/lib/pepite-flood-copy";
import * as policy from "@/lib/pepite-policy";
import {
  PEPITE_METHOD_PATH,
  PEPITE_RULE_PARAMS,
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_V1_RULE_VERSION,
  pepiteV2EffectiveClause,
} from "./method";
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
    expect(description.length).toBeLessThanOrEqual(155);
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

  it("dit ce que c'est : un repère calculé automatiquement sur des critères publics, sans promesse de potentiel", () => {
    render(<Page />);
    const text = sectionText("Ce qu’est le repère « Pépite »");
    expect(text).toContain("repère calculé automatiquement par Immojudis");
    expect(text).toContain("critères publics");
    expect(text).toContain(
      "Il signale les ventes qui remplissent deux conditions chiffrées, calculées sur les données disponibles.",
    );
    expect(text).toContain("(en vente notariale, seule la seconde est posée)");
    expect(text).not.toMatch(/potentiel d’investissement/);
    expect(text).toContain(
      "Les ventes comparables passées ont-elles été le plus souvent adjugées sous l’enchère plafond estimée ? Immojudis regarde si au moins 70 % l’ont été.",
    );
    expect(text).toContain(
      "Le coût total estimé au prix de référence, frais compris, représente-t-il au plus 75 % de la valeur estimée (65 % en vente notariale) ?",
    );
    expect(text).toContain(
      "La valeur estimée est celle d’un bien comparable, d’après les ventes passées de la base Demande de valeurs foncières (DVF) ; elle ne tient compte ni de l’état du bien ni de son occupation.",
    );
    expect(text).toContain("Le prix de référence est un repère statistique, décrit plus bas.");
    expect(text).toContain(
      "Lorsqu’une vente remplit les critères, sa fiche et sa ligne dans la liste portent un badge",
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
    expect(PEPITE_LATEST_RULE_VERSION).toBe(policy.PEPITE_LATEST_RULE_VERSION);
    expect(PEPITE_RULE_PARAMS).toEqual({
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
      // Lissage : recopié de la migration 20261101120100 (voir `method.ts`), 30 et 10 aussi côté application.
      minNationalSales: 30,
      minCourtSales: 10,
      smoothingWeightSales: 15,
      priceCourtOnlyFromSales: 20,
      lowStartingPricePct: policy.PEPITE_LOW_STARTING_PRICE_SHARE * 100,
      maxEvaluationAgeHours: policy.PEPITE_MAX_EVALUATION_AGE_HOURS,
    });
  });

  it("décrit le lissage comme la migration SQL le calcule (30 ventes en France, 10 au tribunal, poids 15, quantiles à 20)", () => {
    const sql = readFileSync(
      "supabase/migrations/20261101120100_auction_scenarios_reliability.sql",
      "utf8",
    );
    expect(sql).toContain(`sizes.n_national < ${PEPITE_RULE_PARAMS.minNationalSales}`);
    expect(sql).toContain(`sizes.n_court >= ${PEPITE_RULE_PARAMS.minCourtSales}`);
    expect(sql).toContain(
      `${PEPITE_RULE_PARAMS.smoothingWeightSales} * bucket_counts.national_count`,
    );
    expect(sql).toContain(
      `sizes.n_court >= ${PEPITE_RULE_PARAMS.priceCourtOnlyFromSales} then 'court'`,
    );
  });

  it("donne les seuils de pepite-v1.1 à partir des constantes de la règle", () => {
    render(<Page />);
    const text = sectionText("Les critères et les seuils");
    // Interrupteur fermé (défaut) : la page décrit la règle appliquée, pepite-v1.
    expect(PEPITE_V1_RULE_VERSION).toBe("pepite-v1");
    expect(text).toContain("Version pepite-v1.");
    expect(text).not.toContain("indiquée sur cette page");
    expect(PEPITE_RULE_PARAMS.chanceMinPct).toBe(70);
    expect(PEPITE_RULE_PARAMS.maxCostShareCourtPct).toBe(75);
    expect(PEPITE_RULE_PARAMS.maxCostShareNotaryPct).toBe(65);
    expect(text).toContain(`Au moins ${PEPITE_RULE_PARAMS.chanceMinPct} % des ventes comparables`);
    expect(text).toContain(
      `d’au plus ${PEPITE_RULE_PARAMS.maxCostShareCourtPct} % de la valeur estimée`,
    );
    expect(text).toContain(`au plus ${PEPITE_RULE_PARAMS.maxCostShareNotaryPct} %`);
    expect(text).toContain(`${PEPITE_RULE_PARAMS.historyYears} dernières années`);
    expect(text).toContain("Version pepite-v1.1. Les seuils ci-dessous");
    expect(text).toContain("Le repère est affiché depuis le 26 octobre 2026.");
    expect(text).toContain(
      `Il faut au moins ${PEPITE_RULE_PARAMS.minNationalSales} ventes comparables en France, tribunaux confondus.`,
    );
    expect(text).toContain(
      `À partir de ${PEPITE_RULE_PARAMS.minCourtSales} ventes comparables au tribunal, la part des ventes adjugées sous l’enchère plafond estimée combine celle du tribunal et la part nationale, qui compte pour ${PEPITE_RULE_PARAMS.smoothingWeightSales} ventes`,
    );
    expect(text).toContain(
      `Sous ${PEPITE_RULE_PARAMS.minCourtSales} ventes au tribunal, le premier critère ne peut pas être évalué et il n’y a pas de repère.`,
    );
    expect(text).toContain(
      `ventes du tribunal seules à partir de ${PEPITE_RULE_PARAMS.priceCourtOnlyFromSales} ventes, sur celles de toute la France en dessous`,
    );
    expect(text).not.toMatch(/complétée par celle de toute la France|remplacée par elle/);
    expect(text).toContain("Vente au tribunal");
    expect(text).toContain("Vente notariale à la bougie");
    expect(text).toContain("Vente notariale interactive");
    expect(text).toContain("Vente domaniale ou de type inconnu : pas de repère");
    expect(text).toContain("prix de réserve inconnu");
    expect(text).toContain(
      "L’offre plafond estimée doit en outre être au moins égale à cette première offre",
    );
  });

  it("règle pepite-v2 fermée (défaut) : aucune trace du risque d'inondation sur la page", () => {
    const { container } = render(<Page />);
    const text = plain(container.textContent ?? "");
    expect(screen.queryByRole("region", { name: "Le risque d’inondation" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Historique des versions" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Sources des données" })).toBeNull();
    expect(text).not.toMatch(/inondation|TRI\b|Géorisques|PPRi/);
  });

  it("énonce les garde-fous", () => {
    render(<Page />);
    const guard = section("Les garde-fous");
    const text = plain(guard.textContent ?? "");
    expect(within(guard).getAllByRole("listitem")).toHaveLength(4);
    expect(text).toContain(`au moins ${PEPITE_RULE_PARAMS.minValueComparables} ventes comparables`);
    expect(text).toContain("Un terrain seul et un bien mixte n’ont pas de repère");
    expect(PEPITE_RULE_PARAMS.extremeStartingPriceBelowPct).toBe(10);
    expect(PEPITE_RULE_PARAMS.extremeStartingPriceAbovePct).toBe(150);
    expect(text).toContain(
      `une mise à prix inférieure à ${PEPITE_RULE_PARAMS.extremeStartingPriceBelowPct} % ou supérieure à ${PEPITE_RULE_PARAMS.extremeStartingPriceAbovePct} % de la valeur estimée signale le plus souvent une erreur de données, et la vente est alors écartée`,
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
      `après ${PEPITE_RULE_PARAMS.favourableEvaluations} évaluations favorables consécutives`,
    );
    expect(text).toContain(`sous ${PEPITE_RULE_PARAMS.exitChanceBelowPct} %`);
    expect(text).toContain(`dépasse ${PEPITE_RULE_PARAMS.exitCostShareAbovePct} %`);
    expect(text).toContain(`dépasse ${PEPITE_RULE_PARAMS.exitCostShareNotaryAbovePct} %`);
    expect(PEPITE_RULE_PARAMS.exitCostShareNotaryAbovePct).toBeGreaterThan(
      PEPITE_RULE_PARAMS.maxCostShareNotaryPct,
    );
    expect(text).toContain(`figé ${PEPITE_RULE_PARAMS.freezeDaysBeforeSale} jours avant la vente`);
    expect(PEPITE_RULE_PARAMS.exitChanceBelowPct).toBeLessThan(PEPITE_RULE_PARAMS.chanceMinPct);
    expect(PEPITE_RULE_PARAMS.exitCostShareAbovePct).toBeGreaterThan(
      PEPITE_RULE_PARAMS.maxCostShareCourtPct,
    );
  });

  it("présente le prix de référence avec sa réserve, jamais comme une prévision", () => {
    render(<Page />);
    const text = sectionText("Le prix de référence et ses limites");
    expect(text).not.toMatch(/prix probable|probable/);
    expect(text).toContain(
      "« Repère statistique tiré de N ventes comparables passées du tribunal (fiabilité X). La moitié de ces ventes s’est conclue dans la fourchette indiquée, l’autre moitié en dehors. Ce n’est pas une prévision : le prix final peut être inférieur ou supérieur. »",
    );
    expect(text).toContain("Lorsqu’il est affiché, le prix de référence l’est avec cette réserve");
    expect(text).toContain(
      "Pour une vente notariale, Immojudis affiche le prix de départ (la première offre possible, pour une vente par offres) et, pour une vente par offres, indique que le prix de réserve du vendeur est inconnu ; il ne donne pas de prix de référence, faute d’historique des résultats.",
    );
    expect(text).toContain("offre Analyse ou déblocage de la vente");
    expect(text).toContain("prix de réserve du vendeur est inconnu");
    expect(text).toContain("« enchère plafond estimée »");
    expect(text).toContain("« offre plafond estimée »");
    expect(text).not.toContain("intéressant jusqu’à");
  });

  it("dit qui voit quoi, sans dire combien de pépites sont affichées", () => {
    const { container } = render(<Page />);
    const text = sectionText("Ce qui est visible, et par qui");
    expect(text).toContain("Lorsqu’il est attribué, le repère « Pépite » est visible par tous");
    expect(text).toContain("réservés à l’offre Analyse ou à un déblocage");
    expect(text).toContain(
      "Cela n’a aucune influence sur l’attribution du repère, qui obéit aux seuls critères publiés sur cette page.",
    );
    const all = plain(container.textContent ?? "");
    expect(all).not.toMatch(/\b(actuellement)\b[^.]*pépite/i);
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
    expect(text).toContain(`moins de ${PEPITE_RULE_PARAMS.maxEvaluationAgeHours} heures`);
    expect(text).toContain("Immojudis peut suspendre le repère pour l’ensemble du site");
    expect(text).toContain("Le repère est recalculé régulièrement, au moins une fois par jour.");
    expect(text).toContain("Il disparaît quand une condition n’est plus remplie");
    expect(text).not.toMatch(/serait|pourrait|disparaîtrait/);
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

  it("répond en quatre questions visibles, avec les formulations de la page", () => {
    render(<Page />);
    const faq = section("Questions fréquentes");
    expect(
      within(faq)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      "Qu’est-ce qu’une pépite ?",
      "Est-ce un conseil ?",
      "Pourquoi ce bien n’a-t-il pas de pépite ?",
      "Qui peut obtenir une pépite ?",
    ]);
    const text = plain(faq.textContent ?? "");
    expect(text).toContain("C’est un repère calculé automatiquement par Immojudis");
    expect(text).toContain("au moins 70 % des ventes comparables passées");
    expect(text).toContain("ne dépasse pas 75 % de la valeur estimée (65 % en vente notariale");
    expect(text).toContain("Non. Ce n’est pas un conseil en investissement");
    expect(text).toContain(
      "L’absence de ce repère ne signifie pas que le bien est sans intérêt ni qu’il présente un risque.",
    );
    expect(text).toContain("Aucune rémunération ne peut obtenir ou améliorer une Pépite");
    expect(text).not.toMatch(/inondation|Géorisques|PPRi/);
  });

  it("n'ajoute pas de données structurées FAQ (à ajouter après relecture juridique)", () => {
    const { container } = render(<Page />);
    const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
    expect(scripts.some((script) => /FAQPage/.test(script.textContent ?? ""))).toBe(false);
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

describe("page de méthode : règle pepite-v2 (interrupteur PEPITE_RULE_V2_ENABLED ouvert)", () => {
  beforeEach(() => vi.stubEnv("PEPITE_RULE_V2_ENABLED", "true"));

  it("annonce la version pepite-v2 et garde les mêmes seuils que la v1", () => {
    render(<Page />);
    const text = sectionText("Les critères et les seuils");
    expect(text).toContain("Version pepite-v2.");
    expect(text).toContain(`Au moins ${PEPITE_RULE_PARAMS.chanceMinPct} % des ventes comparables`);
  });

  it("décrit le critère d'inondation : TRI, position précise, position imprécise, PPRi, limites", () => {
    render(<Page />);
    const text = sectionText("Le risque d’inondation");
    expect(text).toContain(
      "Depuis la version pepite-v2, le repère n’est pas attribué à un bien dont la position connue se trouve dans la zone que la crue fréquente d’un territoire à risque important d’inondation (TRI) inonderait.",
    );
    expect(text).toContain(
      "Immojudis consulte pour cela la cartographie officielle des TRI diffusée par Géorisques, à partir des coordonnées du bien.",
    );
    expect(text).toContain("Ce contrôle suppose une position précise (adresse ou parcelle).");
    expect(text).toContain(
      "si la commune compte un TRI, la vente ne reçoit pas le repère ; si elle n’en compte pas, le contrôle n’a pas d’objet et le repère reste possible, sans vérification du risque d’inondation du bien.",
    );
    expect(text).toContain(
      "Un bien déjà repéré dont le contrôle devient impossible (position retirée, source indisponible) garde son repère jusqu’à la vente ; la fiche l’indique.",
    );
    expect(text).toContain(
      "Quand le bien se trouve dans le périmètre d’un plan de prévention des risques d’inondation (PPRi) d’après le Géoportail de l’urbanisme, le repère peut être attribué, mais la fiche le signale",
    );
    expect(text).toContain("Son zonage est à vérifier.");
    expect(text).toContain(
      "Ce contrôle n’est ni une expertise, ni un état des risques, ni un certificat.",
    );
    expect(text).toContain("article L. 125-5 du code de l’environnement");
    expect(text).toContain("ni l’avis de votre avocat ou du notaire");
  });

  it("n'écrit aucune date réservée tant que la date d'entrée en vigueur n'est pas renseignée", () => {
    expect(pepiteV2EffectiveClause(null)).toBe("");
    expect(pepiteV2EffectiveClause("27 novembre 2026")).toBe(" (en vigueur le 27 novembre 2026)");
    const { container } = render(<Page />);
    expect(container.textContent).not.toMatch(/\[date\]|à renseigner|undefined|null/);
  });

  it("ajoute au « ce que ce n'est pas » l'état des risques et la garantie d'absence de risque", () => {
    render(<Page />);
    const text = sectionText("Ce que le repère n’est pas");
    expect(text).toContain(
      "Ce n’est ni un état des risques, ni un certificat, et cela ne remplace pas l’état des risques annexé au cahier des conditions de vente.",
    );
    expect(text).toContain("Ce n’est pas une garantie d’absence de risque d’inondation.");
  });

  it("ajoute le garde-fou d'inondation (cinq garde-fous)", () => {
    render(<Page />);
    const guard = section("Les garde-fous");
    expect(within(guard).getAllByRole("listitem")).toHaveLength(5);
    expect(plain(guard.textContent ?? "")).toContain(
      "Le bien n’est pas situé, à sa position connue, dans la zone de crue fréquente d’un territoire à risque important d’inondation (voir « Le risque d’inondation »).",
    );
  });

  it("remplace la deuxième puce de « ce que le repère ne mesure pas »", () => {
    render(<Page />);
    const text = sectionText("Ce que le repère ne mesure pas");
    expect(text).toContain(
      "Les charges de copropriété, les servitudes, l’urbanisme, les diagnostics (dont l’état des risques) et les risques juridiques de la procédure, qui se lisent dans le cahier des conditions de vente et les pièces. Seul le risque d’inondation fait l’objet d’un contrôle cartographique limité, décrit plus haut.",
    );
    expect(text).toContain("L’état réel du bien");
  });

  it("dit que l'absence du repère ne permet aucune conclusion, sans donner la raison", () => {
    render(<Page />);
    const text = sectionText("Quand il n’y a pas de repère");
    expect(text).toContain(
      "L’absence de ce repère ne permet de tirer aucune conclusion sur le bien : les données peuvent manquer, ou un critère, dont celui du risque d’inondation, peut ne pas être rempli. Immojudis n’indique pas, vente par vente, la raison.",
    );
    expect(text).not.toContain("ne signifie pas que le bien est sans intérêt");
  });

  it("donne l'historique des versions", () => {
    render(<Page />);
    const text = sectionText("Historique des versions");
    expect(text).toContain("pepite-v2 : ajout du contrôle du risque d’inondation.");
    expect(text).toContain("pepite-v1 (depuis le 26 octobre 2026) : version initiale.");
  });

  it("cite les sources, la licence et la précaution sur les mentions", () => {
    render(<Page />);
    const text = sectionText("Sources des données");
    expect(text).toContain("Géorisques (ministère de la Transition écologique, BRGM)");
    expect(text).toContain("Géoportail de l’urbanisme (IGN)");
    expect(text).toContain("API Carto");
    expect(text).toContain("Licence Ouverte 2.0");
    expect(text).toContain(
      "Ces mentions ne signifient pas que Géorisques, l’IGN ou leurs partenaires cautionnent ce repère, calculé par Immojudis.",
    );
    expect(text).toContain("Seules les coordonnées géographiques du bien sont transmises");
    expect(text).toContain("La date de la carte consultée est enregistrée pour chaque bien.");
    expect(text).not.toMatch(/premier cycle/);
  });

  it("n'emploie aucun mot interdit, sans exception", () => {
    const { container } = render(<Page />);
    const text = plain(container.textContent ?? "");
    expect(text).toContain("Il ne signifie pas l’absence de risque d’inondation");
    for (const forbidden of FLOOD_FORBIDDEN_WORDS) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it("décrit la position « rue » testée avec un tampon, et le périmètre de PPRi non contrôlé", () => {
    render(<Page />);
    const text = sectionText("Le risque d’inondation");
    expect(text).toContain("tampon de 100 mètres");
    expect(text).toContain("entièrement dans la zone de crue fréquente, ou entièrement en dehors");
    expect(text).toContain("périmètres de PPRi n’ont pas pu être consultés");
  });

  it("garde un seul titre de niveau 1 et reste sobre", () => {
    const { container } = render(<Page />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(plain(container.textContent ?? "")).not.toMatch(
      /meilleur|exceptionnel|incroyable|ne manquez pas|dernière chance|\bvite\b/i,
    );
  });
});
