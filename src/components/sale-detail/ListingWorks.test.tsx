// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { formatPrice } from "@/lib/format";
import { ListingWorks } from "./ListingWorks";

afterEach(cleanup);

describe("ListingWorks", () => {
  it("keeps the status compact and reveals dossier evidence on demand", async () => {
    const { container } = render(<ListingWorks sale={EXAMPLE_SALE} estimatedBudget={12_500} />);

    expect(screen.getByRole("heading", { name: "Travaux et état du bien" })).toBeTruthy();
    expect(screen.getByText("État et énergie")).toBeTruthy();
    expect(screen.getByText("Budget travaux retenu")).toBeTruthy();
    expect(screen.getByText("Rafraîchissement à prévoir")).toBeTruthy();
    expect(screen.getByText("DPE D")).toBeTruthy();
    expect(screen.getByText(/aucune interdiction de location/)).toBeTruthy();
    expect(container.textContent).toContain(formatPrice(12_500));

    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Voir les constats et les sources"));
    expect(details?.open).toBe(true);
    expect(screen.getByText(/Ventilation de la salle d'eau à contrôler/)).toBeTruthy();
    expect(screen.getByText(/elle reste à confirmer après la visite du bien/)).toBeTruthy();

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });

  it("does not invent a budget when the analysis has no estimate", () => {
    render(<ListingWorks sale={EXAMPLE_SALE} estimatedBudget={null} />);

    expect(screen.getByText("Non estimé")).toBeTruthy();
    expect(screen.getByText("Données insuffisantes")).toBeTruthy();
  });

  it("no longer offers the old free editor nor any quote wording", () => {
    const { container } = render(
      <ListingWorks
        sale={EXAMPLE_SALE}
        estimatedBudget={12_500}
        surface={68}
        onScenarioSelect={vi.fn()}
        worksBreakdown={[]}
        onWorksBreakdownChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Voir les constats et les sources"));

    expect(screen.queryByRole("button", { name: "Détailler le budget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Utiliser ce budget" })).toBeNull();
    expect(screen.queryByText("Décomposer l’enveloppe")).toBeNull();
    expect(screen.queryByLabelText(/Montant d’un devis/)).toBeNull();
    expect(screen.queryByLabelText("Libellé du poste 1")).toBeNull();
    expect(screen.getByText(/à confirmer lors de la visite/)).toBeTruthy();
    // « Détail de vos travaux » is the only breakdown left.
    expect(screen.getByRole("button", { name: "Détailler les travaux" })).toBeTruthy();
    // The panel's own disclaimer only shows once it is open: nothing else in the tab says it.
    expect(container.textContent).not.toMatch(/devis/i);
  });

  it("picks a scenario, suggested by the published condition", () => {
    const onScenarioSelect = vi.fn();
    const { rerender } = render(
      <ListingWorks
        sale={EXAMPLE_SALE}
        estimatedBudget={0}
        surface={68}
        onScenarioSelect={onScenarioSelect}
        maxWorks={20_000}
      />,
    );

    expect(screen.getAllByText("Aucun travaux").length).toBeGreaterThan(1);
    expect(screen.getByText(/Aucun budget retenu : choisissez un scénario/)).toBeTruthy();
    const refresh = screen.getByRole("radio", { name: /Rafraîchissement locatif/ });
    expect(refresh.textContent).toContain("Suggéré");
    expect(screen.getByText(/Suggéré par l’état décrit/)).toBeTruthy();

    fireEvent.click(refresh);
    expect(onScenarioSelect).toHaveBeenLastCalledWith(34_000);

    rerender(
      <ListingWorks
        sale={EXAMPLE_SALE}
        estimatedBudget={34_000}
        surface={68}
        onScenarioSelect={onScenarioSelect}
        maxWorks={20_000}
      />,
    );
    expect(
      screen.getByRole("radio", { name: /Rafraîchissement locatif/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getAllByText("Rafraîchissement locatif").length).toBeGreaterThan(1);
    expect(screen.getByText(/dépasse l’enveloppe travaux maximale/)).toBeTruthy();
  });

  describe("Détail de vos travaux", () => {
    it("is absent unless the parent keeps the breakdown", () => {
      render(<ListingWorks sale={EXAMPLE_SALE} estimatedBudget={12_500} />);

      expect(screen.queryByRole("button", { name: "Détailler les travaux" })).toBeNull();
    });

    it("hands the postes and their total to the parent, without applying anything else", () => {
      const onWorksBreakdownChange = vi.fn();
      const onScenarioSelect = vi.fn();
      render(
        <ListingWorks
          sale={EXAMPLE_SALE}
          estimatedBudget={12_500}
          surface={68}
          onScenarioSelect={onScenarioSelect}
          worksBreakdown={[
            { id: "a", kind: "toiture", label: "", quantity: "1", unit: "", unitCost: "8000" },
          ]}
          onWorksBreakdownChange={onWorksBreakdownChange}
        />,
      );

      fireEvent.change(screen.getByRole("textbox", { name: /^Coût unitaire, poste 1/ }), {
        target: { value: "9000" },
      });

      expect(onWorksBreakdownChange).toHaveBeenCalledTimes(1);
      const [items, total] = onWorksBreakdownChange.mock.calls[0];
      expect(total).toBe(9_000);
      expect(items[0]).toMatchObject({ kind: "toiture", unitCost: "9000" });
      // The parent decides what feeds the budget; the scenario picker is left alone.
      expect(onScenarioSelect).not.toHaveBeenCalled();
    });
  });
});
