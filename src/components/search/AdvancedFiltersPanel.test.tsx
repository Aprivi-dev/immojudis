// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySearchDraft } from "./search-page-state";
import { MobileFilterDrawer, showResultsLabel } from "./AdvancedFiltersPanel";

vi.mock("./DateRangeFields", () => ({ DateRangeFields: () => null }));

afterEach(cleanup);

function renderDrawer() {
  return render(
    <MobileFilterDrawer
      draft={emptySearchDraft()}
      setDraft={vi.fn()}
      activeFiltersCount={0}
      onClose={vi.fn()}
      onReset={vi.fn()}
    />,
  );
}

describe("filtres sur mobile", () => {
  it("affiche de vrais libellés au-dessus des champs", () => {
    renderDrawer();
    for (const label of [
      "Minimum (€)",
      "Maximum (€)",
      "Chambres minimum",
      "Salles de bain minimum",
      "Ville",
      "Tribunal",
      "Département",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("n'affiche « Mise à prix » qu'une seule fois", () => {
    renderDrawer();
    expect(screen.getAllByText("Mise à prix")).toHaveLength(1);
  });

  it("appelle le critère de note par son nom clair, sans « Score min »", () => {
    renderDrawer();
    expect(screen.getByText("Note minimale (classement Immojudis)")).toBeTruthy();
    expect(screen.queryByText("Score min")).toBeNull();
  });

  it("donne une cible de 44 px à chaque bouton de la fenêtre", () => {
    renderDrawer();
    const targets = [
      screen.getByRole("button", { name: "Fermer" }),
      screen.getByRole("button", { name: /Réinitialiser/ }),
      screen.getByRole("button", { name: "Afficher les résultats" }),
      screen.getByRole("button", { name: "Maison" }),
      screen.getByRole("button", { name: "À venir" }),
      screen.getByRole("button", { name: "A" }),
    ];
    for (const target of targets) {
      expect(target.className, target.textContent ?? "").toContain("min-h-11");
      expect(target.className).not.toMatch(/(^|\s)h-(9|10)(\s|$)/);
    }
  });

  it("dit dans le bouton combien d'annonces correspondent", () => {
    const { rerender } = render(
      <MobileFilterDrawer
        draft={emptySearchDraft()}
        setDraft={vi.fn()}
        activeFiltersCount={2}
        resultCount={1646}
        onClose={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Afficher 1\s646 annonces$/ }).textContent,
    ).toContain("annonces");
    for (const [resultCount, label] of [
      [1, "Afficher l'annonce"],
      [0, "Aucune annonce : élargir"],
      [null, "Afficher les résultats"],
      [undefined, "Afficher les résultats"],
    ] as const) {
      rerender(
        <MobileFilterDrawer
          draft={emptySearchDraft()}
          setDraft={vi.fn()}
          activeFiltersCount={2}
          resultCount={resultCount}
          onClose={vi.fn()}
          onReset={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("le bouton referme toujours la fenêtre, même quand il propose d'élargir", () => {
    const onClose = vi.fn();
    render(
      <MobileFilterDrawer
        draft={emptySearchDraft()}
        setDraft={vi.fn()}
        activeFiltersCount={3}
        resultCount={0}
        onClose={onClose}
        onReset={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Aucune annonce : élargir" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("showResultsLabel", () => {
  it("annonce le total avec les séparateurs français", () => {
    expect(showResultsLabel(2)).toBe("Afficher 2 annonces");
    expect(showResultsLabel(12345).replace(/\s/g, " ")).toBe("Afficher 12 345 annonces");
  });
});
