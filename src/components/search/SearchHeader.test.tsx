// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CsvExportButton,
  FREE_ALERT_LIMIT,
  HomeTypeFilter,
  PriceFilter,
  ResultsSummary,
  ResultsViewToggle,
  SalesSiteHeader,
  SaveSearchButton,
  SearchHeader,
  SortDropdown,
} from "./SearchHeader";
import { PLAN_LIMITS } from "@/lib/plans";
import { emptySearchDraft, type SearchDraft } from "./search-page-state";

vi.mock("next/navigation", () => ({ usePathname: () => "/sales" }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, profile: null, loading: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: vi.fn() } } }));

afterEach(cleanup);

describe("FREE_ALERT_LIMIT", () => {
  it("reprend la limite de zones surveillées de l'offre Découverte", () => {
    expect(PLAN_LIMITS.decouverte.watchedZones).not.toBeNull();
    expect(FREE_ALERT_LIMIT).toBe(PLAN_LIMITS.decouverte.watchedZones);
  });
});

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

  it("garde un nom accessible en version compacte, avec le mot « Alerte » à côté de l'icône", () => {
    render(<SaveSearchButton compact saving={false} onClick={() => undefined} />);
    const button = screen.getByRole("button", { name: "Créer une alerte" });
    expect(button.textContent).toBe("Alerte");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.className).toContain("h-11");
  });
});

