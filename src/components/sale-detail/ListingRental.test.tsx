// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { buildReportRentalScenario } from "@/lib/report-simulation";
import { calculateRentalScenario, ListingRental, rentalDraftFromValues } from "./ListingRental";

afterEach(cleanup);

describe("calculateRentalScenario", () => {
  it("calculates gross yield, NOI and cash flow from explicit inputs", () => {
    const result = calculateRentalScenario({
      acquisitionCost: 200_000,
      monthlyRent: 1_000,
      vacancyRatePct: 5,
      annualNonRecoverableCharges: 600,
      annualPropertyTax: 1_200,
      annualLandlordInsurance: 240,
      monthlyDebtService: 700,
    });

    expect(result?.annualPotentialRent).toBe(12_000);
    expect(result?.annualEffectiveRent).toBe(11_400);
    expect(result?.annualOperatingIncome).toBe(9_360);
    expect(result?.grossYieldPct).toBe(6);
    expect(result?.netOperatingYieldPct).toBeCloseTo(4.68, 8);
    expect(result?.monthlyCashFlow).toBeCloseTo(80, 8);
  });

  it("rejects missing, negative or impossible critical inputs", () => {
    expect(
      calculateRentalScenario({
        acquisitionCost: 0,
        monthlyRent: 1_000,
        vacancyRatePct: 5,
        annualNonRecoverableCharges: 0,
        annualPropertyTax: 0,
        annualLandlordInsurance: 0,
      }),
    ).toBeNull();
    expect(
      calculateRentalScenario({
        acquisitionCost: 200_000,
        monthlyRent: 0,
        vacancyRatePct: 5,
        annualNonRecoverableCharges: 0,
        annualPropertyTax: 0,
        annualLandlordInsurance: 0,
      }),
    ).toBeNull();
    expect(
      calculateRentalScenario({
        acquisitionCost: 200_000,
        monthlyRent: 1_000,
        vacancyRatePct: 101,
        annualNonRecoverableCharges: 0,
        annualPropertyTax: 0,
        annualLandlordInsurance: 0,
      }),
    ).toBeNull();
  });
});

describe("ListingRental", () => {
  it("does not invent a rent and preserves a draft through the change callback", () => {
    const onDraftChange = vi.fn();
    render(
      <ListingRental acquisitionCost={200_000} saleId="sale-1" onDraftChange={onDraftChange} />,
    );

    expect((screen.getByLabelText(/Loyer mensuel/) as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Scénario à compléter")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Loyer mensuel/), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText(/Vacance locative/), { target: { value: "5" } });

    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ monthlyRent: "1000", vacancyRatePct: "5" }),
    );
    expect(screen.getByText("Rendement brut")).toBeTruthy();
    expect(screen.getByText("6,0 %")).toBeTruthy();
  });

  it("shows the formula and passes accessibility checks", async () => {
    const { container } = render(
      <ListingRental
        acquisitionCost={200_000}
        monthlyDebtService={700}
        saleId="sale-2"
        initialDraft={rentalDraftFromValues({
          monthlyRent: 1_000,
          vacancyRatePct: 5,
          annualNonRecoverableCharges: 600,
          annualPropertyTax: 1_200,
          annualLandlordInsurance: 240,
        })}
      />,
    );

    expect(screen.getByText(/Cash-flow mensuel avant impôts/)).toBeTruthy();
    const details = screen.getByText("Voir les formules").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Voir les formules"));
    expect(screen.getByText(/loyer mensuel × 12/)).toBeTruthy();

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });

  it("keeps zero expenses explicit while retaining a blank critical rent", () => {
    render(
      <ListingRental
        acquisitionCost={200_000}
        saleId="sale-3"
        initialDraft={{ vacancyRatePct: "0" }}
      />,
    );

    expect((screen.getByLabelText(/Loyer mensuel/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Vacance locative/) as HTMLInputElement).value).toBe("0");
    expect(screen.getByText(/postes de charges laissés vides sont comptés à 0/)).toBeTruthy();
  });

  it("does not turn a negative expense into a silent zero", () => {
    render(
      <ListingRental
        acquisitionCost={200_000}
        saleId="sale-4"
        initialDraft={{ monthlyRent: "1000", vacancyRatePct: "5" }}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Charges non récupérables/), {
      target: { value: "-600" },
    });

    expect(screen.getByRole("alert").textContent).toContain("négative");
    expect(screen.getByText("Scénario à compléter")).toBeTruthy();
    expect(screen.queryByText("Rendement brut")).toBeNull();
  });

  it("marks the visible figures incomplete when expenses are blank, while keeping explicit zero valid", () => {
    render(<ListingRental acquisitionCost={200_000} saleId="sale-missing-expenses" />);

    fireEvent.change(screen.getByLabelText(/Loyer mensuel/), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText(/Vacance locative/), { target: { value: "5" } });

    expect(screen.getByText("Scénario incomplet")).toBeTruthy();
    expect(screen.getByText(/laissés vides et comptés à 0/)).toBeTruthy();
    expect(screen.getByText("Revenu net d'exploitation")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Charges non récupérables/), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText(/Taxe foncière/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/Assurance propriétaire/), {
      target: { value: "0" },
    });

    expect(screen.queryByText("Scénario incomplet")).toBeNull();
  });

  it("turns the draft emitted by the UI into the export payload used by reports", () => {
    const onDraftChange = vi.fn();
    render(
      <ListingRental
        acquisitionCost={77_720}
        monthlyDebtService={430}
        saleId="sale-export"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Loyer mensuel/), { target: { value: "700" } });
    fireEvent.change(screen.getByLabelText(/Vacance locative/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Charges non récupérables/), {
      target: { value: "1200" },
    });
    fireEvent.change(screen.getByLabelText(/Taxe foncière/), { target: { value: "1800" } });
    fireEvent.change(screen.getByLabelText(/Assurance propriétaire/), {
      target: { value: "240" },
    });

    const draft = onDraftChange.mock.lastCall?.[0];
    expect(
      buildReportRentalScenario({
        draft,
        acquisitionCost: 77_720,
        monthlyDebtService: 430,
      }),
    ).toEqual({
      acquisitionCost: 77_720,
      monthlyRent: 700,
      vacancyRatePct: 5,
      annualNonRecoverableCharges: 1200,
      annualPropertyTax: 1800,
      annualLandlordInsurance: 240,
      monthlyDebtService: 430,
      missingExpenseFields: [],
    });
  });
});
