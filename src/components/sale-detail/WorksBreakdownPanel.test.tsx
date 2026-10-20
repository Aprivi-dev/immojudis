// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { WorksBreakdownItem } from "@/lib/works-breakdown";
import { WorksBreakdownPanel } from "./WorksBreakdownPanel";

afterEach(cleanup);

const saved: WorksBreakdownItem[] = [
  { id: "a", kind: "toiture", label: "", quantity: "1", unit: "forfait", unitCost: "8000" },
  { id: "b", kind: "peinture", label: "", quantity: "40", unit: "m²", unitCost: "25" },
];

function Harness({
  initial = [],
  onChange,
}: {
  initial?: WorksBreakdownItem[];
  onChange?: (items: WorksBreakdownItem[]) => void;
}) {
  const [items, setItems] = useState(initial);
  return (
    <WorksBreakdownPanel
      items={items}
      onChange={(next) => {
        setItems(next);
        onChange?.(next);
      }}
    />
  );
}

function money(element: HTMLElement) {
  return (element.textContent ?? "").replace(/\s/g, "");
}

describe("WorksBreakdownPanel", () => {
  it("is optional: closed behind a button until the user opens it", () => {
    render(<Harness />);

    const toggle = screen.getByRole("button", { name: "Détailler les travaux" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Détail de vos travaux" })).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(
      screen.getByRole("group", { name: "Détail de vos travaux" }).id,
    );
    expect(screen.getByText(/Aucun poste pour l’instant/)).toBeTruthy();
  });

  it("opens by itself when postes were saved", () => {
    render(<Harness initial={saved} />);

    expect(screen.getByRole("group", { name: "Détail de vos travaux" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("uses a neutral title and says that the amounts are the user's, without value as a quote", () => {
    render(<Harness initial={saved} />);

    const panel = screen.getByRole("group", { name: "Détail de vos travaux" });
    expect(within(panel).getByRole("heading", { name: "Détail de vos travaux" })).toBeTruthy();
    expect(panel.textContent).toContain("Montants saisis par vous, sans valeur de devis.");
    // « devis » appears only in that mandatory mention, never in a title or a label.
    expect(panel.textContent?.match(/devis/gi)).toHaveLength(1);
    for (const heading of within(panel).getAllByRole("heading")) {
      expect(heading.textContent).not.toMatch(/devis/i);
    }
  });

  it("carries no fiscal notion and proposes no amount", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Détailler les travaux" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un poste" }));

    const panel = screen.getByRole("group", { name: "Détail de vos travaux" });
    expect(panel.textContent).not.toMatch(
      /TVA|\bHT\b|\bTTC\b|récupérable|régime|fiscal|déductible/i,
    );
    for (const input of within(panel).getAllByRole("textbox")) {
      expect((input as HTMLInputElement).value).toBe("");
      expect(input.getAttribute("placeholder")).toBeNull();
    }
    expect(within(panel).getByRole("status", { name: "Total de vos postes" }).textContent).toBe(
      "—",
    );
  });

  it("offers the twelve kinds of work and nothing else", () => {
    render(<Harness initial={[{ ...saved[0], kind: "" }]} />);

    const select = screen.getByRole("combobox", { name: "Type, poste 1" });
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Choisir un poste",
      "Toiture",
      "Façade",
      "Électricité",
      "Plomberie",
      "Chauffage",
      "Menuiseries",
      "Isolation",
      "Cuisine",
      "Salle de bains",
      "Sols",
      "Peinture",
      "Autre",
    ]);
  });

  it("adds a poste, focuses it, and totals what the user types", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Détailler les travaux" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un poste" }));

    const select = screen.getByRole("combobox", { name: "Type, poste 1" });
    expect(document.activeElement).toBe(select);

    fireEvent.change(select, { target: { value: "electricite" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Quantité, poste 1/ }), {
      target: { value: "12,5" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Unité, poste 1/ }), {
      target: { value: "m²" },
    });
    expect(money(screen.getByRole("status", { name: "Total de vos postes" }))).toBe("—");
    fireEvent.change(screen.getByRole("textbox", { name: /^Coût unitaire, poste 1/ }), {
      target: { value: "80" },
    });

    expect(money(screen.getByRole("status", { name: "Total de vos postes" }))).toBe("1000€");
    expect(money(screen.getByLabelText(/^Total, poste 1/))).toBe("1000€");
    const last = onChange.mock.calls.at(-1)?.[0] as WorksBreakdownItem[];
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({
      kind: "electricite",
      quantity: "12,5",
      unit: "m²",
      unitCost: "80",
    });
  });

  it("sums several postes and leaves out the incomplete ones, saying so", () => {
    render(
      <Harness
        initial={[
          ...saved,
          { id: "c", kind: "sols", label: "", quantity: "30", unit: "m²", unitCost: "" },
        ]}
      />,
    );

    // 8 000 + 40 × 25 = 9 000
    expect(money(screen.getByRole("status", { name: "Total de vos postes" }))).toBe("9000€");
    expect(screen.getByText(/1 poste à compléter/)).toBeTruthy();
    expect(screen.getByText(/il ne compte\s+pas dans le total/)).toBeTruthy();
    expect(screen.getByLabelText(/^Total, poste 3/).textContent).toBe("À compléter");
  });

  it("asks for a free precision only for « Autre »", () => {
    render(<Harness initial={[{ ...saved[0], kind: "autre" }, saved[1]]} />);

    expect(screen.getByRole("textbox", { name: "Précision, poste 1 (Autre)" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /^Précision, poste 2/ })).toBeNull();
  });

  it("removes a poste and puts the focus back on « Ajouter un poste »", () => {
    render(<Harness initial={saved} />);

    fireEvent.click(screen.getByRole("button", { name: "Retirer le poste 1 (Toiture) du détail" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(money(screen.getByRole("status", { name: "Total de vos postes" }))).toBe("1000€");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Ajouter un poste" }));
  });

  it("flags a value that is not a number", () => {
    render(<Harness initial={saved} />);

    const quantity = screen.getByRole("textbox", { name: /^Quantité, poste 1/ });
    expect(quantity.getAttribute("aria-invalid")).toBe("false");
    fireEvent.change(quantity, { target: { value: "beaucoup" } });

    expect(quantity.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText(/^Total, poste 1/).textContent).toBe("À compléter");
  });

  it("stops at thirty postes", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...saved[0],
      id: `p${index}`,
    }));
    render(<Harness initial={many} />);

    const add = screen.getByRole("button", { name: "Ajouter un poste" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText("30 postes au maximum.")).toBeTruthy();
  });

  it("has no accessibility violation, closed or open with postes", async () => {
    const closed = render(<Harness />);
    expect(
      (await axe(closed.container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
    closed.unmount();

    const open = render(<Harness initial={[...saved, { ...saved[0], id: "z", kind: "autre" }]} />);
    expect(
      (await axe(open.container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
