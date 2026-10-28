// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { HousingTension } from "@/lib/housing-tension";
import type { RentReference } from "@/lib/rent-reference";

vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));

import {
  RENTAL_MARKET_TITLE,
  RentalMarketBlock,
  YIELD_AT_STARTING_PRICE_LABEL,
  yieldText,
} from "./RentalMarketBlock";

afterEach(cleanup);

const SALE = {
  id: "sale-1",
  department: "33",
  property_type: "apartment",
  sale_venue_type: "tribunal",
} as never;

const RELIABLE: RentReference = {
  rentPerM2: 15.9931,
  lowPerM2: 12.272,
  highPerM2: 20.8427,
  source: "anil_commune",
  reliability: "reliable",
  segment: "apt_all",
  communeCode: "33063",
  observations: 84_641,
  vintage: 2025,
  sourceUpdatedOn: "2025-12-11",
};
const MAILLE: RentReference = {
  ...RELIABLE,
  rentPerM2: 9.7577,
  lowPerM2: 6.1,
  highPerM2: 14.2,
  source: "anil_maille",
  reliability: "indicative",
  observations: 3,
  segment: "house",
};
const TENSION: HousingTension = {
  communeCode: "33063",
  zoning: "tendue",
  decreeReference: "Décret n° 2025-1267 du 22 décembre 2025",
  sourceUpdatedOn: "2026-01-15",
  sourceUrl: "https://www.data.gouv.fr/datasets/zonage-tlv",
};

function renderBlock(overrides: Partial<Parameters<typeof RentalMarketBlock>[0]> = {}) {
  return render(
    <RentalMarketBlock
      sale={SALE}
      startingPriceEur={100_000}
      surfaceM2={50}
      reference={RELIABLE}
      tension={TENSION}
      {...overrides}
    />,
  );
}

