// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPreview } from "./MapPreview";
import { MapPanelSkeleton } from "./SearchFilters";

afterEach(cleanup);

describe("MapPreview", () => {
  it("expose un bouton nommé « Afficher la carte » qui démarre la carte", () => {
    const onStart = vi.fn();
    render(<MapPreview onStart={onStart} />);
    const button = screen.getByRole("button", { name: "Afficher la carte" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("démarre aussi au survol et au focus de la zone", () => {
    const onStart = vi.fn();
    render(<MapPreview onStart={onStart} />);
    fireEvent.pointerEnter(screen.getByTestId("map-preview"));
    expect(onStart).toHaveBeenCalledTimes(1);
    fireEvent.focus(screen.getByRole("button", { name: "Afficher la carte" }));
    expect(onStart).toHaveBeenCalledTimes(2);
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
