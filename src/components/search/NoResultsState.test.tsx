// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoResultsState } from "./SearchFilters";

afterEach(cleanup);

const filters = [
  { key: "city", label: "Lyon", clear: { city: undefined } },
  { key: "price", label: "Mise à prix jusqu'à 100 k€", clear: { maxPrice: undefined } },
];

describe("NoResultsState", () => {
  it("lists the active criteria as removable chips", () => {
    const onRemoveFilter = vi.fn();
    render(<NoResultsState filters={filters} onRemoveFilter={onRemoveFilter} />);
    fireEvent.click(screen.getByRole("button", { name: "Retirer le critère : Lyon" }));
    expect(onRemoveFilter).toHaveBeenCalledWith(filters[0]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("offers to clear the filters and to look at the whole of France", () => {
    const onReset = vi.fn();
    const onShowFrance = vi.fn();
    render(
      <NoResultsState
        filters={filters}
        onRemoveFilter={vi.fn()}
        onReset={onReset}
        onShowFrance={onShowFrance}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Effacer les filtres" }));
    fireEvent.click(screen.getByRole("button", { name: "Voir toute la France" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onShowFrance).toHaveBeenCalledTimes(1);
  });

  it("has no action to offer when nothing is filtered", () => {
    render(<NoResultsState onReset={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Aucune vente trouvée" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("NoResultsState avec « Pépites seulement »", () => {
  const withPepite = [
    ...filters,
    { key: "pepite", label: "Pépites seulement", clear: { pepite: undefined } },
  ];

  it("dit qu'il n'y a pas de pépite, sans promettre d'autres annonces", () => {
    render(<NoResultsState filters={withPepite} onRemoveFilter={vi.fn()} pepite={{ count: 0 }} />);
    expect(screen.getByText("Aucune pépite avec ces critères pour le moment.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("élargissez votre budget");
  });

  it("ne propose « Élargir à la France » que s'il y en a, et « Retirer les autres filtres » que s'il y a d'autres filtres", () => {
    const onShowFrance = vi.fn();
    const { rerender } = render(
      <NoResultsState
        filters={withPepite}
        onRemoveFilter={vi.fn()}
        onShowFrance={onShowFrance}
        pepite={{ count: 0, onKeepOnlyPepite: vi.fn() }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Élargir à la France" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retirer les autres filtres" })).toBeTruthy();

    rerender(
      <NoResultsState
        filters={[withPepite[2]]}
        onRemoveFilter={vi.fn()}
        onShowFrance={onShowFrance}
        pepite={{ count: 5, onKeepOnlyPepite: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button", { name: "Élargir à la France" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retirer les autres filtres" })).toBeNull();
  });

  it("propose l'alerte préremplie, et la désactive pendant l'enregistrement", () => {
    const onAlert = vi.fn();
    const { rerender } = render(
      <NoResultsState filters={withPepite} pepite={{ count: 0, onAlert }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Me prévenir dès qu’une pépite apparaît" }));
    expect(onAlert).toHaveBeenCalledTimes(1);
    rerender(
      <NoResultsState filters={withPepite} pepite={{ count: 0, onAlert, alertSaving: true }} />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Me prévenir dès qu’une pépite apparaît",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
