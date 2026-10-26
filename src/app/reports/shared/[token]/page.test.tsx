import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SharedReportPage from "./page";
const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/property-reports", () => ({ getSharedPropertyReport: mocks.report }));

async function markup(personal: boolean | "v2", startingPrice = 50000) {
  mocks.report.mockResolvedValue({
    title: "Rapport de recette",
    updatedAt: "2026-09-09",
    sharedAt: null,
    sale: { startingPrice },
    analysis: { opportunity: { acquisitionCosts: { totalCost: 143000 } } },
    sourceTrace: [],
    limitations: [],
    ceiling: {
      available: true,
      maxBid: 244100,
      safetyDiscountPct: 8,
      basisLabel: "Médiane locale",
      ...(personal === "v2"
        ? {
            personalSimulation: {
              version: 2,
              choices: {
                project: "louer",
                profile: "prudent",
                works: { key: "devis", amount: 31000 },
                fpt: 5000,
              },
              expectedMaxBid: 244100,
            },
          }
        : personal
          ? {
              personalSimulation: {
                price: 100000,
                works: 31000,
                fpt: 5000,
                scenario: "prudent",
                manualMarketPricePerM2: null,
                expectedMaxBid: 244100,
              },
            }
          : {}),
    },
  });
  return renderToStaticMarkup(
    await SharedReportPage({ params: Promise.resolve({ token: "test" }) }),
  ).replace(/\s/g, "");
}

describe("shared personal simulation", () => {
  it("shows the saved hypotheses and simulated total alongside the same ceiling", async () => {
    const html = await markup(true);
    expect(html).toContain("Scénariopersonnelsauvegardé");
    for (const value of ["100000", "31000", "5000", "143000", "244100"])
      expect(html).toContain(value);
    expect(html).toContain("Coûtcompletauprixsimulé");
    expect(html).toContain("Médianelocale");
  });
  it("describes a scenario saved by the current engine", async () => {
    const html = await markup("v2");
    expect(html).toContain("Scénariopersonnelsauvegardé");
    for (const value of ["Louer", "Prudent", "31000", "5000"]) expect(html).toContain(value);
    expect(html).toContain("Coûtcompletàlamiseàprix");
  });
  it("shows a starting price of 0 as not communicated", async () => {
    const html = await markup(false, 0);
    expect(html).toMatch(/Miseàprix<\/p><p[^>]*>Prixnoncommuniqué</);
    expect(html).not.toMatch(/Miseàprix<\/p><p[^>]*>0€/);
  });
  it("does not invent personal inputs for a report without a saved simulation", async () => {
    expect(await markup(false)).not.toContain("Scénariopersonnelsauvegardé");
  });
});

describe("shared report of a sale by offers", () => {
  async function offersMarkup(ceiling: Record<string, unknown>) {
    mocks.report.mockResolvedValue({
      title: "Rapport vente interactive",
      updatedAt: "2026-10-26",
      sharedAt: null,
      sale: { startingPrice: 150000 },
      analysis: {
        occupancyAnalysis: { available: true },
        opportunity: { acquisitionCosts: { totalCost: 190000 } },
      },
      sourceTrace: [],
      limitations: [],
      ceiling: {
        available: true,
        maxBid: 120000,
        regime: "notary_online",
        label: "Offre plafond (simulation)",
        scopeNote: "Hors débours et formalités du notaire.",
        reserveNotice:
          "Le vendeur n’est pas tenu de retenir la meilleure offre ; prix de réserve inconnu.",
        estimatedFees: ["Honoraires de négociation"],
        safetyDiscountPct: 8,
        basisLabel: "Médiane locale",
        ...ceiling,
      },
    });
    return renderToStaticMarkup(
      await SharedReportPage({ params: Promise.resolve({ token: "test" }) }),
    ).replace(/\s/g, "");
  }

  it("uses the offer vocabulary and shows the reserve notice, the scope and the estimated fees", async () => {
    const html = await offersMarkup({
      personalSimulation: { version: 2, choices: { project: "louer" }, expectedMaxBid: 120000 },
    });
    expect(html).toContain("Premièreoffrepossible");
    expect(html).toContain("Offreplafond(simulation)");
    expect(html).toContain("Levendeurn’estpastenuderetenirlameilleureoffre;prixderéserveinconnu.");
    expect(html).toContain("Horsdébourset formalitésdunotaire.".replace(/\s/g, ""));
    expect(html).toContain("Fraisestimés,àconfirmer:Honorairesdenégociation.");
    expect(html).toContain("Coûtcompletàlapremièreoffrepossible");
    expect(html).not.toContain("Miseàprix");
    expect(html).not.toContain("avantenchère");
    expect(html).not.toContain("Enchèreplafond");
  });

  it("keeps the court wording for a report without a regime and does not invent a notice", async () => {
    const html = await offersMarkup({
      regime: undefined,
      label: undefined,
      scopeNote: null,
      reserveNotice: null,
      estimatedFees: [],
    });
    expect(html).toContain("Miseàprix");
    expect(html).toContain("Enchèreplafond(simulation)");
    expect(html).not.toContain("Réservessurleplafond");
    expect(html).not.toContain("n’estpastenuderetenir");
  });

  it("does not show the notices of a ceiling that is unavailable", async () => {
    const html = await offersMarkup({ available: false, maxBid: null });
    expect(html).toContain("Donnéesinsuffisantes");
    expect(html).not.toContain("n’estpastenuderetenir");
  });
});

