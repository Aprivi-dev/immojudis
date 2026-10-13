// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import type { MarketEstimate } from "@/lib/market.server";
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
}: {
  initial?: CeilingUserChoices;
  saleOverride?: AuctionSale;
}) {
  const [choices, setChoices] = useState<CeilingUserChoices>(initial);
  useEffect(() => {
    seen.choices = choices;
  }, [choices]);
  return (
    <CeilingHypothesesPanel
      hypotheses={buildCeilingHypotheses(saleOverride, estimate, choices)}
      choices={choices}
      onChoicesChange={(change) => setChoices((current) => change(current))}
    />
  );
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
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
    expect(screen.getByText(/Aucun loyer de référence pour ce département/)).toBeTruthy();
  });
});
