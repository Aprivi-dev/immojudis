// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FinancingSimulator,
  calculateFinancing,
  type FinancingDraft,
  type FinancingResult,
} from "./FinancingSimulator";

const sale = { starting_price_eur: 250_000 };

afterEach(cleanup);

describe("calculateFinancing", () => {
  it("calculates an amortizing loan with a non-zero rate", () => {
    const result = calculateFinancing({
      projectPrice: 390_000,
      downPayment: 78_000,
      annualRate: 3.5,
      termYears: 20,
    });

    expect(result).not.toBeNull();
    expect(result?.loanAmount).toBe(312_000);
    expect(result?.paymentCount).toBe(240);
    expect(result?.monthlyPrincipalAndInterest).toBeCloseTo(1_809.47, 2);
    expect(result?.totalInsurance).toBe(0);
  });

  it("handles a zero-rate loan and optional insurance", () => {
    const result = calculateFinancing({
      projectPrice: 120_000,
      downPayment: 20_000,
      annualRate: 0,
      termYears: 10,
      annualInsuranceRate: 0.3,
    });

    expect(result?.monthlyPrincipalAndInterest).toBeCloseTo(833.33, 2);
    expect(result?.monthlyInsurance).toBeCloseTo(25, 2);
    expect(result?.monthlyPayment).toBeCloseTo(858.33, 2);
    expect(result?.totalRepaid).toBeCloseTo(103_000, 2);
  });

  it("includes explicitly supplied bank and guarantee fees in the financed cost", () => {
    const result = calculateFinancing({
      projectPrice: 200_000,
      downPayment: 40_000,
      annualRate: 0,
      termYears: 10,
      bankFees: 1_500,
      guaranteeFees: 2_500,
    });

    expect(result?.totalProjectCost).toBe(204_000);
    expect(result?.loanAmount).toBe(164_000);
    expect(result?.bankFees).toBe(1_500);
    expect(result?.guaranteeFees).toBe(2_500);
  });

  it("rejects impossible assumptions", () => {
    expect(
      calculateFinancing({
        projectPrice: 100_000,
        downPayment: 100_001,
        annualRate: 3.5,
        termYears: 20,
      }),
    ).toBeNull();
  });
});

