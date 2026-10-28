// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import {
  NOTARY_AUCTION_FEE_REGIME,
  NOTARY_ONLINE_FEE_REGIME,
  type FeeRegime,
} from "@/lib/fee-regime";
import type { MarketEstimate } from "@/lib/market.server";
import type { RentReference } from "@/lib/rent-reference";
import type { AuctionSale } from "@/lib/types";
import { CeilingHypothesesPanel } from "./CeilingHypothesesPanel";

afterEach(cleanup);

const sale = {
  id: "sale-1",
  department: "34",
  property_type: "apartment",
  occupancy_status: "vacant",
  starting_price_eur: 30_000,
  app_surface_m2: 80,
  app_surface_kind: "habitable",
} as unknown as AuctionSale;

const estimate = {
  actionable: true,
  estimatedValueEur: 160_000,
  medianPricePerM2: 2_000,
  p75PricePerM2: 2_200,
  qualityLabel: "forte",
  sampleSize: 20,
} as unknown as MarketEstimate;

const seen: { choices: CeilingUserChoices } = { choices: {} };

function Harness({
  initial = {},
  saleOverride = sale,
  regime = null,
  rentReference = null,
}: {
  initial?: CeilingUserChoices;
  saleOverride?: AuctionSale;
  regime?: FeeRegime | null;
  rentReference?: RentReference | null;
}) {
  const [choices, setChoices] = useState<CeilingUserChoices>(initial);
  useEffect(() => {
    seen.choices = choices;
  }, [choices]);
  return (
    <CeilingHypothesesPanel
      hypotheses={buildCeilingHypotheses(saleOverride, estimate, choices, regime, rentReference)}
      choices={choices}
      onChoicesChange={(change) => setChoices((current) => change(current))}
    />
  );
}

