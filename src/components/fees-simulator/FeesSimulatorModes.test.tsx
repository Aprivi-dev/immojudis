// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

import { MAX_BID_BUDGET_EUR, maxPriceForBudget } from "@/lib/bid-budget";
import { CONSIGNATION_MINIMUM } from "@/lib/bid-ceiling-engine";
import { computeAcquisitionCosts, DEFAULTS } from "@/lib/profitability";
import { MAX_SURENCHERE_PRICE_EUR } from "@/lib/surenchere";
import { getSurenchereReminder } from "@/lib/surenchere-reminder";
import { DEFAULT_SIMULATOR_BUDGET } from "./BudgetMode";
import { FeesSimulator } from "./FeesSimulator";

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
const euroWhole = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Le texte cherché par Testing Library est normalisé : espaces insécables et fines compris. */
const plain = (text: string) => text.replace(/\s/g, " ");

function live() {
  return screen.getByText(/€|Saisissez|Budget insuffisant|trop élevé/, {
    selector: "[aria-live='polite']",
  }).textContent;
}

function field(name: string) {
  return screen.getByLabelText(name) as HTMLInputElement;
}

function choose(label: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name: label }));
}

describe("sélecteur de mode", () => {
  it("est un groupe de boutons radio nommé, avec le calcul direct choisi par défaut", () => {
    render(<FeesSimulator />);
    const group = screen.getByRole("group", { name: "Que voulez-vous calculer ?" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios[0].name).not.toBe("");
    expect(within(group).getByRole("radio", { name: /Prix vers coût total/ })).toBeTruthy();
    expect(within(group).getByRole("radio", { name: /Budget vers prix maximal/ })).toBeTruthy();
    expect(within(group).getByRole("radio", { name: /Surenchère du dixième/ })).toBeTruthy();
  });

  it("n'affiche que le calcul choisi, avec une seule zone annoncée par les lecteurs d'écran", () => {
    const { container } = render(<FeesSimulator />);
    expect(container.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Détail du coût" })).toBeTruthy();

    choose(/Budget vers prix maximal/);
    expect(screen.queryByRole("region", { name: "Détail du coût" })).toBeNull();
    expect(screen.getByRole("region", { name: "Jusqu’où enchérir" })).toBeTruthy();
    expect(container.querySelectorAll("[aria-live='polite']")).toHaveLength(1);

    choose(/Surenchère du dixième/);
    expect(screen.queryByRole("region", { name: "Jusqu’où enchérir" })).toBeNull();
    expect(screen.getByRole("region", { name: "Surenchère du dixième" })).toBeTruthy();
    expect(container.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
  });

  it("change de calcul au clavier : un radio coché reçoit le focus de ses voisins", () => {
    render(<FeesSimulator />);
    const budget = screen.getByRole("radio", {
      name: /Budget vers prix maximal/,
    }) as HTMLInputElement;
    budget.focus();
    expect(document.activeElement).toBe(budget);
    fireEvent.click(budget);
    expect(budget.checked).toBe(true);
  });
});

describe("mode inverse : budget vers prix maximal", () => {
  it("donne le prix maximal du budget par défaut avec le moteur de frais", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    expect(field("Budget total").value).toBe(String(DEFAULT_SIMULATOR_BUDGET));

    const expected = maxPriceForBudget(DEFAULT_SIMULATOR_BUDGET, {
      fpt: DEFAULTS.fpt,
      lawyerFees: DEFAULTS.lawyerFees,
      works: 0,
    });
    expect(expected.status).toBe("ok");
    if (expected.status !== "ok") return;
    expect(live()).toBe(euroWhole.format(expected.maxPrice));
  });

  it("recalcule en direct quand le budget change, sans jamais dépasser le budget", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    let previous = 0;
    for (const budget of [60_000, 120_000, 250_000, 400_000]) {
      fireEvent.change(field("Budget total"), { target: { value: String(budget) } });
      const result = maxPriceForBudget(budget, { fpt: 3_000, lawyerFees: 1_500, works: 0 });
      if (result.status !== "ok") throw new Error("budget exploitable attendu");
      expect(live()).toBe(euroWhole.format(result.maxPrice));
      expect(result.maxPrice).toBeGreaterThan(previous);
      previous = result.maxPrice;
      expect(result.costs.totalCost).toBeLessThanOrEqual(budget);
    }
  });

  it("affiche le détail des frais du moteur au prix maximal", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    fireEvent.change(field("Budget total"), { target: { value: "300000" } });
    fireEvent.change(screen.getByLabelText("Département du bien"), { target: { value: "75" } });
    fireEvent.change(field("Travaux"), { target: { value: "30000" } });

    const options = { fpt: 3_000, lawyerFees: 1_500, works: 30_000, department: "75" };
    const result = maxPriceForBudget(300_000, options);
    if (result.status !== "ok") throw new Error("budget exploitable attendu");
    const costs = computeAcquisitionCosts({ ...options, price: result.maxPrice });
    const shown = screen.getAllByRole("definition").map((node) => node.textContent);
    for (const amount of [
      costs.price,
      costs.emolumentsTTC,
      costs.registrationDuties,
      costs.csi,
      costs.fpt,
      costs.lawyerFees,
      costs.works,
    ]) {
      expect(shown).toContain(euro.format(amount));
    }
    expect(screen.getByText(plain(`Coût total : ${euro.format(costs.totalCost)}`))).toBeTruthy();
  });

  it("garde les hypothèses de frais saisies quand on change de calcul", () => {
    render(<FeesSimulator />);
    fireEvent.change(field("Travaux"), { target: { value: "30000" } });
    fireEvent.change(field("Honoraires de l’avocat enchérisseur"), { target: { value: "2500" } });
    fireEvent.change(screen.getByLabelText("Département du bien"), { target: { value: "36" } });

    choose(/Budget vers prix maximal/);
    expect(field("Travaux").value).toBe("30000");
    expect(field("Honoraires de l’avocat enchérisseur").value).toBe("2500");
    expect((screen.getByLabelText("Département du bien") as HTMLSelectElement).value).toBe("36");

    choose(/Prix vers coût total/);
    expect(field("Travaux").value).toBe("30000");
  });

  it("ferme la boucle avec le calcul direct : le coût du prix maximal tient dans le budget", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    fireEvent.change(field("Budget total"), { target: { value: "180000" } });
    const maxPrice = Number(live()!.replace(/[^\d]/g, ""));

    choose(/Prix vers coût total/);
    fireEvent.change(field("Prix d’adjudication"), { target: { value: String(maxPrice) } });
    const totalText = screen.getByText(/€/, { selector: "[aria-live='polite']" }).textContent;
    const total = Number(totalText!.replace(/[^\d,]/g, "").replace(",", "."));
    expect(total).toBeLessThanOrEqual(180_000);

    fireEvent.change(field("Prix d’adjudication"), { target: { value: String(maxPrice + 1) } });
    const next = screen.getByText(/€/, { selector: "[aria-live='polite']" }).textContent;
    expect(Number(next!.replace(/[^\d,]/g, "").replace(",", "."))).toBeGreaterThan(180_000);
  });

  it("dit qu'un budget trop faible ne couvre même pas les frais fixes", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    fireEvent.change(field("Budget total"), { target: { value: "2000" } });
    expect(live()).toBe("Budget insuffisant");
    const minimum = computeAcquisitionCosts({
      price: 0,
      fpt: DEFAULTS.fpt,
      lawyerFees: DEFAULTS.lawyerFees,
      works: 0,
    }).totalCost;
    const result = screen.getByRole("region", { name: "Jusqu’où enchérir" });
    expect(plain(result.textContent ?? "")).toContain(plain(euro.format(minimum)));
    // Pas de détail de frais pour un prix qui n'existe pas.
    expect(screen.queryByRole("definition")).toBeNull();
  });

  it("invite à saisir un budget quand le champ est vidé, sans réinjecter de valeur", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    fireEvent.change(field("Budget total"), { target: { value: "" } });
    expect(field("Budget total").value).toBe("");
    expect(live()).toBe("Saisissez un budget");
  });

  it("répond proprement à un budget démesuré, sans calcul ni blocage, et plafonne l'input", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    expect(field("Budget total").max).toBe(String(MAX_BID_BUDGET_EUR));
    for (const value of ["1e16", "1e300", String(MAX_BID_BUDGET_EUR * 2)]) {
      fireEvent.change(field("Budget total"), { target: { value } });
      expect(live()).toBe("Budget trop élevé");
      expect(screen.queryByRole("definition")).toBeNull();
    }
    const result = screen.getByRole("region", { name: "Jusqu’où enchérir" });
    expect(plain(result.textContent ?? "")).toContain(plain(euroWhole.format(MAX_BID_BUDGET_EUR)));
    // Revenir sous le plafond rétablit le calcul.
    fireEvent.change(field("Budget total"), { target: { value: "180000" } });
    expect(live()).toContain("€");
  });

  it("rappelle la consignation du moteur, et la chiffre quand la mise à prix est saisie", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    const box = screen.getByText("Consignation à prévoir avant l’audience").parentElement!;
    expect(box.textContent).toContain("10 % de la mise à prix");
    expect(box.textContent).toContain(euroWhole.format(CONSIGNATION_MINIMUM));
    expect(box.textContent).toContain("Saisissez la mise à prix pour la chiffrer");

    fireEvent.change(field("Mise à prix (facultatif)"), { target: { value: "200000" } });
    expect(box.textContent).toContain(`${euroWhole.format(200_000)} : ${euroWhole.format(20_000)}`);

    // Sous 30 000 € de mise à prix, c'est le minimum qui s'applique.
    fireEvent.change(field("Mise à prix (facultatif)"), { target: { value: "12000" } });
    expect(box.textContent).toContain(
      `${euroWhole.format(12_000)} : ${euroWhole.format(CONSIGNATION_MINIMUM)}`,
    );
  });

  it("reprend les avertissements du simulateur et renvoie vers les ventes", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    const result = screen.getByRole("region", { name: "Jusqu’où enchérir" });
    expect(result.textContent).toContain("Estimation indicative");
    expect(result.textContent).toContain("ni un conseil juridique ni un conseil financier");
    expect(result.textContent).toContain("cahier des conditions de vente");
    const link = within(result).getByRole("link", { name: "Chiffrer une vente précise" });
    expect(link.getAttribute("href")).toBe("/sales");
    // Le lien est en fin de résultat.
    const links = within(result).getAllByRole("link");
    expect(links.at(-1)).toBe(link);
  });

  it("mesure l'usage une seule fois, tous modes confondus", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    expect(mocks.track).not.toHaveBeenCalled();
    fireEvent.change(field("Budget total"), { target: { value: "200000" } });
    fireEvent.change(field("Travaux"), { target: { value: "1000" } });
    choose(/Prix vers coût total/);
    fireEvent.change(field("Prix d’adjudication"), { target: { value: "90000" } });
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("fees_simulator_used");
  });

  it("met les champs à 16 px (text-base) pour éviter le zoom mobile", () => {
    render(<FeesSimulator />);
    choose(/Budget vers prix maximal/);
    for (const name of [
      "Budget total",
      "Travaux",
      "Département du bien",
      "Mise à prix (facultatif)",
    ]) {
      expect(screen.getByLabelText(name).className).toContain("text-base");
    }
  });
});

