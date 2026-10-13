// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

import { departmentCode } from "@/lib/department-code";
import { computeAcquisitionCosts, DEFAULTS } from "@/lib/profitability";
import { FEES_SIMULATOR_DEPARTMENTS } from "./departments";
import { DEFAULT_SIMULATOR_PRICE, FeesSimulator } from "./FeesSimulator";
import { formatScaleDate } from "./scale-date";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function total() {
  return screen.getByText(/€/, { selector: "[aria-live='polite']" }).textContent;
}

function field(name: string) {
  return screen.getByLabelText(name) as HTMLInputElement;
}

describe("FeesSimulator", () => {
  it("mesure l'usage une seule fois, au premier changement d'un champ", () => {
    render(<FeesSimulator />);
    expect(mocks.track).not.toHaveBeenCalled();
    fireEvent.change(field("Prix d’adjudication"), { target: { value: "120000" } });
    fireEvent.change(field("Travaux"), { target: { value: "5000" } });
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("fees_simulator_used");
  });

  it("affiche par défaut le calcul de computeAcquisitionCosts avec les valeurs d'exemple", () => {
    render(<FeesSimulator />);
    const expected = computeAcquisitionCosts({
      price: DEFAULT_SIMULATOR_PRICE,
      fpt: DEFAULTS.fpt,
      lawyerFees: DEFAULTS.lawyerFees,
      works: 0,
    });
    expect(field("Prix d’adjudication").value).toBe("100000");
    expect(field("Travaux").value).toBe("0");
    expect(total()).toBe(euro.format(expected.totalCost));
    expect(screen.getAllByText(/Valeur d’exemple/)).toHaveLength(2);
  });

  it.each([
    ["75", 250_000],
    ["36", 250_000],
  ])("reproduit computeAcquisitionCosts pour le département %s", (code, price) => {
    render(<FeesSimulator />);
    fireEvent.change(field("Prix d’adjudication"), { target: { value: String(price) } });
    fireEvent.change(field("Frais préalables de la procédure"), { target: { value: "4200" } });
    fireEvent.change(field("Honoraires de l’avocat enchérisseur"), { target: { value: "1800" } });
    fireEvent.change(field("Travaux"), { target: { value: "30000" } });
    fireEvent.change(screen.getByLabelText("Département du bien"), { target: { value: code } });

    const expected = computeAcquisitionCosts({
      price,
      fpt: 4200,
      lawyerFees: 1800,
      works: 30_000,
      department: code,
    });
    expect(total()).toBe(euro.format(expected.totalCost));
    for (const amount of [
      expected.emolumentsTTC,
      expected.registrationDuties,
      expected.csi,
      expected.fpt,
      expected.lawyerFees,
      expected.works,
    ]) {
      const shown = screen.getAllByRole("definition").map((node) => node.textContent);
      expect(shown).toContain(euro.format(amount));
    }
  });

  it("donne des droits de mutation différents selon le département", () => {
    render(<FeesSimulator />);
    fireEvent.change(screen.getByLabelText("Département du bien"), { target: { value: "75" } });
    const paris = total();
    fireEvent.change(screen.getByLabelText("Département du bien"), { target: { value: "36" } });
    expect(total()).not.toBe(paris);
  });

  it("laisse un champ vidé vide, sans réinjecter la valeur par défaut", () => {
    render(<FeesSimulator />);
    const withExample = total();
    fireEvent.change(field("Frais préalables de la procédure"), { target: { value: "" } });
    expect(field("Frais préalables de la procédure").value).toBe("");
    const expected = computeAcquisitionCosts({
      price: DEFAULT_SIMULATOR_PRICE,
      fpt: 0,
      lawyerFees: DEFAULTS.lawyerFees,
      works: 0,
    });
    expect(total()).toBe(euro.format(expected.totalCost));
    expect(total()).not.toBe(withExample);
  });

  it("invite à saisir un prix quand le prix est vidé", () => {
    render(<FeesSimulator />);
    fireEvent.change(field("Prix d’adjudication"), { target: { value: "" } });
    expect(field("Prix d’adjudication").value).toBe("");
    expect(screen.getByText(/Saisissez un prix d’adjudication/)).toBeTruthy();
    const expected = computeAcquisitionCosts({
      price: 0,
      fpt: DEFAULTS.fpt,
      lawyerFees: DEFAULTS.lawyerFees,
      works: 0,
    });
    expect(total()).toBe(euro.format(expected.totalCost));
  });

  it("annonce le total dans une région aria-live polie", () => {
    render(<FeesSimulator />);
    const live = screen.getByText(/€/, { selector: "[aria-live]" });
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("met les champs à 16 px (text-base) pour éviter le zoom mobile", () => {
    render(<FeesSimulator />);
    for (const name of ["Prix d’adjudication", "Travaux", "Département du bien"]) {
      expect(screen.getByLabelText(name).className).toContain("text-base");
    }
  });
});

describe("liste des départements", () => {
  it("contient 101 départements dont chaque code est reconnu par departmentCode", () => {
    expect(FEES_SIMULATOR_DEPARTMENTS).toHaveLength(101);
    for (const { code } of FEES_SIMULATOR_DEPARTMENTS) {
      expect(departmentCode(code)).toBe(code);
    }
  });
});

describe("formatScaleDate", () => {
  it("formate une date jj/mm/aaaa", () => {
    expect(formatScaleDate("09/10/2026")).toBe("9 octobre 2026");
  });
  it("renvoie le texte d'origine s'il n'a pas le bon format", () => {
    expect(formatScaleDate("octobre 2026")).toBe("octobre 2026");
  });
});