describe("SaveSearchButton : alerte gratuite", () => {
  it("rappelle la limite gratuite dans la fenêtre de création", () => {
    render(
      <SaveSearchButton
        signedIn
        saving={false}
        freeAlertUsage={{ used: 0, limit: 1 }}
        onClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect(screen.getByTestId("free-alert-usage").textContent).toBe(
      "1 alerte gratuite (0/1 utilisée)",
    );
  });

  it("dit comment en créer une autre quand l'alerte gratuite est déjà utilisée", () => {
    render(
      <SaveSearchButton
        signedIn
        saving={false}
        freeAlertUsage={{ used: 1, limit: 1 }}
        onClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    const line = screen.getByTestId("free-alert-usage");
    expect(line.textContent).toContain("1 alerte gratuite (1/1 utilisée)");
    expect(line.textContent).toContain("modifiez ou supprimez votre alerte");
  });

  it("n'affiche rien quand l'usage n'est pas connu, et signale l'ouverture de la fenêtre", () => {
    const onOpen = vi.fn();
    render(<SaveSearchButton signedIn saving={false} onOpen={onOpen} onClick={vi.fn()} />);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("free-alert-usage")).toBeNull();
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

describe("SortDropdown dans la barre de liste", () => {
  it("n'a de cadre qu'à partir de sm : sur mobile, le tri est un mot dans la barre", () => {
    render(<SortDropdown bare sort="relevance" onChange={vi.fn()} />);
    const label = screen.getByRole("combobox", { name: "Tri" }).closest("label")!;
    const classes = label.className.split(/\s+/);
    expect(classes).toContain("sm:border");
    expect(classes).not.toContain("border");
    expect(classes).toContain("min-h-11");
    expect(label.querySelector("svg.lucide-arrow-up-down")?.getAttribute("class")).toContain(
      "hidden sm:block",
    );
  });

  it("garde le tri autonome (cadre et icône) partout ailleurs", () => {
    render(<SortDropdown sort="relevance" onChange={vi.fn()} />);
    const label = screen.getByRole("combobox", { name: "Tri" }).closest("label")!;
    expect(label.className.split(/\s+/)).toContain("border");
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

describe("ResultsSummary (barre de liste)", () => {
  const props = {
    displayCount: 833,
    isLoading: false,
    geocoding: false,
    page: 1,
    totalPages: 35,
  };

  it("dit « N annonces · page X sur Y » et n'annonce que le compteur aux lecteurs d'écran", () => {
    const { container } = render(<ResultsSummary {...props} />);
    const live = container.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("833 annonces");
    expect(container.textContent).toBe("833 annonces · page 1 sur 35");
  });

  it("ne parle pas de pages tant que le total n'est pas connu, ni pour une seule page", () => {
    const { container, rerender } = render(<ResultsSummary {...props} totalPages={0} />);
    expect(container.textContent).toBe("833 annonces");
    rerender(<ResultsSummary {...props} displayCount={3} totalPages={1} />);
    expect(container.textContent).toBe("3 annonces");
    rerender(<ResultsSummary {...props} isLoading />);
    expect(container.textContent).toBe("Recherche en cours…");
  });

  it("montre une petite pastille dans la ligne du compteur quand la liste se met à jour, sans texte", () => {
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

  it("laisse défiler l'en-tête du site : seule la barre de filtres reste à l'écran, à partir de lg", () => {
    render(
      <>
        <SalesSiteHeader refreshing={false} />
        <SearchHeader {...base} />
      </>,
    );
    const header = document.querySelector("header[data-site-header]") as HTMLElement;
    const headerClasses = header.className.split(/\s+/);
    expect(headerClasses).toContain("static");
    expect(headerClasses).not.toContain("sticky");
    expect(headerClasses).not.toContain("lg:sticky");
    const bar = document.querySelector("[data-sales-filters]") as HTMLElement;
    const barClasses = bar.className.split(/\s+/);
    expect(barClasses).toContain("lg:sticky");
    expect(barClasses).toContain("lg:top-0");
    expect(barClasses).not.toContain("sticky");
  });

  it("place l'en-tête du catalogue entre l'en-tête du site et la barre de filtres", () => {
    render(
      <>
        <SalesSiteHeader refreshing={false} />
        <SearchHeader {...base} intro={<h1>Titre du catalogue</h1>} />
      </>,
    );
    const header = document.querySelector("header[data-site-header]")!;
    const title = screen.getByRole("heading", { name: "Titre du catalogue" });
    const bar = document.querySelector("[data-sales-filters]")!;
    expect(header.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Le champ du lieu est dans la barre, plus dans l'en-tête du site.
    const place = screen.getByRole("textbox", { name: "Ville, département ou région" });
    expect(bar.contains(place)).toBe(true);
    expect(header.contains(place)).toBe(false);
  });

  it("annonce la mise à jour des résultats dans une région présente dès le départ", () => {
    const { rerender } = render(<SalesSiteHeader refreshing={false} />);
    const header = document.querySelector("header[data-site-header]")!;
    const status = within(header as HTMLElement).getByRole("status");
    expect(status.textContent).toBe("");
    rerender(<SalesSiteHeader refreshing />);
    expect(within(header as HTMLElement).getByRole("status").textContent).toBe(
      "Mise à jour des résultats",
    );
    // L'en-tête du catalogue ne rend plus l'en-tête du site : il est posé avant le `<main>`.
    cleanup();
    render(<SearchHeader {...base} />);
    expect(document.querySelector("header[data-site-header]")).toBeNull();
  });

  it("met les types de vente en pastilles sous les filtres, et le choix va dans le brouillon", () => {
    const setDraft = vi.fn();
    render(<SearchHeader {...base} setDraft={setDraft} />);
    const pills = screen.getByRole("group", { name: "Type de vente" });
    expect(within(pills).getByRole("button", { name: "Toutes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(within(pills).getByRole("button", { name: "Chez le notaire" }));
    const update = setDraft.mock.calls[0][0] as (draft: SearchDraft) => SearchDraft;
    expect(update({ ...emptySearchDraft(), tribunal: "Paris" })).toMatchObject({
      saleType: "notary",
      tribunal: "",
    });
  });

  it("ouvre tous les filtres depuis la pastille « Filtres » de la rangée mobile", () => {
    const onFiltersOpenChange = vi.fn();
    render(
      <SearchHeader {...base} activeFiltersCount={2} onFiltersOpenChange={onFiltersOpenChange} />,
    );
    const chips = screen.getByRole("group", { name: "Filtres rapides" });
    const filters = within(chips).getByRole("button", { name: /^Filtres/ });
    expect(filters.textContent).toContain("2");
    fireEvent.click(filters);
    // La pastille est transmise : le focus y reviendra à la fermeture de la fenêtre.
    expect(onFiltersOpenChange).toHaveBeenCalledWith(true, filters);
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
