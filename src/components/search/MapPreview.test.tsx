// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPreview } from "./MapPreview";
import { MapPanelSkeleton } from "./SearchFilters";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MapPreview", () => {
  it("expose un bouton nommé « Afficher la carte » qui démarre la carte", () => {
    const onStart = vi.fn();
    render(<MapPreview onStart={onStart} />);
    const button = screen.getByRole("button", { name: "Afficher la carte" });
    expect(button.getAttribute("type")).toBe("button");
    // Le hook de premier geste laisse ce bouton démarrer la carte lui-même.
    expect(button.hasAttribute("data-map-explicit-start")).toBe(true);
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("démarre par `onExplicitStart` au clic (Entrée et Espace y produisent un clic), sans délai", () => {
    const onStart = vi.fn();
    const onExplicitStart = vi.fn();
    render(<MapPreview onStart={onStart} onExplicitStart={onExplicitStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Afficher la carte" }));
    expect(onExplicitStart).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("ne démarre pas au focus (Tab) : ni celui du bouton, ni celui de la zone", () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    const onExplicitStart = vi.fn();
    render(<MapPreview onStart={onStart} onExplicitStart={onExplicitStart} />);
    const button = screen.getByRole("button", { name: "Afficher la carte" });
    act(() => button.focus());
    fireEvent.keyDown(button, { key: "Tab" });
    fireEvent.focus(screen.getByTestId("map-preview"));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(document.activeElement).toBe(button);
    expect(onStart).not.toHaveBeenCalled();
    expect(onExplicitStart).not.toHaveBeenCalled();
  });

  it("ne démarre pas au survol, quelle que soit sa durée : une carte facturée demande un geste", () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    const onExplicitStart = vi.fn();
    render(<MapPreview onStart={onStart} onExplicitStart={onExplicitStart} />);
    const zone = screen.getByTestId("map-preview");
    fireEvent.pointerEnter(zone, { pointerType: "mouse" });
    fireEvent.pointerOver(zone, { pointerType: "mouse" });
    fireEvent.mouseEnter(zone);
    fireEvent.mouseMove(zone);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onStart).not.toHaveBeenCalled();
    expect(onExplicitStart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("explique ce qui se passe réellement : clic ou molette sur le cadre, ni survol ni page", () => {
    render(<MapPreview onStart={vi.fn()} />);
    const help = screen.getByText(/Elle s’affiche aussi/);
    expect(help.textContent).toMatch(/cliquez ou faites défiler la molette sur ce cadre/);
    expect(help.textContent).not.toMatch(/souris/);
    expect(help.textContent).not.toMatch(/défiler la page/);
  });

  it("garde le quadrillage décoratif hors de l'arbre d'accessibilité", () => {
    const { container } = render(<MapPreview onStart={vi.fn()} />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("réserve le même cadre que le squelette de chargement (pas de décalage de mise en page)", () => {
    const frame = (element: Element) =>
      ["h-full", "min-h-[28rem]", "bg-surface-tint"].every((name) =>
        element.classList.contains(name),
      );
    const preview = render(<MapPreview onStart={vi.fn()} />).container.firstElementChild!;
    const skeleton = render(<MapPanelSkeleton />).container.firstElementChild!;
    expect(frame(preview)).toBe(true);
    expect(frame(skeleton)).toBe(true);
  });
});
