// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComparedSale } from "@/lib/search/sale-comparison";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./SavedSaleComparisons", () => ({
  SavedSaleComparisons: () => <div>Comparaisons enregistrées (mock)</div>,
}));

import { SaleComparisonBar } from "./SaleComparisonBar";
import SaleComparisonDialog from "./SaleComparisonDialog";
import { SaleComparisonTable } from "./SaleComparisonTable";

afterEach(cleanup);

function compared(id: string, overrides: Partial<ComparedSale> = {}): ComparedSale {
  return {
    id,
    city: "Lyon",
    department: "69",
    propertyType: "apartment",
    venueType: "tribunal",
    saleDate: "2026-11-12T09:00:00.000Z",
    startingPriceEur: 60_000,
    surfaceM2: 40,
    surfaceKind: "habitable",
    occupancy: "libre",
    rooms: 2,
    bedrooms: 1,
    bathrooms: 1,
    ...overrides,
  };
}

function rowOf(label: string): HTMLElement {
  return screen.getByRole("rowheader", { name: label }).closest("tr")!;
}

describe("SaleComparisonTable", () => {
  it("shows the price per square metre, the occupation and the département", () => {
    render(
      <SaleComparisonTable
        returnTo="/sales"
        items={[
          compared("a"),
          compared("b", {
            department: "13",
            occupancy: "occupé",
            startingPriceEur: 90_000,
            surfaceM2: null,
          }),
        ]}
      />,
    );
    const perM2 = within(rowOf("Mise à prix / m²")).getAllByRole("cell");
    expect(perM2[0].textContent).toMatch(/1\s?500\s€\/m²/);
    expect(perM2[1].textContent).toBe("Non calculable");
    const occupation = within(rowOf("Occupation")).getAllByRole("cell");
    expect(occupation.map((cell) => cell.textContent)).toEqual(["Libre", "Occupé"]);
    const department = within(rowOf("Département")).getAllByRole("cell");
    expect(department.map((cell) => cell.textContent)).toEqual(["69", "13"]);
  });

  it("reads « Prix non communiqué » for a starting price of 0, never « 0 € »", () => {
    render(
      <SaleComparisonTable
        returnTo="/sales"
        items={[compared("a", { startingPriceEur: 0 }), compared("b")]}
      />,
    );
    const price = within(rowOf("Mise à prix")).getAllByRole("cell");
    expect(price[0].textContent).toBe("Prix non communiqué");
    expect(price[1].textContent).toMatch(/60\s000/);
  });

  it("reads « Non renseignée » for an older saved comparison without occupation", () => {
    const { occupancy: _unused, ...legacy } = compared("a");
    void _unused;
    render(<SaleComparisonTable returnTo="/sales" items={[legacy]} />);
    expect(within(rowOf("Occupation")).getByRole("cell").textContent).toBe("Non renseigné");
  });

  it("narrows the criteria column on mobile and fixes the property columns at 180 px", () => {
    render(<SaleComparisonTable returnTo="/sales" items={[compared("a"), compared("b")]} />);
    const criteria = screen.getByRole("columnheader", { name: "Critères" });
    expect(criteria.className).toContain("w-[96px]");
    expect(criteria.className).toContain("sm:w-[140px]");
    const property = screen.getByRole("columnheader", { name: /Bien 1/ });
    expect(property.style.width).toBe("180px");
  });
});

describe("SaleComparisonBar", () => {
  it("sticks under the search header at every width", () => {
    render(
      <SaleComparisonBar
        items={[compared("a")]}
        returnTo="/sales"
        userId={null}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    const bar = screen.getByRole("region", { name: "Sélection à comparer" });
    expect(bar.className).toContain("top-[var(--sales-header-height)]");
    expect(bar.className).not.toMatch(/(^|\s)top-0(\s|$)/);
  });
});

describe("SaleComparisonDialog footer", () => {
  function renderDialog(items: ComparedSale[]) {
    return render(
      <SaleComparisonDialog
        open
        items={items}
        returnTo="/sales"
        userId="user-1"
        onOpenChange={vi.fn()}
        onRemove={vi.fn()}
        onRestore={vi.fn()}
        onRestoreFocus={vi.fn()}
      />,
    );
  }

  it("is folded on mobile until the person unfolds it, and capped at a quarter of the screen", () => {
    renderDialog([compared("a"), compared("b")]);
    const toggle = screen.getByRole("button", { name: /Comparaisons enregistrées et mentions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const footer = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(footer.className).toContain("hidden");
    expect(footer.className).toContain("max-h-[25svh]");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(footer.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("stays open when there is nothing to compare, so saved comparisons can be restored", () => {
    renderDialog([]);
    const toggle = screen.getByRole("button", { name: /Comparaisons enregistrées et mentions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
