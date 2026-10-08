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
    expect(screen.getByText("Point à retenir")).toBeTruthy();
    expect(screen.getByText("Budget travaux")).toBeTruthy();
    expect(container.textContent).toContain(formatPrice(12_500));

    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Voir les constats et les sources"));
    expect(details?.open).toBe(true);
    expect(screen.getByText(/Ventilation de la salle d'eau à contrôler/)).toBeTruthy();
    expect(screen.getByText(/ne remplace pas un devis établi après visite/)).toBeTruthy();

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });

  it("keeps the reference estimate until a complete manual detail is explicitly applied", () => {
    const onBudgetChange = vi.fn();
    render(
      <ListingWorks sale={EXAMPLE_SALE} estimatedBudget={12_500} onBudgetChange={onBudgetChange} />,
    );

    expect(screen.getByText("Estimation")).toBeTruthy();
    expect(screen.getByText(/enveloppe de simulation à confirmer par des devis/i)).toBeTruthy();
    expect(onBudgetChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Détailler le budget" }));
    fireEvent.change(screen.getByLabelText("Libellé du poste 1"), {
      target: { value: "Peinture" },
    });
    fireEvent.change(screen.getByLabelText("Prix unitaire du poste 1"), {
      target: { value: "2200" },
    });

    expect(screen.getByLabelText("Total du poste 1").textContent).toContain("2");
    expect(screen.getByText("Détail saisi")).toBeTruthy();
    expect(onBudgetChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Utiliser ce budget" }));
    expect(onBudgetChange).toHaveBeenCalledWith(2_200);
    expect(screen.getByRole("button", { name: "Budget utilisé" })).toBeTruthy();
  });

  it("does not invent a budget when the analysis has no estimate", () => {
    const onBudgetChange = vi.fn();
    render(
      <ListingWorks sale={EXAMPLE_SALE} estimatedBudget={null} onBudgetChange={onBudgetChange} />,
    );

    expect(screen.getByText("Non estimé")).toBeTruthy();
    expect(screen.getByText("Données insuffisantes")).toBeTruthy();
    expect(onBudgetChange).not.toHaveBeenCalled();
  });

  it("restores a draft and emits edits without applying them to the simulation", () => {
    const onDraftChange = vi.fn();
    render(
      <ListingWorks
        sale={EXAMPLE_SALE}
        estimatedBudget={12_500}
        initialDraft={{
          lines: [{ label: "Peinture", quantity: "2", unit: "m²", unitPrice: "100" }],
        }}
        onDraftChange={onDraftChange}
      />,
    );

    expect((screen.getByLabelText("Libellé du poste 1") as HTMLInputElement).value).toBe(
      "Peinture",
    );
    expect((screen.getByLabelText("Quantité du poste 1") as HTMLInputElement).value).toBe("2");
    expect(screen.getByLabelText("Total du poste 1").textContent).toContain("200");
    expect(onDraftChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Prix unitaire du poste 1"), {
      target: { value: "125" },
    });
    expect(onDraftChange).toHaveBeenLastCalledWith({
      lines: [
        expect.objectContaining({
          label: "Peinture",
          quantity: "2",
          unit: "m²",
          unitPrice: "125",
        }),
      ],
    });
  });
});