describe("shared report evidence", () => {
  async function evidenceMarkup(evidence: unknown, nextActions: unknown) {
    mocks.report.mockResolvedValue({
      title: "Rapport de preuves",
      updatedAt: "2026-09-09",
      sale: {},
      analysis: Object.fromEntries(
        ["dpe", "occupancyAnalysis", "renovationAnalysis"].map((key) => [
          key,
          { available: true, evidence, nextActions },
        ]),
      ),
      ceiling: {},
      sourceTrace: [],
      limitations: [],
    });
    return renderToStaticMarkup(
      await SharedReportPage({ params: Promise.resolve({ token: "test" }) }),
    );
  }

  it("keeps four evidence entries and three actions in each analysis", async () => {
    const html = await evidenceMarkup(
      Array.from({ length: 6 }, (_, index) => ({
        label: `Preuve ${index}`,
        source: "Document officiel",
        excerpt: `Extrait ${index}`,
      })),
      Array.from({ length: 5 }, (_, index) => `Démarche ${index}`),
    );
    expect(html.match(/<ul /g)).toHaveLength(6);
    expect(html.match(/Preuve 3 · Document officiel · Extrait 3/g)).toHaveLength(3);
    expect(html).not.toContain("Preuve 4");
    expect(html.match(/Démarche 2/g)).toHaveLength(3);
    expect(html).not.toContain("Démarche 3");
  });

  it("omits empty lists when saved evidence is missing or malformed", async () => {
    for (const evidence of [null, {}, [null, false, {}, { label: "   " }]]) {
      expect(await evidenceMarkup(evidence, [null, false, "", "   "])).not.toContain("<ul ");
    }
  });
});

describe("shared report rent source", () => {
  async function rentMarkup(rentReference: unknown) {
    mocks.report.mockResolvedValue({
      title: "Rapport loyers",
      updatedAt: "2026-11-09",
      sharedAt: null,
      sale: { startingPrice: 100000 },
      analysis: { opportunity: { grossYieldPct: 6.2, rentReference } },
      sourceTrace: [],
      limitations: [],
    });
    return renderToStaticMarkup(
      await SharedReportPage({ params: Promise.resolve({ token: "test" }) }),
    );
  }

  it("credits the ANIL rent map, with its edition and a source link, beside the yield", async () => {
    const html = await rentMarkup({
      source: "anil_commune",
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });

    expect(html).toContain(
      "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
    );
    expect(html).toContain("mise à jour du 11 décembre 2025");
    expect(html).toContain('href="https://www.data.gouv.fr/datasets/693aa2feed1bf4da603faa49"');
  });

  it("labels the yields « charges comprises » for an ANIL rent, and keeps « net » for the others", async () => {
    const anil = await rentMarkup({ source: "anil_commune", vintage: 2025 });
    expect(anil).toContain("Rendement brut potentiel, charges comprises");
    expect(anil).toContain("Rendement estimé, charges comprises");
    expect(anil).not.toContain("Rendement net estimé");

    const department = await rentMarkup({ source: "department_estimate" });
    expect(department).toContain("Rendement net estimé");
    expect(department).not.toContain("charges comprises");
  });

  it("adds no credit to a report built on the department rent, or saved before the ANIL map", async () => {
    expect(await rentMarkup({ source: "department_estimate" })).not.toContain("ANIL");
    expect(await rentMarkup(undefined)).not.toContain("ANIL");
  });
});
