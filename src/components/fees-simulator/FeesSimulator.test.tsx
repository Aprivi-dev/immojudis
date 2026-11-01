// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

import { departmentCode } from "@/lib/department-code";
import {
  computeAcquisitionCosts,
  DEFAULTS,
  DMTO_DEFAULT_RATE,
  DMTO_RATE_BY_DEPARTMENT,
  DMTO_RATE_REDUCED_DEPARTMENT,
  DMTO_RATE_UNCHANGED_DEPARTMENT,
  DMTO_TABLE_DATE,
  DMTO_TEMPORARY_INCREASE_END,
} from "@/lib/profitability";
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

// Le total s'affiche arrondi à l'euro (le calcul, lui, garde les centimes).
const euroWhole = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function total() {
  return screen.getByText(/€/, { selector: "[aria-live='polite']" }).textContent;
}

function field(name: string) {
  return screen.getByLabelText(name) as HTMLInputElement;
}

describe("FeesSimulator", () => {
  it("dit que la hausse à 5 % est temporaire, hors primo-accédants, et liste les départements à 5,81 %", () => {
    render(<FeesSimulator />);
    const hint = (screen.getByLabelText("Département du bien") as HTMLSelectElement).getAttribute(
      "aria-describedby",
    )!;
    const text = (document.getElementById(hint)?.textContent ?? "").replace(/[\u00a0\u202f]/g, " ");
    expect(text).toContain("Taux de 6,32 % par défaut");
    expect(text).toContain("11 départements (05, 06, 07, 16, 26, 48, 60, 65, 71, 971 et 976)");
    expect(text).toContain("restent à 5,81 %");
    expect(text).toContain("l’Indre est à 5,09 %");
    expect(text).toContain("tableau DGFiP au 01/06/2026");
    expect(text).toContain("temporaire (actes passés jusqu’au 31/03/2028)");
    expect(text).toContain("ne s’applique pas aux primo-accédants");
    expect(text).not.toMatch(/garanti|certain/i);
    // Le texte figé de hypotheses.tsx reste aligné sur le tableau de profitability.ts.
    const codes = (/\(([\d, ]+) et (\d+)\)/.exec(text) ?? []).slice(1);
    const listed = [...codes[0].split(", "), codes[1]].sort();
    const fromTable = Object.entries(DMTO_RATE_BY_DEPARTMENT)
      .filter(([, rate]) => rate === DMTO_RATE_UNCHANGED_DEPARTMENT)
      .map(([code]) => code)
      .sort();
    expect(listed).toEqual(fromTable);
    expect(DMTO_DEFAULT_RATE).toBe(0.0632);
    expect(DMTO_RATE_UNCHANGED_DEPARTMENT).toBe(0.0581);
    expect(DMTO_RATE_REDUCED_DEPARTMENT).toBe(0.0509);
    expect(DMTO_TABLE_DATE).toBe("01/06/2026");
    expect(DMTO_TEMPORARY_INCREASE_END).toBe("31/03/2028");
  });

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
    expect(total()).toBe(euroWhole.format(expected.totalCost));
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
    expect(total()).toBe(euroWhole.format(expected.totalCost));
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
    expect(total()).toBe(euroWhole.format(expected.totalCost));
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
    expect(total()).toBe(euroWhole.format(expected.totalCost));
  });

  it("arrondit le total à l'euro à l'affichage et garde les centimes dans le détail", () => {
    render(<FeesSimulator />);
    const expected = computeAcquisitionCosts({
      price: DEFAULT_SIMULATOR_PRICE,
      fpt: DEFAULTS.fpt,
      lawyerFees: DEFAULTS.lawyerFees,
      works: 0,
    });
    expect(Number.isInteger(expected.totalCost)).toBe(false);
    expect(total()).not.toContain(",");
    const shown = screen.getAllByRole("definition").map((node) => node.textContent);
    expect(shown).toContain(euro.format(expected.registrationDuties));
  });

  it("place le total avant le détail et le répète dans une barre collante sur mobile", () => {
    render(<FeesSimulator />);
    const live = screen.getByText(/€/, { selector: "[aria-live='polite']" });
    const firstLine = screen.getAllByRole("definition")[0];
    expect(live.compareDocumentPosition(firstLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const bar = screen.getByTestId("simulateur-total-collant");
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("bottom-[var(--cookie-banner-height,0px)]");
    expect(bar.className).toContain("lg:hidden");
    expect(bar.textContent).toContain(`Coût total ${live.textContent}`);
    expect(bar.textContent).toMatch(/dont \d+(,\d)? % de frais/);
    expect(bar.querySelector("[aria-live]")).toBeNull();
    // Le total principal reste annoncé ; la barre répétée est masquée aux lecteurs d'écran.
    expect(bar.getAttribute("aria-hidden")).toBe("true");

    fireEvent.change(field("Prix d’adjudication"), { target: { value: "" } });
    expect(screen.getByTestId("simulateur-total-collant").textContent).not.toContain("% de frais");
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
