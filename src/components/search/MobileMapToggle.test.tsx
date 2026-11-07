// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorState, MapPanelSkeleton, MobileMapToggle } from "./SearchFilters";
import { SearchRejectedError } from "@/lib/search/search-errors";

afterEach(cleanup);

describe("MobileMapToggle", () => {
  const renderBar = (props: Partial<React.ComponentProps<typeof MobileMapToggle>> = {}) =>
    render(<MobileMapToggle onOpenMap={vi.fn()} {...props} />);

  it("précharge la carte à l'appui du doigt, avant le clic, et l'ouvre au clic", () => {
    const onPreloadMap = vi.fn();
    const onOpenMap = vi.fn();
    renderBar({ onPreloadMap, onOpenMap });
    const map = screen.getByRole("button", { name: "Voir sur la carte" });

    fireEvent.pointerDown(map);
    expect(onPreloadMap).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(map);
    expect(onPreloadMap).toHaveBeenCalledTimes(2);
    expect(onOpenMap).not.toHaveBeenCalled();

    fireEvent.click(map);
    expect(onOpenMap).toHaveBeenCalledTimes(1);
  });

  it("n'affiche « Voir sur la carte » qu'après un premier défilement (le prix reste lisible)", () => {
    window.scrollY = 0;
    renderBar({ comparedCount: 1, onOpenComparison: vi.fn() });
    const map = screen.getByRole("button", { name: "Voir sur la carte" });
    expect(map.className.split(/\s+/)).toContain("hidden");
    // La pastille du comparateur, elle, reste visible.
    expect(screen.getByRole("button", { name: "Comparer (1)" }).className).not.toMatch(
      /(^|\s)hidden(\s|$)/,
    );

    act(() => {
      window.scrollY = 120;
      window.dispatchEvent(new Event("scroll"));
    });
    expect(map.className.split(/\s+/)).toContain("inline-flex");
    expect(map.className.split(/\s+/)).not.toContain("hidden");

    // Revenue en haut de page : le bouton s'efface de nouveau.
    act(() => {
      window.scrollY = 0;
      window.dispatchEvent(new Event("scroll"));
    });
    expect(map.className.split(/\s+/)).toContain("hidden");
  });

  it("s'affiche dès le montage sur une page rouverte plus bas (retour depuis une fiche)", () => {
    window.scrollY = 900;
    renderBar();
    expect(
      screen.getByRole("button", { name: "Voir sur la carte" }).className.split(/\s+/),
    ).toContain("inline-flex");
    window.scrollY = 0;
  });

  it("ne précharge rien pour la pastille du comparateur", () => {
    const onPreloadMap = vi.fn();
    renderBar({ onPreloadMap, comparedCount: 2, onOpenComparison: vi.fn() });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Comparer (2)" }));
    expect(onPreloadMap).not.toHaveBeenCalled();
  });

  it("montre la pastille « Comparer (N) » seulement quand des biens sont choisis", () => {
    const onOpenComparison = vi.fn();
    const { rerender } = renderBar({ comparedCount: 0, onOpenComparison });
    expect(screen.queryByRole("button", { name: /Comparer/ })).toBeNull();

    rerender(
      <MobileMapToggle comparedCount={3} onOpenComparison={onOpenComparison} onOpenMap={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Comparer (3)" }));
    expect(onOpenComparison).toHaveBeenCalledTimes(1);
  });

  it("est un bouton flottant centré, réservé au mobile, qui laisse passer les gestes autour", () => {
    renderBar({ comparedCount: 1, onOpenComparison: vi.fn() });
    const bar = screen.getByRole("button", { name: "Voir sur la carte" }).parentElement!;
    expect(bar.className).toContain("lg:hidden");
    expect(bar.className).toContain("justify-center");
    expect(bar.className).toContain("pointer-events-none");
    // Les filtres ne sont plus dans cette barre : ils sont sous le champ du lieu.
    expect(screen.queryByRole("button", { name: /Filtres/ })).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("h-12");
      expect(button.className).toContain("pointer-events-auto");
    }
  });
});

describe("MobileMapToggle : pas de décalage à l'arrivée du bandeau de cookies", () => {
  it("se remonte par transform, jamais par bottom (une barre fixe qui change de bottom décale la page)", () => {
    render(<MobileMapToggle onOpenMap={vi.fn()} />);
    const bar = screen.getByRole("button", { name: "Voir sur la carte" }).parentElement!;
    expect(bar.className).toContain("bottom-0");
    expect(bar.className).not.toContain("cookie-banner-height");
    expect(bar.style.transform).toBe("translateY(calc(var(--cookie-banner-height, 0px) * -1))");
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
