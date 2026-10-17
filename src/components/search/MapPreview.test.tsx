// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_HOVER_DELAY_MS, MapPreview } from "./MapPreview";
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

  describe("survol", () => {
    beforeEach(() => vi.useFakeTimers());

    it("démarre après 300 ms de survol continu, une seule fois, après la peinture", () => {
      const onStart = vi.fn();
      render(<MapPreview onStart={onStart} />);
      fireEvent.pointerEnter(screen.getByTestId("map-preview"));
      act(() => {
        vi.advanceTimersByTime(MAP_HOVER_DELAY_MS - 1);
      });
      expect(onStart).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      // Différé après la peinture, comme tout geste (image, puis setTimeout(0)).
      expect(onStart).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(onStart).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("ne démarre pas quand la souris ne fait que traverser la zone", () => {
      const onStart = vi.fn();
      render(<MapPreview onStart={onStart} />);
      const zone = screen.getByTestId("map-preview");
      fireEvent.pointerEnter(zone);
      act(() => {
        vi.advanceTimersByTime(MAP_HOVER_DELAY_MS - 50);
      });
      fireEvent.pointerLeave(zone);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(onStart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("repart de zéro à chaque entrée, et ne démarre pas pour un doigt", () => {
      const onStart = vi.fn();
      render(<MapPreview onStart={onStart} />);
      const zone = screen.getByTestId("map-preview");
      fireEvent.pointerEnter(zone, { pointerType: "touch" });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(onStart).not.toHaveBeenCalled();

      fireEvent.pointerEnter(zone, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      fireEvent.pointerLeave(zone);
      fireEvent.pointerEnter(zone, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(onStart).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("annule le survol en attente au démontage", () => {
      const onStart = vi.fn();
      const { unmount } = render(<MapPreview onStart={onStart} />);
      fireEvent.pointerEnter(screen.getByTestId("map-preview"));
      unmount();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(onStart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("explique ce qui se passe réellement : clic, défilement, survol arrêté, rien au clavier", () => {
    render(<MapPreview onStart={vi.fn()} />);
    const help = screen.getByText(/Elle s’affiche aussi/);
    expect(help.textContent).toMatch(/cliquez ou faites défiler/);
    expect(help.textContent).toMatch(/arrêtez la souris/);
    expect(help.textContent).not.toMatch(/utilisez la page/);
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
