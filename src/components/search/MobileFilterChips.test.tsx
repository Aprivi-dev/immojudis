// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { MobileFilterChips } from "./MobileFilterChips";
import { emptySearchDraft, type SearchDraft } from "./search-page-state";

afterEach(cleanup);

function Harness({ initial = {} }: { initial?: Partial<SearchDraft> }) {
  const [draft, setDraft] = useState<SearchDraft>({ ...emptySearchDraft(), ...initial });
  return <MobileFilterChips draft={draft} setDraft={setDraft} />;
}

describe("MobileFilterChips : noms et liens accessibles", () => {
  it("nomme chacune des fenêtres (dialog) ouvertes par les pastilles", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Mise à prix max/ }));
    expect(screen.getByRole("dialog", { name: "Mise à prix maximum" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    cleanup();

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Date de vente/ }));
    expect(screen.getByRole("dialog", { name: "Date de vente" })).toBeTruthy();
  });

  it("relie l'erreur de prix au champ (aria-describedby vers l'alerte)", () => {
    render(<Harness initial={{ minPrice: "200000", maxPrice: "100000" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Mise à prix max/ }));
    const input = screen.getByLabelText("Mise à prix maximum (€)");
    const alert = screen.getByRole("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.id).not.toBe("");
  });

  it("n'a pas d'erreur reliée tant que la fourchette est valide", () => {
    render(<Harness initial={{ maxPrice: "100000" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Mise à prix max/ }));
    const input = screen.getByLabelText("Mise à prix maximum (€)");
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dit en mots le compteur « · 1 » de la date de vente", () => {
    render(<Harness initial={{ minSaleDate: "2026-11-01" }} />);
    const chip = screen.getByRole("button", { name: /Date de vente/ });
    expect(chip.getAttribute("aria-controls")).toBeNull();
    expect(chip.textContent).toContain("1 filtre actif");
    expect(screen.getByRole("button", { name: "Date de vente, 1 filtre actif" })).toBe(chip);
  });

  it("n'a pas de compteur sans filtre de date", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Date de vente" })).toBeTruthy();
  });

  it("n'a pas de défaut d'accessibilité, fenêtre ouverte comprise", async () => {
    const { container } = render(<Harness initial={{ maxPrice: "100000" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Mise à prix max/ }));
    const result = await axe(document.body, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
    expect(container).toBeTruthy();
  });
});
