// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySearchDraft } from "./search-page-state";
import { MobileFilterDrawer, showResultsLabel } from "./AdvancedFiltersPanel";

vi.mock("./DateRangeFields", () => ({ DateRangeFields: () => null }));

afterEach(cleanup);

function renderDrawer(overrides: Partial<Parameters<typeof MobileFilterDrawer>[0]> = {}) {
  return render(
    <MobileFilterDrawer
      draft={emptySearchDraft()}
      setDraft={vi.fn()}
      activeFiltersCount={0}
      onClose={vi.fn()}
      onReset={vi.fn()}
      {...overrides}
    />,
  );
}

describe("filtre « rendement minimal »", () => {
  it("dit que le filtre suit un repère départemental, sans mention de l'ANIL à côté", () => {
    renderDrawer();

    const note = screen.getByText(/Ce filtre s’appuie sur un repère de loyer départemental/);
    expect(note.textContent).toBe(
      "Ce filtre s’appuie sur un repère de loyer départemental ; les alertes, exports et statistiques utilisent la carte des loyers de l’ANIL (par commune).",
    );
    // La mention de la Licence Ouverte n'apparaît qu'à côté de ce qui vient réellement de l'ANIL.
    expect(document.querySelector("[data-rent-source-notice]")).toBeNull();
    expect(screen.queryByText(/Estimations ANIL/)).toBeNull();
  });
});

describe("filtres « sous la fourchette » et « sans point à vérifier »", () => {
  it("propose les deux cases, avec ce que chaque filtre couvre", () => {
    renderDrawer();

    const below = screen.getByRole("checkbox", {
      name: /Mise à prix sous la fourchette des ventes comparables/,
    });
    const hint = document.getElementById(below.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toContain(
      "Ne couvre que les ventes dont l’estimation est assez fiable",
    );
    expect(hint.textContent).toContain("jamais un bien occupé");

    const noPoints = screen.getByRole("checkbox", { name: /Sans point à vérifier/ });
    const noPointsHint = document.getElementById(noPoints.getAttribute("aria-describedby")!)!;
    expect(noPointsHint.textContent).toContain("ne garantit pas");
  });

  it("coche et décoche le brouillon", () => {
    const setDraft = vi.fn();
    renderDrawer({ setDraft });

    fireEvent.click(screen.getByRole("checkbox", { name: /Sans point à vérifier/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /sous la fourchette/ }));

    const apply = (call: number) => setDraft.mock.calls[call][0](emptySearchDraft());
    expect(apply(0)).toMatchObject({ noPointsToVerify: true, belowRange: false });
    expect(apply(1)).toMatchObject({ belowRange: true, noPointsToVerify: false });
  });

  it("reflète le brouillon", () => {
    renderDrawer({ draft: { ...emptySearchDraft(), belowRange: true } });

    expect(
      (screen.getByRole("checkbox", { name: /sous la fourchette/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: /Sans point à vérifier/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("les réserve à un compte : désactivées pour un visiteur, qui le lit", () => {
    renderDrawer({ preview: true });

    // Désactivées par le fieldset qui les contient.
    expect(screen.getByRole("checkbox", { name: /sous la fourchette/ }).matches(":disabled")).toBe(
      true,
    );
    expect(
      screen.getByRole("checkbox", { name: /Sans point à vérifier/ }).matches(":disabled"),
    ).toBe(true);
    expect(screen.getByText("Ces filtres nécessitent un compte.")).toBeTruthy();
  });

  it("restent ouvertes à un compte gratuit (la bande est publique)", () => {
    renderDrawer({ analysisLocked: true });

    expect(screen.getByRole("checkbox", { name: /sous la fourchette/ }).matches(":disabled")).toBe(
      false,
    );
  });
});

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

  it("propose « Visite dans les 7 jours » et ne retient que les dates publiées en entier", () => {
    renderDrawer();
    const box = screen.getByRole("checkbox", { name: /Visite dans les 7 jours/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/date complète est publiée/)).toBeTruthy();
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

describe("filtre « Pépites seulement »", () => {
  it("n'est pas proposé tant que les pépites ne sont pas ouvertes", () => {
    renderDrawer();
    expect(screen.queryByRole("checkbox", { name: /Pépites seulement/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/pépite/i);
  });

  it("est proposé avec son explication, y compris à un visiteur (hors du bloc réservé aux comptes)", () => {
    renderDrawer({ pepitesActive: true, preview: true });
    const checkbox = screen.getByRole("checkbox", {
      name: /Pépites seulement/,
    }) as HTMLInputElement;
    expect(checkbox.closest("fieldset")).toBeNull();
    expect(checkbox.disabled).toBe(false);
    const hint = document.getElementById(checkbox.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toContain("ni une recommandation d'acheter");
    // Les repères réservés aux comptes restent grisés pour un visiteur.
    expect(
      screen.getByRole("checkbox", { name: /Sans point à vérifier/ }).matches(":disabled"),
    ).toBe(true);
    expect(checkbox.matches(":disabled")).toBe(false);
  });

  it("coche et décoche le brouillon", () => {
    const setDraft = vi.fn();
    renderDrawer({ pepitesActive: true, setDraft });
    fireEvent.click(screen.getByRole("checkbox", { name: /Pépites seulement/ }));
    expect(setDraft.mock.calls[0][0](emptySearchDraft())).toMatchObject({ pepite: true });
  });
});
