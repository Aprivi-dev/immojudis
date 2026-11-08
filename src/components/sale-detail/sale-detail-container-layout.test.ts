import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Repasse design n° 1 : dans la fiche, la colonne principale ne fait que ~550 à 780 px à côté du
// panneau collant. Les grilles réglées sur la largeur de l'écran s'y écrasaient (« Vos paramètres »
// lettre par lettre, scénarios de travaux en 4 colonnes de 30 px). jsdom ne calcule pas la mise en
// page : ce test garde les règles qui l'empêchent (vérifiées au navigateur à 1024, 1280 et 1440 px).

const read = (path: string) => readFileSync(path, "utf8");

/** Corps d'une règle CSS de premier niveau (`.stack { … }`). */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

const CONTAINER_BLOCKS = [
  "src/components/sale-detail/ListingWorks.module.css",
  "src/components/sale-detail/FinancingSimulator.module.css",
  "src/components/sale-detail/ListingRental.module.css",
  "src/components/sale-detail/ListingStatistics.module.css",
];

describe("fiche vente : grilles pilotées par la largeur de leur bloc", () => {
  it("met travaux et financement l'un sous l'autre, en pleine largeur", () => {
    const layout = read("src/components/sale-detail/SaleDetailLayout.module.css");
    expect(layout).not.toMatch(/\.pair\b/);
    expect(rule(layout, ".stack")).not.toContain("grid-template-columns");
    const section = read("src/components/sale-detail/SaleDetailWorksFinancingSection.tsx");
    expect(section).toContain('<DetailSection id="travaux-financement">');
    expect(section).toContain("layoutStyles.stack");
    expect(section.indexOf("<ListingWorks")).toBeLessThan(section.indexOf("<FinancingSimulator"));
  });

  it("fait de chaque section un conteneur de requêtes", () => {
    const layout = read("src/components/sale-detail/SaleDetailLayout.module.css");
    expect(rule(layout, ".sectionContent")).toContain("container-type: inline-size");
  });

  it.each(CONTAINER_BLOCKS)("%s : requêtes de conteneur, aucune largeur d'écran", (path) => {
    const css = read(path);
    expect(css).toContain("container-type: inline-size");
    expect(css).toMatch(/@container \((?:min|max)-width/);
    expect(css).not.toMatch(/@media \((?:min|max)-width/);
    // Les tailles de titre suivent le bloc (cqi), pas la fenêtre (vw).
    expect(css).not.toMatch(/\d+(?:\.\d+)?vw\b/);
    // Les titres ne se coupent pas en plein mot (la fiche impose `overflow-wrap: anywhere`).
    expect(css).toContain("overflow-wrap: break-word");
  });

  it("ouvre les colonnes des grilles seulement au-delà d'une largeur de bloc", () => {
    const works = read("src/components/sale-detail/ListingWorks.module.css");
    expect(rule(works, ".results")).toContain("grid-template-columns: minmax(0, 1fr);");
    const financing = read("src/components/sale-detail/FinancingSimulator.module.css");
    expect(rule(financing, ".layout")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(financing, ".twoColumns")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(financing, ".inputPanel")).toContain("container-type: inline-size");
    const stats = read("src/components/sale-detail/ListingStatistics.module.css");
    for (const grid of [".kpiGrid", ".familyGrid", ".priceMetricGrid"]) {
      expect(rule(stats, grid)).toContain("grid-template-columns: minmax(0, 1fr);");
    }
  });

  it("laisse la pastille passer sous le titre d'une carte", () => {
    const stats = read("src/components/sale-detail/ListingStatistics.module.css");
    expect(stats).toMatch(/\.distributionHeading \{\s*display: flex;\s*flex-wrap: wrap;/);
    const works = read("src/components/sale-detail/ListingWorks.module.css");
    expect(rule(works, ".resultTopline")).toContain("flex-wrap: wrap");
  });

  it("règle les scénarios de travaux, la procédure et l'avocat sur leur conteneur", () => {
    const scenarios = read("src/components/bid-ceiling/BidCeilingWorks.tsx");
    expect(scenarios).toContain("@container");
    expect(scenarios).toContain("@md:grid-cols-2 @4xl:grid-cols-4");
    expect(scenarios).not.toMatch(/\blg:grid-cols-4\b/);
    expect(scenarios).not.toMatch(/text-\[1[01]px\]/);

    const procedure = read("src/components/SaleProcedurePanel.tsx");
    expect(procedure).not.toMatch(/\b(?:sm|lg):grid-cols-/);
    expect(procedure).toContain("@4xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]");

    const lawyer = read("src/components/sale-detail/SaleDetailSections.tsx");
    expect(lawyer).not.toMatch(/\blg:grid-cols-/);
    expect(lawyer).toContain("@4xl:grid-cols-[minmax(0,0.85fr)_minmax(420px,1.15fr)]");
  });

  it("fiche visiteur : « Le bien » sur quatre colonnes selon la largeur de la section", () => {
    const css = read("src/components/SalePublicPreview.module.css");
    const container = css.slice(css.indexOf("@container (min-width: 600px)"));
    expect(container.slice(0, container.indexOf("\n}\n"))).toContain(
      "grid-template-columns: repeat(4, minmax(0, 1fr));",
    );
    // Deux règles seulement : deux colonnes par défaut, quatre dans la requête de conteneur.
    expect(css.match(/\.facts \{/g)).toHaveLength(2);
  });
});
