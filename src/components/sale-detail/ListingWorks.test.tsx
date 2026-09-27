// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(screen.getByText("Enveloppe de simulation")).toBeTruthy();
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
});