describe("bloc « Marché locatif (estimation) »", () => {
  it("montre le loyer, sa fourchette, le nombre d'annonces et la mention ANIL avec son lien", () => {
    renderBlock();
    const block = screen.getByTestId("rental-market-block");
    expect(screen.getByRole("heading", { name: RENTAL_MARKET_TITLE })).toBeTruthy();
    expect(block.textContent).toContain("16,0 €/m² par mois");
    expect(block.textContent).toContain("charges comprises (fourchette de 12,3 €/m² à 20,8 €/m²)");
    expect(block.textContent).toContain("84\u202f641 annonces observées dans la commune");
    expect(block.textContent).toContain("Estimation calculée sur les annonces de la commune.");
    expect(block.textContent).toContain(
      "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
    );
    // Un lien de source pour la carte des loyers, un pour le zonage.
    expect(screen.getAllByRole("link", { name: "Source : data.gouv.fr" })).toHaveLength(2);
  });

  it("rendement à la mise à prix : libellé exact, valeur centrale et fourchette pour une référence fiable", () => {
    renderBlock();
    const block = screen.getByTestId("rental-market-block");
    expect(block.textContent).toContain(`${YIELD_AT_STARTING_PRICE_LABEL} :`);
    expect(YIELD_AT_STARTING_PRICE_LABEL).toBe(
      "Rendement brut à la mise à prix (charges comprises)",
    );
    expect(block.textContent).toMatch(
      /\d+,\d %\s*\(de \d+,\d % à \d+,\d % selon la fourchette de loyer\)/,
    );
    expect(block.textContent).toContain("pas une promesse de gain");
  });

  it("loyer de maille et référence indicative : « loyer de maille », fourchette seule, jamais de chiffre ponctuel", () => {
    renderBlock({ reference: MAILLE });
    const block = screen.getByTestId("rental-market-block");
    expect(block.textContent).toContain("Loyer de maille");
    expect(block.textContent).toContain("3 annonces observées");
    expect(block.textContent).toContain("maisons");
    expect(block.textContent).toMatch(/entre \d+,\d % et \d+,\d %/);
    expect(block.textContent).not.toMatch(/selon la fourchette de loyer/);
  });

  it("médiane des arrondissements ou du département : dit que le loyer est calculé par Immojudis, sans parler d'annonces de la commune", () => {
    const median = {
      ...RELIABLE,
      source: "anil_arrondissements_median",
      reliability: "indicative",
      observations: undefined,
      lowPerM2: undefined,
      highPerM2: undefined,
    } as RentReference;
    const { unmount } = renderBlock({ reference: median });
    let text = screen.getByTestId("rental-market-block").textContent;
    expect(text).toContain(
      "Loyer calculé par Immojudis : médiane des estimations ANIL des arrondissements, faute d’estimation propre à celui du bien. Indicatif.",
    );
    expect(text).not.toContain("annonces de la commune");
    unmount();
    renderBlock({ reference: { ...median, source: "anil_department_median" } });
    text = screen.getByTestId("rental-market-block").textContent;
    expect(text).toContain(
      "Loyer calculé par Immojudis : médiane des estimations ANIL des communes du département, faute d’estimation pour la commune du bien. Indicatif.",
    );
    expect(text).not.toContain("annonces observées");
  });

  it("zone tendue : ligne neutre avec la mention de source déjà rédigée, sans effet sur le rendement", () => {
    renderBlock();
    expect(screen.getByTestId("housing-tension-line").textContent).toContain(
      "Commune en zone tendue (TLV).",
    );
    expect(screen.getByTestId("housing-tension-line").textContent).toContain(
      "n’entre pas dans le calcul du rendement",
    );
    expect(screen.getByTestId("rental-market-block").textContent).toContain(
      "Source : ministère de la Transition écologique, liste des communes selon le zonage TLV (article 232 du code général des impôts), mise à jour du 15 janvier 2026 ; Licence Ouverte 2.0.",
    );
  });

  it("zone tendue seule (pas de loyer ANIL) : le bloc ne montre que le zonage, sans rendement", () => {
    renderBlock({
      reference: { rentPerM2: 14, source: "department_estimate", reliability: "indicative" },
    });
    const block = screen.getByTestId("rental-market-block");
    expect(block.textContent).toContain("zone tendue");
    expect(block.textContent).not.toContain(YIELD_AT_STARTING_PRICE_LABEL);
    expect(block.textContent).not.toContain("Estimations ANIL");
  });

  it("n'affiche rien sans loyer ANIL ni zonage", () => {
    const { container } = renderBlock({ reference: null, tension: null });
    expect(container.innerHTML).toBe("");
  });

  it("sans mise à prix lisible, ou pour une vente notariale aux conditions inconnues : aucun rendement", () => {
    renderBlock({ startingPriceEur: null });
    expect(screen.getByTestId("rental-market-block").textContent).not.toContain(
      YIELD_AT_STARTING_PRICE_LABEL,
    );
    cleanup();
    renderBlock({ sale: { ...(SALE as object), sale_venue_type: "notary" } as never });
    expect(screen.getByTestId("rental-market-block").textContent).not.toContain(
      YIELD_AT_STARTING_PRICE_LABEL,
    );
  });

  it("n'a pas de défaut d'accessibilité", async () => {
    const { container } = render(
      <main>
        <RentalMarketBlock
          sale={SALE}
          startingPriceEur={100_000}
          surfaceM2={50}
          reference={RELIABLE}
          tension={TENSION}
        />
      </main>,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("yieldText", () => {
  const range = { centralPct: 6, lowPct: 4.5, highPct: 8 };
  it("fiable : valeur et fourchette ; indicatif : fourchette seule ; indicatif sans borne : rien", () => {
    expect(yieldText(range, "reliable")).toBe(
      "6,0 % (de 4,5 % à 8,0 % selon la fourchette de loyer)",
    );
    expect(yieldText({ ...range, lowPct: null, highPct: null }, "reliable")).toBe("6,0 %");
    expect(yieldText(range, "indicative")).toBe("entre 4,5 % et 8,0 %");
    expect(yieldText({ ...range, lowPct: null, highPct: null }, "indicative")).toBeNull();
  });
});
