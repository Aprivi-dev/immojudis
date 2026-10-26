// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { MobileFilterChips } from "./MobileFilterChips";
import { emptySearchDraft, type SearchDraft } from "./search-page-state";

afterEach(cleanup);

function Harness({
  initial = {},
  preview = false,
}: {
  initial?: Partial<SearchDraft>;
  preview?: boolean;
}) {
  const [draft, setDraft] = useState<SearchDraft>({ ...emptySearchDraft(), ...initial });
  return <MobileFilterChips draft={draft} setDraft={setDraft} preview={preview} />;
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

describe("MobileFilterChips : « sous la fourchette » et « sans point à vérifier »", () => {
  it("les propose à un compte, à bascule, avec leur état dit en mot", () => {
    render(<Harness />);
    const below = screen.getByRole("button", {
      name: "Mise à prix sous la fourchette des ventes comparables",
    });
    const noPoints = screen.getByRole("button", { name: "Sans point à vérifier" });
    expect(below.getAttribute("aria-pressed")).toBe("false");
    expect(below.textContent).toBe("Sous la fourchette");

    fireEvent.click(below);
    fireEvent.click(noPoints);
    expect(below.getAttribute("aria-pressed")).toBe("true");
    expect(noPoints.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(below);
    expect(below.getAttribute("aria-pressed")).toBe("false");
    expect(noPoints.getAttribute("aria-pressed")).toBe("true");
  });

  it("reprend l'état du brouillon", () => {
    render(<Harness initial={{ belowRange: true }} />);

    expect(
      screen
        .getByRole("button", { name: "Mise à prix sous la fourchette des ventes comparables" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("ne les propose pas à un visiteur sans compte", () => {
    render(<Harness preview />);

    expect(screen.queryByRole("button", { name: /Sans point à vérifier/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /sous la fourchette/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Mise à prix max/ })).toBeTruthy();
  });

  it("garde chaque pastille à 44 px de haut", () => {
    render(<Harness />);

    for (const name of ["Sans point à vérifier", /sous la fourchette/]) {
      expect(screen.getByRole("button", { name }).className).toContain("h-11");
    }
  });
});

describe("MobileFilterChips : « Pépites seulement »", () => {
  function PepiteHarness({
    pepitesActive,
    preview = false,
    initial = {},
  }: {
    pepitesActive: boolean;
    preview?: boolean;
    initial?: Partial<SearchDraft>;
  }) {
    const [draft, setDraft] = useState<SearchDraft>({ ...emptySearchDraft(), ...initial });
    return (
      <MobileFilterChips
        draft={draft}
        setDraft={setDraft}
        preview={preview}
        pepitesActive={pepitesActive}
      />
    );
  }

  it("n'apparaît pas tant que les pépites ne sont pas ouvertes : pas de filtre qui ne renverrait rien", () => {
    render(<PepiteHarness pepitesActive={false} />);
    expect(screen.queryByRole("button", { name: /Pépites seulement/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/pépite/i);
  });

  it("est la première pastille, avec le logo, ouverte aux visiteurs sans compte", () => {
    render(<PepiteHarness pepitesActive preview />);
    const group = screen.getByRole("group", { name: "Filtres rapides" });
    const first = group.querySelector("button, label");
    expect(first?.textContent).toBe("Pépites seulement");
    const chip = screen.getByRole("button", { name: "Pépites seulement" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // Les deux autres repères restent réservés aux comptes.
    expect(screen.queryByRole("button", { name: /Sous la fourchette/ })).toBeNull();
  });

  it("bascule le brouillon et montre l'état par une coche, pas seulement par la couleur", () => {
    render(<PepiteHarness pepitesActive />);
    const chip = screen.getByRole("button", { name: "Pépites seulement" });
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // Actif : la coche remplace le logo (une forme, pas seulement la couleur).
    expect(chip.querySelector("svg")?.getAttribute("class")).toMatch(/lucide-check|size-4/);
    expect(chip.innerHTML).toMatch(/M20 6 9 17l-5-5|lucide-check/);
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });
});
