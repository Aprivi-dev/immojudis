// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorState, MapPanelSkeleton, MobileMapToggle } from "./SearchFilters";
import { SearchRejectedError } from "@/lib/search/search-errors";

afterEach(cleanup);

describe("MobileMapToggle", () => {
  const renderBar = (props: Partial<React.ComponentProps<typeof MobileMapToggle>> = {}) =>
    render(
      <MobileMapToggle
        activeFiltersCount={0}
        onOpenFilters={vi.fn()}
        onOpenMap={vi.fn()}
        {...props}
      />,
    );

  it("précharge la carte à l'appui du doigt, avant le clic, et l'ouvre au clic", () => {
    const onPreloadMap = vi.fn();
    const onOpenMap = vi.fn();
    renderBar({ onPreloadMap, onOpenMap });
    const map = screen.getByRole("button", { name: "Carte" });

    fireEvent.pointerDown(map);
    expect(onPreloadMap).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(map);
    expect(onPreloadMap).toHaveBeenCalledTimes(2);
    expect(onOpenMap).not.toHaveBeenCalled();

    fireEvent.click(map);
    expect(onOpenMap).toHaveBeenCalledTimes(1);
  });

  it("ne précharge rien pour les autres boutons", () => {
    const onPreloadMap = vi.fn();
    renderBar({ onPreloadMap, comparedCount: 2, onOpenComparison: vi.fn() });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Filtres" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Comparer (2)" }));
    expect(onPreloadMap).not.toHaveBeenCalled();
  });

  it("montre la pastille « Comparer (N) » seulement quand des biens sont choisis", () => {
    const onOpenComparison = vi.fn();
    const { rerender } = renderBar({ comparedCount: 0, onOpenComparison });
    expect(screen.queryByRole("button", { name: /Comparer/ })).toBeNull();

    rerender(
      <MobileMapToggle
        activeFiltersCount={0}
        comparedCount={3}
        onOpenFilters={vi.fn()}
        onOpenComparison={onOpenComparison}
        onOpenMap={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Comparer (3)" }));
    expect(onOpenComparison).toHaveBeenCalledTimes(1);
  });

  it("reste une barre basse réservée au mobile, avec une colonne par bouton", () => {
    renderBar({ comparedCount: 1, onOpenComparison: vi.fn() });
    const bar = screen.getByRole("button", { name: "Carte" }).parentElement!;
    expect(bar.className).toContain("lg:hidden");
    expect(bar.className).toContain("grid-flow-col");
    expect(bar.className).toContain("auto-cols-fr");
    for (const button of screen.getAllByRole("button")) expect(button.className).toContain("h-11");
  });
});

describe("MapPanelSkeleton", () => {
  it("annonce « Chargement de la carte » aux lecteurs d'écran", () => {
    render(<MapPanelSkeleton />);
    expect(screen.getByRole("status").textContent).toBe("Chargement de la carte");
  });
});

describe("ErrorState : recherche refusée", () => {
  it("ne présente pas un refus de la route comme une panne et ne propose pas de le rejouer", () => {
    render(<ErrorState error={new SearchRejectedError("Zone trop large.")} onRetry={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Cette recherche n’est pas possible.");
    expect(alert.textContent).toContain("Zone trop large.");
    expect(alert.textContent).not.toContain("ne répond pas");
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
  });

  it("garde « Réessayer » pour une panne, avec une cible de 44 px", () => {
    render(<ErrorState error={new Error("réseau")} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Réessayer" }).className).toContain("min-h-11");
  });
});
