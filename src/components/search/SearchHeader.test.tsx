// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CsvExportButton,
  HomeTypeFilter,
  PriceFilter,
  ResultsSummary,
  ResultsViewToggle,
  SaveSearchButton,
  SearchHeader,
  SortDropdown,
} from "./SearchHeader";
import { emptySearchDraft, type SearchDraft } from "./search-page-state";

vi.mock("next/navigation", () => ({ usePathname: () => "/sales" }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, profile: null, loading: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: vi.fn() } } }));

afterEach(cleanup);

describe("SaveSearchButton", () => {
  it("n'affiche ni cadenas ni mention de l'offre Analyse : la première alerte est gratuite", () => {
    const onClick = vi.fn();
    const { container } = render(<SaveSearchButton saving={false} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Créer une alerte" });
    expect(button.textContent).toBe("Créer une alerte");
    expect(container.querySelector(".lucide-lock-keyhole")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("garde un nom accessible en version compacte", () => {
    render(<SaveSearchButton compact saving={false} onClick={() => undefined} />);
    expect(screen.getByRole("button", { name: "Créer une alerte" })).toBeTruthy();
  });
});

describe("SaveSearchButton avec compte", () => {
  it("propose l'email hebdomadaire au compte gratuit et réserve le quotidien à l'offre Analyse", () => {
    const onClick = vi.fn();
    render(<SaveSearchButton signedIn saving={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect(screen.getByText(/un seul email récapitulatif/)).toBeTruthy();
    const daily = screen.getByRole("radio", { name: /Quotidienne/ }) as HTMLInputElement;
    expect(daily.disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Hebdomadaire" }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    expect(onClick).toHaveBeenCalledWith({ frequency: "weekly", emailRecap: false });
  });

  it("propose le quotidien par défaut avec l'offre Analyse", () => {
    const onClick = vi.fn();
    render(<SaveSearchButton signedIn dailyAllowed saving={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect((screen.getByRole("radio", { name: /Quotidienne/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Hebdomadaire/ }));
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    expect(onClick).toHaveBeenCalledWith({ frequency: "weekly", emailRecap: false });
  });
});

describe("SaveSearchButton : email récapitulatif", () => {
  it("propose une case non cochée et transmet le choix à la création", () => {
    const onClick = vi.fn();
    render(<SaveSearchButton signedIn saving={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    const checkbox = screen.getByRole("checkbox", {
      name: /Recevoir un email récapitulatif chaque semaine/,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    expect(onClick).toHaveBeenCalledWith({ frequency: "weekly", emailRecap: true });
  });

  it("annonce un email quotidien quand la fréquence quotidienne est choisie", () => {
    render(<SaveSearchButton signedIn dailyAllowed saving={false} onClick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect(screen.getByRole("checkbox", { name: /chaque jour/ })).toBeTruthy();
  });

  it("ne redemande pas le consentement s'il est déjà donné", () => {
    const onClick = vi.fn();
    render(<SaveSearchButton signedIn emailRecapEnabled saving={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/L’email récapitulatif est activé/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    expect(onClick).toHaveBeenCalledWith({ frequency: "weekly", emailRecap: false });
  });
});

describe("SortDropdown", () => {
  it("grise « Distance » tant qu'aucune adresse n'est saisie", () => {
    render(<SortDropdown sort="relevance" onChange={vi.fn()} />);
    const option = screen.getByRole("option", { name: /Distance/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    cleanup();
    render(<SortDropdown hasCenter sort="distance" onChange={vi.fn()} />);
    expect((screen.getByRole("option", { name: "Distance" }) as HTMLOptionElement).disabled).toBe(
      false,
    );
  });

  it("peut rétrécir à 320 px : le libellé ne force pas la largeur, le select tronque", () => {
    render(<SortDropdown sort="relevance" onChange={vi.fn()} />);
    const select = screen.getByRole("combobox");
    const label = select.closest("label");
    expect(label?.className).toContain("min-w-0");
    expect(label?.className).toContain("max-w-full");
    expect(label?.className).not.toContain("shrink-0");
    expect(select.className).toContain("min-w-0");
    expect(select.className).toContain("w-full");
    expect(select.className).toContain("text-ellipsis");
  });
});

describe("SortDropdown : options selon l'offre", () => {
  const labels = () => screen.getAllByRole("option").map((option) => option.textContent);

  it("n'affiche pas le tri par score d'investissement aux visiteurs ni à l'offre Découverte", () => {
    render(<SortDropdown sort="relevance" onChange={vi.fn()} />);
    expect(labels()).toContain("Mieux renseignées d’abord");
    expect(labels()).not.toContain("Score d’investissement");
    cleanup();
    render(<SortDropdown preview sort="relevance" onChange={vi.fn()} />);
    expect(labels()).not.toContain("Score d’investissement");
  });

  it("propose le tri par score d'investissement à l'offre Analyse", () => {
    render(<SortDropdown investmentScore sort="score_desc" onChange={vi.fn()} />);
    expect(labels()).toContain("Mieux renseignées d’abord");
    expect(labels()).toContain("Score d’investissement");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("score_desc");
  });

  it("garde « Mieux renseignées d’abord » en première option, tri par défaut", () => {
    render(<SortDropdown investmentScore sort="relevance" onChange={vi.fn()} />);
    expect(labels()[0]).toBe("Mieux renseignées d’abord");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("relevance");
  });
});

describe("Tri et hauteur tactile", () => {
  it("garde le tri par date de vente dans le seul menu de tri", () => {
    const onChange = vi.fn();
    render(<SortDropdown sort="relevance" onChange={onChange} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toContain("sale_date_asc");
    fireEvent.change(select, { target: { value: "sale_date_asc" } });
    expect(onChange).toHaveBeenCalledWith("sale_date_asc");
    expect(screen.queryByRole("button", { name: "Trier par date de vente" })).toBeNull();
  });

  it("donne aux listes Type de bien et Tri une hauteur tactile d'au moins 44 px", () => {
    const { container } = render(<SortDropdown sort="relevance" onChange={vi.fn()} />);
    expect(container.querySelector("label")?.className).toContain("min-h-11");
    expect(container.querySelector("label")?.className).not.toContain("h-10");
  });

  it("donne aussi au filtre Type de bien une hauteur tactile d'au moins 44 px", () => {
    const { container } = render(<HomeTypeFilter draft={emptySearchDraft()} setDraft={vi.fn()} />);
    expect(container.querySelector("label")?.className).toContain("min-h-11");
    expect(container.querySelector("label")?.className).not.toContain("h-10");
  });
});

describe("ResultsSummary", () => {
  it("n'annonce que le compteur aux lecteurs d'écran", () => {
    const { container } = render(
      <ResultsSummary
        search={{ city: "Lyon" }}
        displayCount={12}
        hasLocalFilters={false}
        isLoading={false}
        geocoding={false}
      />,
    );
    const live = container.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("12 annonces");
  });

  it("réserve la hauteur de deux lignes de titre sous sm, pour qu'aucune police ne décale la page", () => {
    // Le h1 pouvait passer de deux lignes (police de secours) à une à l'arrivée de la police :
    // sans réserve, tout ce qui suit remonte de 33 px (CLS) et la photo de la première carte
    // change de surface visible (LCP). 7,625 rem = py-4 + 2 lignes de h1 + compteur (le surtitre,
    // masqué sous sm, n'y est plus compté : 8,8125 rem avant).
    const summary = (city?: string) =>
      render(
        <ResultsSummary
          search={city ? { city } : {}}
          displayCount={12}
          hasLocalFilters={false}
          isLoading={false}
          geocoding={false}
        />,
      ).container.firstElementChild as HTMLElement;

    for (const root of [summary(), summary("Lyon")]) {
      expect(root.className).toContain("min-h-[7.625rem]");
      expect(root.className).toContain("sm:min-h-0");
    }
  });

  it("nomme le département dans le titre et le compteur, au lieu de son code", () => {
    const { container } = render(
      <ResultsSummary
        search={{ department: "13" }}
        displayCount={28}
        hasLocalFilters={false}
        isLoading={false}
        geocoding={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Ventes immobilières aux enchères : Bouches-du-Rhône (13)",
    );
    expect(container.textContent).toContain("28 annonces · Bouches-du-Rhône (13)");
  });

  it("garde la ville dans le titre quand elle est donnée avec le département", () => {
    render(
      <ResultsSummary
        search={{ city: "Marseille", department: "13" }}
        displayCount={3}
        hasLocalFilters={false}
        isLoading={false}
        geocoding={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Ventes immobilières aux enchères à Marseille",
    );
  });

  it("n'a plus de surtitre au-dessus du titre des résultats", () => {
    render(
      <ResultsSummary
        search={{}}
        displayCount={12}
        hasLocalFilters={false}
        isLoading={false}
        geocoding={false}
      />,
    );
    expect(screen.queryByText("Le catalogue des enchères")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Ventes immobilières aux enchères",
    );
  });

  it("montre une petite pastille dans la ligne du compteur quand la liste se met à jour, sans texte", () => {
    const props = {
      search: {},
      displayCount: 12,
      hasLocalFilters: false,
      isLoading: false,
      geocoding: false,
    };
    const { rerender } = render(<ResultsSummary {...props} />);
    expect(screen.queryByTestId("results-refreshing")).toBeNull();
    rerender(<ResultsSummary {...props} refreshing />);
    const indicator = screen.getByTestId("results-refreshing");
    expect(indicator.getAttribute("aria-hidden")).toBe("true");
    expect(indicator.textContent).toBe("");
    // Rien de visible n'est ajouté au compteur annoncé.
    expect(screen.queryByText(/Actualisation/)).toBeNull();
  });
});

describe("PriceFilter : minimum au-dessus du maximum", () => {
  it("dit que la mise à prix minimum dépasse le maximum, dans les deux présentations", () => {
    const draft = { ...emptySearchDraft(), minPrice: "300000", maxPrice: "100000" };
    for (const stacked of [false, true]) {
      const { unmount } = render(
        <PriceFilter draft={draft} setDraft={vi.fn()} stacked={stacked} />,
      );
      expect(screen.getByRole("alert").textContent).toBe(
        "La mise à prix minimum dépasse le maximum",
      );
      unmount();
    }
  });

  it("ne dit rien quand les montants sont cohérents ou incomplets", () => {
    for (const [minPrice, maxPrice] of [
      ["100000", "300000"],
      ["100000", "100000"],
      ["100000", ""],
      ["", "100000"],
    ]) {
      const { unmount } = render(
        <PriceFilter draft={{ ...emptySearchDraft(), minPrice, maxPrice }} setDraft={vi.fn()} />,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      unmount();
    }
  });
});

describe("SearchHeader : effacer les filtres", () => {
  it("n'est plus caché sous le breakpoint desktop", () => {
    const base = {
      draft: emptySearchDraft(),
      setDraft: vi.fn(),
      activeFiltersCount: 2,
      isLoading: false,
      isFetching: false,
      filtersOpen: false,
      savingAlert: false,
      exportingCsv: false,
      csvExportLocked: false,
      wideMap: false,
      onFiltersOpenChange: vi.fn(),
      onReset: vi.fn(),
      onSaveSearch: vi.fn(),
      onExportCsv: vi.fn(),
      onToggleLayout: vi.fn(),
    };
    render(<SearchHeader {...base} />);
    const reset = screen.getByRole("button", { name: "Effacer les filtres" });
    expect(reset.className).not.toMatch(/\bhidden\b/);
    fireEvent.click(reset);
    expect(base.onReset).toHaveBeenCalledTimes(1);
  });
});

describe("SearchHeader : mobile", () => {
  const base = {
    draft: emptySearchDraft(),
    setDraft: vi.fn(),
    activeFiltersCount: 0,
    isLoading: false,
    isFetching: false,
    filtersOpen: false,
    savingAlert: false,
    exportingCsv: false,
    csvExportLocked: false,
    wideMap: false,
    onFiltersOpenChange: vi.fn(),
    onReset: vi.fn(),
    onSaveSearch: vi.fn(),
    onExportCsv: vi.fn(),
    onToggleLayout: vi.fn(),
  };

  it("ne reste collé en haut de l'écran qu'à partir de lg", () => {
    render(<SearchHeader {...base} />);
    const header = document.querySelector("header[data-site-header]") as HTMLElement;
    const classes = header.className.split(/\s+/);
    // `sticky` sans préfixe aurait été conservé par l'ancien en-tête : seul `lg:sticky` reste.
    expect(classes).toContain("static");
    expect(classes).toContain("lg:sticky");
    expect(classes).not.toContain("sticky");
  });

  it("propose « Type de bien », « Mise à prix max. » et « Date de vente » sous le champ de recherche", () => {
    render(<SearchHeader {...base} />);
    const chips = screen.getByRole("group", { name: "Filtres rapides" });
    expect(chips.className).toContain("lg:hidden");
    expect(within(chips).getByRole("combobox", { name: "Type de bien" })).toBeTruthy();
    expect(within(chips).getByRole("button", { name: /Mise à prix max\./ })).toBeTruthy();
    expect(within(chips).getByRole("button", { name: /Date de vente/ })).toBeTruthy();
    // Chaque pastille tient les 44 px de hauteur d'une cible tactile.
    for (const chip of [
      within(chips).getByRole("button", { name: /Mise à prix max\./ }),
      within(chips).getByRole("button", { name: /Date de vente/ }),
    ]) {
      expect(chip.className).toContain("h-11");
    }
  });

  /** L'en-tête avec un vrai brouillon : les saisies passent par l'état, comme dans la page. */
  function StatefulHeader() {
    const [draft, setDraft] = useState<SearchDraft>(emptySearchDraft());
    return (
      <>
        <SearchHeader {...base} draft={draft} setDraft={setDraft} />
        <output data-testid="draft">
          {JSON.stringify({ homeTypes: draft.homeTypes, maxPrice: draft.maxPrice })}
        </output>
      </>
    );
  }
  const draftState = () => JSON.parse(screen.getByTestId("draft").textContent ?? "{}");

  it("applique le type de bien choisi dans la pastille", () => {
    render(<StatefulHeader />);
    const select = within(screen.getByRole("group", { name: "Filtres rapides" })).getByRole(
      "combobox",
      { name: "Type de bien" },
    );
    fireEvent.change(select, { target: { value: "house" } });
    expect(draftState().homeTypes).toEqual(["house"]);
  });

  it("applique le maximum saisi dans la pastille « Mise à prix max. » et le rappelle une fois posé", () => {
    render(<StatefulHeader />);
    fireEvent.click(screen.getByRole("button", { name: /Mise à prix max\./ }));
    fireEvent.change(screen.getByLabelText("Mise à prix maximum (€)"), {
      target: { value: "150000" },
    });
    expect(draftState().maxPrice).toBe("150000");
    expect(screen.getByRole("button", { name: /Mise à prix max\./ }).textContent).toContain(
      "150 k€",
    );
  });

  it("dit dans la pastille quand le minimum saisi dépasse ce maximum", () => {
    function Header() {
      const [draft, setDraft] = useState<SearchDraft>({
        ...emptySearchDraft(),
        minPrice: "400000",
        maxPrice: "100000",
      });
      return <SearchHeader {...base} draft={draft} setDraft={setDraft} />;
    }
    render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: /Mise à prix max\./ }));
    const alerts = screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(alerts).toContain("La mise à prix minimum dépasse le maximum");
  });
});

describe("CsvExportButton", () => {
  it("reste cliquable pour un visiteur afin de le rediriger vers la connexion", () => {
    const onClick = vi.fn();
    render(<CsvExportButton exporting={false} locked onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Exporter en CSV" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("ResultsViewToggle", () => {
  it("propose Cartes et Tableau dans un groupe nommé, avec l'affichage courant enfoncé", () => {
    render(<ResultsViewToggle view="cards" onChange={() => undefined} />);
    const group = screen.getByRole("group", { name: "Affichage des résultats" });
    const cards = within(group).getByRole("button", { name: "Cartes" });
    const table = within(group).getByRole("button", { name: "Tableau" });
    expect(cards.getAttribute("aria-pressed")).toBe("true");
    expect(table.getAttribute("aria-pressed")).toBe("false");
  });

  it("enfonce Tableau quand c'est l'affichage courant", () => {
    render(<ResultsViewToggle view="table" onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "Tableau" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Cartes" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("transmet l'affichage choisi", () => {
    const onChange = vi.fn();
    render(<ResultsViewToggle view="cards" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Tableau" }));
    expect(onChange).toHaveBeenLastCalledWith("table");
    fireEvent.click(screen.getByRole("button", { name: "Cartes" }));
    expect(onChange).toHaveBeenLastCalledWith("cards");
  });

  it("n'apparaît qu'à partir de lg : masqué en dessous par le CSS", () => {
    render(<ResultsViewToggle view="cards" onChange={() => undefined} />);
    const group = screen.getByRole("group", { name: "Affichage des résultats", hidden: true });
    expect(group.className).toContain("hidden");
    expect(group.className).toContain("lg:block");
  });
});
