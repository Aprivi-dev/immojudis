// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FinancingSimulator, calculateFinancing } from "./FinancingSimulator";

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
    expect(screen.getByRole("status").textContent).toContain("Mensualité totale estimée");
    expect(screen.getByRole("status").textContent).not.toContain("À compléter");
    expect(screen.getByText(/Hypothèses illustratives/)).toBeTruthy();
  });

  it("updates the live estimate without submitting or persisting data", () => {
    render(<FinancingSimulator sale={sale} />);

    fireEvent.change(screen.getByLabelText(/Apport personnel/), { target: { value: "100000" } });
    fireEvent.change(screen.getByLabelText(/Taux annuel/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Durée du prêt"), { target: { value: "10" } });
    fireEvent.click(screen.getByLabelText("Ajouter une assurance emprunteur indicative"));

    expect((screen.getByLabelText(/Taux d’assurance annuel/) as HTMLInputElement).value).toBe(
      "0.3",
    );
    expect(screen.getByRole("status").textContent).toMatch(/1.?288/);
    expect(screen.getByText("Assurance emprunteur estimée")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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