/** Le nom d'un champ est « libellé (unité) » : l'unité suit le libellé dans le texte masqué. */
function withUnit(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`);
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(withUnit(label)) as HTMLInputElement;
}

describe("CeilingHypothesesPanel number fields", () => {
  it("shows the default for a field that was not touched", () => {
    render(<Harness />);

    expect(input("Frais préalables").value).toBe("5000");
  });

  it("keeps a cleared field empty while typing, with the default as placeholder", () => {
    render(<Harness />);
    const field = input("Frais préalables");

    fireEvent.change(field, { target: { value: "" } });

    expect(field.value).toBe("");
    expect(field.placeholder).toBe("5000");
  });

  it("lets the user clear a field then type a new amount", () => {
    render(<Harness />);
    const field = input("Frais préalables");

    fireEvent.change(field, { target: { value: "" } });
    fireEvent.change(field, { target: { value: "8" } });
    fireEvent.change(field, { target: { value: "800" } });

    expect(field.value).toBe("800");
    expect(seen.choices.fpt).toBe(800);
    fireEvent.blur(field);
    expect(field.value).toBe("800");
  });

  it("falls back to the default when a cleared field is left, on blur and on Enter", () => {
    render(<Harness initial={{ fpt: 800, lawyerFees: 2_000 }} />);
    const fees = input("Frais préalables");
    const lawyer = input("Honoraires de votre avocat");

    fireEvent.change(fees, { target: { value: "" } });
    expect(seen.choices.fpt).toBeNull();
    fireEvent.blur(fees);
    expect(fees.value).toBe("5000");

    fireEvent.change(lawyer, { target: { value: "" } });
    expect(lawyer.value).toBe("");
    fireEvent.keyDown(lawyer, { key: "Enter" });
    expect(lawyer.value).not.toBe("");
    expect(seen.choices.lawyerFees).toBeNull();
  });

  it("keeps 0 as a real amount for the fees", () => {
    render(<Harness />);
    const field = input("Frais préalables");

    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);

    expect(seen.choices.fpt).toBe(0);
    expect(field.value).toBe("0");
  });
});

describe("CeilingHypothesesPanel price per m²", () => {
  it("announces the user's price only once a positive price is entered", () => {
    render(<Harness />);
    const field = input("Prix au m² du bien");

    expect(screen.queryByText(/Votre prix remplace/)).toBeNull();
    fireEvent.change(field, { target: { value: "2500" } });
    expect(screen.getByText(/Votre prix remplace l’estimation/)).toBeTruthy();
    expect(seen.choices.manualPricePerM2).toBe(2_500);
  });

  it("treats 0 as not entered: back to the estimate, no replacement notice", () => {
    render(<Harness initial={{ manualPricePerM2: 2_500 }} />);
    const field = input("Prix au m² du bien");
    expect(screen.getByText(/Votre prix remplace/)).toBeTruthy();

    fireEvent.change(field, { target: { value: "0" } });
    expect(seen.choices.manualPricePerM2).toBeNull();
    expect(screen.queryByText(/Votre prix remplace/)).toBeNull();
    fireEvent.blur(field);
    expect(field.value).toBe("2000");
  });

  it("ignores a stored price of 0", () => {
    render(<Harness initial={{ manualPricePerM2: 0 }} />);

    expect(screen.queryByText(/Votre prix remplace/)).toBeNull();
    expect(input("Prix au m² du bien").value).toBe("2000");
  });
});

describe("CeilingHypothesesPanel rent", () => {
  it("treats a rent of 0 as not entered and keeps the reference rent", () => {
    render(<Harness initial={{ project: "louer", monthlyRent: 1_200 }} />);
    const field = input("Loyer mensuel hors charges");
    expect(field.value).toBe("1200");

    fireEvent.change(field, { target: { value: "0" } });
    expect(seen.choices.monthlyRent).toBeNull();
    fireEvent.blur(field);
    expect(field.value).toBe("1040");
  });

  it("asks for a rent where no reference exists", () => {
    render(
      <Harness
        initial={{ project: "louer" }}
        saleOverride={{ ...sale, department: "23" } as unknown as AuctionSale}
      />,
    );

    expect(input("Loyer mensuel hors charges").value).toBe("");
    expect(
      screen.getByText(/Aucun loyer de référence pour cette commune ni pour ce département/),
    ).toBeTruthy();
  });

  it("says charges are included and credits the ANIL when the rent comes from its map", async () => {
    render(
      <Harness
        initial={{ project: "louer" }}
        rentReference={{
          rentPerM2: 14,
          source: "anil_commune",
          reliability: "reliable",
          segment: "apt_all",
          communeCode: "34172",
          lowPerM2: 11,
          highPerM2: 17,
          observations: 900,
          vintage: 2025,
          sourceUpdatedOn: "2025-12-11",
        }}
      />,
    );

    // 80 m² x 14 EUR, shown as an estimate of the advertised rent, charges included.
    expect(
      input("Loyer d’annonce estimé, charges comprises (le loyer hors charges est plus bas)").value,
    ).toBe("1120");
    expect(screen.queryByLabelText(withUnit("Loyer mensuel hors charges"))).toBeNull();
    expect(screen.getByText(/non constaté et non garanti/)).toBeTruthy();
    // La mention est chargée à la demande (un seul morceau partagé).
    await waitFor(() => expect(document.querySelector("[data-rent-source-notice]")).not.toBeNull());
    const notice = document.querySelector("[data-rent-source-notice]")!;
    expect(notice.textContent).toContain(
      "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
    );
    expect(notice.textContent).toContain("Carte des loyers 2025");
    expect(notice.textContent).toContain("mise à jour du 11 décembre 2025");
    expect(notice.textContent).toContain("Licence Ouverte 2.0");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.data.gouv.fr/datasets/693aa2feed1bf4da603faa49",
    );
  });

  it("flags an indicative reliability and never calls the department rent a charges-excluded rent", () => {
    render(<Harness initial={{ project: "louer" }} />);

    expect(input("Loyer estimé du département").value).toBe("1040");
    expect(document.querySelector("[data-rent-source-notice]")).toBeNull();
    cleanup();

    render(
      <Harness
        initial={{ project: "louer" }}
        rentReference={{
          rentPerM2: 9.5,
          source: "anil_maille",
          reliability: "indicative",
          segment: "apt_all",
          communeCode: "34172",
          lowPerM2: null,
          highPerM2: null,
          observations: 4,
          vintage: 2025,
          sourceUpdatedOn: "2025-12-11",
        }}
      />,
    );
    expect(screen.getByText(/fiabilité indicative/)).toBeTruthy();
  });

  it("keeps the charges-excluded label for a rent the user typed", () => {
    render(<Harness initial={{ project: "louer", monthlyRent: 700 }} />);

    expect(input("Loyer mensuel hors charges").value).toBe("700");
    expect(document.querySelector("[data-rent-source-notice]")).toBeNull();
  });
});

describe("CeilingHypothesesPanel : aide des frais estimés (tribunal)", () => {
  it("dit comment remplacer les frais préalables par le montant lu dans le cahier des conditions de vente", () => {
    render(<Harness />);
    expect(
      screen.getByText(/Saisissez le montant lu dans le cahier : il remplace la valeur par défaut/),
    ).toBeTruthy();
    fireEvent.change(input("Frais préalables"), { target: { value: "4200" } });
    expect(screen.getByText("Montant que vous avez saisi.")).toBeTruthy();
    expect(seen.choices.fpt).toBe(4_200);
  });
});

describe("CeilingHypothesesPanel : ventes notariales", () => {
  const online = {
    ...sale,
    sale_venue_type: "notary",
    sale_conditions: {
      procedure: "online_tender",
      first_offer_eur: 30_000,
      negotiation_fee_rate: 0.045,
      negotiation_fee_payer: "ACQUEREUR",
      advertising_fees_eur: 1_200,
    },
  } as unknown as AuctionSale;
  const auction = {
    ...sale,
    sale_venue_type: "notary",
    sale_conditions: { procedure: "notarial_auction" },
  } as unknown as AuctionSale;

  it("n'a ni frais préalables ni honoraires d'avocat, et lit honoraires de négociation et publicité (vente interactive)", () => {
    render(<Harness saleOverride={online} regime={NOTARY_ONLINE_FEE_REGIME} />);
    expect(screen.queryByLabelText(withUnit("Frais préalables"))).toBeNull();
    expect(screen.queryByLabelText(withUnit("Honoraires de votre avocat"))).toBeNull();
    expect(screen.queryByLabelText(withUnit("Garantie à déposer"))).toBeNull();
    expect(input("Honoraires de négociation").value).toBe("4.5");
    expect(input("Frais de publicité").value).toBe("1200");
    expect(screen.getByText("Taux lu dans l’annonce, à la charge de l’acquéreur.")).toBeTruthy();
    expect(screen.getByText("Montant lu dans l’annonce.")).toBeTruthy();
  });

  it("remplace le taux de négociation par la saisie de l'utilisateur", () => {
    render(<Harness saleOverride={online} regime={NOTARY_ONLINE_FEE_REGIME} />);
    fireEvent.change(input("Honoraires de négociation"), { target: { value: "3" } });
    expect(seen.choices.negotiationFeeRatePct).toBe(3);
    expect(screen.getByText("Taux que vous avez saisi.")).toBeTruthy();
    fireEvent.change(input("Frais de publicité"), { target: { value: "800" } });
    expect(seen.choices.advertisingFees).toBe(800);
  });

  it("dit que rien n'est compté quand le taux ou le redevable manquent, à confirmer dans les conditions de la vente", () => {
    const noRate = {
      ...online,
      sale_conditions: { procedure: "online_tender", first_offer_eur: 30_000 },
    } as unknown as AuctionSale;
    render(<Harness saleOverride={noRate} regime={NOTARY_ONLINE_FEE_REGIME} />);
    expect(
      screen.getByText(/Taux non indiqué dans l’annonce : aucun honoraire n’est compté/),
    ).toBeTruthy();
    expect(screen.getByText(/Non indiqués dans l’annonce : 0 € est compté/)).toBeTruthy();
    cleanup();
    const vendor = {
      ...online,
      sale_conditions: { ...online.sale_conditions, negotiation_fee_payer: "VENDEUR" },
    } as unknown as AuctionSale;
    render(<Harness saleOverride={vendor} regime={NOTARY_ONLINE_FEE_REGIME} />);
    expect(
      screen.getByText("À la charge du vendeur d’après l’annonce : rien n’est compté."),
    ).toBeTruthy();
  });

  it("propose la garantie à déposer d'une vente à la bougie, par défaut 20 % de la mise à prix, à confirmer", () => {
    render(<Harness saleOverride={auction} regime={NOTARY_AUCTION_FEE_REGIME} />);
    expect(input("Garantie à déposer").value).toBe("6000");
    expect(screen.getByText(/Valeur par défaut \(20 % de la mise à prix\)/)).toBeTruthy();
    expect(screen.queryByLabelText(withUnit("Honoraires de négociation"))).toBeNull();
    expect(screen.queryByLabelText(withUnit("Frais préalables"))).toBeNull();
    fireEvent.change(input("Garantie à déposer"), { target: { value: "7500" } });
    expect(seen.choices.consignation).toBe(7_500);
    expect(screen.getByText("Montant que vous avez saisi.")).toBeTruthy();
  });

  it("cite le barème des émoluments du notaire, à confirmer sur Légifrance, et ne parle pas du titre d'expulsion judiciaire", () => {
    render(
      <Harness
        saleOverride={auction}
        regime={NOTARY_AUCTION_FEE_REGIME}
        initial={{ occupation: "occupe" }}
      />,
    );
    expect(screen.getByText(/émoluments du notaire suivent le barème réglementé/)).toBeTruthy();
    expect(screen.getByText(/à confirmer sur Légifrance/)).toBeTruthy();
    expect(screen.getByText(/pas de titre d’expulsion automatique/)).toBeTruthy();
    expect(screen.queryByText(/Commandement, délais du juge/)).toBeNull();
  });
});

describe("CeilingHypothesesPanel : charges récupérables et rendement", () => {
  const anil: RentReference = {
    rentPerM2: 14,
    source: "anil_commune",
    reliability: "reliable",
    segment: "apt_all",
    communeCode: "34172",
    lowPerM2: 11,
    highPerM2: 17,
    observations: 900,
    vintage: 2025,
    sourceUpdatedOn: "2025-12-11",
  };
  const CHARGES = "Charges récupérables comprises dans le loyer";

  it("offers an empty, editable field for the recoverable charges, with no invented amount", () => {
    render(<Harness initial={{ project: "louer" }} rentReference={anil} />);
    const field = input(CHARGES);

    expect(field.value).toBe("");
    expect(field.placeholder).toBe("");
    expect(
      screen.getByText(/Vide : le loyer d’annonce ANIL est compté charges comprises/),
    ).toBeTruthy();

    // 80 m² x 14 EUR = 1 120; with 120 EUR of recoverable charges the rent kept is 1 000.
    expect(
      input("Loyer d’annonce estimé, charges comprises (le loyer hors charges est plus bas)").value,
    ).toBe("1120");
    fireEvent.change(field, { target: { value: "120" } });
    expect(seen.choices.recoverableCharges).toBe(120);
    expect(
      input("Loyer d’annonce estimé, charges comprises (le loyer hors charges est plus bas)").value,
    ).toBe("1000");
    // Cleared or set to 0, it is empty again.
    fireEvent.change(field, { target: { value: "0" } });
    expect(seen.choices.recoverableCharges).toBeNull();
  });

  it("does not call a charges-included yield « net », and says so only while the charges are empty", () => {
    render(<Harness initial={{ project: "louer" }} rentReference={anil} />);

    expect(screen.getByLabelText(withUnit("Rendement brut visé, charges comprises"))).toBeTruthy();
    expect(screen.queryByLabelText(withUnit("Rendement net visé"))).toBeNull();

    fireEvent.change(input(CHARGES), { target: { value: "120" } });

    expect(screen.getByLabelText(withUnit("Rendement net visé"))).toBeTruthy();
    expect(screen.queryByLabelText(withUnit("Rendement brut visé, charges comprises"))).toBeNull();
  });

  it("keeps « net » for the department rent and for a typed rent", () => {
    render(<Harness initial={{ project: "louer" }} />);
    expect(screen.getByLabelText(withUnit("Rendement net visé"))).toBeTruthy();
    cleanup();

    render(<Harness initial={{ project: "louer", monthlyRent: 900 }} rentReference={anil} />);
    expect(screen.getByLabelText(withUnit("Rendement net visé"))).toBeTruthy();
  });

  it("does not claim that every charge is withdrawn from the rent", () => {
    render(<Harness initial={{ project: "louer" }} rentReference={anil} />);

    expect(document.body.textContent).not.toMatch(/retire lui-même|toutes les charges/i);
  });

  it("relie l'aide au champ et met l'unité dans son nom", () => {
    render(<Harness />);
    const field = screen.getByLabelText(/^Marge de sécurité \(%\)$/) as HTMLInputElement;
    const hint = document.getElementById(field.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Remplace celle du profil choisi.");
  });

  it("dit qu'un montant négatif est refusé au lieu de le corriger en silence", () => {
    render(<Harness />);
    const field = input("Prix au m² du bien");

    fireEvent.change(field, { target: { value: "-5" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Saisissez un montant positif.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);

    fireEvent.change(field, { target: { value: "2500" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });
});
