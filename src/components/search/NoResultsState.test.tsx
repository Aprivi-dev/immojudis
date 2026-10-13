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
    expect(screen.getByRole("heading", { name: "Aucun dossier trouvé" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
