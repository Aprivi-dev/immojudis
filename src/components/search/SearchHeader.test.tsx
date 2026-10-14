// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CsvExportButton,
  ResultsSummary,
  SaveSearchButton,
  SearchHeader,
  SortDropdown,
} from "./SearchHeader";
import { emptySearchDraft } from "./search-page-state";

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

describe("CsvExportButton", () => {
  it("reste cliquable pour un visiteur afin de le rediriger vers la connexion", () => {
    const onClick = vi.fn();
    render(<CsvExportButton exporting={false} locked onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Exporter en CSV" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