describe("FinancingSimulator", () => {
  it("uses the listing price and illustrative defaults", () => {
    render(<FinancingSimulator sale={sale} />);

    expect(screen.getByRole("heading", { name: "Simulateur de financement" })).toBeTruthy();
    expect((screen.getByLabelText(/Prix du projet/) as HTMLInputElement).value).toBe("250000");
    expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).toBe("50000");
    expect((screen.getByLabelText(/Taux annuel/) as HTMLInputElement).value).toBe("3.5");
    expect((screen.getByLabelText("Durée du prêt") as HTMLSelectElement).value).toBe("20");
    expect((screen.getByLabelText(/Frais de dossier bancaires/) as HTMLInputElement).value).toBe(
      "0",
    );
    expect((screen.getByLabelText(/Garantie \/ caution/) as HTMLInputElement).value).toBe("0");
    expect(screen.getByRole("status").textContent).toContain("Mensualité totale estimée");
    expect(screen.getByRole("status").textContent).not.toContain("À compléter");
    expect(screen.getByText("Coût total du projet")).toBeTruthy();
    expect(screen.getByText(/Hypothèses illustratives/)).toBeTruthy();
  });

  it("updates the live estimate without submitting or persisting data", () => {
    render(<FinancingSimulator sale={sale} />);

    fireEvent.change(screen.getByLabelText(/Apport personnel/), { target: { value: "100000" } });
    fireEvent.change(screen.getByLabelText(/Taux annuel/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Durée du prêt"), { target: { value: "10" } });
    fireEvent.click(screen.getByLabelText("Ajouter une assurance indicative"));

    expect((screen.getByLabelText(/Taux d’assurance annuel/) as HTMLInputElement).value).toBe(
      "0.3",
    );
    expect(screen.getByRole("status").textContent).toMatch(/1.?288/);
    expect(screen.getByText("Assurance par mois")).toBeTruthy();
    expect(screen.getByText("Montant emprunté")).toBeTruthy();
  });

  it("keeps the financing breakdown visible beside the parameters", () => {
    render(<FinancingSimulator sale={sale} />);

    expect(screen.getAllByText("Prix du projet").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Frais de dossier bancaires").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Garantie / caution").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Coût total du projet")).toBeTruthy();
    expect(screen.getByLabelText("Ajouter une assurance indicative")).toBeTruthy();
    expect(screen.queryByText("Voir le détail de l’estimation")).toBeNull();
  });

  it("accepts a scenario override, restores a draft, and reports updates", () => {
    const drafts: FinancingDraft[] = [];
    const results: Array<FinancingResult | null> = [];
    const initialDraft: Partial<FinancingDraft> = {
      projectPrice: 475_000,
      downPayment: 95_000,
      annualRate: 2.8,
      termYears: 15,
      bankFees: 1_000,
      guaranteeFees: 2_000,
      insuranceEnabled: false,
      insuranceRate: null,
    };
    const onDraftChange = (draft: FinancingDraft) => {
      drafts.push(draft);
    };
    const onResultChange = (result: FinancingResult | null) => {
      results.push(result);
    };

    const { rerender } = render(
      <FinancingSimulator
        sale={sale}
        projectPriceOverride={500_000}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onResultChange={onResultChange}
      />,
    );

    const projectPriceInput = screen.getByLabelText(/Prix du projet/) as HTMLInputElement;
    expect(projectPriceInput.value).toBe("500000");
    expect(projectPriceInput.disabled).toBe(true);
    expect(screen.getByText("Scénario de l’annonce")).toBeTruthy();
    expect(drafts.at(-1)?.projectPriceSource).toBe("scenario");
    expect(results.at(-1)?.totalProjectCost).toBe(503_000);

    fireEvent.change(screen.getByLabelText(/Frais de dossier bancaires/), {
      target: { value: "1500" },
    });

    expect(drafts.at(-1)?.bankFees).toBe(1500);
    expect(results.at(-1)?.totalProjectCost).toBe(503_500);

    fireEvent.change(screen.getByLabelText(/Apport personnel/), {
      target: { value: "110000" },
    });
    rerender(
      <FinancingSimulator
        sale={sale}
        projectPriceOverride={520_000}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onResultChange={onResultChange}
      />,
    );

    expect((screen.getByLabelText(/Prix du projet/) as HTMLInputElement).value).toBe("520000");
    expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).toBe("110000");

    rerender(
      <FinancingSimulator
        sale={sale}
        projectPriceOverride={null}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onResultChange={onResultChange}
      />,
    );

    expect((screen.getByLabelText(/Prix du projet/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).toBe("110000");
    expect((screen.getByLabelText(/Frais de dossier bancaires/) as HTMLInputElement).value).toBe(
      "1500",
    );
    expect(drafts.at(-1)?.projectPriceSource).toBe("manual");
    expect(results.at(-1)).toBeNull();

    rerender(
      <FinancingSimulator
        sale={sale}
        projectPriceOverride={540_000}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onResultChange={onResultChange}
      />,
    );

    expect((screen.getByLabelText(/Prix du projet/) as HTMLInputElement).value).toBe("540000");
    expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).toBe("110000");
    expect(results.at(-1)?.totalProjectCost).toBe(543_500);
  });

  it("does not restore a linked price after remount when the scenario is unavailable", () => {
    const snapshots: FinancingDraft[] = [];
    const linkedDraft: Partial<FinancingDraft> = {
      projectPrice: 500_000,
      projectPriceSource: "scenario",
      downPayment: 100_000,
      annualRate: 2.8,
      termYears: 15,
      bankFees: 1_000,
      guaranteeFees: 2_000,
      insuranceEnabled: false,
      insuranceRate: null,
    };

    const firstMount = render(
      <FinancingSimulator
        sale={sale}
        projectPriceOverride={null}
        initialDraft={linkedDraft}
        onDraftChange={(draft) => snapshots.push(draft)}
      />,
    );

    expect((screen.getByLabelText(/Prix du projet/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).toBe("100000");
    expect(snapshots.at(-1)?.projectPriceSource).toBe("manual");
    firstMount.unmount();

    render(
      <FinancingSimulator
        sale={sale}
        projectPriceOverride={null}
        initialDraft={{ ...linkedDraft, projectPrice: 275_000, projectPriceSource: "manual" }}
      />,
    );

    expect((screen.getByLabelText(/Prix du projet/) as HTMLInputElement).value).toBe("275000");
    expect(screen.getByRole("status").textContent).not.toContain("À compléter");
  });

  it("shows an accessible validation message when the down payment exceeds the price", () => {
    render(<FinancingSimulator sale={sale} />);

    fireEvent.change(screen.getByLabelText(/Apport personnel/), { target: { value: "300000" } });

    expect(
      (screen.getByLabelText(/Apport personnel/) as HTMLInputElement).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("compris entre 0 €");
    expect(screen.getByRole("status").textContent).toContain("À compléter");
  });
});
