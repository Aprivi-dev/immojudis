import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPANY_DESCRIPTION } from "./company-description";
import { buildLlmsTxt } from "./llms-txt";
import { aboutPageStructuredData, organizationStructuredData } from "./seo";

const ORIGIN = "https://immojudis.com";

describe("description unique de l'entreprise", () => {
  it("tient dans une meta description sobre", () => {
    expect(COMPANY_DESCRIPTION.length).toBeGreaterThanOrEqual(140);
    expect(COMPANY_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(COMPANY_DESCRIPTION).not.toMatch(/garantie|conforme|certifi|gratuit|illimit/i);
    expect(COMPANY_DESCRIPTION).toMatch(/^Immojudis est /);
  });

  it("est la description de l'Organization et celle de l'AboutPage, qui la désigne par son @id", () => {
    const graph = (organizationStructuredData(ORIGIN) as { "@graph": Array<{ "@type": string }> })[
      "@graph"
    ];
    const organization = graph.find((node) => node["@type"] === "Organization");
    expect(organization).toMatchObject({
      "@id": `${ORIGIN}/#organisation`,
      description: COMPANY_DESCRIPTION,
    });
    const about = aboutPageStructuredData(ORIGIN);
    expect(about).toMatchObject({
      "@type": "AboutPage",
      url: `${ORIGIN}/a-propos`,
      description: COMPANY_DESCRIPTION,
      about: { "@id": `${ORIGIN}/#organisation`, description: COMPANY_DESCRIPTION },
      mainEntity: { "@id": `${ORIGIN}/#organisation` },
    });
    expect(JSON.stringify(about)).not.toMatch(/telephone|address|siret|siren/i);
  });

  it("ouvre aussi /llms.txt", () => {
    expect(buildLlmsTxt(ORIGIN)).toContain(`> ${COMPANY_DESCRIPTION}`);
  });

  it("est reprise, et non réécrite, par le site, l'accueil et la page À propos", () => {
    for (const file of ["src/app/layout.tsx", "src/app/page.tsx", "src/app/a-propos/page.tsx"]) {
      expect(readFileSync(file, "utf8"), file).toContain("COMPANY_DESCRIPTION");
    }
    // Les anciennes formulations ne reviennent pas.
    for (const file of ["src/app/layout.tsx", "src/app/page.tsx", "src/app/a-propos/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(
        /annonces immobilières référencées|Ventes au tribunal, notariales et domaniales référencées|centralise les annonces/,
      );
    }
  });
});