describe("surenchère du dixième", () => {
  it("donne le prix minimal d'une surenchère : prix + 10 %", () => {
    render(<FeesSimulator />);
    choose(/Surenchère du dixième/);
    expect(field("Prix d’adjudication").value).toBe("100000");
    expect(live()).toBe(euro.format(110_000));

    fireEvent.change(field("Prix d’adjudication"), { target: { value: "85000" } });
    expect(live()).toBe(euro.format(93_500));
    const result = screen.getByRole("region", { name: "Surenchère du dixième" });
    expect(result.textContent).toContain(euro.format(8_500));
  });

  it("invite à saisir un prix quand le champ est vidé", () => {
    render(<FeesSimulator />);
    choose(/Surenchère du dixième/);
    fireEvent.change(field("Prix d’adjudication"), { target: { value: "" } });
    expect(live()).toBe("Saisissez un prix");
  });

  it("répond proprement à un prix démesuré et plafonne l'input", () => {
    render(<FeesSimulator />);
    choose(/Surenchère du dixième/);
    expect(field("Prix d’adjudication").max).toBe(String(MAX_SURENCHERE_PRICE_EUR));
    for (const value of ["1e16", "1e300", String(MAX_SURENCHERE_PRICE_EUR * 2)]) {
      fireEvent.change(field("Prix d’adjudication"), { target: { value } });
      expect(live()).toBe("Prix trop élevé");
    }
    fireEvent.change(field("Prix d’adjudication"), { target: { value: "85000" } });
    expect(live()).toBe(euro.format(93_500));
  });

  it("rappelle le délai tel que l'article le formule, avec un lien vers l'article", () => {
    const reminder = getSurenchereReminder();
    render(<FeesSimulator surenchereReminder={reminder} />);
    choose(/Surenchère du dixième/);
    const result = screen.getByRole("region", { name: "Surenchère du dixième" });
    expect(result.textContent).toContain(reminder!.delay);
    expect(result.textContent).toContain("Pendant dix jours");
    expect(within(result).getByText("Dans quels types de vente ?")).toBeTruthy();
    expect(result.textContent).toContain(reminder!.scope!);
    expect(
      within(result).getByRole("link", { name: reminder!.articleTitle }).getAttribute("href"),
    ).toBe(reminder!.articleHref);
  });

  it("n'invente aucun délai quand l'article n'est pas fourni", () => {
    render(<FeesSimulator />);
    choose(/Surenchère du dixième/);
    const result = screen.getByRole("region", { name: "Surenchère du dixième" });
    expect(result.textContent).not.toMatch(/dix jours|jours/);
    expect(result.textContent).toContain("ni un conseil juridique ni un conseil financier");
  });

  it("termine sur le lien vers les ventes", () => {
    render(<FeesSimulator surenchereReminder={getSurenchereReminder()} />);
    choose(/Surenchère du dixième/);
    const result = screen.getByRole("region", { name: "Surenchère du dixième" });
    const links = within(result).getAllByRole("link");
    expect(links.at(-1)?.textContent).toBe("Chiffrer une vente précise");
    expect(links.at(-1)?.getAttribute("href")).toBe("/sales");
  });
});
